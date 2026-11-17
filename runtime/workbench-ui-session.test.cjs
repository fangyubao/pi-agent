'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const agent=require('./workbench-agent.js'),library=require('./workbench-library.js');
const slice=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(custom=false){
  const state={revision:0,count:0},task={id:'t',workbenches:{demo:state},messages:[]};
  const frames=[],events=[];let callback;
  const h={active:{id:'demo',taskId:'t',runtimeId:'old',mode:'use',custom,runtimeState:state},trialSession:null,structuredClone,Map,Promise,Error,Date,
    window:{PiWorkbenchAgent:agent,PiWorkbenchLibrary:library,piDesktop:{workbench:{onEvent(fn){callback=fn;}}}},
    located:()=>({task}),save(){},renderSidePanel(){},$(){return {contentWindow:{postMessage(m){frames.push(m);}}}},
    applyWorkbenchState(c,key,state){c.task.workbenches[key]=state;},designFlow:{},agentStream:null,
  };
  vm.createContext(h);
  vm.runInContext(slice('  function assertWorkbenchSession(',"  window.addEventListener('message',event=>{"),h);
  return {h,task,frames,emit:m=>callback(m)};
}
test('UI 与 Agent 动作串行共享同一状态，动作事件与实时事件均可读取',async()=>{
  const {h,task,frames,emit}=harness(true);let calls=0;
  h.window.piDesktop.workbench.serverPath=async request=>{
    calls++;await new Promise(r=>setTimeout(r,5));
    return {ok:true,state:{revision:request.state.revision+1,count:request.state.count+1},events:[{type:'changed',payload:{source:request.source}}]};
  };
  const session=h.active;
  await Promise.all([h.runCustomAction(session,'increment',{},'ui'),h.runCustomAction(session,'increment',{},'agent')]);
  assert.equal(calls,2);assert.equal(task.workbenches.demo.count,2);assert.equal(session.runtimeState.count,2);
  emit({sessionId:'old',event:{type:'terminal.data',payload:{text:'live'}}});
  assert.equal(agent.readEvents(session).events.length,3);
  assert.deepEqual(frames.filter(x=>x.type==='runtime-state').map(x=>x.state.count),[1,2]);
  assert.equal(frames.at(-1).type,'runtime-event');
  h.active=null;emit({sessionId:'old',event:{type:'terminal.data',payload:{text:'late'}}});
  assert.equal(agent.readEvents(session).events.length,3);
});
for(const custom of [false,true])test(`${custom?'自定义':'内置'}工作台关闭重开拒绝旧动作结果和排队动作`,async()=>{
  const {h,task}=harness(custom),old=h.active,gate=deferred(),started=deferred();let calls=0;
  h.window.piDesktop.workbench[custom?'serverPath':'server']=async()=>{calls++;started.resolve();return gate.promise;};
  const run=h.runWorkbenchAction(old,'write',{},'ui');const queued=h.runWorkbenchAction(old,'write',{},'agent');
  const rejected=Promise.all([assert.rejects(run,/已关闭或已切换/),assert.rejects(queued,/已关闭或已切换/)]);
  await started.promise;
  h.active={...old,runtimeId:'new'};
  gate.resolve({ok:true,state:{revision:99,count:99},events:[{type:'late'}]});await rejected;
  assert.equal(calls,1);assert.equal(task.workbenches.demo.count,0);assert.equal(agent.readEvents(old).events.length,0);
  h.window.piDesktop.workbench[custom?'serverPath':'server']=async()=>({ok:true,state:{count:1,revision:1}});
  await h.runWorkbenchAction(h.active,'write',{},'agent');assert.equal(task.workbenches.demo.count,1);
});
test('关闭中的试运行拒绝 UI/Agent 调用及实时事件',async()=>{
  const {h,emit,frames}=harness(true);h.active.closing=true;
  h.window.piDesktop.workbench.serverPath=()=>{throw new Error('不应调用后端');};
  await assert.rejects(h.runCustomAction(h.active,'readState'),/已关闭/);
  emit({sessionId:'old',event:{type:'late'}});assert.equal(frames.length,0);
});
test('工作台隐藏模式选择，程序调用也不能开启拆分或画布',async()=>{
  let c={task:{id:'t',use:{workbenchId:'demo'},workflowOn:true}};let notified=0;
  const h={window:{PiWorkbenchLibrary:library},current:()=>c,agentStream:null,notify(){notified++;},renderChat(){},
    composerOn:()=>false,active:null,icon:()=>'',esc:x=>x};vm.createContext(h);
  vm.runInContext(slice('  const workflowEnabled=', '  // 返回 true'),h);
  vm.runInContext(slice('  function composerToolsHtml(', '  function renderChat('),h);
  const html=()=>h.composerToolsHtml(null,{capacityHelp:'',interactiveHelp:'',tokenRate:'',controlsApproval:''});
  assert.ok(!html().includes('task-mode'));
  await h.setTaskMode('workflow');assert.equal(notified,1);
  await h.openWorkflowCanvas(c); // no desktop or frame stub: an accidental entry fails.
  c={task:{id:'basic'}};assert.ok(html().includes('task-mode'));
});
