// Direct unit tests for src/core/util.mjs's scaled-integer money arithmetic
// and date validation -- every other module trusts these primitives, so a
// mistake here is silent and everywhere at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Money, isValidDate } from '../src/core/util.mjs';

test('Money.parse recognizes accounting parenthesis notation as negative', () => {
  // Parens are outside the digit/dot/comma/minus filter, so they used to be
  // dropped silently, turning a negative amount (e.g. a debit from a bank
  // export) into a positive one.
  assert.equal(Money.parse('(1,234.56)'), -123456);
  assert.equal(Money.parse('$(1,234.56)'), -123456);
  assert.equal(Money.parse('(5)'), -500);
});

test('Money.parse recognizes a trailing minus as negative', () => {
  // parseFloat stops at the first non-numeric character rather than failing,
  // so "1234.56-" used to parse as the positive number 1234.56.
  assert.equal(Money.parse('1234.56-'), -123456);
  assert.equal(Money.parse('1,234.56-'), -123456);
});

test('Money.parse still handles ordinary positive and negative amounts', () => {
  assert.equal(Money.parse('1,234.56'), 123456);
  assert.equal(Money.parse('$1234.56'), 123456);
  assert.equal(Money.parse('-1234.56'), -123456);
  assert.equal(Money.parse(1234.56), 123456);
  assert.equal(Money.parse(''), 0);
  assert.equal(Money.parse(null), 0);
});

test('isValidDate rejects calendar-invalid dates instead of letting them roll forward', () => {
  // Date.parse silently rolls "2024-02-30" forward to March 1st rather than
  // failing, so the shape-check-plus-parse combo used to accept it.
  assert.equal(isValidDate('2024-02-30'), false, 'February has no 30th');
  assert.equal(isValidDate('2023-02-29'), false, '2023 is not a leap year');
  assert.equal(isValidDate('2024-04-31'), false, 'April has 30 days');
  assert.equal(isValidDate('2024-13-01'), false, 'month 13 does not exist');
});

test('isValidDate still accepts real dates, including leap days', () => {
  assert.equal(isValidDate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(isValidDate('2026-06-15'), true);
  assert.equal(isValidDate('2026-01-01'), true);
  assert.equal(isValidDate('not-a-date'), false);
  assert.equal(isValidDate(null), false);
});
