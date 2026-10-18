import crypto from 'crypto';
import fs from 'fs/promises';
import { Mod, Requirement, Runtime } from './modMetadata';

export type Artifact = {
  filename: string; url: string; hashes: { sha512?: string; sha1?: string }; size?: number;
  source: string;
};
type Version = {
  id: string; project_id: string; game_versions: string[]; loaders: string[]; version_type: string;
  environment?: string; files: Array<Artifact & { primary?: boolean }>;
  dependencies: Array<{ dependency_type: string; project_id?: string; version_id?: string }>;
};
const MAX_DOWNLOAD = 128 * 1024 * 1024;
const API = 'https://api.modrinth.com/v2';
const CURSE = 'https://api.curseforge.com/v1';
const HOSTS = new Set(['api.modrinth.com', 'cdn.modrinth.com', 'api.curseforge.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net']);

// A verified fallback for the reported crash, independent of API availability
// or a CurseForge API key. Original publisher file (not a re-hosted copy):
// https://www.curseforge.com/minecraft/mc-mods/nightlib/files/8940234
const KNOWN: Record<string, { runtime: Runtime; artifact: Artifact }> = {
  nightlib: {
    runtime: { minecraft: '1.20.1', loader: 'forge' },
    artifact: {
      filename: 'NightLib-Forge-1.20.1-1.3.0.jar',
      url: 'https://edge.forgecdn.net/files/8940/234/NightLib-Forge-1.20.1-1.3.0.jar',
      hashes: { sha1: '46f7ade7b8aae688fdfdc7fa05ea6ba214f8d4c8' },
      source: 'CurseForge:1704376/8940234',
    },
  },
};

export class DependencySources {
  readonly errors: string[] = [];
  private cache = new Map<string, Promise<any>>();
  private requests = 0;
  private deadline = Date.now() + 180_000;
  constructor(private request: typeof fetch = fetch, private curseKey = process.env.CURSEFORGE_API_KEY) {}

