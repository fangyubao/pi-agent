'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'persistence.js'),'utf8');
test('异步启动期间导入的旧记录不会被启动前快照覆盖',async()=>{
  const records=new Map(),saved=[],state=id=>({schema:2,projects:[{id,tasks:[]}],settings:{},deleted:[]});let release;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)},window:{piDesktop:{storage:{load:()=>new Promise(r=>release=r),save:async value=>{saved.push(value);return {ok:true};},saveSync:value=>{saved.push(value);return {ok:true};}}}}};
  records.set('pi-workbench-design-v2',JSON.stringify(state('old')));vm.runInNewContext(source,scope);const persistence=scope.window.PiPersistence,pending=persistence.load();
  records.set('pi-workbench-design-v2',JSON.stringify(state('new')));release({ok:true,result:{state:null}});assert.equal((await pending).projects[0].id,'new');
  const imported=state('imported');records.set('pi-workbench-design-v2',JSON.stringify(imported));persistence.save(state('old'));await persistence.flush();assert.equal(saved.at(-1).state.projects[0].id,'imported');
  persistence.close(state('old'));assert.equal(saved.at(-1).state.projects[0].id,'imported');
  const count=saved.length;persistence.save(state('late'));await persistence.flush();assert.equal(saved.length,count);
});

test('高频保存合并镜像与磁盘请求，flush 等待最新状态，关闭保留最后输入',async()=>{
  const records=new Map(),saved=[],releases=[];let writes=0;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>{writes++;records.set(k,v);},removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:input=>{saved.push(structuredClone(input));return new Promise(r=>releases.push(r));},saveSync:input=>{saved.push(structuredClone(input));return {ok:true};}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[],draft:''};
  for(let i=0;i<200;i++){state.draft=String(i);p.save(state,{defer:true});}
  assert.equal(writes,0);const flush=p.flush();await new Promise(setImmediate);assert.equal(writes,1);assert.equal(saved[0].state.draft,'199');
  for(let i=200;i<400;i++){state.draft=String(i);p.save(state,{defer:true});p.flush();}
  assert.equal(saved.length,1);releases.shift()({ok:true});await new Promise(setImmediate);
  assert.equal(saved.length,2);assert.equal(saved[1].state.draft,'399');releases.shift()({ok:true});await flush;assert.equal(writes,2);
  state.draft='最后输入';p.save(state,{defer:true});p.close(state);assert.equal(saved.at(-1).state.draft,'最后输入');
});

test('磁盘失败后保留最新待保存状态以便重试',async()=>{
  let fail=true;const saved=[],records=new Map();
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));return fail?{ok:false,error:'disk unavailable'}:{ok:true};}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence;p.save({schema:2,projects:[],draft:'retain'},{defer:true});
  await assert.rejects(p.flush(),/disk unavailable/);fail=false;await p.flush();assert.equal(saved.length,2);assert.equal(saved[1].state.draft,'retain');
});

test('任务补丁只传变化任务，元数据更新不重传历史，失败后完整重试',async()=>{
  const saved=[],records=new Map();let reject=false;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));if(reject)throw new Error('connection lost');return {ok:true};}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,activeTask:'a',settings:{},projects:[{id:'p',tasks:[{id:'a',messages:['original']},{id:'b',messages:['untouched']}]}]};
  p.save(state);await p.flush();assert.ok(saved[0].state);
  state.projects[0].tasks[0].messages.push('updated');p.save(state,{taskId:'a'});await p.flush();
  assert.equal(saved[1].state,undefined);assert.deepEqual(saved[1].patch.tasks.map(t=>t.id),['a']);assert.deepEqual(saved[1].patch.projects[0].taskIds,['a','b']);
  state.activeTask='b';p.save(state,{metaOnly:true,defer:true});await p.flush();assert.equal(saved[2].patch.tasks.length,0);assert.equal(saved[2].patch.meta.activeTask,'b');
  reject=true;state.projects[0].tasks[0].messages.push('retry');p.save(state,{taskId:'a'});await assert.rejects(p.flush(),/connection lost/);
  reject=false;await p.flush();assert.deepEqual(saved.at(-1).state.projects[0].tasks[0].messages,['original','updated','retry']);
});

test('流式保存只携带变化消息，多个消息的待保存修改合并',async()=>{
  const records=new Map(),saved=[];
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));return {ok:true};}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[{id:'p',tasks:[{id:'a',messages:[{id:'old',text:'keep'},{id:'active',text:''}]}]}]};
  p.save(state);await p.flush();const task=state.projects[0].tasks[0];
  for(let i=0;i<100;i++){task.messages[1].text+='delta';p.save(state,{taskId:'a',messageId:'active',defer:true});}
  task.messages.push({id:'new',text:'next'});task.draft='draft';p.save(state,{taskId:'a',messageId:'new',taskFields:['draft'],defer:true});await p.flush();
  const patch=saved.at(-1).patch;assert.equal(patch.tasks.length,0);assert.deepEqual(patch.taskPatches[0].messageIds,['old','active','new']);assert.deepEqual(patch.taskPatches[0].messages.map(m=>m.id),['active','new']);assert.deepEqual(patch.taskPatches[0].fields,{draft:'draft'});
});

