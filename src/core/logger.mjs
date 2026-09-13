// Meridian ERP :: core/logger
// Structured logging for the server and modules.
// Replaces bare console calls with a consistent format that can be easily
// redirected to a file or a monitoring service.

import { nowIso } from './util.mjs';

const LEVELS = {
  DEBUG: { rank: 0, label: 'DEBUG' },
  INFO:  { rank: 1, label: 'INFO ' },
  WARN:  { rank: 2, label: 'WARN ' },
  ERROR: { rank: 3, label: 'ERROR' },
};

let currentLevel = LEVELS.INFO;

/** Configure the logger's minimum level and output destination. */
export function configure({ level = 'INFO', stream = process.stdout } = {}) {
  currentLevel = LEVELS[level.toUpperCase()] || LEVELS.INFO;
  logStream = stream;
}

let logStream = process.stdout;

function log(level, message, ...args) {
  if (level.rank < currentLevel.rank) return;

  const ts = nowIso();
  const formattedArgs = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
  const line = `[${ts}] ${level.label} ${message} ${formattedArgs}`.trim();

  if (logStream && typeof logStream.write === 'function') {
    logStream.write(line + '\n');
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (m, ...a) => log(LEVELS.DEBUG, m, ...a),
  info:  (m, ...a) => log(LEVELS.INFO, m, ...a),
  warn:  (m, ...a) => log(LEVELS.WARN, m, ...a),
  error: (m, ...a) => log(LEVELS.ERROR, m, ...a),
};
