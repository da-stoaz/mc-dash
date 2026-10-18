import AdmZip from 'adm-zip';
import { parse } from '@iarna/toml';
import fs from 'fs/promises';
import path from 'path';

export type Loader = 'forge' | 'neoforge' | 'fabric';
export type Runtime = { minecraft: string; loader: Loader; loaderVersion?: string };
export type Requirement = { id: string; range: string | string[]; kind: 'maven' | 'fabric'; owner: string };
export type Mod = {
  id: string; version: string; requirements: Requirement[]; conflicts: Requirement[];
  file: string; loader: Loader; embedded: boolean;
};
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_NESTED = 256;

// Fabric uses a semver *superset*, not npm ranges: arbitrary numeric component
// counts, exact partial versions, empty prereleases, and ^0.x means <1.0-.
// https://wiki.fabricmc.net/documentation:fabric_mod_json_spec#versionrange
function fabricVersion(value: string) {
  const match = value.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]*))?(?:\+.*)?$/);
  return match ? { numbers: match[1].split('.').map(BigInt), pre: match[2] } : undefined;
}
function compareFabric(a: string, b: string): number | undefined {
  if (a === b) return 0;
  const aa = fabricVersion(a), bb = fabricVersion(b);
  if (!aa || !bb) return undefined;
  for (let i = 0; i < Math.max(aa.numbers.length, bb.numbers.length); i++) {
    const x = aa.numbers[i] ?? 0n, y = bb.numbers[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (aa.pre === bb.pre) return 0;
  if (aa.pre === undefined) return 1;
  if (bb.pre === undefined) return -1;
  if (aa.pre === '') return -1;
  if (bb.pre === '') return 1;
  const ap = aa.pre.split('.'), bp = bb.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) { const x = BigInt(ap[i]), y = BigInt(bp[i]); if (x !== y) return x > y ? 1 : -1; continue; }
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}
function matchesFabric(version: string, range: string): boolean | undefined {
  const results = range.split(/\s+/).map(token => {
    if (token === '*') return true;
    const predicate = token.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!predicate) return undefined;
    const op = predicate[1] ?? '=', reference = predicate[2];
    const wildcard = reference.match(/^(\d+(?:\.\d+)*)\.[xX*](?:\.[xX*])*$/);
    if (wildcard) {
      if (op !== '=') return undefined;
      const parsed = fabricVersion(version), prefix = wildcard[1].split('.').map(BigInt);
      return parsed ? prefix.every((v, i) => (parsed.numbers[i] ?? 0n) === v) : undefined;
    }
    const compared = compareFabric(version, reference);
    if (compared === undefined) return undefined;
    if (op === '=') return compared === 0;
    if (op === '>=') return compared >= 0;
    if (op === '<=') return compared <= 0;
    if (op === '>') return compared > 0;
    if (op === '<') return compared < 0;
    const base = fabricVersion(reference);
    if (!base) return undefined;
    const bound = op === '^' ? `${base.numbers[0] + 1n}-` : `${base.numbers[0]}.${(base.numbers[1] ?? 0n) + 1n}-`;
    return compared >= 0 && compareFabric(version, bound)! < 0;
  });
  return results.includes(false) ? false : results.includes(undefined) ? undefined : true;
}

// Support numeric Maven versions and the common dotted qualifier form used by
// Connector (1.0.0-beta.18+1.20.1). Other Maven syntax stays unknown rather than
// being interpreted as semver: Maven does not discard the suffix after '+'.
function compareMaven(a: string, b: string): number | undefined {
  if (a === b) return 0;
  const parseVersion = (value: string) => value.toLowerCase().match(/^(\d+(?:\.\d+)*)(?:-(alpha|beta|milestone|rc|snapshot|sp)(?:\.(\d+))?)?(\+[0-9a-z.-]+)?$/);
  const aa = parseVersion(a), bb = parseVersion(b);
  if (!aa || !bb) return undefined;
  if ([aa, bb].some(v => v[2] && !v[3] && v[4])) return undefined;
  const an = aa[1].split('.').map(BigInt), bn = bb[1].split('.').map(BigInt);
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    if ((an[i] ?? 0n) !== (bn[i] ?? 0n)) return (an[i] ?? 0n) > (bn[i] ?? 0n) ? 1 : -1;
  }
  const qualifiers = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
  const aq = qualifiers.indexOf(aa[2] ?? ''), bq = qualifiers.indexOf(bb[2] ?? '');
  // A '+' suffix immediately after a numeric release is an unknown Maven
  // qualifier, which sorts after the known qualifiers, including 'sp'.
  const ar = !aa[2] && aa[4] ? qualifiers.length : aq;
  const br = !bb[2] && bb[4] ? qualifiers.length : bq;
  if (ar !== br) return ar > br ? 1 : -1;
  const ap = BigInt(aa[3] ?? '0'), bp = BigInt(bb[3] ?? '0');
  if (ap !== bp) return ap > bp ? 1 : -1;
  if (aa[4] === bb[4]) return 0;
  // An extra unknown qualifier sorts after the same version without it.
  if (!aa[4] || !bb[4]) return aa[4] ? 1 : -1;
  return undefined;
}

