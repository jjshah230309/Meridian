#!/usr/bin/env node
// Meridian ERP :: scripts/backup
// A consistent copy of the database, taken while it is running.
//
// Copying the file with `cp` while the server is writing produces something
// that looks like a database and is not one. SQLite's VACUUM INTO takes a
// proper snapshot of a live database -- consistent, compacted, and safe to
// run against a server with people using it.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const command = args.find((a) => !a.startsWith('--')) || 'create';

const dataDir = flag('data', process.env.MERIDIAN_DATA || path.join(ROOT, 'data'));
const dbPath = path.join(dataDir, 'meridian.db');
const backupDir = flag('to', path.join(dataDir, 'backups'));
const keep = Number(flag('keep', '14'));

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const human = (bytes) => (bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

function create() {
  if (!fs.existsSync(dbPath)) { console.error(`\nNo database at ${dbPath}\n`); process.exit(1); }
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `meridian-${stamp()}.db`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // VACUUM INTO is atomic from the reader's point of view: what lands is
    // the database as it was at a single instant, whatever is being written
    // while it runs.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally { db.close(); }

  const size = fs.statSync(target).size;
  console.log(`\n· ${target}`);
  console.log(`· ${human(size)}\n`);
  prune();
  return target;
}

function prune() {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const files = fs.readdirSync(backupDir)
    .filter((f) => /^meridian-.*\.db$/.test(f))
    .sort()
    .reverse();
  const stale = files.slice(keep);
  for (const f of stale) fs.unlinkSync(path.join(backupDir, f));
  if (stale.length) console.log(`· Removed ${stale.length} backup${stale.length === 1 ? '' : 's'} beyond the last ${keep}\n`);
}

function list() {
  if (!fs.existsSync(backupDir)) { console.log(`\nNo backups yet in ${backupDir}\n`); return; }
  const files = fs.readdirSync(backupDir).filter((f) => /^meridian-.*\.db$/.test(f)).sort().reverse();
  console.log(`\n${files.length} backup${files.length === 1 ? '' : 's'} in ${backupDir}\n`);
  for (const f of files) {
    const s = fs.statSync(path.join(backupDir, f));
    console.log(`  ${f}   ${human(s.size).padStart(8)}   ${s.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  console.log('');
}

/**
 * Put a backup back. Deliberately awkward: it refuses unless the server is
 * stopped and the caller says the word, because restoring is how a bad
 * afternoon becomes a bad quarter.
 */
function restore() {
  const from = flag('from');
  if (typeof from !== 'string') { console.error('\nWhich backup? Pass --from <file>\n'); process.exit(1); }
  if (!fs.existsSync(from)) { console.error(`\nNo such file: ${from}\n`); process.exit(1); }
  if (!args.includes('--yes')) {
    console.error(`\nThis replaces ${dbPath} with ${from}.`);
    console.error('Stop the server first, then run it again with --yes.\n');
    process.exit(1);
  }
  // Verify before destroying anything: an unreadable backup is worse than none.
  const check = new DatabaseSync(from, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get();
    const verdict = Object.values(result)[0];
    if (verdict !== 'ok') { console.error(`\nThat backup is damaged: ${verdict}\n`); process.exit(1); }
  } finally { check.close(); }

  if (fs.existsSync(dbPath)) {
    const aside = `${dbPath}.replaced-${stamp()}`;
    fs.renameSync(dbPath, aside);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* not present */ }
    }
    console.log(`\n· The database that was there is at ${aside}`);
  }
  fs.copyFileSync(from, dbPath);
  console.log(`· Restored ${from}\n`);
}

const usage = `
Meridian ERP — backups

  node scripts/backup.mjs create              take one now
  node scripts/backup.mjs list                what has been taken
  node scripts/backup.mjs restore --from <f>  put one back (stop the server first)

Options
  --data <dir>   where the database lives  (default: ./data)
  --to <dir>     where backups go          (default: <data>/backups)
  --keep <n>     how many to keep          (default: 14)
  --yes          required by restore, so it cannot happen by accident
`;

const actions = { create, list, restore, prune };
if (!actions[command]) { console.log(usage); process.exit(1); }
try { actions[command](); }
catch (e) { console.error(`\nThat did not work: ${e.message}\n`); process.exit(1); }
