/**
 * What the console knows about Minecraft commands.
 *
 * Two jobs: offer the standard commands with their argument shapes so the UI
 * can complete them, and recognise a server saying "I don't have that command"
 * so a typo is reported as a failure instead of looking like it worked.
 *
 * The catalog is vanilla only, and deliberately not treated as the whole truth:
 * modpacks add commands of their own, so an unlisted verb is allowed through
 * and judged by the server's answer (see consoleService).
 */

export type CommandArg = {
  /** As written in the usage, e.g. `<player>`, `[count]`, `set`. */
  label: string;
  /** Values worth offering. Empty when the argument is free-form. */
  options: string[];
  /** Fill this one from whoever is online rather than a fixed list. */
  wantsPlayer: boolean;
  optional: boolean;
};

export type CatalogCommand = {
  name: string;
  usage: string;
  summary: string;
  args: CommandArg[];
};

/** A usage entry before its arguments have been worked out. */
type CatalogSeed = Omit<CatalogCommand, 'args'>;

/**
 * Read a command's arguments off its usage line, so the usage string stays the
 * single place each command is described.
 *
 * `<a|b|c>` and `(a|b|c)` enumerate the values an argument accepts; a bare word
 * is a literal that has to be typed as-is (`time set …`); `<player>` and
 * `<target>` are filled from who is online; anything else is free-form.
 */
export function parseUsageArgs(usage: string): CommandArg[] {
  const tokens = usage.trim().split(/\s+/).slice(1);

  return tokens
    .map((token) => {
      // Kept rather than dropped so an argument's position in this list always
      // matches its position in the usage line the UI highlights.
      if (token === '…' || token === '...') {
        return { label: token, options: [], wantsPlayer: false, optional: true };
      }

      const optional = token.startsWith('[');
      const wrapped = /^[[<(].*[\]>)]$/.test(token);
      const inner = wrapped ? token.slice(1, -1) : token;

      if (inner.includes('|')) {
        return {
          label: token,
          // An ellipsis inside a group stands for "and more", not a value.
          options: inner
            .split('|')
            .map((option) => option.trim())
            .filter((option) => option && option !== '…' && option !== '...'),
          wantsPlayer: false,
          optional,
        };
      }

      // Unwrapped words are literal parts of the command, not placeholders.
      if (!wrapped) {
        return { label: token, options: [token], wantsPlayer: false, optional };
      }

      return { label: token, options: [], wantsPlayer: /player|target/i.test(inner), optional };
    });
}

// The commands worth completing: the ones an operator actually reaches for,
// with the argument order spelled out so the shape is right on the first try.
const CATALOG_SEEDS: CatalogSeed[] = [
  { name: 'give', usage: 'give <player> <item> [count]', summary: 'Put an item in a player’s inventory' },
  { name: 'tp', usage: 'tp <player> <x> <y> <z>', summary: 'Teleport to coordinates or another player' },
  { name: 'teleport', usage: 'teleport <target> <destination>', summary: 'Teleport an entity or player' },
  { name: 'kill', usage: 'kill <target>', summary: 'Kill players or entities' },
  { name: 'gamemode', usage: 'gamemode <survival|creative|adventure|spectator> [player]', summary: 'Change a player’s game mode' },
  { name: 'defaultgamemode', usage: 'defaultgamemode <survival|creative|adventure|spectator>', summary: 'Game mode for players joining the first time' },
  { name: 'time', usage: 'time set <day|night|noon|midnight>', summary: 'Set or add to the world time' },
  { name: 'weather', usage: 'weather <clear|rain|thunder> [duration]', summary: 'Change the weather' },
  { name: 'difficulty', usage: 'difficulty <peaceful|easy|normal|hard>', summary: 'Set the world difficulty' },
  { name: 'gamerule', usage: 'gamerule <rule> [value]', summary: 'Read or set a game rule' },
  { name: 'effect', usage: 'effect give <target> <effect> [seconds] [amplifier]', summary: 'Apply or clear status effects' },
  { name: 'enchant', usage: 'enchant <player> <enchantment> [level]', summary: 'Enchant the held item' },
  { name: 'xp', usage: 'xp add <player> <amount> [points|levels]', summary: 'Grant or query experience' },
  { name: 'experience', usage: 'experience add <player> <amount>', summary: 'Grant or query experience' },
  { name: 'summon', usage: 'summon <entity> [x] [y] [z]', summary: 'Spawn an entity' },
  { name: 'clear', usage: 'clear [player] [item] [count]', summary: 'Clear items from an inventory' },
  { name: 'setblock', usage: 'setblock <x> <y> <z> <block>', summary: 'Place a single block' },
  { name: 'fill', usage: 'fill <x1> <y1> <z1> <x2> <y2> <z2> <block>', summary: 'Fill a region with a block' },
  { name: 'setworldspawn', usage: 'setworldspawn [x] [y] [z]', summary: 'Set the world spawn point' },
  { name: 'spawnpoint', usage: 'spawnpoint [player] [x] [y] [z]', summary: 'Set a player’s spawn point' },
  { name: 'op', usage: 'op <player>', summary: 'Grant operator status' },
  { name: 'deop', usage: 'deop <player>', summary: 'Revoke operator status' },
  { name: 'kick', usage: 'kick <player> [reason]', summary: 'Disconnect a player' },
  { name: 'ban', usage: 'ban <player> [reason]', summary: 'Ban a player' },
  { name: 'pardon', usage: 'pardon <player>', summary: 'Unban a player' },
  { name: 'banlist', usage: 'banlist [players|ips]', summary: 'Show the ban list' },
  { name: 'whitelist', usage: 'whitelist <on|off|add|remove|list|reload> [player]', summary: 'Manage the whitelist' },
  { name: 'list', usage: 'list [uuids]', summary: 'Show who is online' },
  { name: 'say', usage: 'say <message>', summary: 'Broadcast a message to everyone' },
  { name: 'tell', usage: 'tell <player> <message>', summary: 'Send a private message' },
  { name: 'msg', usage: 'msg <player> <message>', summary: 'Send a private message' },
  { name: 'tellraw', usage: 'tellraw <player> <json>', summary: 'Send a formatted message' },
  { name: 'title', usage: 'title <player> title <json>', summary: 'Show a title on screen' },
  { name: 'me', usage: 'me <action>', summary: 'Broadcast an action message' },
  { name: 'seed', usage: 'seed', summary: 'Show the world seed' },
  { name: 'save-all', usage: 'save-all [flush]', summary: 'Write the world to disk' },
  { name: 'save-off', usage: 'save-off', summary: 'Pause automatic saving' },
  { name: 'save-on', usage: 'save-on', summary: 'Resume automatic saving' },
  { name: 'stop', usage: 'stop', summary: 'Shut the server down' },
  { name: 'reload', usage: 'reload', summary: 'Reload datapacks and loot tables' },
  { name: 'scoreboard', usage: 'scoreboard <objectives|players> …', summary: 'Manage scoreboards' },
  { name: 'team', usage: 'team <add|join|leave|list|modify|remove> …', summary: 'Manage teams' },
  { name: 'tag', usage: 'tag <target> <add|list|remove> [name]', summary: 'Manage entity tags' },
  { name: 'execute', usage: 'execute <subcommand> … run <command>', summary: 'Run a command in another context' },
  { name: 'locate', usage: 'locate <structure|biome|poi> <id>', summary: 'Find the nearest structure or biome' },
  { name: 'particle', usage: 'particle <name> [x] [y] [z]', summary: 'Spawn particles' },
  { name: 'playsound', usage: 'playsound <sound> <source> <player>', summary: 'Play a sound' },
  { name: 'stopsound', usage: 'stopsound <player> [source] [sound]', summary: 'Stop a playing sound' },
  { name: 'spreadplayers', usage: 'spreadplayers <x> <z> <spread> <max> <respectTeams> <targets>', summary: 'Scatter entities' },
  { name: 'worldborder', usage: 'worldborder <set|add|center|…> …', summary: 'Manage the world border' },
  { name: 'forceload', usage: 'forceload <add|remove|query> …', summary: 'Keep chunks loaded' },
  { name: 'datapack', usage: 'datapack <list|enable|disable> …', summary: 'Manage datapacks' },
  { name: 'data', usage: 'data <get|merge|modify|remove> …', summary: 'Read or edit entity/block NBT' },
  { name: 'item', usage: 'item <modify|replace> …', summary: 'Modify or replace items' },
  { name: 'loot', usage: 'loot <give|insert|replace|spawn> …', summary: 'Drop or grant loot table results' },
  { name: 'advancement', usage: 'advancement <grant|revoke> <player> …', summary: 'Grant or revoke advancements' },
  { name: 'attribute', usage: 'attribute <target> <attribute> …', summary: 'Read or modify entity attributes' },
  { name: 'setidletimeout', usage: 'setidletimeout <minutes>', summary: 'Kick players after idling' },
  { name: 'help', usage: 'help [command]', summary: 'List the commands this server has' },
];

