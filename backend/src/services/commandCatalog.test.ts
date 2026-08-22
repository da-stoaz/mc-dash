import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutput, COMMAND_CATALOG, suggestCommand, VANILLA_COMMANDS, verbOf } from './commandCatalog';

test('reads the command name off the front', () => {
  assert.equal(verbOf('give Alice minecraft:diamond 64'), 'give');
  assert.equal(verbOf('  TIME set day '), 'time');
  assert.equal(verbOf('list'), 'list');
});

test('recognises a server rejecting a command it does not have', () => {
  assert.equal(classifyOutput('Unknown or incomplete command, see below for error'), 'unknown-command');
  assert.equal(classifyOutput('Unknown command'), 'unknown-command');
});

test('recognises a real command used wrongly, which is a different problem', () => {
  assert.equal(classifyOutput('Incorrect argument for command'), 'bad-arguments');
  assert.equal(classifyOutput('Expected whitespace to end one argument'), 'bad-arguments');
});

test('treats ordinary console output as success', () => {
  assert.equal(classifyOutput('Gave 64 [Diamond] to Alice'), 'ok');
  assert.equal(classifyOutput('Set the time to 1000'), 'ok');
  assert.equal(classifyOutput('There are 0 of a max of 20 players online:'), 'ok');
  // Plenty of commands say nothing at all.
  assert.equal(classifyOutput(''), 'ok');
});

test('suggests the command a typo was reaching for', () => {
  assert.equal(suggestCommand('giv'), 'give');
  assert.equal(suggestCommand('tpp'), 'tp');
  assert.equal(suggestCommand('gamemod'), 'gamemode');
  assert.equal(suggestCommand('weathr'), 'weather');
});

test('stays quiet when nothing is close enough to be a typo', () => {
  assert.equal(suggestCommand('ftbquests'), null);
  assert.equal(suggestCommand(''), null);
  // An exact match is not a typo.
  assert.equal(suggestCommand('give'), null);
});

test('suggests from the modded commands a server has shown it accepts', () => {
  assert.equal(suggestCommand('waystone', ['waystones']), 'waystones');
});

test('every catalog entry is a real command and leads with its own name', () => {
  for (const entry of COMMAND_CATALOG) {
    assert.ok(VANILLA_COMMANDS.has(entry.name), `${entry.name} missing from VANILLA_COMMANDS`);
    assert.ok(entry.usage.startsWith(entry.name), `${entry.name} usage should start with the command`);
    assert.ok(entry.summary.length > 0, `${entry.name} needs a summary`);
  }
});
