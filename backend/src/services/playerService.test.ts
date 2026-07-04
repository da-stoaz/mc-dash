import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerList } from './playerService';

test('parses vanilla list output with names', () => {
  const result = parsePlayerList('There are 3 of a max of 20 players online: Alice, Bob, Carol');
  assert.deepEqual(result, { online: 3, max: 20, names: ['Alice', 'Bob', 'Carol'] });
});

test('parses empty server (nobody online)', () => {
  const result = parsePlayerList('There are 0 of a max of 20 players online:');
  assert.deepEqual(result, { online: 0, max: 20, names: [] });
});

test('parses "N/M" shorthand used by some modded servers', () => {
  const result = parsePlayerList('Players 2/10 online: Alice, Bob');
  assert.deepEqual(result, { online: 2, max: 10, names: ['Alice', 'Bob'] });
});

test('returns null for unrecognized output', () => {
  assert.equal(parsePlayerList('Unknown command'), null);
  assert.equal(parsePlayerList(''), null);
});
