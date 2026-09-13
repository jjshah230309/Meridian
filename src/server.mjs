#!/usr/bin/env node
// Meridian ERP :: server
// Single-process HTTP server: API + embedded web client + SQLite.
// No npm dependencies -- everything below is Node's standard library.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { openDatabase, migrate, Repo, transaction } from './core/db.mjs';
import * as httpx from './core/http.mjs';
import * as auth from './core/auth.mjs';
import * as rbac from './core/rbac.mjs';
import { nowIso } from './core/util.mjs';
import { buildApi } from './api.mjs';
import * as appconfig from './core/appconfig.mjs';
import * as desktop from './core/desktop.mjs';
import { logger } from './core/logger.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERSION = '1.0.0';

// ------------------------------------------------------------- config
function loadConfig(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true) : v;
  }
  // Data lives beside the app by default so the whole thing stays portable;
  // MERIDIAN_DATA points it at a per-user directory for an installed build.
  const dataDir = args.data || process.env.MERIDIAN_DATA || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const stored = appconfig.readConfig(args.config || process.env.MERIDIAN_HOME || dataDir);

  // Meridian is a desktop application first. Running it as a server on the
  // network is a deliberate choice somebody makes -- with `--server`, or by
  // setting the mode in the configuration file -- not what happens by
  // default because a default happened to be a listening socket.
  const serverMode = !!args.server || process.env.MERIDIAN_SERVER === '1'
    || (stored.mode === 'server' && !args.desktop);

  const envPort = process.env.PORT === undefined ? undefined : Number(process.env.PORT);
  const port = args.port !== undefined ? Number(args.port)
    : envPort !== undefined ? envPort
      : serverMode ? Number(stored.server.port) || 8422
        : 8422;
  const host = args.host || process.env.HOST
    || (serverMode ? (stored.server.host || '0.0.0.0') : '127.0.0.1');

  const tlsCert = args['tls-cert'] || process.env.MERIDIAN_TLS_CERT || (serverMode ? stored.server.tls.cert : '');
  const tlsKey = args['tls-key'] || process.env.MERIDIAN_TLS_KEY || (serverMode ? stored.server.tls.key : '');

  return {
    version: VERSION,
    // `--port 0` asks the OS for a free port, which is what the native
    // desktop host does so two copies can never fight over one number.
    port,
    host,
    dataDir,
    configDir: args.config || process.env.MERIDIAN_HOME || dataDir,
    appConfig: stored,
    serverMode,
    tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
    dbPath: path.join(dataDir, 'meridian.db'),
    webDir: path.join(HERE, 'web'),
    migrationsDir: path.join(ROOT, 'migrations'),
    // A server opens no window. A desktop copy opens one unless told not to,
    // which is what the native host does when it owns the window itself.
    open: !serverMode && args.open !== 'false' && args['no-open'] !== true && process.env.MERIDIAN_NO_OPEN !== '1',
    seed: !!args.seed,
    reset: !!args.reset,
    exitAfter: !!args.exit,
    dev: !!args.dev || process.env.NODE_ENV === 'development',
    trustProxy: !!args['trust-proxy'] || (serverMode && stored.server.trust_proxy),
    secret: auth.loadServerSecret(dataDir),
  };
}

// ----------------------------------------------------------- mime types
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf',
};

