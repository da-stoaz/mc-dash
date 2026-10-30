import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mc-dash-status-'));
process.env.DATA_ROOT=root;
process.env.SQLITE_PATH=path.join(root,'test.sqlite');
const {serverStore}=require('../serverStore');
const {dockerService}=require('./dockerService');
const {lifecycleBusy,preparing}=require('../state');
const {refreshServerStatus}=require('./serverStatus');
const {db}=require('../db');
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
const server={id:'status',containerId:'original',status:'stopped',hibernated:true,updatedAt:'before'};

test('status polling leaves an active lifecycle operation in control', async t=>{
  t.mock.method(dockerService,'statusDetails',async()=>assert.fail('must not inspect during a lifecycle operation'));
  t.mock.method(serverStore,'get',()=>server);
  for(const lock of [lifecycleBusy,preparing]) {
    lock.add(server.id);
    try {assert.deepEqual(await refreshServerStatus(server),server);}
    finally {lock.delete(server.id);}
  }
});

test('a slow stopped reading cannot overwrite a completed wake or replacement', async t=>{
  for(const change of [
    {status:'starting',hibernated:false,updatedAt:'after'},
    {containerId:'replacement'},
    {status:'stopped',updatedAt:'after'},
  ]) {
    let current={...server};
    let finish!:(value:any)=>void;
    t.mock.method(serverStore,'get',()=>current);
    t.mock.method(serverStore,'update',()=>assert.fail('stale observation must not write'));
    t.mock.method(dockerService,'statusDetails',()=>new Promise(resolve=>{finish=resolve;}));
    const refresh=refreshServerStatus(current);
    current={...current,...change};
    finish({status:'stopped',exitCode:0});
    assert.deepEqual(await refresh,current);
  }
});

test('an operation beginning during inspection prevents a status write', async t=>{
  t.mock.method(serverStore,'get',()=>server);
  t.mock.method(serverStore,'update',()=>assert.fail('operation owns status'));
  t.mock.method(dockerService,'statusDetails',async()=>{lifecycleBusy.add(server.id);return {status:'running',exitCode:null};});
  try {assert.deepEqual(await refreshServerStatus(server),server);}
  finally {lifecycleBusy.delete(server.id);}
});

test('a server started outside the panel stops being routed as sleeping', async t=>{
  let current={...server};
  t.mock.method(serverStore,'get',()=>current);
  t.mock.method(serverStore,'update',(_id:string,patch:any)=>current={...current,...patch});
  t.mock.method(dockerService,'statusDetails',async()=>({status:'running',exitCode:null}));
  const refreshed=await refreshServerStatus(server);
  assert.equal(refreshed.status,'running');
  assert.equal(refreshed.hibernated,false);
  assert.equal(current.hibernated,false);
});