// Undefined means the loader has a version syntax we cannot confidently compare.
// Never treat an unknown comparison as permission to install a downloaded JAR.
export function matches(version: string, range: string | string[], kind: Requirement['kind']): boolean | undefined {
  if (Array.isArray(range)) {
    const results = range.map(r => matches(version, r, kind));
    return results.includes(true) ? true : results.includes(undefined) ? undefined : false;
  }
  range = range.trim();
  if (!range || range === '*' || range === '(,)') return true;
  if (kind === 'fabric') {
    return matchesFabric(version, range);
  }
  range = range.replace(/\s/g, '');
  const intervals = range.match(/[[(][^\[\]()]*[\])]/g);
  // Maven's unbracketed version is a recommendation, not a hard restriction.
  if (!intervals) return /^[^\[\]()]+$/.test(range) ? true : undefined;
  if (intervals.join(',') !== range.replace(/\s/g, '')) return undefined;
  const results = intervals.map(interval => {
    const parts = interval.slice(1, -1).split(',').map(s => s.trim());
    if (parts.length === 1) {
      const result = compareMaven(version, parts[0]);
      return interval.startsWith('[') && interval.endsWith(']') && result !== undefined ? result === 0 : undefined;
    }
    const low = parts[0] ? compareMaven(version, parts[0]) : 1;
    const high = parts[1] ? compareMaven(version, parts[1]) : -1;
    if (low === undefined || high === undefined) return undefined;
    return (low > 0 || (low === 0 && interval[0] === '[')) && (high < 0 || (high === 0 && interval.endsWith(']')));
  });
  return results.includes(true) ? true : results.includes(undefined) ? undefined : false;
}

export function readMods(buffer: Buffer, file: string, preferred?: Loader): Mod[] {
  let nestedCount = 0;
  function read(data: Buffer, label: string, embedded: boolean, depth: number): Mod[] {
    if (depth > 8 || ++nestedCount > MAX_NESTED) throw new Error(`Too many embedded JARs in ${file}`);
    const zip = new AdmZip(data);
    function text(name: string): string | undefined {
      const entry = zip.getEntry(name);
      if (!entry) return undefined;
      if (entry.header.size > MAX_METADATA) throw new Error(`Oversized ${name} in ${label}`);
      return entry.getData().toString('utf8');
    }
    const mods: Mod[] = [];
    const nested = new Map<string, boolean>();
    // Manifest attributes may wrap onto continuation lines. Only the main
    // section describes this JAR; named entry sections must not override it.
    const manifest = (text('META-INF/MANIFEST.MF') ?? '').replace(/\r?\n /g, '').split(/\r?\n\r?\n/)[0];
    const neo = text('META-INF/neoforge.mods.toml');
    const forge = text('META-INF/mods.toml');
    const fabric = text('fabric.mod.json');
    if ((neo || forge) && !(preferred === 'fabric' && fabric)) {
      const meta = parse(neo ?? forge!) as any;
      if (meta.clientSideOnly === true) return [];
      const loader: Loader = neo ? 'neoforge' : 'forge';
      const implementation = manifest.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
      for (const mod of meta.mods ?? []) {
        if (typeof mod.modId !== 'string') continue;
        const reqs: Requirement[] = [], conflicts: Requirement[] = [];
        for (const dep of meta.dependencies?.[mod.modId] ?? []) {
          if (String(dep.side).toUpperCase() === 'CLIENT') continue;
          const req = { id: dep.modId, range: dep.versionRange ?? '*', kind: 'maven' as const, owner: mod.modId };
          if (dep.mandatory === true || dep.type === 'required') reqs.push(req);
          if (dep.type === 'incompatible') conflicts.push(req);
        }
        mods.push({ id: mod.modId, version: String(mod.version ?? '').replace('${file.jarVersion}', implementation ?? '${file.jarVersion}'), requirements: reqs, conflicts, file, loader, embedded });
      }
    } else if (fabric) {
      const meta = JSON.parse(fabric);
      if (meta.environment === 'client' || (Array.isArray(meta.environment) && !meta.environment.some((e: string) => e === '*' || e === 'server'))) return [];
      const requirements = (deps: Record<string, string | string[]> = {}) => Object.entries(deps).map(([id, range]) => ({ id, range, kind: 'fabric' as const, owner: meta.id }));
      if (typeof meta.id === 'string') {
        mods.push({ id: meta.id, version: String(meta.version), requirements: requirements(meta.depends), conflicts: requirements(meta.breaks), file, loader: 'fabric', embedded });
        for (const id of meta.provides ?? []) mods.push({ id, version: String(meta.version), requirements: [], conflicts: [], file, loader: 'fabric', embedded });
      }
      for (const jar of meta.jars ?? []) nested.set(jar.file, true);
    }
    if (((neo || forge) && !(preferred === 'fabric' && fabric)) || !fabric) {
      const jarjar = text('META-INF/jarjar/metadata.json');
      if (jarjar) for (const jar of JSON.parse(jarjar).jars ?? []) nested.set(jar.path, true);
      // Connector is a service wrapper: its primary mod is declared here,
      // outside standard jarjar metadata, and can itself bundle libraries.
      const payload = manifest.match(/^Embedded-Dependencies-Mod:\s*(.+)$/mi)?.[1]?.trim();
      if (payload) nested.set(payload, embedded);
    }
    for (const [name, nestedEmbedded] of nested) {
      const entry = zip.getEntry(name);
      if (!entry || entry.header.size > 128 * 1024 * 1024) throw new Error(`Missing or oversized embedded JAR ${name} in ${label}`);
      mods.push(...read(entry.getData(), `${label}!/${name}`, nestedEmbedded, depth + 1));
    }
    return mods;
  }
  return read(buffer, file, false, 0);
}

