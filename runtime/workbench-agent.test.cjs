'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const agent=require('./workbench-agent.js'),interaction=require('./interaction-timeout.js');
const {validateManifest}=require('./workbench-protocol.cjs');
test('权限按动作声明判断：带点的读取动作无需批准，伪装成 read 的写动作仍需批准',()=>{
  const manifest=validateManifest({id:'test',name:'test',ui:{entry:'index.html'},server:{entry:'index.cjs'},state:{schema:'test.v1'},actions:[{name:'fs.list',access:'read'},{name:'readAndDelete',access:'write'},{name:'elevate',access:'write',requiresConfirmation:true,inputSchema:{type:'object'}}]});
  assert.deepEqual(agent.access('callWorkbenchBackend',{action:'fs.list'},manifest),{access:'read',requiresConfirmation:false});
  assert.equal(agent.access('readAndDelete',{},manifest).access,'write');
  assert.equal(agent.access('callWorkbenchBackend',{action:'elevate'},manifest).requiresConfirmation,true);
  assert.deepEqual(manifest.actions[2].inputSchema,{type:'object'});
  assert.throws(()=>agent.access('callWorkbenchBackend',{action:'undeclared'},manifest),/undeclared/);
});
test('Agent 必须使用宿主完整生命周期验证后才能提交交互验证',()=>{
  assert.ok(agent.context().actions.includes('verifyWorkbench'));
  assert.equal(agent.access('verifyWorkbench').access,'write');
  assert.ok(agent.context().actions.includes('scaffoldWorkbench'));
  assert.equal(agent.access('scaffoldWorkbench').access,'write');
  assert.match(agent.context().prompt,/verifyWorkbench/);
  assert.match(agent.context().prompt,/打开会话.*关闭.*重新打开/);
  for(const action of ['inspectWorkbenchUI','actWorkbenchUI','captureWorkbenchUI'])assert.ok(agent.context().actions.includes(action));
  assert.equal(agent.access('inspectWorkbenchUI').access,'read');assert.equal(agent.access('actWorkbenchUI',{}).access,'write');
  assert.equal(agent.access('actWorkbenchUI',{}, {actions:[{name:'hardware.move',requiresConfirmation:true}]}).requiresConfirmation,true);
});
test('实时事件有界保存、游标分页，截断会明确告诉 Agent',()=>{
  const session={};for(let i=1;i<=120;i++)agent.recordEvent(session,{type:'terminal.data',payload:{text:String(i)}});
  const first=agent.readEvents(session,{after:0,limit:10});assert.equal(first.truncated,true);assert.equal(first.events[0].sequence,21);assert.equal(first.next,30);assert.equal(first.hasMore,true);
  const last=agent.readEvents(session,{after:119});assert.equal(last.events[0].event.payload.text,'120');assert.equal(last.hasMore,false);
  agent.recordEvent(session,{type:'terminal.data',payload:{text:'x'.repeat(9000)}});assert.equal(agent.readEvents(session,{after:120}).events[0].event.truncated,true);
});
test('自定义占位选项合并到输入区，不自动提交“其他”或删掉具体方案',()=>{
  const q={method:'select',options:['保留','其他（请说明）'],recommended:1};assert.equal(interaction.customIndex(q),1);assert.equal(interaction.autoAnswer(q,30),null);
  assert.equal(interaction.customIndex({options:['自定义需求']}),0);assert.equal(interaction.customIndex({options:['其他设备使用 USB 连接']}),-1);
});
