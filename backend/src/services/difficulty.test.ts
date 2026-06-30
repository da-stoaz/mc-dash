import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTIES, formatDifficulty, isDifficulty, parseDifficulty, usesNumericFormat } from './difficulty';

test('parses the modern string format (any case/whitespace)', () => {
  assert.equal(parseDifficulty('peaceful'), 'peaceful');
  assert.equal(parseDifficulty('EASY'), 'easy');
  assert.equal(parseDifficulty('  Normal '), 'normal');
  assert.equal(parseDifficulty('hard'), 'hard');
});

test('parses the legacy numeric format (pre-1.13 servers)', () => {
  assert.equal(parseDifficulty('0'), 'peaceful');
  assert.equal(parseDifficulty('1'), 'easy');
  assert.equal(parseDifficulty('2'), 'normal');
  assert.equal(parseDifficulty('3'), 'hard');
});

test('rejects values that are not a real difficulty', () => {
  assert.equal(parseDifficulty(undefined), undefined);
  assert.equal(parseDifficulty(''), undefined);
  assert.equal(parseDifficulty('4'), undefined);
  assert.equal(parseDifficulty('extreme'), undefined);
});

test('detects which format a server uses', () => {
  assert.equal(usesNumericFormat('2'), true);
  assert.equal(usesNumericFormat(' 0 '), true);
  assert.equal(usesNumericFormat('normal'), false);
  assert.equal(usesNumericFormat('7'), false);
  assert.equal(usesNumericFormat(undefined), false);
});

test('formats back into the format the server already uses', () => {
  for (const d of DIFFICULTIES) {
    // round-trips through both formats
    assert.equal(parseDifficulty(formatDifficulty(d, false)), d);
    assert.equal(parseDifficulty(formatDifficulty(d, true)), d);
  }
  assert.equal(formatDifficulty('normal', false), 'normal');
  assert.equal(formatDifficulty('normal', true), '2');
});

test('isDifficulty guards the union', () => {
  assert.equal(isDifficulty('hard'), true);
  assert.equal(isDifficulty('lethal'), false);
  assert.equal(isDifficulty(2), false);
});
