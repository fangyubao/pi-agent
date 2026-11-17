'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const workers=require('./workbench-worker-host.cjs');
const {scaffold}=require('./workbench-scaffold.cjs'),{createCatalog}=require('./workbench-catalog.cjs');

test('会话实时事件在动作返回后到达，任务隔离，关闭调用后端清理且不再转发',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-worker-stream-'));
  try{
    const source=(await scaffold(root,{name:'实时事件'})).path;
    await fs.writeFile(path.join(source,'server','index.cjs'),`const fs=require('node:fs'),path=require('node:path');module.exports={dispatch:()=>{throw new Error('必须使用会话入口')},createSession:({state,taskId})=>{
      let current={revision:0,...state},listener,timer;return {
        onEvent(fn){listener=fn;return ()=>{listener=null}},readState:()=>current,
        async call(action,payload){current={...current,revision:current.revision+1};timer=setTimeout(()=>listener?.({type:'terminal.data',payload:{taskId,text:payload.text}}),50);return {state:current,result:{taskId}};},
        async close(){clearTimeout(timer);fs.writeFileSync(path.join(__dirname,'closed-'+taskId),'closed')}
      };
    }};`);
    const receivedA=[],receivedB=[];
    assert.equal((await workers.executePath(source,{sessionId:'a',taskId:'a',action:'readState',state:{revision:4},payload:{text:'A'}},ev=>receivedA.push(ev))).state.revision,5);
    await workers.executePath(source,{sessionId:'b',taskId:'b',action:'readState',payload:{text:'B'}},ev=>receivedB.push(ev));
    await new Promise(r=>setTimeout(r,120));assert.deepEqual(receivedA.map(x=>x.payload.text),['A']);assert.deepEqual(receivedB.map(x=>x.payload.text),['B']);
    await workers.executePath(source,{sessionId:'a',taskId:'a',action:'readState',payload:{text:'closed'}});workers.closeSession(source,'a');
    for(let i=0;i<60&&!await fs.stat(path.join(source,'server','closed-a')).catch(()=>null);i++)await new Promise(r=>setTimeout(r,25));
    assert.equal(await fs.readFile(path.join(source,'server','closed-a'),'utf8'),'closed');assert.equal(receivedA.length,1);
  }finally{await workers.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('同一运行会话保留后端连接对象，任务隔离，关闭后释放，重开使用新实例',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-lifecycle-'));
  try{const source=(await scaffold(root,{name:'后端生命周期'})).path;
    await fs.writeFile(path.join(source,'server','index.cjs'),'let count=0;module.exports={dispatch:async()=>({state:{revision:0},result:{count:++count}})}');
    const call=sessionId=>workers.executePath(source,{sessionId,action:'readState'});
    assert.equal((await call('a')).result.count,1);assert.equal((await call('a')).result.count,2);assert.equal((await call('b')).result.count,1);
    workers.closeSession(source,'a');assert.equal((await call('a')).result.count,1);assert.equal((await call('b')).result.count,2);
  }finally{await workers.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('发布包含生产依赖与传递依赖，排除开发依赖，缺依赖不会破坏已发布版本',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-dependencies-'));await fs.mkdir(path.join(root,'workbench-projects'));
  try{const source=(await scaffold(path.join(root,'workbench-projects'),{name:'依赖工作台'})).path;
    const pkgFile=path.join(source,'package.json'),pkg=JSON.parse(await fs.readFile(pkgFile,'utf8'));pkg.dependencies={first:'1.0.0'};pkg.devDependencies={unused:'1.0.0'};await fs.writeFile(pkgFile,JSON.stringify(pkg));
    for(const name of ['first','second','unused']){const dir=path.join(source,'node_modules',name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.cjs',...(name==='first'?{dependencies:{second:'1.0.0'}}:{})}));await fs.writeFile(path.join(dir,'index.cjs'),name==='first'?'module.exports=require("second")':'module.exports=42');}
    const catalog=createCatalog(root),entry=await catalog.publish(source);assert.equal(entry.dependencies.packages,2);assert.equal(await fs.stat(path.join(entry.path,'node_modules','unused')).catch(()=>null),null);assert.equal(require(path.join(entry.path,'node_modules','first')),42);
    pkg.dependencies.missing='1.0.0';await fs.writeFile(pkgFile,JSON.stringify(pkg));await assert.rejects(catalog.publish(source),/缺少运行依赖 missing/);
    assert.equal((await catalog.list())[0].publishedAt,entry.publishedAt);assert.equal(require(path.join(entry.path,'node_modules','first')),42);
    const fork=await catalog.fork(entry.id);assert.equal(require(path.join(fork.path,'node_modules','first')),42);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('后端异常和结构化失败保留原因，不能伪装成功或污染状态，失败后仍可继续',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-worker-errors-'));
  try{const source=(await scaffold(root,{name:'异常隔离'})).path;
    await fs.writeFile(path.join(source,'server','index.cjs'),`module.exports={dispatch:async({payload,state})=>{
      if(payload.fail==='throw')throw Object.assign(new Error('设备未找到'),{code:'DEVICE_MISSING',details:{port:'TEST_PORT'}});
      if(payload.fail==='envelope')return {ok:false,error:{code:'CONNECT_FAILED',message:'连接失败',details:{target:'127.0.0.1'}},state:{revision:999}};
      return {state,result:{alive:true}};
    }};`);
    for(const fail of ['throw','envelope']){
      const r=await workers.executePath(source,{sessionId:'a',action:'readState',state:{revision:5},payload:{fail}});
      assert.equal(r.ok,false);assert.ok(r.failure.code);assert.ok(r.failure.details);assert.equal(r.state,undefined);
      assert.equal((await workers.executePath(source,{sessionId:'a',action:'readState'})).result.alive,true);
    }
  }finally{await workers.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('后端崩溃与关闭中的请求及时结束，重开不会接收旧会话的结果',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-worker-close-'));
  try{const source=(await scaffold(root,{name:'运行关闭'})).path;
    await fs.writeFile(path.join(source,'server','index.cjs'),`module.exports={dispatch:async({payload})=>{
      if(payload.crash)setTimeout(()=>{throw new Error('TEST_BACKEND_CRASH')},5);
      if(payload.wait)await new Promise(r=>setTimeout(r,5000));
      return {result:{alive:true}};
    }};`);
    const crashed=await workers.executePath(source,{sessionId:'a',action:'readState',payload:{crash:true,wait:true}});
    assert.equal(crashed.ok,false);assert.match(crashed.error,/TEST_BACKEND_CRASH/);
    assert.equal((await workers.executePath(source,{sessionId:'a',action:'readState'})).ok,true);
    const pending=workers.executePath(source,{sessionId:'a',action:'readState',payload:{wait:true}});
    workers.closeSession(source,'a');const fresh=workers.executePath(source,{sessionId:'a',action:'readState'});
    assert.equal((await pending).ok,false);assert.equal((await fresh).ok,true);
  }finally{await workers.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('关闭执行中的会话会丢弃排队动作，不执行迟到副作用，仍调用清理',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-worker-queue-'));
  try {
    const source=(await scaffold(root,{name:'关闭队列'})).path;
    await fs.writeFile(path.join(source,'server','index.cjs'),`const fs=require('node:fs'),path=require('node:path');module.exports={createSession:()=>({
      async call(action,payload){if(payload.slow){fs.writeFileSync(path.join(__dirname,'started'),'yes');await new Promise(r=>setTimeout(r,300));}if(payload.queued)fs.writeFileSync(path.join(__dirname,'side-effect'),'BAD');return {result:{alive:true}}},
      close(){fs.writeFileSync(path.join(__dirname,'cleaned'),'yes')}
    })};`);
    // scaffold's loader also requires a legacy dispatch export.
    await fs.appendFile(path.join(source,'server','index.cjs'),'module.exports.dispatch=()=>({});');
    const first=workers.executePath(source,{sessionId:'a',action:'readState',payload:{slow:true}});
    for(let i=0;i<100&&!await fs.stat(path.join(source,'server','started')).catch(()=>null);i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(await fs.stat(path.join(source,'server','started')));
    const queued=workers.executePath(source,{sessionId:'a',action:'readState',payload:{queued:true}});
    await workers.closeSession(source,'a');
    assert.equal((await first).ok,false);assert.equal((await queued).ok,false);
    assert.equal(await fs.stat(path.join(source,'server','side-effect')).catch(()=>null),null);
    assert.equal(await fs.readFile(path.join(source,'server','cleaned'),'utf8'),'yes');
  } finally {await workers.dispose();await fs.rm(root,{recursive:true,force:true});}
});
