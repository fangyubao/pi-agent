'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createStateStore}=require('./state-store.cjs');
const {scaffold}=require('./workbench-scaffold.cjs');
const {createVerifier,contractCheck}=require('./workbench-lifecycle-verification.cjs');
const workers=require('./workbench-worker-host.cjs');
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-platform-'));t.after(async()=>{await workers.dispose();if(path.dirname(dir)!==os.tmpdir())throw new Error('清理路径越界');await fs.rm(dir,{recursive:true,force:true});});return dir;}
test('分块保存只写变化任务；索引损坏恢复完整上个版本',async t=>{
  const dir=await temporary(t),store=createStateStore(dir),state={schema:2,settings:{},deleted:[],projects:[{id:'p',tasks:[{id:'a',messages:['one']},{id:'b',messages:['keep']}]}]};
  await store.save(state);state.projects[0].tasks[0].messages.push('two');const second=await store.save(state);assert.equal(second.changed,1);
  assert.deepEqual((await store.load()).state,state);
  await fs.writeFile(path.join(dir,'current.json'),'{broken');const restored=await store.load();assert.equal(restored.recovered,true);assert.deepEqual(restored.state.projects[0].tasks[0].messages,['one']);
  await store.save(restored.state);assert.equal((await store.load()).state.projects[0].tasks[1].messages[0],'keep');
});
test('首次存档丢失内容文件时明确失败，不当成空数据覆盖',async t=>{
  const dir=await temporary(t),store=createStateStore(dir);await store.save({schema:2,projects:[],settings:{}});
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'current.json'),'utf8'));const file=path.resolve(dir,'objects',manifest.state+'.json');assert.equal(path.dirname(file),path.join(dir,'objects'));await fs.unlink(file);
  await assert.rejects(()=>store.load(),/无法恢复/);assert.ok(await fs.stat(path.join(dir,'current.json')));
});
test('工程包携带源码、重映射路径、校验完整性，不依赖原电脑',async t=>{
  const dir=await temporary(t),source=(await scaffold(dir,{name:'可迁移工程'})).path;
  const {encodePortable,decodePortable}=require('./project-package.cjs');
  const project={id:'p',name:'可迁移',tasks:[{id:'t',design:{workspacePath:source},workbenchSession:{sourcePath:source}}]};
  const encoded=await encodePortable(project,'password');const result=await decodePortable(encoded.text,'password',path.join(dir,'imported'));
  const restored=result.project.tasks[0].design.workspacePath;assert.notEqual(restored,source);assert.equal(result.project.tasks[0].workbenchSession.sourcePath,restored);
  assert.equal(await fs.readFile(path.join(restored,'server/index.cjs'),'utf8'),await fs.readFile(path.join(source,'server/index.cjs'),'utf8'));
  await assert.rejects(()=>decodePortable(encoded.text,'bad',path.join(dir,'bad')));
});
test('发布验证不能由关键词代替动作，死循环可超时且宿主保持响应',async t=>{
  const dir=await temporary(t),source=(await scaffold(dir,{name:'验证隔离'})).path;
  assert.throws(()=>contractCheck([{rel:'README.md',data:Buffer.from('readState updateState spawn stdin.write revision UNKNOWN_ACTION close reopen mutation fail')}],{actions:[{name:'readState',access:'read'},{name:'updateState',access:'write'}]}),/host-scenarios/);
  await fs.writeFile(path.join(source,'server/index.cjs'),'while(true){}');
  const verifier=createVerifier({timeoutMs:600}),before=Date.now();const result=await verifier.verify(source);assert.equal(result.ok,false);assert.equal(result.reason,'WORKBENCH_VERIFICATION_TIMEOUT');assert.ok(Date.now()-before<5000);
});
test('后台任务：进度可读、取消不杀会话、完成状态与 UI/Agent 共享',async t=>{
  const dir=await temporary(t),source=(await scaffold(dir,{name:'长计算'})).path;
  const manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));manifest.actions.push({name:'calculate',access:'compute'});await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify(manifest));
  await fs.writeFile(path.join(source,'server/index.cjs'),`module.exports={dispatch:async({action,state={},signal,progress})=>{if(action==='calculate'){for(let i=0;i<12;i++){if(signal?.aborted)throw new Error('已取消');progress?.(i/12,'计算中');await new Promise(r=>setTimeout(r,20));}return {state:{revision:(state.revision||0)+1,data:{answer:42}},result:{answer:42}};}return {state,result:state};}};`);
  const events=[],call=(action,payload={},from='ui')=>workers.executePath(source,{sessionId:'shared',taskId:'t',action,payload,source:from},event=>events.push(event));
  const first=await call('__jobs.start',{action:'calculate'},'agent');assert.ok(first.result.id);
  await new Promise(r=>setTimeout(r,80));const running=await call('__jobs.list');assert.equal(running.result.jobs[0].status,'running');assert.ok(running.result.jobs[0].progress>0);
  await call('__jobs.cancel',{id:first.result.id});await new Promise(r=>setTimeout(r,60));const cancelled=(await call('__jobs.get',{id:first.result.id})).result;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.error,'');
  const second=await call('__jobs.start',{action:'calculate'});let finished;for(let attempt=0;attempt<60;attempt++){finished=(await call('__jobs.get',{id:second.result.id})).result;if(finished.status==='completed'||finished.status==='failed')break;await new Promise(r=>setTimeout(r,30));}assert.equal(finished.status,'completed',JSON.stringify(finished));
  assert.equal((await call('readState',{},'agent')).state.data.answer,42);assert.ok(events.some(e=>e.type==='job.updated'&&e.payload.status==='completed'));
});
test('修改副本发布沿用身份，旧版保留，回退和停用可恢复',async t=>{
  const dir=await temporary(t);await fs.mkdir(path.join(dir,'workbench-projects'));const source=(await scaffold(path.join(dir,'workbench-projects'),{name:'版本'})).path;
  const catalog=require('./workbench-catalog.cjs').createCatalog(dir),first=await catalog.publish(source),fork=await catalog.fork(first.id);
  await fs.writeFile(path.join(fork.path,'ui','version.txt'),'v2');const second=await catalog.publish(fork.path);assert.equal(first.id,second.id);assert.equal((await catalog.list()).length,1);assert.notEqual(first.path,second.path);
  const back=await catalog.manage(first.id,'rollback',first.releaseId);assert.equal(back.path,first.path);assert.equal(back.releases.length,2);
  assert.equal((await catalog.manage(first.id,'disable')).disabled,true);assert.equal((await catalog.manage(first.id,'enable')).disabled,false);
});
test('知识库检索可命中文件尾部，保留来源版本，源文件改变会提示过期',async t=>{
  const dir=await temporary(t),file=path.join(dir,'source.txt');await fs.writeFile(file,'开头段落。'.repeat(10000)+'目标：量子门校准必须使用参考相位。');
  const index=require('./knowledge-index.cjs').createKnowledgeIndex(path.join(dir,'index'));const report=await index.build([file]);assert.equal(report.readCount,1);assert.equal(report.files[0].content,undefined);
  const hit=await index.search(report.indexId,'参考相位');assert.ok(hit.matches.length);assert.match(hit.matches[0].text,/参考相位/);assert.equal(hit.matches[0].stale,false);
  const read=await index.read(report.indexId,report.files[0].id,50000);assert.match(read.text,/参考相位/);
  await fs.appendFile(file,'更新');assert.equal((await index.search(report.indexId,'参考相位')).matches[0].stale,true);
  assert.equal((await index.read(report.indexId,report.files[0].id)).stale,true);
});
test('PDF 与 Word 实际文本提取在独立知识库进程中可用',async t=>{
  const dir=await temporary(t),files=await require('../tests/fixtures/knowledge-documents.cjs').createDocuments(dir),host=require('./knowledge-index-host.cjs');
  const result=await host.call(path.join(dir,'index'),'build',files);assert.equal(result.ok,true,result.error);assert.equal(result.result.readCount,2,JSON.stringify(result));
  const found=await host.call(path.join(dir,'index'),'search',result.result.indexId,'ReferencePhase');assert.equal(found.ok,true);assert.equal(new Set(found.result.matches.map(x=>x.sourceId)).size,2);
});
test('验证可取消，失败包含具体测试和报错，修正后重新加载新后端',async t=>{
  const dir=await temporary(t),source=(await scaffold(dir,{name:'取消及修复'})).path,verifier=createVerifier({timeoutMs:20000});t.after(()=>verifier.dispose());
  require('../tests/fixtures/workbench-ui.cjs').counter(source);
  const file=path.join(source,'server/application/actions.cjs'),original=await fs.readFile(file,'utf8');await fs.writeFile(file,original.replace('next.data={...next.data,...payload.patch};','next.data={...next.data};'));
  const failure=await verifier.verify(source);assert.equal(failure.ok,false);assert.equal(failure.reason,'WORKBENCH_TESTS_FAILED');assert.match(failure.stdout,/not ok/);assert.match(failure.message,/not ok/);
  await fs.writeFile(file,original);const pass=await verifier.verify(source);assert.equal(pass.ok,true,JSON.stringify(pass));
  await fs.writeFile(path.join(source,'server/index.cjs'),'while(true){}');const pending=verifier.verify(source);setTimeout(()=>verifier.cancel(source),300);const cancelled=await pending;assert.equal(cancelled.reason,'WORKBENCH_VERIFICATION_CANCELLED');
});