/** Serve a file from the web directory, with ETag and gzip. */
function serveStatic(req, res, config, pathname) {
  let rel = decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (rel === '' || !path.extname(rel)) rel = 'index.html';        // SPA fallback
  const full = path.resolve(config.webDir, rel);
  // Path traversal guard: the resolved path must stay inside webDir.
  if (!full.startsWith(config.webDir + path.sep) && full !== config.webDir) {
    return httpx.send(res, 403, 'Forbidden');
  }
  let stat;
  try { stat = fs.statSync(full); }
  catch { return httpx.send(res, 404, 'Not found'); }
  if (stat.isDirectory()) return httpx.send(res, 404, 'Not found');

  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) return httpx.send(res, 304, null, { ETag: etag });

  const ext = path.extname(full).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    // Asset URLs are not content-hashed, so a max-age would leave an updated
    // install running last version's JavaScript against this version's API
    // until the entry expired. The server is on this machine: revalidating
    // costs a local round trip and the ETag turns it into a 304.
    'Cache-Control': 'no-cache',
  };
  const body = fs.readFileSync(full);
  const accepts = String(req.headers['accept-encoding'] || '');
  if (body.length > 1400 && /\bgzip\b/.test(accepts) && /text|json|javascript|svg/.test(headers['Content-Type'])) {
    const gz = zlib.gzipSync(body, { level: 6 });
    return httpx.send(res, 200, gz, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
  return httpx.send(res, 200, body, headers);
}

// ------------------------------------------------------------- pipeline
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createServer(config, db) {
  const api = buildApi({ config });
  const limiters = {
    default: new httpx.RateLimiter({ windowMs: 60_000, max: 1200 }),
    auth: new httpx.RateLimiter({ windowMs: 300_000, max: 30 }),
  };

  // A server on somebody's network should be reachable over TLS; a desktop
  // copy talking to itself on the loopback has nothing to encrypt.
  const listener = async (req, res) => {
    const started = process.hrtime.bigint();
    const requestId = httpx.newRequestId();
    const ip = httpx.clientIp(req, config.trustProxy);
    let parsed;
    try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return httpx.send(res, 400, 'Bad request'); }
    const pathname = parsed.pathname.replace(/\/{2,}/g, '/');

    try {
      // ---- static assets and the SPA shell
      // Anything that is not an API path is a file or the SPA shell. `/odata`
      // is served by the router too: BI tools address the feed directly, so
      // it cannot live under /api/v1.
      const isApiPath = pathname.startsWith('/api/') || pathname === '/health'
        || pathname === '/odata/v1' || pathname.startsWith('/odata/v1/')
        || pathname === '/soap/v1' || pathname.startsWith('/soap/v1/');
      if (!isApiPath) {
        return serveStatic(req, res, config, pathname);
      }

      const matched = api.match(req.method, pathname);
      if (!matched) return httpx.sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${pathname}`, requestId } });
      if (matched.methodNotAllowed) return httpx.sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed on ${pathname}`, requestId } });

      const { route, params } = matched;
      const opts = route.opts || {};

      // ---- rate limiting
      const limiter = limiters[opts.rateLimit] || limiters.default;
      const rl = limiter.check(`${ip}:${opts.rateLimit || 'default'}`);
      if (!rl.ok) {
        return httpx.sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.', requestId } },
          { 'Retry-After': Math.ceil(rl.resetMs / 1000) });
      }

      // ---- body
      // Routes read `ctx.body.field` freely, so a JSON body of `null`, `7` or
      // `"hello"` must not be allowed through as-is -- every one of those
      // turned a bad request into a 500. Arrays, strings from a CSV or XML
      // upload, and Buffers are real payload shapes and pass untouched.
      let body = null;
      if (MUTATING.has(req.method)) {
        // Almost every route is well served by the default cap; a handful --
        // a workbook of years of invoices, arriving base64-encoded inside the
        // JSON body -- genuinely need more room, declared explicitly per
        // route rather than raising the ceiling for everyone.
        const parsed = await httpx.readBody(req, opts.bodyLimit ? { limit: opts.bodyLimit } : {});
        body = parsed === null || typeof parsed === 'object' || typeof parsed === 'string' || Buffer.isBuffer(parsed)
          ? parsed
          : {};
        if (body === null) body = {};
      }

      // ---- identity
      const cookies = httpx.parseCookies(req.headers.cookie);
      const sessionToken = cookies[auth.SESSION_COOKIE] || null;
      const authHeader = req.headers.authorization || '';
      let bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1] || null;
      // Power BI, Excel and Tableau offer Basic auth for an OData feed but not
      // Bearer, so an API token presented as the Basic password is accepted.
      // The username is ignored: the token alone identifies the caller.
      if (!bearer) {
        const basic = /^Basic\s+(.+)$/i.exec(authHeader)?.[1];
        if (basic) {
          try {
            const decoded = Buffer.from(basic, 'base64').toString('utf8');
            const idx = decoded.indexOf(':');
            if (idx >= 0) bearer = decoded.slice(idx + 1) || null;
          } catch { /* malformed header: treat as no credentials */ }
        }
      }

      let session = null, tokenRow = null, tenant = null, user = null, access = null, repo = null, csrf = null;
      if (sessionToken) session = auth.readSession(db, sessionToken);
      if (!session && bearer) tokenRow = auth.readApiToken(db, bearer);

      const identity = session || tokenRow;
      if (identity) {
        tenant = db.prepare('SELECT * FROM tenant WHERE id = ?').get(identity.tenant_id);
        if (tenant && tenant.status === 'active') {
          access = rbac.loadAccess(db, tenant.id, identity.user_id);
          if (access) {
            user = access.user;
            repo = new Repo(db, tenant.id, { user, access, ip, requestId });
            if (session) csrf = auth.csrfFor(config.secret, session.id);
          }
        }
      }

      if (!opts.public) {
        if (!user) {
          return httpx.sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Please sign in to continue.', requestId } });
        }
        // ---- CSRF: cookie-authenticated writes must present the token.
        // Bearer-token clients are exempt: they cannot be driven by a browser
        // that silently attaches credentials.
        if (session && MUTATING.has(req.method)) {
          const presented = req.headers['x-csrf-token'] || body?.__csrf;
          if (!auth.csrfValid(config.secret, session.id, presented)) {
            return httpx.sendJson(res, 403, { error: { code: 'CSRF_FAILED', message: 'Your session token is missing or stale. Refresh the page and try again.', requestId } });
          }
          const origin = req.headers.origin;
          if (origin) {
            const host = req.headers.host;
            try { if (new URL(origin).host !== host) return httpx.sendJson(res, 403, { error: { code: 'BAD_ORIGIN', message: 'Cross-origin write rejected.', requestId } }); }
            catch { return httpx.sendJson(res, 403, { error: { code: 'BAD_ORIGIN', message: 'Cross-origin write rejected.', requestId } }); }
          }
        }
      }

      // ---- context handed to every route
      const ctx = {
        req, res, db, config, params, body, ip, requestId,
        query: httpx.parseQuery(parsed.searchParams),
        session, sessionToken, tenant, user, access, repo, csrf,
        tx: (fn) => transaction(db, fn),
        setSessionCookie: (token) => res.setHeader('Set-Cookie', httpx.serializeCookie(auth.SESSION_COOKIE, token, {
          maxAge: auth.SESSION_TTL_HOURS * 3600, httpOnly: true, sameSite: 'Strict',
          secure: (req.headers['x-forwarded-proto'] === 'https'),
        })),
        clearSessionCookie: () => res.setHeader('Set-Cookie', httpx.serializeCookie(auth.SESSION_COOKIE, '', { maxAge: 0 })),
      };

      const result = await route.handler(ctx);
      if (res.writableEnded) return;

      // CSV responses come back through a small escape hatch.
      // Routes that produce a file or a non-JSON document return it through
      // `__body`, with `__csv` kept as the original shorthand for CSV.
      if (result && typeof result === 'object' && (result.__csv !== undefined || result.__body !== undefined)) {
        const payload = result.__body !== undefined ? result.__body : result.__csv;
        const headers = {
          'Content-Type': result.__contentType || 'text/csv; charset=utf-8',
          ...(result.__headers || {}),
        };
        // `inline` lets a browser render it; a download needs the filename.
        if (result.__filename !== undefined || result.__csv !== undefined) {
          headers['Content-Disposition'] =
            `${result.__inline ? 'inline' : 'attachment'}; filename="${result.__filename || 'export.csv'}"`;
        }
        return httpx.send(res, result.__status || 200, payload, headers);
      }
      return httpx.sendJson(res, req.method === 'POST' && result?.id && route.opts?.created ? 201 : 200, result ?? { ok: true }, { 'X-Request-Id': requestId });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        logger.error(`${requestId} ${req.method} ${pathname} →`, err);
      } else if (config.dev) {
        logger.warn(`${requestId} ${req.method} ${pathname} → ${status} ${err.message}`);
      }
      return httpx.sendError(res, err, { exposeStack: config.dev, requestId });
    } finally {
      if (config.dev) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms > 250) console.warn(`  slow: ${req.method} ${pathname} ${ms.toFixed(0)}ms`);
      }
    }
  };

  // A server on somebody's network should be reachable over TLS; a desktop
  // copy talking to itself over the loopback has nothing to encrypt.
  const server = config.tls
    ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, listener)
    : http.createServer(listener);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const config = loadConfig(argv);

  // Meridian is a desktop application. If a copy is installed on this
  // machine, running the command hands over to it rather than starting a
  // second server behind its back -- the installed app owns its own window,
  // menus and shortcuts, and starting our own here would take the port it
  // wants. A build sitting in the project's `dist` is deliberately NOT used
  // for this: somebody running from source wants the source they are editing,
  // not the snapshot they last packaged. `--app` overrides that.
  if (!config.serverMode && config.open && !config.seed && !config.reset && !config.exitAfter) {
    const forceApp = argv.includes('--app');
    const native = desktop.findNativeHost(ROOT, { installedOnly: !forceApp });
    if (native) {
      desktop.openWindow('', { root: ROOT, preferNative: true, installedOnly: !forceApp });
      console.log(`· Opening ${path.basename(native)}`);
      console.log('  Run with --dev to serve this working copy instead.');
      return;
    }
  }

  if (config.reset && fs.existsSync(config.dbPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(config.dbPath + suffix); } catch { /* not present */ }
    }
    console.log('· Existing database removed');
  }

  const db = openDatabase(config.dbPath, { verbose: config.dev });
  const applied = migrate(db, config.migrationsDir);
  if (applied.length) console.log(`· Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}`);

  const tenantCount = db.prepare('SELECT COUNT(*) c FROM tenant').get().c;
  // A fresh copy is NOT seeded automatically: the first-run wizard in the app
  // asks for a real company name, currency and administrator instead. Pass
  // --seed to build the Northwind demo company for a walkthrough or a test.
  if (config.seed) {
    const { seedDemo } = await import('./seed.mjs');
    const result = seedDemo(db, { force: true });
    if (result) console.log(`· Demo company "${result.name}" ready — sign in as ${result.email} / ${result.password}`);
  } else if (tenantCount === 0) {
    console.log('· No company yet — the app will open its setup screen.');
  }

  auth.purgeExpiredSessions(db);
  if (config.exitAfter) { db.close(); return; }

  const server = createServer(config, db);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  // With `--port 0` the real port is only known once the socket is bound.
  const boundPort = server.address().port;
  const scheme = config.tls ? 'https' : 'http';
  const appUrl = `${scheme}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${boundPort}/`;
  const line = '─'.repeat(52);

  if (config.serverMode) {
    const addresses = desktop.lanAddresses(boundPort, !!config.tls);
    console.log(`\n${line}\n  Meridian ERP ${VERSION} — server`);
    console.log(`  data:   ${config.dataDir}`);
    console.log(`  config: ${config.appConfig.$file}`);
    console.log(`  ${config.tls ? 'TLS enabled' : 'TLS off — put it behind a reverse proxy, or set tls.cert and tls.key'}`);
    console.log(`\n  Reachable at:\n${['  ' + appUrl, ...addresses.map((a) => '  ' + a)].join('\n')}`);
    console.log(`\n  Point a desktop copy at one of those addresses under\n  Settings → Connection, or set "mode": "remote" in its ${appconfig.CONFIG_NAME}.\n${line}\n`);
  } else {
    console.log(`\n${line}\n  Meridian ERP ${VERSION}\n  ${appUrl}\n  data: ${config.dataDir}\n${line}\n`);
  }

  // A single machine-readable line the native desktop host waits for, so it
  // never has to guess when the server is up or which port it landed on.
  console.log(`MERIDIAN_READY ${appUrl}`);

  if (config.open) {
    const opened = desktop.openWindow(appUrl, { root: ROOT, preferNative: false });
    if (opened.how === 'none') console.log(`  Open ${appUrl} in your browser to begin.`);
    else if (opened.how === 'browser') console.log('  No Chromium-based browser found, so this opened in your default browser.');
  }

  // Housekeeping: expire sessions and checkpoint the WAL hourly.
  const housekeeping = setInterval(() => {
    try {
      auth.purgeExpiredSessions(db);
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch (e) { console.error('housekeeping:', e.message); }
  }, 3600_000);
  housekeeping.unref();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n· ${signal} received — closing cleanly`);
    server.close(() => {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error('\nMeridian failed to start:\n ', e.message, '\n'); process.exit(1); });
}

export { loadConfig };
