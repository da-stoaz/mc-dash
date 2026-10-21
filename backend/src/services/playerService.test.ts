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

test('UUID delimiters keep a comma-containing title with its player', () => {
  const result = parsePlayerList('There are 2 of a max of 20 players online: Schimobi, the Nutcracker (00000000-0000-0000-0000-000000000001), Bruckinator67 (00000000-0000-0000-0000-000000000002)');
  assert.deepEqual(result, { online: 2, max: 20, names: ['Schimobi, the Nutcracker', 'Bruckinator67'] });
});

test('ambiguous plain list does not invent a third player', () => {
  assert.deepEqual(parsePlayerList('There are 2 of a max of 20 players online: Schimobi, the Nutcracker, Bruckinator67'), { online: 2, max: 20, names: [] });
});

test('formatting and colons within a display name do not truncate the roster', () => {
  assert.deepEqual(parsePlayerList('§aThere are 1 of a max of 20 players online: [Title: Hero] Alice (00000000-0000-0000-0000-000000000001)'), { online: 1, max: 20, names: ['[Title: Hero] Alice'] });
});
