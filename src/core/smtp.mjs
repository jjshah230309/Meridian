// Meridian ERP :: core/smtp
// A minimal SMTP client written against node:net and node:tls, because
// sending an email is otherwise the one thing this zero-dependency project
// cannot do on its own. Supports implicit TLS (port 465) and STARTTLS
// (587/25), AUTH LOGIN, and a plain-text message with one optional binary
// attachment (the statements, dunning notices and remittance advice this
// is actually for are all a PDF plus a short note).
//
// What this deliberately does not do: connection pooling, DSN/delivery
// receipts, HTML bodies, multiple recipients on one message, or retrying --
// core/outbox.mjs already owns retry and backoff, one level up. A single
// send here either succeeds or throws; the caller decides what "try again
// later" means.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class SmtpError extends Error {
  constructor(message, code) { super(message); this.name = 'SmtpError'; this.code = code; }
}

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Read SMTP responses off a socket, one logical (possibly multi-line)
 * reply at a time. A multi-line reply is "250-more coming" lines followed
 * by a final "250 last line" -- a space, not a dash, in the fourth column. */
function replyReader(socket) {
  let buf = '';
  const waiters = [];
  const feed = () => {
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const rawLine = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue; // a malformed line is ignored rather than crashing the whole exchange
      pending.lines.push(m[3]);
      if (m[2] === ' ') {
        pending.code = Number(m[1]);
        const done = pending;
        pending = { code: null, lines: [] };
        const w = waiters.shift();
        if (w) w.resolve(done);
      }
    }
  };
  let pending = { code: null, lines: [] };
  const onData = (chunk) => { buf += chunk.toString('latin1'); feed(); };
  socket.on('data', onData);
  return {
    next(timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new SmtpError('Timed out waiting for a reply', 'TIMEOUT')), timeoutMs);
        waiters.push({ resolve: (r) => { clearTimeout(timer); resolve(r); } });
      });
    },
    // Before handing the raw socket to tls.connect({ socket }) for a
    // STARTTLS upgrade, this listener MUST come off first: tls's own
    // internal consumption of the socket competes with any 'data'
    // listener still attached from outside, corrupting or silently
    // dropping the TLS handshake's own bytes.
    stop() { socket.off('data', onData); },
  };
}

function write(socket, line) {
  return new Promise((resolve, reject) => socket.write(line + CRLF, (err) => (err ? reject(err) : resolve())));
}

async function expect(reader, codes, context, timeoutMs) {
  const r = await reader.next(timeoutMs);
  const want = Array.isArray(codes) ? codes : [codes];
  if (!want.includes(r.code)) {
    throw new SmtpError(`${context}: server said ${r.code} ${r.lines.join(' ')}`, 'PROTOCOL');
  }
  return r;
}

/** Dot-stuff the message body: RFC 5321 says a line consisting of, or
 * starting with, a single "." must have that dot doubled, or the receiving
 * server (or a proxy in between) reads it as the end-of-data marker and
 * truncates the message right there. */
const dotStuff = (body) => body.split(CRLF).map((line) => (line.startsWith('.') ? '.' + line : line)).join(CRLF);

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

/** RFC 2047 encoded-word, for a header value (a Subject, a From display
 * name) that isn't plain ASCII -- an em dash or an accented name is
 * ordinary in this application's own text, but sent raw as a header value
 * it depends on the connection having negotiated 8BITMIME/SMTPUTF8, which
 * this client never checks for. Left un-encoded, a compliant receiver may
 * reject it outright; a lenient one decodes the UTF-8 bytes as Latin-1 and
 * silently mangles it -- which is exactly what an unencoded em dash in a
 * Subject line turns into. Encoding sidesteps needing to negotiate either
 * extension at all. Chunking into multiple encoded-words past RFC 2047's
 * 75-character limit is not implemented -- every header value here (a
 * subject, a display name) is short enough in practice that it never
 * matters, and a too-long line degrades to a long header rather than a
 * wrong one. */