async function optionalText(file: string) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (err: any) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined; throw err; }
}

export async function detectModRuntime(root: string): Promise<Runtime | undefined> {
  // Installed Forge args are authoritative after the pack's first launch.
  for (const [loader, lib] of [['neoforge', 'net/neoforged/neoforge'], ['forge', 'net/minecraftforge/forge']] as const) {
    const dir = path.join(root, 'libraries', lib);
    let versions: string[] = [];
    try { versions = await fs.readdir(dir); } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
    if (versions.length === 1) {
      const args = await optionalText(path.join(dir, versions[0], 'unix_args.txt'));
      const minecraft = args?.match(/--fml\.mcVersion\s+["']?([^\s"']+)/)?.[1] ?? (loader === 'forge' ? versions[0].split('-')[0] : undefined);
      if (minecraft) return { minecraft, loader, loaderVersion: loader === 'forge' ? versions[0].split('-')[1] : versions[0] };
    }
  }
  for (const dir of [root, path.dirname(root)]) {
    const vars = await optionalText(path.join(dir, 'variables.txt'));
    if (vars) {
      const value = (key: string) => vars.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?([^\\s"'#]+)`, 'mi'))?.[1];
      const loader = value('MODLOADER')?.toLowerCase();
      const minecraft = value('MINECRAFT_VERSION');
      if (minecraft && (loader === 'forge' || loader === 'neoforge' || loader === 'fabric')) return { minecraft, loader, loaderVersion: value('MODLOADER_VERSION') };
    }
    const manifest = await optionalText(path.join(dir, 'manifest.json'));
    if (manifest) {
      const mc = JSON.parse(manifest).minecraft;
      const id = mc?.modLoaders?.find((l: any) => l.primary)?.id ?? mc?.modLoaders?.[0]?.id;
      const match = id?.match(/^(forge|neoforge|fabric)-(.+)$/);
      if (mc?.version && match) return { minecraft: mc.version, loader: match[1], loaderVersion: match[2] };
    }
    const index = await optionalText(path.join(dir, 'modrinth.index.json'));
    if (index) {
      const deps = JSON.parse(index).dependencies ?? {};
      for (const [key, loader] of [['forge', 'forge'], ['neoforge', 'neoforge'], ['fabric-loader', 'fabric']] as const) {
        if (deps.minecraft && deps[key]) return { minecraft: deps.minecraft, loader, loaderVersion: deps[key] };
      }
    }
  }
  const launcher = await optionalText(path.join(root, 'fabric-server-launcher.properties'));
  const fabric = launcher?.match(/fabric-server-mc\.([\w.+-]+)-loader\.([\w.+-]+)-launcher\./);
  if (fabric) return { minecraft: fabric[1], loader: 'fabric', loaderVersion: fabric[2] };
  return undefined;
}
