// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopServerSafely, unsafeStopMessage } from './safeStop';

const server = { id: 'safe-stop' } as any;

// A fake container: `running` until something stops it, with a JVM whose PID
// changes when a looping start script relaunches the server.
function fakeServer(opts: {
  saveReply?: string[] | null;
  jvmExitsAfterMs?: number | null;   // null = the JVM never exits on its own
  wrapperRelaunches?: boolean;       // container stays up after the JVM exits
  topWorks?: boolean;
}) {
  let clock = 0;
  let running = true;
  let exitCode: number | null = null;
  let stopAt: number | null = null;
  const log: string[] = [];
  const jvmExited = () => stopAt !== null && opts.jvmExitsAfterMs != null && clock >= stopAt + opts.jvmExitsAfterMs;
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    runState: async () => {
      if (running && jvmExited() && !opts.wrapperRelaunches) { running = false; exitCode = 0; }
      return { running, exitCode };
    },
    javaPids: async () => {
      if (opts.topWorks === false) return null;
      if (!running) return [];
      return jvmExited() ? [200] : [100];
    },
    rcon: async (_s: any, commands: string[]) => {
      log.push(commands.join(';'));
      if (commands[0] === 'stop') { stopAt = clock; return null; }
      return opts.saveReply === undefined ? ['Saving the game (this may take a moment!)Saved the game'] : opts.saveReply;
    },
    hardStop: async (_s: any, timeoutSec: number) => {
      log.push(`hardStop:${timeoutSec}`);
      // A bash PID 1 ignores SIGTERM, so Docker kills the container (137)
      // whether or not the JVM inside it had already exited.
      exitCode = 137;
      running = false;
    },
  };
  return { deps, log, elapsed: () => clock };
}

test('a server that exits by itself is never force-stopped', async () => {
  const fake = fakeServer({ jvmExitsAfterMs: 5_000 });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.deepEqual(fake.log, ['save-all flush', 'stop']);
  assert.deepEqual(outcome, { saveConfirmed: true, jvmExited: true, killedRunningJvm: false });
  assert.equal(unsafeStopMessage(outcome), null);
});

test('a looping start script is stopped as soon as the JVM has exited, not after a long wait', async () => {
  const fake = fakeServer({ jvmExitsAfterMs: 40_000, wrapperRelaunches: true });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.deepEqual(fake.log, ['save-all flush', 'stop', 'hardStop:5']);
  assert.equal(outcome.killedRunningJvm, false);
  assert.ok(fake.elapsed() < 45_000, `waited ${fake.elapsed()} ms`);
});

test('a slow save is waited for: no kill while the JVM is still shutting down', async () => {
  // The old Stop gave Minecraft 20 s, then 5 s of SIGTERM, before SIGKILL.
  const fake = fakeServer({ jvmExitsAfterMs: 90_000, wrapperRelaunches: true });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.ok(fake.elapsed() >= 90_000);
  assert.equal(outcome.killedRunningJvm, false);
});

test('a hung JVM is killed eventually and reported, with the save status', async () => {
  const saved = await stopServerSafely(server, fakeServer({ jvmExitsAfterMs: null }).deps as any);
  assert.deepEqual(saved, { saveConfirmed: true, jvmExited: false, killedRunningJvm: true });
  assert.match(unsafeStopMessage(saved)!, /saved just before/);

  const unsaved = await stopServerSafely(server, fakeServer({ jvmExitsAfterMs: null, saveReply: ['An error occurred'] }).deps as any);
  assert.equal(unsaved.saveConfirmed, false);
  assert.match(unsafeStopMessage(unsaved)!, /not confirmed/);
});

test('without RCON the stop falls back to SIGTERM with a long grace period', async () => {
  const fake = fakeServer({ saveReply: null, jvmExitsAfterMs: null });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.deepEqual(fake.log, ['save-all flush', 'hardStop:60']);
  assert.equal(outcome.saveConfirmed, false);
  assert.equal(outcome.killedRunningJvm, true);
});

test('without a process list, a looping script is stopped after a bounded wait and not reported once saved', async () => {
  const fake = fakeServer({ jvmExitsAfterMs: 5_000, wrapperRelaunches: true, topWorks: false });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.equal(fake.log[fake.log.length - 1], 'hardStop:30');
  assert.ok(fake.elapsed() <= 61_000);
  assert.equal(outcome.killedRunningJvm, false);
});

test('an already stopped server is left alone', async () => {
  const fake = fakeServer({});
  fake.deps.runState = async () => ({ running: false, exitCode: 0 });
  const outcome = await stopServerSafely(server, fake.deps as any);
  assert.deepEqual(fake.log, []);
  assert.equal(outcome.killedRunningJvm, false);
});
