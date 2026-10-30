// Explicit opt-in: build `docker build --target jattach -t mc-dash-jattach:inspection-check backend`
// then npm run test:jvm-integration (DOCKER_SOCKET may select a local daemon).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import Docker from 'dockerode';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-jvm-integration-'));
process.env.DATA_ROOT = root; process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { DockerService } = require('./dockerService');
const { db } = require('../db');
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('real JDK and JRE diagnostics, including unsupported attach', { timeout: 120000 }, async t => {
  fs.chmodSync(root, 0o777);
  fs.writeFileSync(path.join(root, 'Probe.java'), 'class Probe { public static void main(String[] args) throws Exception { System.out.println("PROBE_READY"); Thread.sleep(60000); } }');
  const compiler = await docker.createContainer({ Image: 'eclipse-temurin:17-jdk', User: '1000:1000', Cmd: ['javac', '/probe/Probe.java'], HostConfig: { NetworkMode: 'none', Binds: [`${root}:/probe`] } });
  try { await compiler.start(); assert.equal((await compiler.wait()).StatusCode, 0); }
  finally { await compiler.remove({ force: true }); }
  const tools = await docker.createContainer({ Image: 'mc-dash-jattach:inspection-check', Cmd: ['true'] });
  try { await pipeline(await tools.getArchive({ path: '/jattach' }), tar.x({ cwd: root })); }
  finally { await tools.remove({ force: true }); }
  for (const [image, disabled] of [
    ['eclipse-temurin:17-jdk', false], ['eclipse-temurin:17-jre', false],
    ['eclipse-temurin:21-jre', false], ['eclipse-temurin:25-jre', false],
    ['eclipse-temurin:25-jre', true],
  ] as const) await t.test(`${image}${disabled ? ' with attach disabled' : ''}`, async () => {
    const container = await docker.createContainer({ Image: image, User: '1000:1000',
      Cmd: ['java', '-Xms64m', '-Xmx128m', ...(disabled ? ['-XX:+DisableAttachMechanism'] : []), '-cp', '/probe', 'Probe'],
      Labels: { 'io.mc-dash.test': 'jvm-inspection' },
      HostConfig: { Memory: 384 * 1024 ** 2, MemorySwap: 384 * 1024 ** 2, NanoCpus: 1_000_000_000, PidsLimit: 64,
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        Binds: [`${root}:/probe:ro`], Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,size=67108864,mode=1777' } } });
    try {
      await container.start();
      let ready = false;
      for (let i = 0; i < 30; i++) {
        if ((await container.logs({ stdout: true, stderr: true, follow: false })).toString().includes('PROBE_READY')) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(ready, 'isolated JVM must become ready');
      const service = new DockerService(); service.docker = docker; service.jattachPath = path.join(root, 'jattach');
      const server = { id: 'probe', containerId: container.id, resources: { minRamMb: 64, maxRamMb: 384 } };
      const result = await service.inspectJvmMemory(server);
      assert.equal(result.containerLimitMb, 384, 'Docker limit survives JVM inspection failures');
      if (disabled) {
        assert.equal(result.status, 'unverified'); assert.match(result.reason, /five seconds/);
      } else {
        assert.equal(result.status, 'verified', result.reason);
        assert.equal(result.initialHeapMb, 64); assert.equal(result.maximumHeapMb, 128);
        const mismatch = await service.inspectJvmMemory({ ...server, resources: { minRamMb: 32, maxRamMb: 320 } });
        assert.equal(mismatch.status, 'mismatch');
      }
      assert.equal((await container.inspect()).State.Running, true, 'diagnostics must leave the JVM running');
      const cleanup = await container.exec({ Cmd: ['sh', '-c', 'test -z "$(find /tmp -name mc-dash-inspect-\\*)"'], AttachStdout: true, AttachStderr: true });
      const stream = await cleanup.start({}); stream.resume(); await new Promise(resolve => stream.on('end', resolve));
      assert.equal((await cleanup.inspect()).ExitCode, 0, 'temporary helper is removed');
    } finally { await container.remove({ force: true }); }
  });
});