const encodeHeaderValue = (s) => (isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Same as encodeHeaderValue, but for a "Display Name <addr>" From header:
 * only the display name can be non-ASCII (the address portion is what the
 * server actually routes on), so only it gets encoded -- encoding the
 * whole string would swallow the angle-bracket address into the encoded
 * word along with the name. */
function encodeFromHeader(from) {
  const m = /^(.*)<(.+)>\s*$/.exec(from);
  if (!m) return encodeHeaderValue(from);
  const name = m[1].trim();
  return isAscii(name) ? from : `${encodeHeaderValue(name)} <${m[2]}>`;
}

/** Quoted-printable, RFC 2045: every byte kept 7-bit-clean, non-ASCII bytes
 * escaped as =XX, lines soft-wrapped under 76 columns. Used for the body
 * only when it actually contains non-ASCII bytes -- plain ASCII text is
 * left exactly as written, since encoding it would only make a support
 * request's "what did the email actually say" harder to answer by eye. */
function quotedPrintable(text) {
  const bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
  let out = '', lineLen = 0;
  const put = (piece) => {
    if (lineLen + piece.length > 75) { out += '=' + CRLF; lineLen = 0; }
    out += piece; lineLen += piece.length;
  };
  for (const b of bytes) {
    if (b === 0x0A) { out += CRLF; lineLen = 0; continue; }
    if ((b >= 0x21 && b <= 0x7E && b !== 0x3D) || b === 0x20 || b === 0x09) put(String.fromCharCode(b));
    else put('=' + b.toString(16).toUpperCase().padStart(2, '0'));
  }
  return out;
}

function buildMessage({ from, to, subject, text, attachments = [] }) {
  const boundary = `meridian-${crypto.randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${encodeFromHeader(from)}`, `To: ${to}`, `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@meridian.local>`,
    'MIME-Version: 1.0',
  ];
  const bodyAscii = isAscii(text);
  const body = bodyAscii ? text : quotedPrintable(text);
  const bodyEncoding = bodyAscii ? '7bit' : 'quoted-printable';
  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${bodyEncoding}`);
    return dotStuff(headers.join(CRLF) + CRLF + CRLF + body);
  }
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${bodyEncoding}`, '', body, '',
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      a.bytes.toString('base64').replace(/(.{76})/g, '$1\n'),
      '',
    );
  }
  parts.push(`--${boundary}--`);
  return dotStuff(headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF));
}

/**
 * Send one message. `config` is { host, port, secure, username, password }
 * -- `secure: true` connects with TLS from the first byte (port 465);
 * `secure: false` connects plain and upgrades with STARTTLS if the server
 * offers it (587/25), refusing to send AUTH over an unencrypted connection
 * either way once credentials are configured.
 */
export async function sendMail(config, { from, to, subject, text, attachments = [] }) {
  if (!config?.host) throw new SmtpError('No SMTP host configured', 'NOT_CONFIGURED');
  if (!to) throw new SmtpError('No recipient address', 'NO_RECIPIENT');
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  // TLS's SNI extension (the `servername` option) only carries a hostname --
  // Node throws outright if it is given a bare IP literal, which a relay
  // reached by address (as any test server, or an on-prem relay with no DNS
  // entry, is) would hit on every single send. Omitted entirely for an IP;
  // certificate verification still happens, just without SNI.
  const tlsOpts = net.isIP(config.host) ? {} : { servername: config.host };

  let socket = config.secure
    ? tls.connect({ host: config.host, port: config.port || 465, rejectUnauthorized: config.rejectUnauthorized !== false, ...tlsOpts })
    : net.connect({ host: config.host, port: config.port || 587 });
  socket.setTimeout(timeoutMs);
  socket.on('timeout', () => socket.destroy(new SmtpError('Connection timed out', 'TIMEOUT')));

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve); socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  let reader = replyReader(socket);
  const localName = 'meridian.local';
  try {
    await expect(reader, 220, 'greeting', timeoutMs);
    await write(socket, `EHLO ${localName}`);
    let ehlo = await expect(reader, 250, 'EHLO', timeoutMs);

    if (!config.secure) {
      const startTls = ehlo.lines.some((l) => /^STARTTLS/i.test(l));
      if (startTls) {
        await write(socket, 'STARTTLS');
        await expect(reader, 220, 'STARTTLS', timeoutMs);
        reader.stop();
        const plain = socket;
        socket = tls.connect({ socket: plain, host: config.host, rejectUnauthorized: config.rejectUnauthorized !== false, ...tlsOpts });
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => socket.destroy(new SmtpError('Connection timed out', 'TIMEOUT')));
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        reader = replyReader(socket);
        await write(socket, `EHLO ${localName}`);
        ehlo = await expect(reader, 250, 'EHLO after STARTTLS', timeoutMs);
      } else if (config.username) {
        throw new SmtpError('This server does not offer STARTTLS, and a password is configured -- refusing to send it in the clear.', 'INSECURE_AUTH');
      }
    }

    if (config.username) {
      await write(socket, 'AUTH LOGIN');
      await expect(reader, 334, 'AUTH LOGIN', timeoutMs);
      await write(socket, Buffer.from(config.username, 'utf8').toString('base64'));
      await expect(reader, 334, 'AUTH LOGIN (username)', timeoutMs);
      await write(socket, Buffer.from(config.password || '', 'utf8').toString('base64'));
      await expect(reader, 235, 'AUTH LOGIN (password)', timeoutMs);
    }

    await write(socket, `MAIL FROM:<${from}>`);
    await expect(reader, 250, 'MAIL FROM', timeoutMs);
    await write(socket, `RCPT TO:<${to}>`);
    await expect(reader, [250, 251], 'RCPT TO', timeoutMs);
    await write(socket, 'DATA');
    await expect(reader, 354, 'DATA', timeoutMs);
    await write(socket, buildMessage({ from, to, subject, text, attachments }) + CRLF + '.');
    await expect(reader, 250, 'message body', timeoutMs);
    await write(socket, 'QUIT').catch(() => {}); // a QUIT that never gets an answer is not a failed send
  } finally {
    socket.destroy();
  }
}
