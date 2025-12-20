import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { logger } from '../logger';

const API_BASE = 'https://api.curseforge.com';

type CurseforgeFile = {
  id: number;
  displayName: string;
  fileDate: string;
  downloadUrl?: string;
  isServerPack?: boolean;
  serverPackFileId?: number;
};

type CurseforgeMod = {
  id: number;
  name: string;
};

type CurseforgeFileResponse = {
  id: number;
  displayName: string;
  fileDate: string;
  downloadUrl?: string;
  isServerPack?: boolean;
  serverPackFileId?: number;
};

async function apiFetch<T>(url: string): Promise<T> {
  if (!config.curseforgeApiKey) {
    throw new Error('CURSEFORGE_API_KEY is missing');
  }

  const res = await fetch(url, {
    headers: {
      'x-api-key': config.curseforgeApiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CurseForge API failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { data: T };
  return json.data;
}

export async function getMod(modId: number): Promise<CurseforgeMod> {
  return apiFetch<CurseforgeMod>(`${API_BASE}/v1/mods/${modId}`);
}

export async function getFiles(modId: number): Promise<CurseforgeFile[]> {
  return apiFetch<CurseforgeFile[]>(`${API_BASE}/v1/mods/${modId}/files`);
}

export async function getFile(modId: number, fileId: number): Promise<CurseforgeFileResponse> {
  return apiFetch<CurseforgeFileResponse>(`${API_BASE}/v1/mods/${modId}/files/${fileId}`);
}

export async function getServerPacks(modId: number): Promise<CurseforgeFile[]> {
  const files = await getFiles(modId);
  return files.filter((file) => file.isServerPack);
}

export async function resolveServerPack(modId: number, fileId?: number): Promise<CurseforgeFileResponse | null> {
  const files = await getFiles(modId);

  const pickServerPack = async (candidate: CurseforgeFile | undefined): Promise<CurseforgeFileResponse | null> => {
    if (!candidate) return null;
    if (candidate.isServerPack && candidate.downloadUrl) return candidate;
    if (candidate.serverPackFileId) {
      return getFile(modId, candidate.serverPackFileId);
    }
    if (candidate.isServerPack) {
      // Server pack but missing downloadUrl; fetch by ID to get the URL.
      return getFile(modId, candidate.id);
    }
    return null;
  };

  if (fileId) {
    const specific = files.find((f) => f.id === fileId);
    const resolved = await pickServerPack(specific);
    if (resolved) return resolved;
  }

  // Prefer the newest server pack
  const serverFiles = files.filter((f) => f.isServerPack || f.serverPackFileId);
  serverFiles.sort((a, b) => new Date(b.fileDate).getTime() - new Date(a.fileDate).getTime());

  for (const candidate of serverFiles) {
    const resolved = await pickServerPack(candidate);
    if (resolved) return resolved;
  }

  return null;
}

export async function downloadServerPack(url: string, destinationDir: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download server pack: ${res.statusText}`);
  }

  if (!fs.existsSync(destinationDir)) {
    fs.mkdirSync(destinationDir, { recursive: true });
  }

  const filename = path.basename(new URL(url).pathname) || 'server-pack.zip';
  const outputPath = path.join(destinationDir, filename);
  const fileStream = fs.createWriteStream(outputPath);
  await pipeline(res.body, fileStream);
  logger.info({ outputPath }, 'Downloaded server pack');
  return outputPath;
}
