import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryForecast} from './memoryForecast';

test('sustained growth warns before the static threshold',()=>{
  const f=new MemoryForecast();
  assert.equal(f.approaching('pool',10000,12000,0,185000),false);
  assert.equal(f.approaching('pool',10100,12000,10000,185000),false);
  assert.equal(f.approaching('pool',10300,12000,20000,185000),true);
});
test('stable usage, GC drops, changed limits and stale gaps do not extrapolate old growth',()=>{
  for(const [used,limit,at] of [[9500,10000,20000],[9300,10000,20000],[9700,10500,20000],[9700,10000,60000]]) {
    const f=new MemoryForecast();
    f.approaching('pool',9000,10000,0,185000);
    f.approaching('pool',9500,10000,10000,185000);
    assert.equal(f.approaching('pool',used,limit,at,185000),false);
  }
});
test('repeated reads of the same sample do not manufacture a trend',()=>{
  const f=new MemoryForecast();
  for(let i=0;i<10;i++) assert.equal(f.approaching('s',9000,10000,0,185000),false);
});

test('normal JVM growth with ample capacity never schedules a shutdown',()=>{
  const f=new MemoryForecast();
  assert.equal(f.approaching('pool',1000,12000,0,185000),false);
  assert.equal(f.approaching('pool',2000,12000,10000,185000),false);
  assert.equal(f.approaching('pool',3000,12000,20000,185000),false);
});