test('保存期间新增修改不会丢失，补丁失败后使用最新完整状态',async()=>{
  const records=new Map(),saved=[];let release,blocking=false;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));if(blocking)return new Promise(r=>release=r);return {ok:true};}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[{id:'p',tasks:[{id:'a',draft:'a'},{id:'b',draft:'b'}]}]};
  p.save(state);await p.flush();blocking=true;
  state.projects[0].tasks[0].draft='first';p.save(state,{taskId:'a',defer:true});const pending=p.flush();await new Promise(setImmediate);
  state.projects[0].tasks[1].draft='second';p.save(state,{taskId:'b',defer:true});release({ok:false,error:'retry'});await assert.rejects(pending,/retry/);
  blocking=false;await p.flush();assert.deepEqual(saved.at(-1).state.projects[0].tasks.map(t=>t.draft),['first','second']);
});

test('工作台字段更新不传整段历史，与同批消息更新合并且重启读回一致',async t=>{
  const os=require('node:os'),fsp=require('node:fs/promises'),{createStorage}=require('./state-store-host.cjs');
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'pi-field-persistence-'));let storage=createStorage(dir);
  t.after(async()=>{await storage.close();if(path.dirname(dir)!==os.tmpdir())throw new Error('清理路径越界');await fsp.rm(dir,{recursive:true,force:true});});
  const records=new Map(),saved=[],scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:input=>{saved.push(structuredClone(input));return storage.request('save',input);}}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[{id:'p',tasks:[{id:'a',name:'设计任务',draft:'保留草稿',messages:[{id:'old',text:'保留历史'},{id:'active',text:'开始处理'}],workbenches:{},workbenchHistory:[],workbenchAudit:[]}]}]};
  p.save(state);await p.flush();const task=state.projects[0].tasks[0];
  task.workbenches={qubo:{revision:2,result:{bits:'1010',energy:-2}}};p.save(state,{taskId:'a',taskFields:['workbenches'],defer:true});
  task.workbenchHistory=[{id:'snapshot',revision:2}];task.workbenchAudit=[{id:'audit',label:'求解完成'}];p.save(state,{taskId:'a',taskFields:['workbenchHistory','workbenchAudit'],defer:true});
  task.messages[1].text='求解完成';p.save(state,{taskId:'a',messageId:'active',defer:true});await p.flush();
  const patch=saved.at(-1).patch;assert.deepEqual(patch.tasks,[]);assert.equal(patch.taskPatches[0].meta,null);assert.deepEqual(patch.taskPatches[0].messages,[task.messages[1]]);
  assert.deepEqual(Object.keys(patch.taskPatches[0].fields).sort(),['workbenchAudit','workbenchHistory','workbenches']);
  await storage.close();storage=createStorage(dir);assert.deepEqual((await storage.request('load')).result.state,state);
});

test('异步关闭只提交最后变更，等待在途保存，不发送同步全量快照',async()=>{
  const saved=[],records=new Map();let block=false,release,sync=0;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));if(block){block=false;await new Promise(r=>release=r);}return {ok:true};},saveSync:()=>{sync++;return {ok:true};},flush:async()=>({ok:true})}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[{id:'p',tasks:[{id:'a',messages:[{id:'old',text:'unchanged'}],draft:''}]}]};
  p.save(state);await p.flush();block=true;state.projects[0].tasks[0].draft='first';p.save(state,{taskId:'a',taskFields:['draft'],defer:true});const saving=p.flush();await new Promise(setImmediate);
  state.projects[0].tasks[0].draft='latest';p.save(state,{taskId:'a',taskFields:['draft'],defer:true});const closing=p.closeAsync(state);release();await Promise.all([saving,closing]);
  assert.equal(sync,0);assert.equal(saved.length,3);assert.equal(saved[2].state,undefined);assert.deepEqual(saved[2].patch.taskPatches[0].messages,[]);assert.equal(saved[2].patch.taskPatches[0].fields.draft,'latest');
});

test('异步关闭保存失败后保留脏状态，允许用户继续编辑并重试',async()=>{
  const saved=[],records=new Map();let fail=false;
  const scope={setTimeout,clearTimeout,document:{querySelector:()=>null},localStorage:{getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},window:{piDesktop:{storage:{save:async input=>{saved.push(structuredClone(input));return fail?{ok:false,error:'disk failed'}:{ok:true};},flush:async()=>({ok:true})}}}};
  vm.runInNewContext(source,scope);const p=scope.window.PiPersistence,state={schema:2,projects:[],draft:'first'};
  p.save(state);await p.flush();fail=true;state.draft='second';p.save(state,{defer:true});await assert.rejects(p.closeAsync(state),/disk failed/);
  state.draft='retry';p.save(state,{defer:true});fail=false;await p.closeAsync(state);assert.equal(saved.at(-1).state.draft,'retry');
});
