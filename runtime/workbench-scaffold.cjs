'use strict';
const fs=require('node:fs/promises');
const fs0=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const tokens=require('./design-tokens.cjs');
// Sample backend test that follows the 后端测试规范 in runtime/design-workflow.js: every action's happy path,
// validation errors, revision conflicts, unknown actions, persistence/restore, manifest parity, server isolation,
// and one real child-process round trip over the stdio JSONL transport. No backticks or ${ } inside.
const STATE_TEST=String.raw`'use strict';
// 后端测试范例（按「后端测试规范」）：新增动作时照此补齐用例。
// 不得 mock 被测的 dispatch、领域、应用或传输代码；只允许替换外部设备/网络/硬件适配器。
// 全绿后请做变异检查：故意破坏后端逻辑（如删掉 revision 校验），这些测试必须变红，再恢复。
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {dispatch,ACTIONS}=require('../server/index.cjs');
const ROOT=path.join(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'),'utf8'));

test('manifest 声明的动作与后端实现一一对应',()=>{
  assert.deepEqual(manifest.actions.map(a=>a.name).sort(),[...ACTIONS].sort());
});

test('readState：返回当前状态，不改变 revision，不发事件',async()=>{
  const r=await dispatch({action:'readState',state:{revision:3,data:{a:1}}});
  assert.deepEqual(r.result,{revision:3,data:{a:1}});
  assert.equal(r.state.revision,3);
  assert.deepEqual(r.events,[]);
});

test('updateState：合并数据、revision 加一并发出 state.updated',async()=>{
  const r=await dispatch({action:'updateState',state:{revision:0,data:{keep:true}},payload:{baseRevision:0,patch:{hello:'world'}}});
  assert.deepEqual(r.state.data,{keep:true,hello:'world'});
  assert.equal(r.state.revision,1);
  assert.deepEqual(r.result,{revision:1});
  assert.deepEqual(r.events.map(e=>[e.type,e.payload.revision]),[['state.updated',1]]);
});

test('updateState：参数错误被拒，且不改动传入状态',async()=>{
  const state={revision:2,data:{x:1}};
  const before=structuredClone(state);
  for(const patch of [undefined,null,'text',[1]]){
    await assert.rejects(()=>dispatch({action:'updateState',state,payload:{baseRevision:2,patch}}),e=>e.code==='VALIDATION'&&/patch must be an object/.test(e.message));
  }
  assert.deepEqual(state,before);
});

test('updateState：旧 revision 被拒，状态不变；用最新 revision 重试成功',async()=>{
  const first=await dispatch({action:'updateState',state:{},payload:{baseRevision:0,patch:{v:1}}});
  await assert.rejects(()=>dispatch({action:'updateState',state:first.state,payload:{baseRevision:0,patch:{v:2}}}),e=>e.code==='REVISION_CONFLICT'&&/Revision conflict/.test(e.message));
  await assert.rejects(()=>dispatch({action:'updateState',state:first.state,payload:{patch:{v:2}}}),e=>e.code==='REVISION_CONFLICT');
  assert.equal(first.state.data.v,1);
  const retry=await dispatch({action:'updateState',state:first.state,payload:{baseRevision:1,patch:{v:2}}});
  assert.equal(retry.state.data.v,2);
  assert.equal(retry.state.revision,2);
});

test('未知动作被拒',async()=>{
  await assert.rejects(()=>dispatch({action:'deleteEverything',state:{},payload:{baseRevision:0}}),e=>e.code==='UNKNOWN_ACTION');
});

test('持久化与恢复：状态经 JSON 保存后继续调用，结果一致且 revision 连续',async()=>{
  let state={};
  for(let i=0;i<3;i++){
    const r=await dispatch({action:'updateState',state,payload:{baseRevision:i,patch:{['k'+i]:i}}});
    state=JSON.parse(JSON.stringify(r.state));
  }
  const read=await dispatch({action:'readState',state});
  assert.deepEqual(read.result,{revision:3,data:{k0:0,k1:1,k2:2}});
});

test('server 不依赖 DOM、window、Electron 或 ui/',()=>{
  const files=[];
  const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.[cm]?js$/.test(entry.name))files.push(file);}};
  walk(path.join(ROOT,'server'));
  assert.ok(files.length>0);
  for(const file of files){
    const source=fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(source,/\b(?:window|document|localStorage|navigator)\s*[.[]/,file);
    assert.doesNotMatch(source,/require\(\s*['"](?:electron|[^'"]*\/ui\/)[^'"]*['"]\s*\)/,file);
  }
});

// 真实子进程：经 server/transport/stdio.cjs 收发 JSONL，按 id 对应响应。
function startBackend(){
  const child=spawn(process.execPath,[path.join(ROOT,'server','transport','stdio.cjs')],{cwd:ROOT,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const waiting=new Map();
  let buffer='',stderr='',seq=0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      if(!line.trim())continue;
      const message=JSON.parse(line);
      const resolve=waiting.get(message.id);
      if(resolve){waiting.delete(message.id);resolve(message);}
    }
  });
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const exited=new Promise(resolve=>child.on('exit',code=>resolve(code)));
  return {
    pid:child.pid,
    raw:line=>child.stdin.write(line+'\n'),
    call(action,payload){
      const id=String(++seq);
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('后端 5 秒内没有响应：'+action+' '+stderr));},5000);
        waiting.set(id,message=>{clearTimeout(timer);resolve(message);});
        child.stdin.write(JSON.stringify({id,action,payload})+'\n');
      });
    },
    async stop(){
      child.stdin.end();
      const code=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),5000))]);
      if(code==='timeout')child.kill();
      return code;
    }
  };
}

test('stdio 端到端：真实子进程走通 读→写→冲突→参数错误→坏输入→未知动作→读回',async()=>{
  const backend=startBackend();
  let code;
  try{
    assert.ok(backend.pid>0,'子进程没有启动');
    const first=await backend.call('readState',{});
    assert.equal(first.ok,true);
    assert.deepEqual(first.state,{revision:0,data:{}});
    const written=await backend.call('updateState',{baseRevision:0,patch:{name:'测试'}});
    assert.equal(written.ok,true);
    assert.equal(written.state.revision,1);
    assert.deepEqual(written.events.map(e=>e.type),['state.updated']);
    const stale=await backend.call('updateState',{baseRevision:0,patch:{name:'覆盖'}});
    assert.equal(stale.ok,false);
    assert.equal(stale.code,'REVISION_CONFLICT');
    const invalid=await backend.call('updateState',{baseRevision:1,patch:'x'});
    assert.equal(invalid.ok,false);
    assert.equal(invalid.code,'VALIDATION');
    backend.raw('这不是 JSON');
    const unknown=await backend.call('noSuchAction',{});
    assert.equal(unknown.ok,false);
    assert.equal(unknown.code,'UNKNOWN_ACTION');
    const back=await backend.call('readState',{});
    assert.deepEqual(back.state,{revision:1,data:{name:'测试'}});
  }finally{
    code=await backend.stop();
  }
  assert.equal(code,0,'关闭输入后后端进程应正常退出');
});
`;
// Template source lives outside prompts; only its contract is injected in design mode.
function filesFor({id,name,prompt=''}){
  const manifest={protocolVersion:'1.0',id,name,version:'0.1.0',ui:{entry:'index.html'},server:{entry:'index.cjs',runtime:'node'},state:{schema:id+'.v1'},actions:[{name:'readState',access:'read'},{name:'updateState',access:'write'}],events:['state.updated'],capabilities:['structured-state','semantic-events'],permissions:[]};
  return {
    'manifest.json':JSON.stringify(manifest,null,2),
    'agent/CONTEXT.md':String(prompt||'仅按需读取状态和调用声明动作。用户界面与 Agent 使用同一后端。'),
    'agent/TESTING.md':fs0.readFileSync(path.join(__dirname,'../contexts/workbench-testing.md'),'utf8'),
    'package.json':JSON.stringify({name:id,version:'0.1.0',private:true,scripts:{start:'node server/transport/stdio.cjs',test:'node --test tests/*.test.cjs'}},null,2),
    'ui/index.html':'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>'+String(name).replace(/[<>&"]/g,'')+'</title><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="layout.css"></head><body><main id="app"></main><script src="index.js"></script><script src="layout-runtime.js"></script></body></html>',
    // Tokens come from runtime/design-tokens.cjs, the single source shared with the host theme and the agent prompts.
    'ui/styles.css':tokens.css()+'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{min-height:100vh;padding:20px}h1,h2,h3{margin:0 0 8px;font-weight:600}h1{font-size:18px}h2{font-size:15px}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:var(--gap)}.panel{background:var(--surface);border-right:1px solid var(--line)}.hint{color:var(--muted);font-size:13px}button{min-height:32px;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:9px;padding:6px 12px;font:inherit;cursor:pointer}button:hover{background:var(--soft)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{background:var(--accent-strong);border-color:var(--accent-strong)}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input,select,textarea{min-height:32px;border:1px solid var(--line);border-radius:9px;padding:6px 10px;font:inherit;color:var(--text);background:var(--card)}.ok{color:var(--ok)}.warn{color:var(--warn)}.error{color:var(--error)}',
    'ui/layout.css':'/* 由「界面预览」里的布局设计自动生成；没有手动调整过布局时为空。 */\n',
    'ui/layout-runtime.js':fs0.readFileSync(path.join(__dirname,'layout-runtime.js'),'utf8'),
    'ui/index.js':"'use strict';\n// Blank by design. Build user interactions here.\n// 在「界面预览」与工作台里，后端只能经宿主通道 window.__wbTransport(action,payload) 调用；\n// 实时输出可订阅 window.__wbOnEvent(callback)，返回值是取消订阅函数。\n// 没有该通道时（例如直接打开本文件）请显示友好提示，不要报红色错误。\n",
    'ui/api/client.js':"export function createClient(transport){return {read:()=>transport('readState',{}),update:(patch,baseRevision)=>transport('updateState',{patch,baseRevision})};}\n",
    'ui/components/README.md':'可复用控件。只处理交互和展示，不导入 server。\n',
    'ui/pages/README.md':'页面组合与布局，设备状态来自后端状态快照。\n',
    'server/contracts/protocol.cjs':"'use strict';\nconst event=(type,payload)=>({type,payload,time:Date.now()});\nmodule.exports={event};\n",
    'server/domain/state.cjs':"'use strict';\nfunction normalize(state={}){return {revision:Number(state.revision)||0,data:state.data&&typeof state.data==='object'?structuredClone(state.data):{}};}\nmodule.exports={normalize};\n",
    'server/application/actions.cjs':String.raw`'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/protocol.cjs');
// 错误带 code，便于 UI 给出用户能懂的提示、测试精确断言：VALIDATION 参数错误、REVISION_CONFLICT 版本冲突、UNKNOWN_ACTION 未知动作。
function fail(code,message){const error=new Error(message);error.code=code;return error;}
const handlers={
  readState(next){return {state:next,result:next,events:[]};},
  updateState(next,payload){
    if(payload.baseRevision!==next.revision)throw fail('REVISION_CONFLICT','Revision conflict');
    if(!payload.patch||typeof payload.patch!=='object'||Array.isArray(payload.patch))throw fail('VALIDATION','patch must be an object');
    next.data={...next.data,...payload.patch};next.revision++;
    return {state:next,result:{revision:next.revision},events:[event('state.updated',{revision:next.revision})]};
  }
};
// 与 manifest.json 的 actions 保持一致；tests/state.test.cjs 会逐一对照。
const ACTIONS=Object.freeze(Object.keys(handlers));
async function dispatch({action,payload={},state={}}){
  if(!Object.prototype.hasOwnProperty.call(handlers,action))throw fail('UNKNOWN_ACTION','Unknown action');
  return handlers[action](normalize(state),payload||{});
}
module.exports={dispatch,ACTIONS};
`,
    'server/application/tasks/queue.cjs':"'use strict';\nfunction createQueue(){let tail=Promise.resolve();return {run(job){const pending=tail.catch(()=>{}).then(job);tail=pending;return pending;}};}\nmodule.exports={createQueue};\n",
    'server/ports/README.md':'领域需要的外部能力接口定义放在这里。示例：Camera.capture()、Processor.process(frame)、StateStore.save(state)。应用层依赖接口，不直接依赖 OpenCV 或摄像头 SDK。\n',
    'server/adapters/devices/README.md':'摄像头、串口、PLC 等设备适配器；负责连接、断开、错误和资源释放。\n',
    'server/adapters/processing/README.md':'OpenCV、GPU、推理库等处理引擎适配器。纯算法放 processing/，库和硬件绑定放这里。\n',
    'server/adapters/storage/README.md':'文件、数据库、任务表等存储适配器，不依赖 DOM 或 Electron。\n',
    'server/processing/README.md':'可单独测试的纯计算代码；禁止直接读取控件、操作设备或文件。\n',
    'server/index.cjs':"'use strict';\nconst {dispatch,ACTIONS}=require('./application/actions.cjs');\nconst {normalize}=require('./domain/state.cjs');\nmodule.exports={dispatch,ACTIONS,normalize,health:()=>({status:'healthy',issues:[]})};\n",
    'server/transport/stdio.cjs':"'use strict';\nconst readline=require('node:readline');\nconst {dispatch}=require('../index.cjs');\nconst {createQueue}=require('../application/tasks/queue.cjs');\nconst queue=createQueue();let state={};\nreadline.createInterface({input:process.stdin}).on('line',line=>{if(!line.trim())return;void queue.run(async()=>{let req;try{req=JSON.parse(line);const result=await dispatch({...req,state});state=result.state;process.stdout.write(JSON.stringify({id:req.id,ok:true,...result})+'\\n');}catch(error){process.stdout.write(JSON.stringify({id:req?.id??null,ok:false,code:error.code||(req?'ERROR':'BAD_REQUEST'),error:error.message})+'\\n');}});});\n",
    'tests/state.test.cjs':STATE_TEST,
    'tests/ui-scenarios.json':JSON.stringify({schema:1,initialState:{revision:0,data:{}},cases:[]},null,2),
    'tests/host-scenarios.json':JSON.stringify({initialState:{revision:0,data:{}},cases:[
      {action:'readState',payload:{},expect:{state:{revision:0,data:{}}}},
      {action:'updateState',payload:{baseRevision:'$revision',patch:{hostVerified:true}},expect:{state:{revision:1,'data.hostVerified':true},result:{revision:1}}},
      {action:'updateState',payload:{baseRevision:0,patch:{hostVerified:false}},errorCode:'REVISION_CONFLICT'},
      {action:'updateState',payload:{baseRevision:'$revision',patch:null},errorCode:'VALIDATION'}
    ]},null,2),
    'README.md':'# '+name+'\n\n离线工作台工程，UI 与 server 独立。\n\n- ui/：页面、控件、前端 API 适配。初始画布为空。\n- server/domain/：领域状态与校验。\n- server/application/：用例与任务调度。\n- server/ports/：设备、处理和存储接口。\n- server/adapters/：各硬件或外部库实现。\n- server/processing/：纯计算。\n- server/transport/：传输适配。\n- agent/：按需加载的能力提示词。\n\n运行 npm test 验证。npm start 启动 JSONL 后端，可独立于 Electron/浏览器运行。每行输入 {"id":"1","action":"readState"}，每行输出对应结果；失败时为 {"id":"1","ok":false,"code":"REVISION_CONFLICT","error":"..."}。后端当前在内存保持会话状态；生产持久化请实现 storage 接口。\n\n## 测试规范\n\ntests/state.test.cjs 是范例，新增动作时照此补齐：\n\n- manifest 里每个动作：正常路径、参数错误、版本冲突（写动作）各至少一条，断言具体值、状态和 revision；未知动作被拒；manifest 与后端实现逐一对照。\n- 持久化与恢复：状态经 JSON 保存后继续调用结果一致；若后端自己写文件，测试重启进程后读回，目录用系统临时目录。\n- 至少一条用例真实启动 node server/transport/stdio.cjs 子进程，经 JSONL 走通读、写、冲突、未知动作。\n- 不 mock 被测代码，只替换外部设备/网络适配器，并测试适配器失败时的提示。\n- 变异检查：故意破坏后端逻辑（如删掉 revision 校验），测试必须变红，再恢复。\n- server/ 不得依赖 DOM、window、Electron 或 ui/。\n\n允许依赖方向：UI → 传输接口；传输 → application → domain/ports；adapters 实现 ports。禁止 server 导入 UI/DOM/Electron。\n'
  };
}
async function scaffold(base,input={}){
  const id='workbench-'+crypto.randomBytes(6).toString('hex'),name=String(input.name||'新工作台').slice(0,120);
  const root=path.join(base,id);
  await fs.mkdir(root,{recursive:false});
  for(const [relative,content] of Object.entries(filesFor({id,name,prompt:input.prompt}))){const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{flag:'wx'});}
  return {id,name,path:root,files:Object.keys(filesFor({id,name})),preview:path.join(root,'ui','index.html')};
}
module.exports={scaffold,filesFor};
