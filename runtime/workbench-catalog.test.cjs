'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createCatalog}=require('./workbench-catalog.cjs');const {scaffold}=require('./workbench-scaffold.cjs');
test('本地发布保存目录、规范化入口、隔离源码；恢复幂等、重新发布移除旧产物',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-catalog-'));
  await fs.mkdir(path.join(profile,'workbench-projects'));
  try{const source=(await scaffold(path.join(profile,'workbench-projects'),{name:'计数工作台'})).path;
    const file=path.join(source,'manifest.json'),m=JSON.parse(await fs.readFile(file,'utf8'));m.server.entry='transport/stdio.cjs';await fs.writeFile(file,JSON.stringify(m));await fs.writeFile(path.join(source,'ui','obsolete.txt'),'old');
    const catalog=createCatalog(profile),entry=await catalog.publish(source);
    assert.equal(entry.name,'计数工作台');assert.notEqual(entry.path,source);assert.equal((await catalog.list()).length,1);
    const normalized=JSON.parse(await fs.readFile(path.join(entry.path,'manifest.json'),'utf8'));assert.equal(normalized.server.entry,'index.cjs');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).server.entry,'transport/stdio.cjs');
    assert.equal((await catalog.publish(source,{recover:true})).publishedAt,entry.publishedAt);
    await fs.unlink(path.join(source,'ui','obsolete.txt'));const second=await catalog.publish(source);assert.notEqual(second.path,entry.path);assert.equal(await fs.stat(path.join(second.path,'ui','obsolete.txt')).catch(()=>null),null);assert.ok(await fs.stat(path.join(entry.path,'ui','obsolete.txt')));assert.equal(second.releases.length,2);
    assert.equal((await fs.readdir(path.join(profile,'workbench-library'))).filter(n=>/pending|backup/.test(n)).length,0);
    const fork=await catalog.fork(entry.id);assert.notEqual(fork.path,entry.path);assert.equal(await fs.readFile(path.join(fork.path,'ui','index.html'),'utf8'),await fs.readFile(path.join(entry.path,'ui','index.html'),'utf8'));
    const state=await require('./workbench-runtime.cjs').dispatchPath(entry.path,{action:'readState'});assert.equal(state.ok,true);assert.equal(state.state.revision,0);
  }finally{await fs.rm(profile,{recursive:true,force:true});}
});
test('不合规的包不登记，并发恢复同一工程只产生一个工作台',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-catalog-'));
  await fs.mkdir(path.join(profile,'workbench-projects'));
  try{const catalog=createCatalog(profile);await assert.rejects(catalog.publish(path.join(profile,'missing')),/不能发布/);assert.deepEqual(await catalog.list(),[]);
    const source=(await scaffold(path.join(profile,'workbench-projects'),{name:'并发发布'})).path;
    const [a,b]=await Promise.all([catalog.publish(source,{recover:true}),catalog.publish(source,{recover:true})]);assert.equal(a.id,b.id);assert.equal(a.publishedAt,b.publishedAt);assert.equal((await catalog.list()).length,1);
  }finally{await fs.rm(profile,{recursive:true,force:true});}
});
