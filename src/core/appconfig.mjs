// Meridian ERP :: core/appconfig
// The handful of settings that have to be known before the database is open.
//
// Everything else Meridian knows lives in SQLite, where it belongs. But three
// questions come first and cannot: which mode to run in, where the data is,
// and -- if this machine is a client of a server somewhere else -- what that
// server's address is. Those live in a small JSON file beside the data, so a
// site administrator can set them with a text editor and so the desktop app
// can read them before it has anything to connect to.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_NAME = 'meridian.json';

/**
 * Where the config lives when nobody says otherwise.
 *
 * The per-user application directory rather than beside the binary: an
 * installed copy in /Applications is not writable, and two people sharing a
 * machine should not share a company.
 */
export function defaultConfigDir() {
  if (process.env.MERIDIAN_HOME) return process.env.MERIDIAN_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Meridian');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Meridian');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meridian');
}

export const DEFAULTS = {
  // local   -- this machine runs the server and holds the data (the default)
  // remote  -- this machine is a client; the data is on a server elsewhere
  // server  -- this machine IS the server: no window, listens on the network
  mode: 'local',
  remote: { url: '', verify_tls: true },
  server: {
    host: '0.0.0.0',
    port: 8422,
    tls: { cert: '', key: '' },
    trust_proxy: false,
    // Empty means "anything on the local network". A site that fronts
    // Meridian with its own reverse proxy names the proxy's origin here.
    allowed_origins: [],
  },
  window: { width: 1560, height: 980, zoom: 1 },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `patch` over `base`, arrays replaced wholesale. */
export function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export const configPath = (dir = defaultConfigDir()) => path.join(dir, CONFIG_NAME);

/**
 * Read the file, falling back to the defaults for anything absent.
 *
 * A malformed file is reported and ignored rather than fatal: a stray comma
 * in a config file should not stop somebody's accounts from opening.
 */
export function readConfig(dir = defaultConfigDir()) {
  const file = configPath(dir);
  let stored = {};
  let problem = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') problem = `${file} could not be read (${e.message}); using defaults.`;
  }
  return { ...merge(DEFAULTS, stored), $file: file, $problem: problem, $exists: !problem && Object.keys(stored).length > 0 };
}

/** Write it back, atomically, so a crash mid-save cannot truncate it. */
export function writeConfig(patch, dir = defaultConfigDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const current = readConfig(dir);
  const next = merge(DEFAULTS, merge(stripMeta(current), patch));
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ...next, $file: file };
}

const stripMeta = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('$')));

/** A remote URL is only usable if it parses and speaks http(s). */
export function validateRemote(url) {
  if (!url) return 'Enter the address of the Meridian server';
  let parsed;
  try { parsed = new URL(url); } catch { return 'That is not a valid address'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'The address has to start with http:// or https://';
  return null;
}
