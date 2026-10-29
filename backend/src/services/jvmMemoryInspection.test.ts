import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpretJvmMemory} from './jvmMemoryInspection';
const server:any={resources:{minRamMb:512,maxRamMb:2355}};
const flags='1:\n-XX:InitialHeapSize=536870912 -XX:MaxHeapSize=2147483648 -XX:+UseG1GC\n';
test('reports effective heap sizes with their actual units',()=>{
  const report=interpretJvmMemory(flags,server,2355*1024**2,123);
  assert.equal(report.status,'verified');assert.equal(report.initialHeapMb,512);assert.equal(report.maximumHeapMb,2048);assert.equal(report.checkedAt,123);
});
test('overridden and pending heap settings are reported as mismatches',()=>{
  for(const pending of [false,true]) {
    const report=interpretJvmMemory(flags,{...server,resources:{minRamMb:256,maxRamMb:1024},restartRequired:pending},2560*1024**2);
    assert.equal(report.status,'mismatch');assert.match(report.reason,pending?/pending/:/launch arguments/);
  }
});
test('missing, duplicate, invalid and unsupported flag output is never verified',()=>{
  for(const output of ['',flags+flags,flags.replace('536870912','NaN'),'Attach not supported',flags.replace('2147483648','123')])
    assert.equal(interpretJvmMemory(output,server,2560*1024**2).status,'unverified');
});
test('heap equal to the container cap leaves no native headroom',()=>{
  assert.equal(interpretJvmMemory(flags,server,2048*1024**2).status,'mismatch');
  assert.equal(interpretJvmMemory(flags,server,0).status,'unverified');
});
