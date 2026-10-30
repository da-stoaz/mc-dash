import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-memory-lifecycle-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.MC_DASH_MEMORY_POOL = 'true';
process.env.MC_DASH_HIBERNATE = 'true';
const { config } = require('../config');
const { db } = require('../db');
const { serverStore } = require('../serverStore');
const { HibernationService } = require('./hibernationService');
const { MemoryPressureService } = require('./memoryPressureService');
const { DockerService, dockerService } = require('./dockerService');
const { SleepListener } = require('./sleepGateway');
const poolModule = require('./memoryPool');
const recovery = require('./memoryRecovery');
const { bootMemoryDemand } = require('./bootMemory');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const pool = { enabled:true, enforced:true, usedMb:12100, limitMb:12288, pressure:true, reason:null, oomKills:0 };
const server = { id:'world', name:'World', status:'running', containerId:'container', serverPort:25566,
  resources:{minRamMb:512,maxRamMb:8192} };

test('disabled hibernation prevents pressure sleep and direct automatic shutdown', async t => {
  t.mock.property(config, 'hibernationEnabled', false);
  let refreshed=0;
  const pressure = new MemoryPressureService({pool:async()=>pool,servers:()=>[server],now:()=>60000,
    refresh:async()=>{refreshed++;},
    players:async()=>0,usage:()=>10000,warn:async()=>assert.fail('must not warn for disabled sleep'),
    sleep:async()=>assert.fail('must not sleep')});
  await pressure.tick();
  assert.equal(refreshed,1,'readiness must still be refreshed with no browser connected');
  assert.equal(await new HibernationService().hibernate(server,{allowOccupied:true}),false);
});

test('disabling either manager during a countdown cancels the shutdown', async t => {
  for (const setting of ['hibernationEnabled','memoryPoolEnabled']) {
    let now=0;
    const messages:string[]=[];
    const pressure = new MemoryPressureService({pool:async()=>pool,servers:()=>[server],now:()=>now,
      players:async()=>2,usage:()=>10000,warn:async(_server:any,message:string)=>{messages.push(message);return true;},
      sleep:async()=>assert.fail('cancelled countdown must not sleep')});
    await pressure.tick();
    assert.match(messages[0],/60 seconds/);
    t.mock.property(config,setting,false);
    now=60000;
    await pressure.tick();
    assert.match(messages[1],/disabled.*cancelled/);
    t.mock.restoreAll();
  }
});

test('disabling sleep while saving vetoes the final stop', async t => {
  const rcon=require('./rconService');
  t.mock.method(serverStore,'get',()=>server);
  t.mock.method(require('./playerService'),'getPlayerCount',async()=>({online:0}));
  const commands:string[]=[];
  t.mock.method(rcon,'runServerRcon',async(_server:any,cmd:string[])=>{
    commands.push(...cmd);
    t.mock.property(config,'hibernationEnabled',false);
    return ['Saved the game'];
  });
  t.mock.method(serverStore,'update',()=>server);
  assert.equal(await new HibernationService().hibernate(server),false);
  assert.deepEqual(commands,['save-all flush']);
});

test('failed wake listener binds are retried even after automatic sleep is disabled', async t => {
  t.mock.property(config,'hibernationEnabled',false);
  let sleeping:any={...server,status:'stopped',hibernated:true};
  t.mock.method(serverStore,'get',()=>sleeping);
  t.mock.method(serverStore,'list',()=>[sleeping]);
  t.mock.method(serverStore,'update',(_id:string,patch:any)=>sleeping={...sleeping,...patch});
  t.mock.method(dockerService,'statusDetails',async()=>({status:'stopped',exitCode:0}));
  let binds=0,closed=0;
  t.mock.method(SleepListener.prototype,'listen',async()=>{if(++binds===1) throw new Error('EADDRINUSE');});
  t.mock.method(SleepListener.prototype,'close',async()=>{closed++;});
  const service=new HibernationService();
  await service.tick();
  assert.match(sleeping.lastError,/Wake listener unavailable/);
  await service.tick();
  await service.tick();
  assert.equal(binds,2);
  assert.equal(sleeping.lastError,null);
  sleeping={...sleeping,status:'error'};
  await service.reconcile();
  assert.equal(closed,0,'a temporary Docker inspection failure must not remove a working wake listener');
  t.mock.method(dockerService,'start',async()=>{
    assert.equal(closed,1,'listener must release the port before Docker starts');
    return server.containerId;
  });
  const result=await service.wake(server.id,'player');
  assert.equal(result,config.hibernationWakeMessage);
  assert.equal(sleeping.hibernated,false);
  assert.equal(sleeping.status,'starting');
});

