'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {entityFolder,sourceFolder}=require('./file-trace.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-trace-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('项目与任务拥有独立目录，项目不会误指向任一子任务',async t=>{
  const base=await fixture(t),project={id:'p',name:'工程',tasks:[{id:'a',name:'任务甲'},{id:'b',name:'任务乙'}]};
  const p=await entityFolder(base,{kind:'project',project}),a=await entityFolder(base,{kind:'task',project,task:project.tasks[0]}),b=await entityFolder(base,{kind:'task',project,task:project.tasks[1]});
  assert.notEqual(a.path,b.path);assert.equal(path.dirname(path.dirname(a.path)),p.path);
  const index=JSON.parse(await fs.readFile(path.join(p.path,'.pi-trace/location.json'),'utf8'));assert.equal(index.tasks[0].path,a.path);
});
test('优先真实设计工程及历史工作路径，不静默替换丢失目录',async t=>{
  const base=await fixture(t),project={id:'p',name:'P'},task={id:'a',name:'A',design:{workspacePath:base},cwd:'wrong'};
  assert.equal((await entityFolder(base,{kind:'task',project,task})).path,base);
  assert.equal((await entityFolder(base,{kind:'task',project,task:{id:'b',messages:[{run:{cwd:base}}]}})).path,base);
  await assert.rejects(entityFolder(base,{kind:'task',project,task:{id:'c',path:path.join(base,'missing')}}),/目录不存在/);
});
test('源码目录区分内置与真实工程，拒绝无效工作台及不存在的源码',async t=>{
  const base=await fixture(t),root=path.join(base,'workbenches');await fs.mkdir(path.join(root,'qubo'),{recursive:true});
  const opts={workbenchRoot:root,exportRoot:path.join(base,'exports'),key:'qubo'};
  assert.equal((await sourceFolder(opts)).path,path.join(root,'qubo'));
  assert.equal((await sourceFolder({...opts,sourcePath:base})).kind,'project');
  await assert.rejects(sourceFolder({...opts,key:'../escape'}),/标识无效/);
  await assert.rejects(sourceFolder({...opts,sourcePath:path.join(base,'missing')}),/目录不存在/);
});
test('设计副本保留 UI/server、完整布局及 HTML，重复打开不覆盖用户源码',async t=>{
  const base=await fixture(t),root=path.join(base,'workbenches'),original=path.join(root,'mcu');
  await fs.mkdir(path.join(original,'ui'),{recursive:true});await fs.mkdir(path.join(original,'server'),{recursive:true});
  await fs.writeFile(path.join(original,'ui/index.js'),'original');await fs.writeFile(path.join(original,'server/index.cjs'),'backend');
  const opts={workbenchRoot:root,exportRoot:path.join(base,'exports'),key:'mcu',taskId:'task',design:true,state:{html:'<h1>我的界面</h1>',_layout:{revision:3,elements:{control:{x:12}}}}};
  const result=await sourceFolder(opts);assert.equal(result.kind,'design-copy');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.path,'.pi-design/state.json'),'utf8')),opts.state);
  assert.equal(await fs.readFile(path.join(result.path,'.pi-design/draft.html'),'utf8'),opts.state.html);
  await fs.writeFile(path.join(result.path,'ui/index.js'),'user edit');await sourceFolder(opts);
  assert.equal(await fs.readFile(path.join(result.path,'ui/index.js'),'utf8'),'user edit');
  assert.equal(await fs.readFile(path.join(result.path,'server/index.cjs'),'utf8'),'backend');
});
