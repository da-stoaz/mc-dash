// SPDX-License-Identifier: AGPL-3.0-only

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mc-dash-events-'));
process.env.DATA_ROOT=root;
process.env.SQLITE_PATH=path.join(root,'test.sqlite');
const {serverStore}=require('../serverStore');
const {dockerService}=require('./dockerService');
const {crashReason,handleContainerEvent}=require('./containerEvents');
const {db}=require('../db');
after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});

const server={id:'srv',containerId:'c1',status:'running',hibernated:false,updatedAt:'t'};
const event=(Action:string,extra:Record<string,string>={})=>({Action,Actor:{ID:'c1',Attributes:{'io.mc-dash.server-id':'srv',...extra}}});

test('crash reason names the exit, signal and log tail', ()=>{
  assert.equal(crashReason(1,false,''),'Server crashed (exit 1).');
  assert.match(crashReason(137,true,'boom'),/out of memory \(exit 137, signal 9\)[\s\S]*Last log lines:\nboom$/);
});

test('an oom followed by die records an OOM crash with the log tail', async t=>{
  const updates:any[]=[];
  t.mock.method(serverStore,'get',()=>server);
  t.mock.method(serverStore,'update',(_id:string,u:any)=>{updates.push(u);return {...server,...u};});
  t.mock.method(dockerService,'statusDetails',async()=>({status:'exited',exitCode:137}));
  t.mock.method(dockerService,'logTail',async()=>'java.lang.OutOfMemoryError');
  await handleContainerEvent(event('oom'));
  await handleContainerEvent(event('die',{exitCode:'137'}));
  assert.match(updates[updates.length-1].lastError,/out of memory[\s\S]*OutOfMemoryError/);
});

test('a clean stop records nothing', async t=>{
  const updates:any[]=[];
  t.mock.method(serverStore,'get',()=>server);
  t.mock.method(serverStore,'update',(_id:string,u:any)=>{updates.push(u);return {...server,...u};});
  t.mock.method(dockerService,'statusDetails',async()=>({status:'stopped',exitCode:0}));
  await handleContainerEvent(event('die',{exitCode:'0'}));
  assert.ok(updates.every(u=>u.lastError===undefined));
});
