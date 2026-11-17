'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createWriter}=require('./clipboard-write.cjs');
test('clipboard preserves Unicode, newlines and exact content',async()=>{
  let value;const write=createWriter({writeText:text=>value=text,readText:()=>value});
  assert.deepEqual(await write('中文\nE:\\工作台\\源码'),{ok:true});assert.equal(value,'中文\nE:\\工作台\\源码');
});
test('clipboard retries a temporary busy owner, then verifies the write',async()=>{
  let calls=0,value='',waits=0;const write=createWriter({writeText:text=>{if(++calls<3)throw Error('busy');value=text;},readText:()=>value},{sleep:async()=>{waits++;}});
  await write('retry');assert.equal(value,'retry');assert.equal(calls,3);assert.equal(waits,2);
});
test('clipboard silent failure rejects with an actionable error',async()=>{
  let calls=0;const write=createWriter({writeText:()=>calls++,readText:()=>''},{sleep:async()=>{}});
  await assert.rejects(write('sensitive data'),/内容未复制/);assert.equal(calls,4);
});
test('clipboard serializes copies and recovers after a rejected request',async()=>{
  let value='',disabled=true;const writes=[];const write=createWriter({writeText:text=>{writes.push(text);if(!disabled)value=text;},readText:()=>value},{attempts:1});
  await assert.rejects(write('first'));disabled=false;
  await Promise.all([write('second'),write('third')]);assert.deepEqual(writes,['first','second','third']);assert.equal(value,'third');
});