// The catalog proper: each entry with its arguments worked out from its usage.
export const COMMAND_CATALOG: CatalogCommand[] = CATALOG_SEEDS.map((seed) => ({
  ...seed,
  args: parseUsageArgs(seed.usage),
}));

// Every vanilla command name, including the ones not worth completing. Used
// only to answer "is this a real command?", never to refuse one outright.
const EXTRA_VANILLA = [
  'ban-ip',
  'bossbar',
  'clone',
  'damage',
  'debug',
  'fillbiome',
  'function',
  'jfr',
  'pardon-ip',
  'perf',
  'place',
  'publish',
  'random',
  'recipe',
  'return',
  'ride',
  'rotate',
  'schedule',
  'spectate',
  'teammsg',
  'tick',
  'tm',
  'transfer',
  'trigger',
  'w',
];

export const VANILLA_COMMANDS: ReadonlySet<string> = new Set([
  ...COMMAND_CATALOG.map((entry) => entry.name),
  ...EXTRA_VANILLA,
]);

/** The first word of a command, lowercased — the part that names it. */
export function verbOf(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * How the server reports a command it doesn't have. Minecraft answers an
 * unrecognised command with "Unknown or incomplete command…"; a real command
 * used wrongly gets "Incorrect argument…" or "Expected…". Both are failures
 * worth flagging, but only the first means the command doesn't exist.
 */
export function classifyOutput(output: string): 'ok' | 'unknown-command' | 'bad-arguments' {
  const text = output.trim();
  if (!text) return 'ok';
  if (/^unknown (or incomplete )?command/i.test(text)) return 'unknown-command';
  if (/^unknown function/i.test(text)) return 'unknown-command';
  if (/^incorrect argument/i.test(text) || /^expected /i.test(text)) return 'bad-arguments';
  return 'ok';
}

function editDistance(a: string, b: string): number {
  // Classic Levenshtein over two rolling rows; the strings here are one word.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The command the user most likely meant, or null when nothing is close
 * enough to be worth suggesting.
 */
export function suggestCommand(verb: string, extra: Iterable<string> = []): string | null {
  const target = verb.trim().toLowerCase();
  if (!target) return null;

  const candidates = new Set<string>([...VANILLA_COMMANDS, ...extra]);
  // Anything more than a couple of edits away is a different word, not a typo.
  const limit = target.length <= 4 ? 1 : 2;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === target) return null;
    const distance = editDistance(target, candidate);
    if (distance < bestDistance && distance <= limit) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
