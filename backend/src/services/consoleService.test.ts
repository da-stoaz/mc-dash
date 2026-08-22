import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COMMAND_LENGTH, sanitizeCommand } from './consoleService';

const NUL = String.fromCharCode(0);

test('strips the leading slash people type out of habit', () => {
  assert.equal(sanitizeCommand('/give Alice minecraft:diamond 64'), 'give Alice minecraft:diamond 64');
  assert.equal(sanitizeCommand('/tp Alice 0 64 0'), 'tp Alice 0 64 0');
  assert.equal(sanitizeCommand('/kill @e[type=zombie]'), 'kill @e[type=zombie]');
});

test('leaves a slash-less command alone', () => {
  assert.equal(sanitizeCommand('list'), 'list');
  assert.equal(sanitizeCommand('  say hello there  '), 'say hello there');
});

test('only the first slash is a prefix — paths inside the command survive', () => {
  assert.equal(sanitizeCommand('/function my_pack:setup/start'), 'function my_pack:setup/start');
});

test('rejects nothing to run', () => {
  assert.throws(() => sanitizeCommand(''), /Empty command/);
  assert.throws(() => sanitizeCommand('   '), /Empty command/);
  assert.throws(() => sanitizeCommand('/'), /Empty command/);
  assert.throws(() => sanitizeCommand(undefined), /Empty command/);
  assert.throws(() => sanitizeCommand(42), /Empty command/);
});

test('refuses control characters, so one line stays one command', () => {
  assert.throws(() => sanitizeCommand('say hi\nstop'), /Invalid command/);
  assert.throws(() => sanitizeCommand('say hi\r\nstop'), /Invalid command/);
  assert.throws(() => sanitizeCommand(`say hi${NUL}stop`), /Invalid command/);
});

test('refuses a command too long to fit an RCON packet', () => {
  const long = `say ${'x'.repeat(MAX_COMMAND_LENGTH)}`;
  assert.throws(() => sanitizeCommand(long), /too long/i);
  assert.doesNotThrow(() => sanitizeCommand('x'.repeat(MAX_COMMAND_LENGTH)));
});
