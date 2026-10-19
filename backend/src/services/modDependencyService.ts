import fs from 'fs/promises';
import path from 'path';
import { UserFacingError } from '../apiErrors';
import { logger } from '../logger';
import { detectModRuntime, matches, Mod, readMods, Requirement, Runtime } from './modMetadata';
import { Artifact, DependencySources } from './modDependencySources';

const BUILTINS = new Set(['minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'quilt_loader']);
type Addition = { artifact: Artifact; staged: string; mods: Mod[]; bytes: number };
export type DependencyResult = { installed: string[] };

function problem(message: string): never {
  throw new UserFacingError({
    error: 'Mod dependency check failed', code: 'MOD_DEPENDENCY_UNRESOLVED', status: 422,
    reason: message, details: `${message} Install the dependency manually in mods/ or correct the pack and try again. Existing mods were preserved.`,
  });
}

// Each downloaded JAR must satisfy *all* current requirements, not just the
// first mod that requested it. Backtracking handles new transitive constraints.
function nextMissing(mods: Mod[], runtime?: Runtime, strictFiles = new Set<string>()): Requirement[] | undefined {
  // Re-evaluate after each addition: installing Connector can enable Fabric
  // mods that were already present in the original Forge pack.
  if (runtime) {
    const connector = mods.some(m => m.loader === 'forge' && m.id === 'connectormod');
    mods = mods.filter(m => m.loader === runtime.loader || (connector && runtime.loader === 'forge' && m.loader === 'fabric'));
  }
  const disabled = mods.filter(m => m.serverDisabled);
  mods = mods.filter(m => !m.serverDisabled);
  const requirements = new Map<string, Requirement[]>();
  for (const mod of mods) {
    for (const conflict of mod.conflicts) {
      if (mods.some(m => m.id === conflict.id && (matches(m.version, conflict.range, conflict.kind) === true ||
          (matches(m.version, conflict.range, conflict.kind) === undefined && (strictFiles.has(m.file) || strictFiles.has(mod.file)))))) {
        throw new Error(`${mod.id} conflicts with ${conflict.id} ${JSON.stringify(conflict.range)}`);
      }
    }
    for (const req of mod.requirements) {
      // Fabric softens schema 0/1 dependencies when a matching version is
      // installed but disabled for this environment, and no active ID exists.
      // Keep absent modules and incompatible disabled versions unresolved.
      if (mod.loader === 'fabric' && (mod.schemaVersion ?? 0) < 2 &&
          !mods.some(m => m.id === req.id) &&
          disabled.some(m => m.id === req.id && matches(m.version, req.range, req.kind) === true)) continue;
      if (BUILTINS.has(req.id)) {
        const installed = req.id === 'minecraft' ? runtime?.minecraft : req.id === runtime?.loader || (req.id === 'fabricloader' && runtime?.loader === 'fabric') ? runtime?.loaderVersion : undefined;
        const match = installed ? matches(installed, req.range, req.kind) : undefined;
        if (installed && (match === false || (match === undefined && strictFiles.has(mod.file)))) throw new Error(`${req.owner} requires ${req.id} ${JSON.stringify(req.range)}; pack uses ${installed}`);
        continue;
      }
      requirements.set(req.id, [...(requirements.get(req.id) ?? []), req]);
    }
  }
  const missing: Requirement[][] = [];
  for (const [id, reqs] of requirements) {
    const installed = mods.filter(m => m.id === id);
    if (!installed.length) { missing.push(reqs); continue; }
    // Unknown installed version expressions are left to the loader. They are
    // never sufficient to validate a newly downloaded candidate below.
    if (!installed.some(m => reqs.every(r => {
      const result = matches(m.version, r.range, r.kind);
      return strictFiles.has(m.file) || mods.some(owner => owner.id === r.owner && strictFiles.has(owner.file)) ? result === true : result !== false;
    }))) {
      throw new Error(`${reqs.map(r => `${r.owner} requires ${id} ${JSON.stringify(r.range)}`).join('; ')}; installed: ${installed.map(m => m.version).join(', ')}. Automatic replacement of existing mods is disabled`);
    }
  }
  return missing[0];
}

export async function ensureModDependencies(root: string, sources = new DependencySources()): Promise<DependencyResult> {
  const modsDir = path.join(root, 'mods');
  let entries;
  try {
    const stat = await fs.lstat(modsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) problem('mods/ must be a regular directory');
    entries = await fs.readdir(modsDir, { withFileTypes: true });
  } catch (err: any) { if (err.code === 'ENOENT') return { installed: [] }; throw err; }
  const runtime = await detectModRuntime(root);
  let inventory: Mod[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
    const file = path.join(modsDir, entry.name);
    try { inventory.push(...readMods(await fs.readFile(file), file, runtime?.loader, true)); }
    catch (err: any) { problem(`Cannot inspect ${entry.name}: ${err.message}`); }
  }
  let missing: Requirement[] | undefined;
  try { missing = nextMissing(inventory, runtime); } catch (err: any) { problem(err.message); }
  if (!missing) return { installed: [] }; // Complete packs work offline.
  if (!runtime) problem(`Missing ${missing[0].id}, but Minecraft version and loader could not be determined from the pack`);

  logger.info({ root, runtime, dependency: missing[0].id }, 'Resolving missing mod dependencies');
  const stage = await fs.mkdtemp(path.join(root, '.mc-dash-dependencies-'));
  const committed: string[] = [];
  let attempts = 0;
  let stagedBytes = 0;
  const downloads = new Map<string, Promise<Addition>>();
  async function solve(mods: Mod[], additions: Addition[]): Promise<Addition[]> {
    if (additions.length > 64 || attempts > 150) throw new Error('Dependency resolution limit reached');
    const reqs = nextMissing(mods, runtime, new Set(additions.map(a => a.staged)));
    if (!reqs) return additions;
    const req = reqs[0];
    // Use the requesting mod's loader for Fabric dependencies under Connector.
    const parents = mods.filter(m => reqs.some(r => r.owner === m.id));
    const target = { ...runtime!, loader: parents[0]?.loader ?? runtime!.loader };
    const errors: string[] = [];
    for await (const artifact of sources.candidates(req, target, parents)) {
      if (++attempts > 150) throw new Error('Dependency resolution limit reached');
      try {
        if (entries.some(e => e.name === artifact.filename) || additions.some(a => a.artifact.filename === artifact.filename)) throw new Error(`File already exists: ${artifact.filename}`);
        let pending = downloads.get(artifact.url);
        if (!pending) {
          pending = (async () => {
            const buffer = await sources.download(artifact);
            stagedBytes += buffer.length;
            if (stagedBytes > 512 * 1024 * 1024) throw new Error('Total dependency download size limit exceeded');
            const staged = path.join(stage, String(downloads.size));
            const found = readMods(buffer, staged, target.loader, true);
            await fs.writeFile(staged, buffer, { flag: 'wx' });
            return { artifact, staged, mods: found, bytes: buffer.length };
          })();
          downloads.set(artifact.url, pending);
        }
        const candidate = await pending;
        if (!candidate.mods.some(m => !m.serverDisabled && !m.embedded && m.loader === target.loader && m.id === req.id && reqs.every(r => matches(m.version, r.range, r.kind) === true))) {
          throw new Error(`${artifact.filename} does not provide ${req.id} with the required version and loader`);
        }
        const duplicate = candidate.mods.find(m => !m.serverDisabled && !m.embedded && mods.some(old => !old.serverDisabled && !old.embedded && old.id === m.id));
        if (duplicate) {
          const existing = mods.find(old => !old.embedded && old.id === duplicate.id)!;
          throw new Error(`${artifact.filename} would introduce duplicate mod ID ${duplicate.id}; already provided by ${path.basename(existing.file)} (${existing.loader}, ${existing.version})`);
        }
        if (additions.reduce((sum, a) => sum + a.bytes, candidate.bytes) > 256 * 1024 * 1024) throw new Error('Dependency download size limit exceeded');
        return await solve([...mods, ...candidate.mods], [...additions, candidate]);
      } catch (err: any) { errors.push(err.message); }
    }
    const description = reqs.map(r => `${r.owner} requires ${r.id} ${JSON.stringify(r.range)}`).join('; ');
    const detail = errors.slice(-3).join('; ') || sources.errors.slice(-2).join('; ') || 'No compatible verified download found';
    const message = `${description} (${target.loader}, Minecraft ${target.minecraft}). ${detail}`;
    throw new Error(message);
  }

  try {
    const additions = await solve(inventory, []);
    for (const addition of additions) {
      const dest = path.join(modsDir, addition.artifact.filename);
      // Hard-link creation is atomic and refuses to overwrite existing files.
      await fs.link(addition.staged, dest);
      committed.push(dest);
    }
    const report = additions.map(a => ({ filename: a.artifact.filename, source: a.artifact.source, hashes: a.artifact.hashes, mods: a.mods.filter(m => !m.embedded).map(m => ({ id: m.id, version: m.version })) }));
    const reportPath = path.join(stage, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), runtime, installed: report }, null, 2) + '\n');
    await fs.rename(reportPath, path.join(root, '.mc-dash-dependencies.json'));
    logger.info({ root, installed: report }, 'Installed and verified missing mod dependencies');
    return { installed: additions.map(a => a.artifact.filename) };
  } catch (err: any) {
    await Promise.all(committed.map(file => fs.unlink(file)));
    problem(`${err.message}${process.env.CURSEFORGE_API_KEY ? '' : '. For additional CurseForge-only mods, configure CURSEFORGE_API_KEY'}`);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
