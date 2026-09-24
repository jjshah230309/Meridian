// Error.prototype.message/name/stack are non-enumerable, so JSON.stringify
// on a bare Error silently produces "{}" -- the one time a log line most
// needs to say something, a 500 in production, it said nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, configure } from '../src/core/logger.mjs';

function capture(fn) {
  let out = '';
  configure({ level: 'DEBUG', stream: { write: (s) => { out += s; } } });
  try { fn(); } finally { configure({}); }
  return out;
}

test('logging an Error keeps its message and stack, not "{}"', () => {
  const out = capture(() => logger.error('request failed', new Error('kaput')));
  assert.match(out, /"message":\s*"kaput"/);
  assert.match(out, /"stack":\s*"Error: kaput/);
  assert.doesNotMatch(out, /\{\}\s*$/, 'an Error must not serialise to an empty object');
});

test('an own enumerable field on a custom error subclass still comes through', () => {
  class HttpLikeError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const out = capture(() => logger.error('request failed', new HttpLikeError(404, 'not found')));
  assert.match(out, /"status":\s*404/);
  assert.match(out, /"message":\s*"not found"/);
});

test('a plain object still logs as before', () => {
  const out = capture(() => logger.info('context', { a: 1 }));
  assert.match(out, /"a":\s*1/);
});
