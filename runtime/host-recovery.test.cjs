'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const recovery = require('./agent-recovery.cjs');
const transport = require('./context-transport.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness(stops) {
  const events = [], calls = [], run = { id: 'same-run', taskId: 'task', input: { message: '工作台设计阶段：结构设计', context: { task: { id: 'task' }, policies: {} } }, tools: [{ tool: 'write', target: 'ui/index.html', status: 'done', output: 'saved' }], recoveryAttempts: 0, settlementWaiters: [], pendingSettlement: { event: { type: 'agent_settled' } }, lastAssistant: { role: 'assistant', content: [], stopReason: 'length' }, done: false, cancelled: false };
  let rebuilt = 0;
  const client = { process: { pid: 42, exitCode: null, stdin: { writable: true, destroyed: false } }, async prompt(text) {
    calls.push(text);
    const stop = stops.shift() || 'stop';
    queueMicrotask(() => {
      run.lastAssistant = { role: 'assistant', content: stop === 'stop' ? [{ type: 'text', text: 'verified final' }] : [], stopReason: stop };
      context.queueRunSettlement(run, { type: 'agent_settled' });
    });
  } };
  const context = vm.createContext({ agentRecovery: recovery, contextTransport: transport, activeRun: run, piClient: client, clearTimeout, setTimeout, console,
    broadcastAgent(event) { events.push(event); }, async stopPiClient() { rebuilt++; context.piClient = null; },
    async ensurePiClient() { rebuilt++; context.piClient = client; return client; }, async finishFileAudit() {},
    promptParts(_input, prompt) { return { prompt, images: [] }; }
  });
  const code = section('function queueRunSettlement(', 'async function ensurePiClient(');
  vm.runInContext(code + '\nglobalThis.processRunSettlements=processRunSettlements;globalThis.queueRunSettlement=queueRunSettlement;globalThis.waitForRunSettlement=waitForRunSettlement;', context);
  return { context, run, events, calls, get rebuilt() { return rebuilt; } };
}
test('host supervisor keeps one client and one run through length continuation', async () => {
  const h = harness(['stop']); h.context.queueRunSettlement(h.run, {type:'agent_settled'}); await h.run.settlementPromise;
  assert.equal(h.rebuilt, 0); assert.equal(h.calls.length, 1); assert.equal(h.run.recoveryAttempts, 1);
  assert.match(h.calls[0], /小型参数/); assert.match(h.calls[0], /ui\/index.html/);
  assert.equal(h.events.filter(e => e.type === 'agent_settled').length, 1);
  assert.equal(h.events.find(e => e.type === 'agent_settled').failure, undefined);
  assert.ok(h.events.every(e => e.runId === 'same-run'));
  assert.equal(h.run.done, true); assert.equal(h.context.activeRun, null);
});
test('host supervisor stops after two continuation attempts without replaying a write', async () => {
  const h = harness(['length', 'length']); h.context.queueRunSettlement(h.run, {type:'agent_settled'}); await h.run.settlementPromise;
  assert.equal(h.calls.length, 2); assert.equal(h.rebuilt, 0);
  const final = h.events.find(e => e.type === 'agent_settled');
  assert.equal(final.failure.code, 'OUTPUT_LIMIT'); assert.equal(final.failure.exhausted, true);
  assert.equal(h.run.tools.length, 1); assert.equal(h.run.tools[0].status, 'done');
});
test('host permission denial stops without sending a recovery prompt', async () => {
  const h = harness(['stop']); h.run.tools.push({ status: 'error', output: '用户未批准此操作' });
  h.context.queueRunSettlement(h.run, {type:'agent_settled'}); await h.run.settlementPromise;
  assert.equal(h.calls.length, 0); assert.equal(h.events.find(e => e.type === 'agent_settled').failure.code, 'PERMISSION');
});
test('provider settings can clear old output overrides instead of merging them back', async () => {
  let handler,stored;
  const context=vm.createContext({modelTiers:require('./model-tiers.js'),vendorList:()=>[],ipcMain:{handle(_name,fn){handler=fn;}},serializeProviderWrite:fn=>fn(),checkShell(){},readProviderConfig:async()=>({activeProfileId:'p',profiles:[{id:'p',model:'m',models:['m'],modelLimits:{m:{maxOutputTokens:12000}},apiKeyEncrypted:''}]}),providerProfiles:raw=>raw.profiles,cleanUrl:value=>value,storeProviderConfig:async raw=>{stored=raw;},publicConfig:value=>value});
  vm.runInContext(section("  ipcMain.handle('provider:save-config'", "  ipcMain.handle('provider:save-tiers'"),context);
  await handler({}, {profileId:'p',modelLimits:{}});
  assert.deepEqual(Object.keys(stored.profiles[0].modelLimits),[]);
});

test('task context bridge calls the enabled task reader directly, not the workbench renderer', async()=>{
  let onConnection;
  const context=vm.createContext({workbenchBridgeReady:null,workbenchBridge:null,net:{createServer(fn){onConnection=fn;return{once(){},listen(_port,_host,fn){fn();},address(){return{port:1234};}};}},require,activeRun:{done:false,cancelled:false,input:{context:{plugins:['task-context'],contexts:[{id:'plugin:task-context',kind:'plugin',actions:['readTaskContext']}],task:{id:'task',name:'当前任务',project:'项目',messageCount:2}}}},contextTransport:transport,allowedWorkbenchActions:new Set(),pendingWorkbenchRequests:new Map(),BrowserWindow:{getAllWindows(){throw new Error('must not dispatch plugin to workbench');}},setTimeout});
  vm.runInContext(section('async function ensureWorkbenchBridge(', 'function resolveWorkbenchRequest(')+'\nglobalThis.ensureWorkbenchBridge=ensureWorkbenchBridge;',context);
  const bridge=await context.ensureWorkbenchBridge();let onData,reply;
  const socket={on(_event,fn){onData=fn;},write(value){reply=JSON.parse(value);},end(value){reply=JSON.parse(value);}};
  onConnection(socket);onData(Buffer.from(JSON.stringify({id:'req',token:bridge.token,command:'readTaskContext'})+'\n'));
  assert.equal(reply.ok,true);assert.equal(reply.result.task,'当前任务');
  onData(Buffer.from(JSON.stringify({id:'req2',token:bridge.token,command:'readTaskContext',payload:{taskId:'other'}})+'\n'));
  assert.equal(reply.ok,false);assert.match(reply.error,/其他任务/);
});

test('settlement waiter times out and removes itself instead of blocking permanently', async () => {
  const h = harness([]); h.run.pendingSettlement = null;
  await assert.rejects(h.context.waitForRunSettlement(h.run, 10), /完成事件超时/);
  assert.equal(h.run.settlementWaiters.length, 0);
});
