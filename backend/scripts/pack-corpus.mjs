#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Real ZIP -> production HTTP API -> Docker -> ready -> stop -> ready again.
// Never targets an existing backend. Every invocation owns a new data directory.
import fs, { openAsBlob } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input || process.argv.includes('--help')) {
  console.log('Usage: node scripts/pack-corpus.mjs /directory/of/server-zips [maximum-count=100]');
  process.exit(input ? 0 : 1);
}
const corpus = path.resolve(input);
const limit = Number(process.argv[3] ?? 100);
if (!Number.isInteger(limit) || limit < 1) throw new Error('Count must be a positive integer');
await fsp.access(path.join(backend, 'dist/index.js'));
await fsp.mkdir(path.join(backend, 'data'), { recursive: true });
const root = await fsp.mkdtemp(path.join(backend, 'data', 'corpus-'));
const data = path.join(root, 'data');
await fsp.mkdir(data);
const timeoutMs = Number(process.env.CORPUS_TIMEOUT_MINUTES ?? 20) * 60000;
const maxRamMb = Number(process.env.CORPUS_RAM_MB ?? 6144);
if (!Number.isFinite(timeoutMs) || timeoutMs < 60000 || !Number.isInteger(maxRamMb) || maxRamMb < 1024) {
  throw new Error('Invalid CORPUS_TIMEOUT_MINUTES or CORPUS_RAM_MB');
}
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]}: ${result.stderr}`);
  return args[0] === 'logs' ? result.stdout + result.stderr : result.stdout;
};
const report = {
  startedAt: new Date().toISOString(), requested: limit, corpus,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { cwd: backend, encoding: 'utf8' }).trim(),
  docker: JSON.parse(docker('info', '--format', '{{json .}}')),
  maxRamMb, timeoutMs, memoryPool: false, results: [],
};
// Do not write daemon credentials/configuration into the report.
report.docker = { architecture: report.docker.Architecture, memoryBytes: report.docker.MemTotal, version: report.docker.ServerVersion };
async function save() {
  await fsp.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = report.results.map(result =>
    `| ${cell(result.file)} | ${result.outcome} | ${cell(result.failedStage ?? '')} | ${cell(result.error ?? '')} |`);
  await fsp.writeFile(path.join(root, 'report.md'), [
    '# Server-pack compatibility run', '',
    `Source: \`${report.commit}\`. Architecture: ${report.docker.architecture}. Memory setting: ${maxRamMb} MiB.`, '',
    `Attempted ${report.results.length} of up to ${limit} requested packs. ` +
      `${report.results.filter(result => result.outcome === 'passed').length} passed; ` +
      `${report.results.filter(result => result.outcome === 'failed').length} failed.`, '',
    'A pass requires two ready boots with RCON responses and a stop after each, without a rebuild.', '',
    '| Archive | Result | Failed stage | Error |', '| --- | --- | --- | --- |', ...rows, '',
    'See report.json for archive hashes, timings, runtime images and container state. Numbered directories contain logs.', '',
  ].join('\n'));
}
console.log(`Report directory: ${root}`);
await save();
const listener = net.createServer();
await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const logFd = fs.openSync(path.join(root, 'backend.log'), 'w');
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: backend, stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env, PORT: String(port), DATA_ROOT: data, SQLITE_PATH: path.join(data, 'mc-dash.sqlite'),
    MC_DASH_BIND_HOST: '127.0.0.1', MC_DASH_ALLOW_NO_AUTH: 'true', MC_DASH_PASSWORD: '',
    MC_ROUTER_ENABLED: 'false', MC_DASH_HIBERNATE: 'false', MC_DASH_MEMORY_POOL: 'false',
    MC_SERVER_PORT: '28565', MC_SERVER_PORT_MIN: '28565', MC_SERVER_PORT_MAX: '28665',
    MC_CONTAINER_USER: `${process.getuid()}:${process.getgid()}`, JAVA_IMAGE: 'eclipse-temurin:17-jre',
  },
});
fs.closeSync(logFd);
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, options = {}) {
  if (interrupted) throw new Error('Run interrupted');
  const response = await fetch(origin + route, { ...options, signal: AbortSignal.timeout(120000) });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${route}: ${JSON.stringify(body)}`);
  return body;
}
async function operation(id, action) {
  const job = await api(`/servers/${id}/${action}`, { method: 'POST', headers: { Prefer: 'respond-async' } });
  if (!job.statusUrl) throw new Error('Lifecycle operation did not return a job');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await api(job.statusUrl);
    if (status.status === 'failed') throw new Error(JSON.stringify(status.body));
    if (status.status === 'completed') return status.body;
    await sleep(2000);
  }
  // A timed-out preparation may still be mutating disk. Abort the batch instead
  // of deleting that server or competing with the in-flight operation.
  const error = new Error(`Operation ${action} timed out`);
  error.abortBatch = true;
  throw error;
}
async function ready(id, result, cycle) {
  const until = Date.now() + timeoutMs;
  let lastProgress = 0;
  let lastRconError;
  while (Date.now() < until) {
    const { status } = await api(`/servers/${id}/status`);
    if (Date.now() - lastProgress > 30000) {
      console.log(`${result.file}: ${cycle}: ${status}`);
      lastProgress = Date.now();
    }
    if (status === 'running') {
      // Require a new readiness line from this container start, not an old log
      // or merely Docker's Running flag. Then require a successful RCON command.
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', `mc-dash-${id}`));
      const logs = docker('logs', '--since', state.StartedAt, `mc-dash-${id}`);
      if (/Done \([0-9.,]+s\)!|Server ready/i.test(logs)) {
        try {
          const reply = await api(`/servers/${id}/console`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'list' }),
          });
          if (reply.status !== 'ok') throw new Error(`RCON: ${JSON.stringify(reply)}`);
          result[`rcon-${cycle}`] = reply.output;
          return;
        } catch (error) {
          // The RCON listener may open just after the ready message.
          lastRconError = error.message;
        }
      }
    }
    if (['exited', 'error', 'stopped'].includes(status)) throw new Error(`Server became ${status} before readiness`);
    await sleep(5000);
  }
  throw new Error(`Readiness timeout after ${timeoutMs / 60000} minutes${lastRconError ? `; ${lastRconError}` : ''}`);
}
let activeId;
try {
  for (let retry = 0; ; retry++) {
    try { await api('/health'); break; }
    catch (error) {
      if (retry >= 30 || child.exitCode !== null || interrupted) throw error;
      await sleep(1000);
    }
  }
  const tested = new Set();
  while (report.results.length < limit && !interrupted) {
    const names = (await fsp.readdir(corpus)).filter(name => /\.zip$/i.test(name)).sort();
    const file = names.find(name => !tested.has(name));
    if (!file) break;
    tested.add(file);
    const disk = await fsp.statfs(root);
    if (disk.bavail * disk.bsize < 20 * 1024 ** 3) throw new Error('Less than 20 GiB free disk: stopping batch');
    const result = { file, startedAt: new Date().toISOString(), stages: [], outcome: 'running' };
    report.results.push(result);
    const resultDir = path.join(root, String(report.results.length).padStart(3, '0'));
    await fsp.mkdir(resultDir);
    let phase = 'archive';
    let abortBatch = false;
    async function stage(name, fn) {
      phase = name;
      console.log(`${file}: ${name}`);
      const started = Date.now();
      const value = await fn();
      result.stages.push({ name, seconds: (Date.now() - started) / 1000, outcome: 'passed' });
      await save();
      return value;
    }
    try {
      const archive = path.join(corpus, file);
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
      result.sha256 = hash.digest('hex');
      result.bytes = (await fsp.stat(archive)).size;
      const form = new FormData();
      form.set('name', `Corpus ${report.results.length}: ${file}`);
      form.set('minRamMb', '1024'); form.set('maxRamMb', String(maxRamMb)); form.set('cpuLimit', '4');
      form.set('file', await openAsBlob(archive), file);
      const server = await stage('upload', () => api('/servers', { method: 'POST', body: form }));
      activeId = server.id;
      result.serverId = activeId;
      await stage('prepare', () => operation(activeId, 'prepare'));
      const prepared = await api(`/servers/${activeId}`);
      result.javaImage = prepared.effectiveJavaImage;
      result.containerId = docker('inspect', '--format', '{{.Id}}', `mc-dash-${activeId}`).trim();
      for (let cycle = 1; cycle <= 2; cycle++) {
        await stage(`start-${cycle}`, () => operation(activeId, 'start'));
        if (docker('inspect', '--format', '{{.Id}}', `mc-dash-${activeId}`).trim() !== result.containerId) {
          throw new Error('Start replaced the container; this is not a same-container restart pass');
        }
        await stage(`ready-${cycle}`, () => ready(activeId, result, cycle));
        await fsp.writeFile(path.join(resultDir, `boot-${cycle}.log`), docker('logs', `mc-dash-${activeId}`));
        await stage(`stop-${cycle}`, () => operation(activeId, 'stop'));
        const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', `mc-dash-${activeId}`));
        (result.shutdowns ??= []).push({ cycle, exitCode: state.ExitCode, oomKilled: state.OOMKilled });
        if (state.ExitCode !== 0 || state.OOMKilled) {
          (result.warnings ??= []).push(`Stop ${cycle}: exit ${state.ExitCode}, OOMKilled=${state.OOMKilled}; restart success does not prove a clean shutdown`);
        }
        if (state.Running) throw new Error('Stop completed but container is still running');
      }
      result.outcome = 'passed';
    } catch (error) {
      result.outcome = 'failed'; result.failedStage = phase; result.error = error.message;
      abortBatch = error.abortBatch === true;
      console.log(`${file}: FAILED at ${phase}: ${error.message}`);
    } finally {
      if (abortBatch || interrupted) child.kill('SIGKILL');
      if (activeId) {
        const container = `mc-dash-${activeId}`;
        try {
          const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', container));
          result.containerState = state;
          await fsp.writeFile(path.join(resultDir, 'container.log'), docker('logs', container));
        } catch (error) { result.captureError = error.message; }
        // Cleanup must still happen if log collection itself failed.
        try {
          const exists = docker('ps', '-aq', '--filter', `name=^/${container}$`).trim();
          if (exists) docker('rm', '-f', container);
        } catch (error) { result.cleanupError = error.message; abortBatch = true; }
        if (!abortBatch && !interrupted) {
          try { await api(`/servers/${activeId}`, { method: 'DELETE' }); }
          catch (error) { result.cleanupError = error.message; }
        }
        activeId = undefined;
      }
      result.finishedAt = new Date().toISOString();
      await save();
    }
    if (abortBatch) throw new Error('Aborting batch after lifecycle timeout or cleanup failure; see report');
  }
} catch (error) {
  report.batchError = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  report.pendingDownloads = (await fsp.readdir(corpus)).filter(name => name.endsWith('.part'));
  report.passed = report.results.filter(result => result.outcome === 'passed').length;
  report.failed = report.results.filter(result => result.outcome === 'failed').length;
  await save();
  console.log(`Tested ${report.results.length}/${limit}: ${report.passed} passed, ${report.failed} failed. Report: ${root}/report.json`);
  if (report.failed || interrupted) process.exitCode = 1;
}
