import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mc-dash-wake-lifecycle-'));
process.env.DATA_ROOT=root;
process.env.SQLITE_PATH=path.join(root,'test.sqlite');
process.env.MC_DASH_MEMORY_POOL='true';
process.env.MC_DASH_HIBERNATE='false';
const {config}=require('../config');
const {db}=require('../db');
const {serverStore}=require('../serverStore');
const {dockerService}=require('./dockerService');
const {hibernationService}=require('./hibernationService');
const {RouterService}=require('./routerService');
const poolModule=require('./memoryPool');
const {recordPressureSleep}=require('./memoryRecovery');
const proto=require('./minecraftProtocol');
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});

function handshake(port:number,state:number):Buffer {
  const portBytes=Buffer.alloc(2);portBytes.writeUInt16BE(port);
  return proto.packet(0,Buffer.concat([proto.writeVarInt(763),proto.writeString('world.mc.test'),portBytes,proto.writeVarInt(state)]));
}
async function exchange(port:number,state:number):Promise<any> {
  const raw=await new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];
    const socket=net.connect(port,'127.0.0.1',()=>{
      socket.write(handshake(port,state));
      if(state===1) socket.write(proto.packet(0));
    });
    socket.setTimeout(2000,()=>socket.destroy(new Error('Wake reply timed out')));
    socket.on('data',chunk=>{chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));socket.end();});
    socket.on('error',reject);
    socket.on('close',()=>resolve(Buffer.concat(chunks)));
  });
  assert.ok(raw.length>0,'player must receive a reply');
  const length=proto.readVarInt(raw,0);
  const id=proto.readVarInt(raw,length.size);
  const stringLength=proto.readVarInt(raw,length.size+id.size);
  const start=length.size+id.size+stringLength.size;
  return JSON.parse(raw.subarray(start,start+stringLength.value).toString('utf8'));
}
async function listen(server:net.Server,port=0):Promise<number> {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return (server.address() as net.AddressInfo).port;
}
async function close(server:net.Server):Promise<void> {
  if(server.listening) await new Promise<void>(resolve=>server.close(()=>resolve()));
}

for(const route of ['direct port','subdomain router']) {
  test(`${route}: refused wake can retry and start through real TCP and memory admission`,async t=>{
    let current:any={id:'world',name:'World',subdomain:'world',containerId:'container',serverPort:0,
      status:'stopped',hibernated:true,resources:{minRamMb:512,maxRamMb:8192}};
    let usedMb=12000,workingSetMb=12000,starts=0,running=false;
    const game=net.createServer(socket=>socket.end());
    const router=new RouterService();
    const proxy=net.createServer(socket=>router.handleConnection(socket));
    const originalWake=config.hibernationWakeOnConnect;
    config.hibernationWakeOnConnect=true;
    t.after(()=>{config.hibernationWakeOnConnect=originalWake;});
    t.mock.property(config,'routerDomain','mc.test');
    t.mock.method(serverStore,'get',()=>current);
    t.mock.method(serverStore,'list',()=>[current]);
    t.mock.method(serverStore,'update',(_id:string,patch:any)=>current={...current,...patch});
    t.mock.method(poolModule,'readMemoryPool',async()=>({enabled:true,enforced:true,limitMb:12288,usedMb,workingSetMb,
      pressure:workingSetMb>11900,reason:null,oomKills:0}));
    t.mock.method(require('./hostCapacityService'),'readHostMemory',async()=>({availableKnown:true,availableMb:12000}));
    t.mock.method(require('./serverFiles'),'prepareServerFiles',async()=>{});
    const container={id:'container',inspect:async()=>({State:{Running:running,Status:running?'running':'exited',ExitCode:0},
      HostConfig:{CgroupParent:'minecraft.slice',Memory:8192*1024**2}}),update:async()=>{},
      start:async()=>{await listen(game,current.serverPort);running=true;starts++;}};
    t.mock.property(dockerService,'docker',{getContainer:()=>container,info:async()=>({CgroupDriver:'systemd',CgroupVersion:'2'}),listContainers:async()=>[]});
    poolModule.startupReservations.retain(new Set());
    recordPressureSleep(current.id,4000);
    try {
      await hibernationService.reconcile();
      current.serverPort=hibernationService.listeners.get(current.id).boundPort();
      const port=route==='direct port'?current.serverPort:await listen(proxy);
      const ping=await exchange(port,1);
      assert.equal(ping.description.text,config.hibernationMotd);
      assert.equal(starts,0,'server-list pings must not launch Docker');
      config.hibernationWakeOnConnect=false;
      assert.match((await exchange(port,2)).text,/Automatic wake is disabled/);
      assert.equal(starts,0);
      config.hibernationWakeOnConnect=true;
      const refused=await exchange(port,2);
      assert.match(refused.text,/Could not wake.*Not enough shared RAM/);
      assert.match(refused.text,/4000 MiB/);
      assert.equal(current.hibernated,true);
      assert.equal(current.status,'stopped');
      assert.equal(starts,0);
      // The same endpoint must still answer after a refusal. Cache left by a
      // stopped server must not count as another resident JVM on the retry.
      assert.equal((await exchange(port,1)).description.text,config.hibernationMotd);
      usedMb=1843;workingSetMb=43;
      const accepted=await exchange(port,2);
      assert.equal(accepted.text,config.hibernationWakeMessage);
      assert.equal(starts,1);
      assert.equal(current.status,'starting');
      assert.equal(current.hibernated,false);
      assert.equal(game.listening,true,'the game must bind the exact port handed back by the listener');
    } finally {
      await hibernationService.clear(current.id);
      await close(proxy);await close(game);
      poolModule.startupReservations.retain(new Set());
      db.prepare('DELETE FROM memory_recovery WHERE serverId=?').run(current.id);
    }
  });
}