  private async bytes(url: string, max: number, headers: Record<string, string> = {}): Promise<Buffer | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let current = new URL(url);
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (++this.requests > 250 || Date.now() > this.deadline) throw new Error('Dependency lookup time/request limit exceeded');
          if (current.protocol !== 'https:' || !HOSTS.has(current.hostname) || current.port || current.username || current.password) throw new Error('Untrusted dependency download URL');
          response = await this.request(current.toString(), {
            headers: { 'User-Agent': 'mc-dash/1.0 (Minecraft server dependency repair)', ...(current.origin === new URL(url).origin ? headers : {}) },
            redirect: 'manual', signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, this.deadline - Date.now()))),
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === 5) throw new Error('Invalid dependency download redirect');
          current = new URL(location, current);
        }
        if (!response) throw new Error('Dependency request failed');
        if (response.status === 404) return undefined;
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await response.body?.cancel();
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(250 * (attempt + 1), Number(response.headers.get('retry-after') ?? 0) * 1000))));
            continue;
          }
          throw new Error(`HTTP ${response.status} from ${current.hostname}`);
        }
        if (Number(response.headers.get('content-length') ?? 0) > max) { await response.body?.cancel(); throw new Error('Dependency response too large'); }
        const chunks: Buffer[] = [];
        let size = 0;
        if (response.body) {
          for await (const chunk of response.body as any) {
            size += chunk.length;
            if (size > max) throw new Error('Dependency response too large');
            chunks.push(Buffer.from(chunk));
          }
        }
        return Buffer.concat(chunks);
      } catch (err: any) {
        if (attempt === 2 || /Untrusted|too large|limit exceeded|HTTP [34]/.test(err.message)) throw err;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw new Error('Dependency request failed');
  }

  private json(url: string): Promise<any> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.bytes(url, 16 * 1024 * 1024, url.startsWith(CURSE) && this.curseKey ? { 'x-api-key': this.curseKey } : {})
        .then(data => data ? JSON.parse(data.toString('utf8')) : undefined)
        .catch(err => { this.errors.push(err.message); return undefined; });
      this.cache.set(url, pending);
    }
    return pending;
  }

  async download(artifact: Artifact): Promise<Buffer> {
    if (!/^[^/\\\x00-\x1f]+\.jar$/i.test(artifact.filename) || artifact.filename.includes('..')) throw new Error('Unsafe dependency filename');
    const algorithm = artifact.hashes.sha512 ? 'sha512' : 'sha1';
    const expected = artifact.hashes[algorithm];
    if (!expected || !new RegExp(`^[a-f0-9]{${algorithm === 'sha512' ? 128 : 40}}$`, 'i').test(expected)) throw new Error('Dependency has no verifiable checksum');
    const data = await this.bytes(artifact.url, MAX_DOWNLOAD);
    if (!data) throw new Error(`Download unavailable: ${artifact.filename}`);
    if (artifact.size !== undefined && artifact.size !== data.length) throw new Error(`Size mismatch: ${artifact.filename}`);
    if (crypto.createHash(algorithm).update(data).digest('hex') !== expected.toLowerCase()) throw new Error(`Checksum mismatch: ${artifact.filename}`);
    return data;
  }

  async *candidates(requirement: Requirement, runtime: Runtime, parents: Mod[]): AsyncGenerator<Artifact> {
    const known = KNOWN[requirement.id];
    if (known && known.runtime.loader === runtime.loader && known.runtime.minecraft === runtime.minecraft) yield known.artifact;
    const seen = new Set<string>();
    const compatible = (version: Version) => version.game_versions?.includes(runtime.minecraft) && version.loaders?.includes(runtime.loader) && !['client_only', 'singleplayer_only'].includes(version.environment ?? '');
    async function* files(versions: Version[]) {
      // Stable releases first, preserving the provider's newest-first order.
      for (const version of [...versions].sort((a, b) => Number(b.version_type === 'release') - Number(a.version_type === 'release'))) {
        if (!compatible(version)) continue;
        for (const file of [...(version.files ?? [])].sort((a, b) => Number(!!b.primary) - Number(!!a.primary))) {
          if (!file.filename?.endsWith('.jar') || /-(sources|javadoc|dev)\.jar$/.test(file.filename) || seen.has(file.url)) continue;
          seen.add(file.url);
          yield { ...file, source: `Modrinth:${version.project_id}/${version.id}` };
        }
      }
    }
    const projects = new Set<string>();
    // Exact hash of the requiring mod identifies upstream dependency projects
    // even when the dependency's mod ID differs from its project slug.
    for (const parent of parents) {
      const bytes = await fs.readFile(parent.file);
      const hash = crypto.createHash('sha1').update(bytes).digest('hex');
      const version: Version | undefined = await this.json(`${API}/version_file/${hash}?algorithm=sha1`);
      for (const dep of version?.dependencies ?? []) {
        if (dep.dependency_type !== 'required') continue;
        if (dep.version_id) {
          const pinned = await this.json(`${API}/version/${encodeURIComponent(dep.version_id)}`);
          if (pinned) yield* files([pinned]);
        }
        if (dep.project_id) projects.add(dep.project_id);
      }
    }
    projects.add(requirement.id);
    const query = new URLSearchParams({ game_versions: JSON.stringify([runtime.minecraft]), loaders: JSON.stringify([runtime.loader]), include_changelog: 'false' });
    for (const project of projects) {
      const versions = await this.json(`${API}/project/${encodeURIComponent(project)}/version?${query}`);
      if (Array.isArray(versions)) yield* files(versions);
    }
    const search = new URLSearchParams({ query: requirement.id.replace(/[_-]/g, ' '), limit: '5', facets: JSON.stringify([['project_type:mod'], [`versions:${runtime.minecraft}`], [`categories:${runtime.loader}`]]) });
    const hits = await this.json(`${API}/search?${search}`);
    for (const hit of hits?.hits ?? []) {
      if (projects.has(hit.project_id)) continue;
      const versions = await this.json(`${API}/project/${encodeURIComponent(hit.project_id)}/version?${query}`);
      if (Array.isArray(versions)) yield* files(versions);
    }
    if (!this.curseKey) return;
    const loaderType = { forge: 1, fabric: 4, neoforge: 6 }[runtime.loader];
    const curseQuery = new URLSearchParams({ gameId: '432', classId: '6', searchFilter: requirement.id.replace(/[_-]/g, ' '), gameVersion: runtime.minecraft, modLoaderType: String(loaderType), pageSize: '5' });
    const mods = await this.json(`${CURSE}/mods/search?${curseQuery}`);
    for (const project of mods?.data ?? []) {
      for (let index = 0; index < 150; index += 50) {
        const query = new URLSearchParams({ gameVersion: runtime.minecraft, modLoaderType: String(loaderType), pageSize: '50', index: String(index) });
        const page = await this.json(`${CURSE}/mods/${project.id}/files?${query}`);
        for (const file of page?.data ?? []) {
          if (!file.downloadUrl || !file.gameVersions?.includes(runtime.minecraft) || !file.gameVersions?.some((v: string) => v.toLowerCase() === runtime.loader)) continue;
          const sha1 = file.hashes?.find((h: any) => h.algo === 1)?.value;
          yield { filename: file.fileName, url: file.downloadUrl, hashes: { sha1 }, size: file.fileLength, source: `CurseForge:${project.id}/${file.id}` };
        }
        if ((page?.data?.length ?? 0) < 50) break;
      }
    }
  }
}