test('readiness advances with memory management disabled and no dashboard connected', async t => {
  t.mock.property(config,'hibernationEnabled',false);
  t.mock.property(config,'memoryPoolEnabled',false);
  let current:any={...server,status:'starting'};
  t.mock.method(serverStore,'get',()=>current);
  t.mock.method(serverStore,'list',()=>[current]);
  t.mock.method(serverStore,'update',(_id:string,patch:any)=>current={...current,...patch});
  t.mock.method(dockerService,'statusDetails',async()=>({status:'running',exitCode:null}));
  await new HibernationService().tick();
  assert.equal(current.status,'running');
});

test('a failed wake preserves pending settings and a successful retry clears them', async t => {
  let sleeping:any={...server,status:'stopped',hibernated:true,restartRequired:true};
  t.mock.method(serverStore,'get',()=>sleeping);
  t.mock.method(serverStore,'update',(_id:string,patch:any)=>sleeping={...sleeping,...patch});
  const service=new HibernationService();
  t.mock.method(service,'armListener',async()=>{});
  let refuse=true;
  t.mock.method(dockerService,'start',async()=>{if(refuse) throw new Error('Not enough shared RAM to start');return server.containerId;});
  assert.match(await service.wake(server.id,'player'),/Could not wake.*Not enough shared RAM/);
  assert.equal(sleeping.hibernated,true);
  assert.equal(sleeping.restartRequired,true);
  refuse=false;
  await service.wake(server.id,'player');
  assert.equal(sleeping.hibernated,false);
  assert.equal(sleeping.restartRequired,false);
});

test('legacy cache-inflated boot and pressure records cannot lock out upgraded servers', () => {
  const legacyProfile=JSON.stringify([512,8192,undefined,undefined]);
  db.prepare('INSERT INTO boot_memory VALUES (?, ?, ?)').run(server.id,legacyProfile,8000);
  db.prepare('INSERT INTO memory_recovery (serverId,untilMs,demandMb) VALUES (?, ?, ?)')
    .run(server.id,Date.now()+300000,8000);
  try {
    assert.ok(bootMemoryDemand(server)<2000);
    assert.equal(recovery.pressureRestartDemand(server.id,8192),0);
  } finally {
    db.prepare('DELETE FROM boot_memory WHERE serverId=?').run(server.id);
    db.prepare('DELETE FROM memory_recovery WHERE serverId=?').run(server.id);
  }
});

test('recent pressure sleep permits an immediate start when current capacity fits', async t => {
  const service=new DockerService();
  let starts=0;
  service.docker={getContainer:()=>({id:'container',inspect:async()=>({State:{Running:false},HostConfig:{CgroupParent:'minecraft.slice'}}),
    update:async()=>{},start:async()=>{starts++;}})};
  t.mock.method(service,'verifyMemoryPoolContainers',async()=>{});
  t.mock.method(require('./serverFiles'),'prepareServerFiles',async()=>{});
  t.mock.method(poolModule,'readMemoryPool',async()=>({...pool,usedMb:1843,workingSetMb:43,pressure:false}));
  t.mock.method(require('./hostCapacityService'),'readHostMemory',async()=>({availableKnown:true,availableMb:10000}));
  recovery.recordPressureSleep(server.id,6000);
  poolModule.startupReservations.retain(new Set());
  try {
    assert.equal(await service.start(server),'container');
    assert.equal(starts,1);
    // Disabling the shared manager must not consult its persistent demand gate.
    t.mock.property(config,'memoryPoolEnabled',false);
    t.mock.method(recovery,'pressureRestartDemand',()=>assert.fail('disabled manager must not gate starts'));
    assert.equal(await service.start(server),'container');
    assert.equal(starts,2);
  } finally {
    poolModule.startupReservations.retain(new Set());
    db.prepare('DELETE FROM memory_recovery WHERE serverId=?').run(server.id);
  }
});
