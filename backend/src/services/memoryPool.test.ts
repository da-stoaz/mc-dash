import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-pool-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.MC_DASH_MEMORY_POOL = 'true';
const poolModule = require('./memoryPool');
const { readMemoryPool, requireMemoryPool, requireStartRoom, StartupReservations } = poolModule;
const { MemoryPressureService } = require('./memoryPressureService');
const { DockerService } = require('./dockerService');
const { metricsCollector } = require('./metricsCollector');
const capacityModule = require('./hostCapacityService');
const { db } = require('../db');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const MB = 1024 ** 2;
const poolDir = path.join(root, 'minecraft.slice');
const membership = path.join(root, 'membership');
const good = { enabled:true,enforced:true,usedMb:5000,limitMb:12288,pressure:false,reason:null,oomKills:0 };
function fixtures() {
  fs.mkdirSync(poolDir, {recursive:true});
  for (const [name, value] of Object.entries({'memory.max':12288*MB,'memory.current':5000*MB,'memory.swap.max':0,'memory.events':'oom 0\noom_kill 0\n'})) fs.writeFileSync(path.join(poolDir,name),String(value));
  fs.writeFileSync(membership,'0::/system.slice/mc-dash-backend.service\n');
}
test('verifies controller values and membership; fails closed on missing or unbounded controls', async () => {
  fixtures(); assert.equal((await readMemoryPool(root,membership)).enforced,true);
  for (const [name,value] of [['memory.max','max'],['memory.max','0'],['memory.swap.max','1024']]) {
    fixtures(); fs.writeFileSync(path.join(poolDir,name),value);
    const report = await readMemoryPool(root,membership);
    assert.equal(report.enforced,false); assert.throws(()=>requireMemoryPool(report), /Shared RAM protection/);
  }
  // Limit is read from the installed controller, with no duplicated env value.
  fixtures(); fs.writeFileSync(path.join(poolDir,'memory.max'),String(10*1024*MB));
  assert.equal((await readMemoryPool(root,membership)).limitMb,10240);
  for (const controlPath of ['/minecraft.slice/backend.service','/minecraft.slice','/mcdash.slice/backend.service','/','']) {
    fixtures(); fs.writeFileSync(membership,`0::${controlPath}`);
    const report = await readMemoryPool(root,membership);
    assert.equal(report.enforced,false, controlPath);
  }
  fixtures(); fs.unlinkSync(path.join(poolDir,'memory.current'));
  assert.equal((await readMemoryPool(root,membership)).enforced,false);
});
test('admission uses usage and temporary boot allowances without reserving full maxima', () => {
  assert.doesNotThrow(()=>requireStartRoom(good,1500,1000));
  assert.throws(()=>requireStartRoom({...good,usedMb:9500},1500,0), /Not enough shared RAM/);
  const pending = new StartupReservations(); pending.reserve('one',1500,0);
  assert.equal(pending.pending(new Map(),1000),1500);
  assert.equal(pending.pending(new Map([['one',1000]]),1000),500);
  assert.equal(pending.pending(new Map([['one',2000]]),1000),0);
  assert.equal(pending.pending(new Map(),120001),1500);
  pending.retain(new Set());
  assert.equal(pending.pending(new Map()),0);
});
test('pressure sleeps only repeatedly confirmed empty servers, largest first, with cooldown', async () => {
  let now=0, pressure=true;
  const servers:any[]=[{id:'small',name:'Small',status:'running'},{id:'big',name:'Big',status:'running'},{id:'occupied',status:'running'},{id:'unknown',status:'running'}];
  const slept:string[]=[];
  const service=new MemoryPressureService({pool:async()=>({...good,pressure}),servers:()=>servers,
    players:async(s:any)=>s.id==='occupied'?2:s.id==='unknown'?null:0,usage:(id:string)=>id==='big'?9000:1000,now:()=>now,
    sleep:async(s:any)=>{slept.push(s.id);s.status='stopped';s.hibernated=true;}});
  await service.tick(); now=59000; await service.tick(); assert.deepEqual(slept,[]);
  now=60000; await service.tick(); assert.deepEqual(slept,['big']);
  now=70000; await service.tick(); assert.deepEqual(slept,['big']);
  pressure=false; now=130000; await service.tick(); assert.deepEqual(slept,['big']);
});
test('unknown readings reset idle tracking and a final player check prevents sleeping a new join', async () => {
  let now=0, count:number|null=0, calls=0;
  const server={id:'one',name:'One',status:'running'}, slept:string[]=[];
  const deps={pool:async()=>({...good,pressure:true}),servers:()=>[server],usage:()=>1000,now:()=>now,sleep:async()=>{slept.push('one');}};
  const service=new MemoryPressureService({...deps,players:async()=>count});
  await service.tick(); now=60000; count=null; await service.tick();
  now=70000; count=0; await service.tick(); now=129000; await service.tick(); assert.deepEqual(slept,[]);
  const joining=new MemoryPressureService({...deps,players:async()=>++calls===3?1:0});
  await joining.tick(); now+=60000; await joining.tick(); assert.deepEqual(slept,[]);
});
test('Docker start serializes admissions and refuses legacy container parents', async () => {
  const service = new DockerService();
  const originalPool=poolModule.readMemoryPool, originalHost=capacityModule.readHostMemory, originalLive=metricsCollector.liveAll;
  poolModule.readMemoryPool=async()=>({...good,usedMb:9000}); capacityModule.readHostMemory=async()=>({availableKnown:false}); metricsCollector.liveAll=()=>new Map();
  const starts:string[]=[]; let parent='minecraft.slice';
  service.docker={info:async()=>({CgroupDriver:'systemd',CgroupVersion:'2'}),listContainers:async()=>[],getContainer:(id:string)=>({id,update:async()=>{},inspect:async()=>({HostConfig:{CgroupParent:parent},State:{Running:false}}),start:async()=>{starts.push(id);}})};
  try {
    const results=await Promise.allSettled(['one','two'].map(id=>service.start({id,containerId:id,resources:{minRamMb:700,maxRamMb:2048}})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(starts.length,1);
    parent='system.slice'; await assert.rejects(()=>service.start({id:'legacy',containerId:'legacy',resources:{minRamMb:700,maxRamMb:2048}}),/outside the shared RAM pool/);
  } finally {poolModule.readMemoryPool=originalPool;capacityModule.readHostMemory=originalHost;metricsCollector.liveAll=originalLive;}
});

test('a refused wake remains asleep and restores its listener for retry', async () => {
  const { HibernationService } = require('./hibernationService');
  const { serverStore } = require('../serverStore');
  const { dockerService } = require('./dockerService');
  const originalGet=serverStore.get, originalUpdate=serverStore.update, originalStart=dockerService.start;
  let server:any={id:'sleeping',name:'Sleeping',status:'stopped',hibernated:true};
  let armed=0;
  serverStore.get=()=>server;
  serverStore.update=(_id:string,change:any)=>server={...server,...change};
  dockerService.start=async()=>{throw new Error('No capacity');};
  const service=new HibernationService();
  service.armListener=async()=>{armed++;};
  try {
    await service.wake('sleeping','player');
    assert.equal(server.status,'stopped'); assert.equal(server.hibernated,true); assert.equal(armed,1);
  } finally {serverStore.get=originalGet;serverStore.update=originalUpdate;dockerService.start=originalStart;}
});


test('Docker audit separates panel containers from managed Minecraft servers', async () => {
  const { serverStore } = require('../serverStore');
  const originalList = serverStore.list;
  const service = new DockerService();
  let gameParent = 'minecraft.slice', panelParent = 'system.slice';
  serverStore.list = () => [{id:'world',containerId:'world-container'}];
  service.docker = {
    info: async () => ({CgroupDriver:'systemd',CgroupVersion:'2'}),
    listContainers: async () => [
      {Id:'panel',Names:['/mc-dash-backend-1'],Labels:{'io.mc-dash.role':'backend'}},
      {Id:'front',Names:['/mc-dash-frontend-1'],Labels:{'io.mc-dash.role':'frontend'}},
      {Id:'world-container',Names:['/mc-dash-world'],Labels:{}},
      {Id:'unrelated',Names:['/mc-dash-other-deployment'],Labels:{}},
    ],
    getContainer: (id:string) => ({inspect:async()=>({HostConfig:{CgroupParent:id==='world-container'?gameParent:panelParent}})}),
  };
  try {
    await assert.doesNotReject(()=>service.verifyMemoryPoolContainers());
    panelParent='minecraft.slice';
    await assert.rejects(()=>service.verifyMemoryPoolContainers(),/panel must be outside/);
    panelParent='mcdash.slice';
    await assert.rejects(()=>service.verifyMemoryPoolContainers(),/panel must be outside/);
    panelParent='system.slice'; gameParent='system.slice';
    await assert.rejects(()=>service.verifyMemoryPoolContainers(),/outside the shared RAM pool/);
  } finally { serverStore.list=originalList; }
});

test('deployment configuration never assigns the panel to the Minecraft pool', () => {
  const repo = path.resolve(__dirname,'../../..');
  const compose = fs.readFileSync(path.join(repo,'docker-compose.yml'),'utf8');
  const slice = fs.readFileSync(path.join(repo,'deploy/systemd/minecraft.slice'),'utf8');
  assert.doesNotMatch(compose,/cgroup_parent:/);
  assert.doesNotMatch(compose,/\/etc\/mc-dash\/memory.env/);
  assert.match(slice,/MemoryMax=12G/);
  assert.match(slice,/MemorySwapMax=0/);
  assert.equal(fs.existsSync(path.join(repo,'scripts/setup-memory-pool.sh')),false);
});

test('occupied servers get a full countdown; fewest players first, then largest usage', async () => {
  let now = 0;
  const servers:any[] = [
    {id:'busy',name:'Busy',status:'running'}, {id:'small',name:'Small',status:'running'},
    {id:'large',name:'Large',status:'running'}, {id:'unknown',name:'Unknown',status:'running'},
  ];
  const warnings:any[] = [], sleeps:any[] = [];
  const service = new MemoryPressureService({
    pool:async()=>({...good,usedMb:11300,pressure:true}), servers:()=>servers, now:()=>now,
    players:async(s:any)=>s.id==='busy'?5:s.id==='unknown'?null:1,
    usage:(id:string)=>id==='large'?6000:1000,
    warn:async(s:any,message:string)=>{warnings.push([s.id,message]);return true;},
    sleep:async(s:any,options:any)=>{sleeps.push([s.id,options.allowOccupied]);s.status='stopped';s.hibernated=true;return true;},
  });
  await service.tick(); assert.equal(warnings[0][0],'large'); assert.deepEqual(sleeps,[]);
  now=30000; await service.tick(); assert.match(warnings[1][1],/30 seconds/);
  now=59999; await service.tick(); assert.deepEqual(sleeps,[]);
  now=60000; await service.tick(); assert.deepEqual(sleeps,[['large',true]]);
  now=70000; await service.tick(); assert.equal(warnings.length,2);
});

test('countdown survives small fluctuations but cancels on recovery or unverified protection', async () => {
  for (const unverified of [false,true]) {
    let now=0,usedMb=11300,enforced=true;
    const server={id:'one',name:'One',status:'running'}, warnings:string[]=[], sleeps:string[]=[];
    const service=new MemoryPressureService({pool:async()=>({...good,enforced,usedMb,pressure:usedMb>=10444.8}),
      servers:()=>[server],now:()=>now,players:async()=>2,usage:()=>5000,
      warn:async(_s:any,msg:string)=>{warnings.push(msg);return true;},sleep:async()=>{sleeps.push('one');}});
    await service.tick(); now=30000; usedMb=10800; await service.tick();
    assert.equal(warnings.length,2);
    now=60000; if(unverified) enforced=false; else usedMb=9000;
    await service.tick(); assert.deepEqual(sleeps,[]); assert.match(warnings[2],/cancelled/);
    now=120000; await service.tick(); assert.deepEqual(sleeps,[]);
  }
});

test('unreachable warnings never cause an occupied server to be stopped', async () => {
  let now=0, warningCalls=0, sleeps=0;
  const server={id:'one',name:'One',status:'running'};
  const service=new MemoryPressureService({pool:async()=>({...good,usedMb:12000,pressure:true}),
    servers:()=>[server],now:()=>now,players:async()=>null,usage:()=>9000,
    warn:async()=>{warningCalls++;return false;},sleep:async()=>{sleeps++;}});
  await service.tick(); now=10000; await service.tick(); assert.equal(warningCalls,1);
  now=60000; await service.tick(); assert.equal(warningCalls,2); assert.equal(sleeps,0);
});

test('manual stop or container replacement cancels a pending pressure shutdown', async () => {
  for (const replaced of [false,true]) {
    let now=0,sleeps=0;
    let server={id:'one',name:'One',status:'running',containerId:'original'};
    const service=new MemoryPressureService({pool:async()=>({...good,usedMb:11300,pressure:true}),
      servers:()=>[server],now:()=>now,players:async()=>1,usage:()=>9000,
      warn:async()=>true,sleep:async()=>{sleeps++;}});
    await service.tick(); now=60000;
    server={...server,...(replaced?{containerId:'replacement'}:{status:'stopping'})};
    await service.tick(); assert.equal(sleeps,0);
  }
});

test('failed saves are reported and retried without claiming a successful sleep', async () => {
  let now=0,sleeps=0;
  const server={id:'one',name:'One',status:'running'};
  const service=new MemoryPressureService({pool:async()=>({...good,usedMb:11300,pressure:true}),
    servers:()=>[server],now:()=>now,players:async()=>1,usage:()=>9000,
    warn:async()=>true,sleep:async()=>{sleeps++;return false;}});
  await service.tick(); now=60000; await service.tick();
  await new Promise(resolve=>setImmediate(resolve));
  fixtures(); const report=await readMemoryPool(root,membership);
  assert.match(report.lastAction,/Could not safely sleep/);
  now=70000; await service.tick(); assert.equal(sleeps,1);
});

test('overlapping pressure ticks cannot schedule two shutdowns', async () => {
  let finish!:()=>void, warnings=0;
  const hold=new Promise<void>(resolve=>{finish=resolve;});
  const server={id:'one',name:'One',status:'running'};
  const service=new MemoryPressureService({pool:async()=>({...good,usedMb:11300,pressure:true}),
    servers:()=>[server],now:()=>0,players:async()=>{await hold;return 2;},usage:()=>9000,
    warn:async()=>{warnings++;return true;},sleep:async()=>true});
  const first=service.tick(); await service.tick(); finish(); await first;
  assert.equal(warnings,1);
});

test('pressure refresh discovers ready servers without browser status polling', async () => {
  const { refreshPressureServers } = require('./memoryPressureService');
  const { serverStore } = require('../serverStore');
  const { dockerService } = require('./dockerService');
  const originalList=serverStore.list, originalGet=serverStore.get, originalUpdate=serverStore.update, originalStatus=dockerService.status;
  let server:any={id:'one',status:'starting',containerId:'one'};
  serverStore.list=()=>[server]; serverStore.get=()=>server;
  serverStore.update=(_id:string,update:any)=>{server={...server,...update};return server;};
  dockerService.status=async()=> 'running';
  try {
    await refreshPressureServers(); assert.equal(server.status,'running');
    server.status='starting';
    dockerService.status=async()=>{server={...server,status:'stopping'};return 'running';};
    await refreshPressureServers(); assert.equal(server.status,'stopping');
  } finally {serverStore.list=originalList;serverStore.get=originalGet;serverStore.update=originalUpdate;dockerService.status=originalStatus;}
});

test('automatic sleep requires a successful flush before sending stop', async () => {
  const { gracefulSleep } = require('./gracefulSleep');
  for(const response of [null,[],['Unknown command'],['Failed to save the game']]) {
    const commands:string[]=[];
    await assert.rejects(()=>gracefulSleep({},()=>true,{
      command:async(_s:any,cmd:string[])=>{commands.push(...cmd);return response;},
      waitForExit:async()=>{assert.fail('must not wait after failed save');},
    }),/save was not confirmed/);
    assert.deepEqual(commands,['save-all flush']);
  }
  const commands:string[]=[];
  await gracefulSleep({},()=>true,{
    command:async(_s:any,cmd:string[])=>{commands.push(...cmd);return cmd[0]==='stop'?null:['Saving the game\nSaved the game'];},
    waitForExit:async()=>true,
  });
  assert.deepEqual(commands,['save-all flush','stop']);
});

test('automatic sleep stops on lifecycle changes and never escalates a shutdown timeout', async () => {
  const { gracefulSleep } = require('./gracefulSleep');
  for(const changed of [false,true]) {
    const commands:string[]=[];
    await assert.rejects(()=>gracefulSleep({},()=>!changed,{
      command:async(_s:any,cmd:string[])=>{commands.push(...cmd);return ['Saved the game'];},
      waitForExit:async()=>false,
    }),changed?/Server changed/:/clean shutdown was not confirmed/);
    assert.deepEqual(commands,changed?['save-all flush']:['save-all flush','stop']);
  }
});

test('automatic sleep does not treat an OOM, failed exit, or missing container as clean', async () => {
  const service=new DockerService();
  let state:any={Running:false,Status:'exited',ExitCode:0,OOMKilled:false};
  let missing=false;
  service.docker={getContainer:()=>({inspect:async()=>{if(missing) throw {statusCode:404};return {State:state};}})};
  assert.equal(await service.waitForExit({id:'one'},100,{requireClean:true}),true);
  for (const bad of [{ExitCode:137},{OOMKilled:true},{Status:'dead'},{Status:'created'}]) {
    const original=state;state={...state,...bad};
    assert.equal(await service.waitForExit({id:'one'},100,{requireClean:true}),false); state=original;
  }
  missing=true;
  assert.equal(await service.waitForExit({id:'one'},100,{requireClean:true}),false);
});

test('hibernation keeps failed saves running and only marks a confirmed clean exit asleep', async () => {
  const { HibernationService } = require('./hibernationService');
  const { serverStore } = require('../serverStore');
  const { dockerService } = require('./dockerService');
  const rcon=require('./rconService'), players=require('./playerService');
  const originals={get:serverStore.get,update:serverStore.update,stop:dockerService.stop,wait:dockerService.waitForExit,
    rcon:rcon.runServerRcon,players:players.getPlayerCount};
  let server:any={id:'one',name:'One',containerId:'one',status:'running'}, response:string[]|null=null, armed=0, checks=0;
  const commands:string[]=[];
  serverStore.get=()=>server;serverStore.update=(_id:string,change:any)=>server={...server,...change};
  players.getPlayerCount=async()=>({online:0});
  rcon.runServerRcon=async(_s:any,cmd:string[])=>{commands.push(...cmd);return response;};
  dockerService.waitForExit=async(_s:any,_ms:number,opts:any)=>{assert.equal(opts.requireClean,true);checks++;return true;};
  dockerService.stop=async()=>assert.fail('automatic hibernation must not use Docker stop/kill');
  const service=new HibernationService();service.armListener=async()=>{armed++;};
  try {
    assert.equal(await service.hibernate(server),false);
    assert.equal(server.status,'running');assert.equal(server.hibernated,undefined);assert.equal(checks,0);
    assert.match(server.lastError,/save was not confirmed/);
    response=['Saved the game'];commands.length=0;
    let playerChecks=0;players.getPlayerCount=async()=>({online:++playerChecks===1?0:1});
    assert.equal(await service.hibernate(server),false);assert.deepEqual(commands,['save-all flush']);
    players.getPlayerCount=async()=>({online:3});commands.length=0;
    assert.equal(await service.hibernate(server,{allowOccupied:true}),true);
    assert.deepEqual(commands,['save-all flush','stop']);assert.equal(server.hibernated,true);
    assert.equal(server.status,'stopped');assert.equal(armed,1);assert.equal(server.lastError,null);
  } finally {
    serverStore.get=originals.get;serverStore.update=originals.update;dockerService.stop=originals.stop;
    dockerService.waitForExit=originals.wait;rcon.runServerRcon=originals.rcon;players.getPlayerCount=originals.players;
  }
});


test('pressure recovery during refresh cancels an expiring countdown', async () => {
  let now=0, pressure=true, sleeps=0;
  const service=new MemoryPressureService({
    pool:async()=>({...good,usedMb:11300,pressure}), servers:()=>[{id:'one',status:'running'}],
    now:()=>now, players:async()=>1, usage:()=>1000, warn:async()=>true,
    refresh:async()=>{if(now===60000) pressure=false;}, sleep:async()=>{sleeps++;},
  });
  await service.tick(); now=60000; await service.tick(); assert.equal(sleeps,0);
});

test('pressure recovery during saving vetoes the stop', async () => {
  let now=0, pressure=true, stopped=false;
  const service=new MemoryPressureService({
    pool:async()=>({...good,usedMb:11300,pressure}), servers:()=>[{id:'one',status:'running'}],
    now:()=>now, players:async()=>1, usage:()=>1000, warn:async()=>true,
    sleep:async(_s:any, options:any)=>{pressure=false; stopped=await options.beforeStop();return false;},
  });
  await service.tick(); now=60000; await service.tick(); assert.equal(stopped,false);
});

test('RAM reductions preserve the running cap and apply after exit', async () => {
  const service=new DockerService(); let running=true; const updates:any[]=[];
  service.docker={getContainer:()=>({inspect:async()=>({State:{Running:running},HostConfig:{Memory:8192*1024**2}}),update:async(value:any)=>updates.push(value)})};
  const server={id:'one',containerId:'one',resources:{minRamMb:512,maxRamMb:2048,cpuLimit:2}};
  await service.updateResources(server);
  assert.equal(updates[0].Memory,undefined); assert.equal(updates[0].NanoCPUs,2000000000);
  running=false; await service.updateResources(server);
  assert.ok(updates[1].Memory>2048*1024**2); assert.ok(updates[1].Memory<8192*1024**2);
});

test('start rejects growth during the asynchronous Docker audit', async () => {
  const service=new DockerService(); let usedMb=5000, started=false;
  const originalPool=poolModule.readMemoryPool, originalHost=capacityModule.readHostMemory;
  poolModule.readMemoryPool=async()=>({...good,usedMb});
  capacityModule.readHostMemory=async()=>({availableKnown:false});
  service.verifyMemoryPoolContainers=async()=>{usedMb=12000;};
  service.docker={getContainer:()=>({id:'fresh',update:async()=>{},inspect:async()=>({State:{Running:false},HostConfig:{CgroupParent:'minecraft.slice'}}),start:async()=>{started=true;}})};
  try {
    await assert.rejects(()=>service.start({id:'fresh',containerId:'fresh',resources:{minRamMb:700,maxRamMb:2048}}),/Not enough shared RAM/);
    assert.equal(started,false);
  } finally {poolModule.readMemoryPool=originalPool;capacityModule.readHostMemory=originalHost;}
});

test('Docker audit reconstructs boot allowance and releases it on readiness', async () => {
  const {serverStore}=require('../serverStore');
  const originalList=serverStore.list; let ready=false;
  const service=new DockerService();
  serverStore.list=()=>[{id:'boot',containerId:'boot',resources:{minRamMb:700,maxRamMb:2048}}];
  service.isReady=async()=>ready;
  service.docker={info:async()=>({CgroupDriver:'systemd',CgroupVersion:'2'}),listContainers:async()=>[{Id:'boot'}],getContainer:()=>({inspect:async()=>({HostConfig:{CgroupParent:'minecraft.slice'}})})};
  poolModule.startupReservations.retain(new Set());
  try {
    await service.verifyMemoryPoolContainers();
    assert.ok(poolModule.startupReservations.pending(new Map())>=700);
    ready=true; await service.verifyMemoryPoolContainers();
    assert.equal(poolModule.startupReservations.pending(new Map()),0);
  } finally {serverStore.list=originalList;poolModule.startupReservations.retain(new Set());}
});


test('pressure sampling continues during a slow save without duplicate interventions', async () => {
  let now=0, reads=0, sleeps=0, finish!:()=>void;
  const hold=new Promise<void>(resolve=>{finish=resolve;});
  const service=new MemoryPressureService({
    pool:async()=>{reads++;return {...good,usedMb:11300,pressure:true};},
    servers:()=>[{id:'slow',status:'running'}],now:()=>now,players:async()=>1,usage:()=>5000,warn:async()=>true,
    sleep:async()=>{sleeps++;await hold;return true;},
  });
  await service.tick();now=60000;await service.tick();
  const before=reads;now=70000;await service.tick();
  assert.ok(reads>before);assert.equal(sleeps,1);
  finish();await new Promise(resolve=>setImmediate(resolve));
});

test('automatic lifecycle actions respect manual ownership', async () => {
  const {lifecycleBusy}=require('../state');
  const {HibernationService}=require('./hibernationService');
  lifecycleBusy.add('locked');
  try { assert.equal(await new HibernationService().hibernate({id:'locked'}),false); }
  finally {lifecycleBusy.delete('locked');}
});

test('a fresh service recovers a late clean exit and leaves failed exits awake', async () => {
  const {db}=require('../db'), {serverStore}=require('../serverStore');
  const {dockerService}=require('./dockerService'), {HibernationService}=require('./hibernationService');
  const originals={get:serverStore.get,update:serverStore.update,status:dockerService.statusDetails,wait:dockerService.waitForExit};
  let server:any={id:'late',containerId:'late-container',status:'stopping'}, armed=0, clean=true;
  serverStore.get=()=>server;serverStore.update=(_id:string,patch:any)=>server={...server,...patch};
  dockerService.statusDetails=async()=>({status:'stopped',exitCode:0});
  dockerService.waitForExit=async()=>clean;
  try {
    for (const success of [true,false]) {
      clean=success;server={id:'late',containerId:'late-container',status:'stopping'};
      db.prepare('INSERT OR REPLACE INTO sleep_intents VALUES (?, ?)').run('late','late-container');
      const restarted=new HibernationService();restarted.armListener=async()=>{armed++;};
      await restarted.reconcile();
      assert.equal(!!server.hibernated,success);
    }
    assert.equal(armed,1);
  } finally {
    db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run('late');
    serverStore.get=originals.get;serverStore.update=originals.update;dockerService.statusDetails=originals.status;dockerService.waitForExit=originals.wait;
  }
});

test('individual pressure warns only the affected container when the pool has room',async()=>{
  const warnings:string[]=[];
  const service=new MemoryPressureService({pool:async()=>({...good}),
    risks:async()=>({global:false,critical:true,targets:new Set(['full']),reason:'This server is approaching its RAM limit'}),
    servers:()=>[{id:'empty',status:'running'},{id:'full',status:'running'}],
    players:async(s:any)=>s.id==='empty'?0:2,usage:()=>1000,now:()=>0,
    warn:async(s:any)=>{warnings.push(s.id);return true;},sleep:async()=>true});
  await service.tick();assert.deepEqual(warnings,['full']);
});
test('host pressure warns even when the shared pool is below its threshold',async()=>{
  let warnings=0;
  const service=new MemoryPressureService({pool:async()=>({...good}),
    risks:async()=>({global:true,critical:true,targets:new Set(),reason:'The host is running low on RAM'}),
    servers:()=>[{id:'one',status:'running'}],players:async()=>2,usage:()=>1000,now:()=>0,
    warn:async(_s:any,message:string)=>{assert.match(message,/host/);warnings++;return true;},sleep:async()=>true});
  await service.tick();assert.equal(warnings,1);
});
test('pressure cooldown and observed demand survive service recreation',()=>{
  const {recordPressureSleep,pressureRestartDemand,shutdownHorizonMs}=require('./memoryRecovery');
  try {
    recordPressureSleep('cool',4000,1000,120000);
    assert.throws(()=>pressureRestartDemand('cool',8000,2000),/cooling down/);
    assert.equal(pressureRestartDemand('cool',8000,301001),4000);
    assert.equal(pressureRestartDemand('cool',2000,301001),2000);
    assert.equal(shutdownHorizonMs(),210000);
  } finally {db.prepare('DELETE FROM memory_recovery WHERE serverId=?').run('cool');}
});

test('runtime signals use host availability and observed container limits',async()=>{
  const {assessRuntimeRisks}=require('./memoryPressureService'),{serverStore}=require('../serverStore');
  const originals={host:capacityModule.readHostMemory,list:serverStore.list,live:metricsCollector.liveFor};
  let availableMb=4000;
  capacityModule.readHostMemory=async()=>({totalMb:14000,availableKnown:true,availableMb});
  serverStore.list=()=>[{id:'runtime',containerId:'container',status:'running',resources:{maxRamMb:99999}}];
  metricsCollector.liveFor=()=>({memoryBytes:950*MB,memoryLimitBytes:1000*MB,at:Date.now()});
  try {
    let risk=await assessRuntimeRisks(good);
    assert.equal(risk.global,false);assert.equal(risk.critical,true);assert.ok(risk.targets.has('runtime'));
    availableMb=500;risk=await assessRuntimeRisks(good);
    assert.equal(risk.global,true);assert.match(risk.reason,/host/);
    metricsCollector.liveFor=()=>null;availableMb=4000;
    risk=await assessRuntimeRisks(good);assert.equal(risk.targets.size,0);
  } finally {capacityModule.readHostMemory=originals.host;serverStore.list=originals.list;metricsCollector.liveFor=originals.live;}
});
