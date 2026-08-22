import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOutput,
  COMMAND_CATALOG,
  formatServerOutput,
  parseUsageArgs,
  suggestCommand,
  VANILLA_COMMANDS,
  verbOf,
} from './commandCatalog';

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

test('enumerated arguments become values worth offering', () => {
  const [mode, player] = parseUsageArgs('gamemode <survival|creative|adventure|spectator> [player]');
  assert.deepEqual(mode.options, ['survival', 'creative', 'adventure', 'spectator']);
  assert.equal(mode.optional, false);
  assert.deepEqual(player.options, []);
  assert.equal(player.wantsPlayer, true);
  assert.equal(player.optional, true);
});

test('a bare word is a literal part of the command', () => {
  const [set, when] = parseUsageArgs('time set <day|night|noon|midnight>');
  assert.deepEqual(set.options, ['set']);
  assert.deepEqual(when.options, ['day', 'night', 'noon', 'midnight']);
});

test('free-form arguments offer nothing rather than guessing', () => {
  // `<item>` is the exception — see the item-ids test below.
  const [, , count] = parseUsageArgs('give <player> <item> [count]');
  assert.deepEqual(count.options, []);
  assert.equal(count.optional, true);

  const [x, y, z] = parseUsageArgs('setworldspawn [x] [y] [z]');
  for (const arg of [x, y, z]) {
    assert.deepEqual(arg.options, []);
    assert.equal(arg.wantsPlayer, false);
  }
});

test('player and target slots are filled from who is online', () => {
  assert.equal(parseUsageArgs('kill <target>')[0].wantsPlayer, true);
  assert.equal(parseUsageArgs('op <player>')[0].wantsPlayer, true);
  assert.equal(parseUsageArgs('summon <entity> [x] [y] [z]')[0].wantsPlayer, false);
});

test('an ellipsis offers nothing but still holds its place', () => {
  // Its position has to line up with the usage line the UI highlights.
  const args = parseUsageArgs('advancement <grant|revoke> <player> …');
  assert.equal(args.length, 3);
  assert.deepEqual(args[2].options, []);
  assert.deepEqual(parseUsageArgs('worldborder <set|add|center|…> …')[0].options, ['set', 'add', 'center']);
});

test('every catalog entry carries the arguments its usage describes', () => {
  const gamemode = COMMAND_CATALOG.find((entry) => entry.name === 'gamemode');
  assert.ok(gamemode);
  assert.deepEqual(gamemode.args[0].options, ['survival', 'creative', 'adventure', 'spectator']);
  // A command with no arguments has an empty list, never undefined.
  assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === 'seed')?.args, []);
});

test('a rejected argument is a failure, not ordinary output', () => {
  // The bug this covers: "Unknown item" fell through as success, so a command
  // that did nothing rendered exactly like one that worked.
  assert.equal(classifyOutput("Unknown item 'minecraft:diamond-hoe'"), 'bad-arguments');
  assert.equal(classifyOutput('No player was found'), 'bad-arguments');
  assert.equal(classifyOutput('Invalid name or UUID'), 'bad-arguments');
  // The caret marker means refused, whatever the wording before it.
  assert.equal(classifyOutput("Some mod's own complaint...give x<--[HERE]"), 'bad-arguments');
});

test('a missing command still outranks a bad argument', () => {
  assert.equal(classifyOutput('Unknown or incomplete command, see below for error...x<--[HERE]'), 'unknown-command');
});

test('splits a run-together parse error onto two lines', () => {
  const raw = "Unknown item 'minecraft:diamond-hoe'...lschranks minecraft:diamond-hoe<--[HERE]";
  assert.equal(
    formatServerOutput(raw, 'give Kuehlschranks minecraft:diamond-hoe'),
    "Unknown item 'minecraft:diamond-hoe'\n...lschranks minecraft:diamond-hoe<--[HERE]"
  );
});

test('splits it using the command when the echo was not truncated', () => {
  const raw = 'Unknown or incomplete command, see below for errorfoo bar<--[HERE]';
  assert.equal(
    formatServerOutput(raw, 'foo bar'),
    'Unknown or incomplete command, see below for error\nfoo bar<--[HERE]'
  );
});

test('leaves ordinary output alone', () => {
  assert.equal(formatServerOutput('Gave 64 [Diamond] to Alice', 'give Alice diamond 64'), 'Gave 64 [Diamond] to Alice');
  assert.equal(formatServerOutput('  Set the time to 1000  '), 'Set the time to 1000');
});

test('offers item ids for the slots that take one', () => {
  const [, item] = parseUsageArgs('give <player> <item> [count]');
  assert.ok(item.options.includes('diamond_hoe'), 'diamond_hoe should be offered');
  assert.ok(item.options.includes('netherite_pickaxe'));
  assert.ok(item.options.includes('enchanted_golden_apple'));
  // Underscores, material first — the shape people get wrong unaided.
  assert.ok(item.options.every((id) => !id.includes('-')), 'no item id uses a hyphen');
  // Still nothing for slots we genuinely cannot enumerate.
  assert.deepEqual(parseUsageArgs('summon <entity> [x] [y] [z]')[0].options, []);
});
