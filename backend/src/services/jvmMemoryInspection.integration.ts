// Explicit opt-in: runs only through npm run test:jvm-integration.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Docker from 'dockerode';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcdash-jvm-integration-'));
process.env.DATA_ROOT=root;process.env.SQLITE_PATH=path.join(root,'test.sqlite');
const {DockerService}=require('./dockerService');
const {db}=require('../db');

test('real isolated JDK reports its heap through Docker diagnostics', {timeout:45000}, async()=>{
  const docker=new Docker({socketPath:process.env.DOCKER_SOCKET || '/var/run/docker.sock'});
  let container:Docker.Container|undefined;
  try {
    fs.chmodSync(root,0o755);
    fs.writeFileSync(path.join(root,'Probe.java'),'class Probe { public static void main(String[] args) throws Exception { System.out.println("PROBE_READY"); Thread.sleep(60000); } }');
    container=await docker.createContainer({Image:'eclipse-temurin:17-jdk',User:'1000:1000',
      Cmd:['java','-Xms64m','-Xmx128m','/probe/Probe.java'],
      Labels:{'io.mc-dash.test':'jvm-inspection'},
      HostConfig:{Memory:512*1024**2,MemorySwap:512*1024**2,NanoCpus:1_000_000_000,PidsLimit:64,
        NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],
        Binds:[`${root}:/probe:ro`],Tmpfs:{'/tmp':'rw,nosuid,nodev,size=67108864,mode=1777'}}});
    await container.start();
    let ready=false;
    for(let i=0;i<30;i++) {
      const logs=await container.logs({stdout:true,stderr:true,follow:false});
      if(logs.toString().includes('PROBE_READY')) {ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(ready,'isolated JVM must become ready');
    const service=new DockerService();service.docker=docker;
    const server={id:'probe',containerId:container.id,resources:{minRamMb:64,maxRamMb:128}};
    const result=await service.inspectJvmMemory(server);
    assert.equal(result.status,'verified',result.reason);
    assert.equal(result.initialHeapMb,64);assert.equal(result.maximumHeapMb,128);
    assert.equal(result.containerLimitMb,512);
    const mismatch=await service.inspectJvmMemory({...server,resources:{minRamMb:32,maxRamMb:64}});
    assert.equal(mismatch.status,'mismatch');
    assert.equal((await container.inspect()).State.Running,true,'diagnostics must leave the JVM running');
  } finally {
    if(container) await container.remove({force:true});
    db.close();fs.rmSync(root,{recursive:true,force:true});
  }
});
