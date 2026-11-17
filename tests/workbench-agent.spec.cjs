'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const ROOT=path.resolve(__dirname,'..');test.use({video:'off'});
const call=(command,payload={})=>({command,payload});
async function launch(){
  const requests=[],answers=[];let steps=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const data of req)raw+=data;const body=JSON.parse(raw||'{}');requests.push(body);
    // Pi appends tool screenshots as synthetic user image messages. They are
    // evidence, not a new turn; keep counting tool results after the real prompt.
    const messages=body.messages||[],lastUser=messages.findLastIndex(x=>x.role==='user'&&!(Array.isArray(x.content)&&x.content.some(c=>c.type==='text'&&c.text==='Attached image(s) from tool result:'))),results=messages.slice(lastUser+1).filter(x=>x.role==='tool');
    if(results.length){const last=results.at(-1);try{answers.push(JSON.parse(last.content));}catch{answers.push(last.content);}}
    const step=steps[results.length],action=typeof step==='function'?step(answers.at(-1)):step,id='wb-'+requests.length;
    const delta=action?{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name:action.tool||'workbench_action',arguments:JSON.stringify(action.args||action)}}]}:{role:'assistant',content:'WB_AGENT_DONE'};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const [d,finish] of [[delta,null],[{},action?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:'local-agent-test',choices:[{index:0,delta:d,finish_reason:finish}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-agent-control-')),exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,960));
  await page.evaluate(async port=>{await window.PiProviderManager.saveConfig({provider:'openai-compatible',baseUrl:'http://127.0.0.1:'+port+'/v1',apiKey:'local-fixture',model:'local-agent-test',models:['local-agent-test']});},server.address().port);
  const result=await page.evaluate(()=>window.piDesktop.workbench.scaffold({name:'共享后端测试'})),dir=result.result.path;
  const file=path.join(dir,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));
  manifest.actions=[{name:'readState',access:'read'},{name:'fs.list',access:'read'},{name:'increment',access:'write'},{name:'fail',access:'read'},{name:'privileged',access:'write',requiresConfirmation:true}];fs.writeFileSync(file,JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir,'ui/index.html'),`<!doctype html><html><body><h1>共享后端</h1><button id="increment">增加计数</button><pre id="value"></pre><pre id="events"></pre><script>
    window.addEventListener('workbench-state',e=>document.querySelector('#value').textContent=JSON.stringify(e.detail));
    window.__wbOnEvent?.(e=>document.querySelector('#events').textContent+=e.payload.text);
    document.querySelector('#increment').onclick=async()=>{await window.__wbTransport('increment',{});};
  </script></body></html>`);
  fs.writeFileSync(path.join(dir,'server/index.cjs'),`const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(__dirname,'loaded'),'yes');
    exports.dispatch=async({state})=>({state,result:state});
    exports.createSession=({state})=>{let s={revision:0,count:0,...state},listener=null;return {readState:()=>s,onEvent:f=>{listener=f;return ()=>listener=null;},close:()=>fs.writeFileSync(path.join(__dirname,'closed'),'yes'),call:async(action)=>{
      if(action==='fail')return {ok:false,error:{code:'DEVICE_OFFLINE',message:'测试设备未连接',details:{action:'fail',device:'fixture-device'}}};
      if(action==='increment'){s={revision:s.revision+1,count:s.count+1};listener?.({type:'terminal.data',payload:{text:'count='+s.count}});}
      return {state:s,result:{count:s.count,action}};
    }};};`);
  await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
  await page.evaluate(dir=>{const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=dir;s.settings.approval='full';s.settings.automaticRecovery=false;s.settings.autoTranslate=false;localStorage.setItem(k,JSON.stringify(s));},dir);await page.reload();
  async function send(plan){steps=plan;answers.length=0;await page.evaluate(()=>{window.__events=[];window.piDesktop.agent.onEvent(e=>window.__events.push(e));});await page.locator('#message-input').fill('请检查并操作当前工作台');await page.locator('#composer').evaluate(f=>f.requestSubmit());}
  const settle=(timeout=45000)=>page.waitForFunction(()=>window.__events?.some(e=>e.type==='agent_settled'),null,{timeout});
  return {page,app,dir,profile,answers,requests,setPlan:plan=>{steps=plan;answers.length=0;},send,settle,close:async()=>{try{await app.close();}finally{server.close();fs.rmSync(profile,{force:true,recursive:true});}}};
}
test('Agent 从布局状态自行检查、启动试运行、操作后端与读取事件；UI 和 Agent 共享同一会话',async({},info)=>{
  const fx=await launch();try{
    const {page}=fx;
    await fx.send([call('inspectWorkbenchRuntime')]);await fx.settle();
    expect(fx.answers[0].runtimeReady).toBe(false);expect(fx.answers[0].manifest.actions.map(x=>x.name)).toContain('fs.list');
    expect(fs.existsSync(path.join(fx.dir,'server/loaded'))).toBe(false); // inspection must not execute backend code
    await fx.send([call('startWorkbenchTrial'),call('inspectWorkbenchUI'),call('callWorkbenchBackend',{action:'readState'}),call('callWorkbenchBackend',{action:'increment'}),call('callWorkbenchBackend',{action:'readState'}),call('readWorkbenchEvents')]);await fx.settle();
    expect(fx.answers[0].runtimeReady).toBe(true);expect(fx.answers[1].controls.some(c=>c.selector==='#increment')).toBe(true);expect(fx.answers[2].state.count).toBe(0);expect(fx.answers[4].state.count).toBe(1);
    expect(fx.answers[5].events.some(x=>x.event.payload.text==='count=1')).toBe(true);
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);await expect(page.locator('[data-action="toggle-trial"]')).toHaveText('停止试运行');
    const frame=page.frameLocator('#preview-frame');await expect(frame.locator('#value')).toContainText('"count":1');await expect(page.locator('#preview-hint')).toHaveText('');
    await fx.send([call('inspectWorkbenchUI'),call('actWorkbenchUI',{operation:'click',selector:'#increment'}),call('inspectWorkbenchUI'),call('callWorkbenchBackend',{action:'readState'})]);await fx.settle();
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);
    expect(fx.answers[0].controls.some(c=>c.selector==='#increment')).toBe(true);expect(fx.answers[1].ok,JSON.stringify(fx.answers)).toBe(true);expect(fx.answers[3].state.count).toBe(2);
    await expect(frame.locator('#value')).toContainText('"count":2');
    await fx.send([call('startWorkbenchTrial'),call('callWorkbenchBackend',{action:'readState'}),call('callWorkbenchBackend',{action:'increment'}),call('readWorkbenchEvents')]);await fx.settle();
    expect(fx.answers[1].state.count).toBe(2);expect(fx.answers[2].state.count).toBe(3);await expect(frame.locator('#value')).toContainText('"count":3');
    await page.screenshot({path:info.outputPath('agent-shared-runtime.png')});
    const sys=String(fx.requests.at(-1).messages[0].content);expect(sys).toContain('不再问“需要我修吗”');expect(sys).toContain('callWorkbenchBackend');
    await fx.send([call('stopWorkbenchTrial')]);await fx.settle();expect(fx.answers[0].runtimeReady).toBe(false);expect(fs.existsSync(path.join(fx.dir,'server/closed'))).toBe(true);
    await expect(page.locator('[data-action="toggle-trial"]')).toHaveText('试运行');await expect(frame.locator('.design-mode-switch')).toBeVisible();
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();await fx.send([call('readLayout')]);await fx.settle();expect(fx.answers[0].elements.length).toBeGreaterThan(0);await expect(frame.locator('.design-mode-switch')).toBeVisible();
  }finally{await fx.close();}
});
test('真实 Pi Agent 接收前端失败证据，编辑修复并自行重验，测试不污染当前试运行状态',async()=>{
  const fx=await launch();try{
    const {page}=fx,source=await page.evaluate(async()=>(await window.piDesktop.workbench.scaffold({name:'自主修复验收'})).result.path);
    require('./fixtures/workbench-ui.cjs').counter(source);
    const file=path.join(source,'ui/index.html');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace("document.querySelector('#increment').onclick=",'window.unbound='));
    await page.evaluate(async dir=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=dir;localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));},source);await page.reload();
    await fx.send([call('startWorkbenchTrial'),call('callWorkbenchBackend',{action:'updateState',payload:{baseRevision:0,patch:{count:41}}}),call('verifyWorkbench'),result=>result?.ok===false&&result.frontend?.failure?{tool:'edit',args:{path:file,oldText:'window.unbound=',newText:"document.querySelector('#increment').onclick="}}:null,call('verifyWorkbench'),call('callWorkbenchBackend',{action:'readState'})]);
    await fx.settle(100000);
    expect(fx.answers[2].ok).toBe(false);expect(fx.answers[2].frontend.failure.step).toBe(1);expect(fx.answers[2].frontend.failure.page.controls[0].selector).toBe('#increment');
    expect(fx.answers[4].ok,JSON.stringify(fx.answers)).toBe(true);expect(fx.answers[4].frontend.ok).toBe(true);expect(fx.answers[5].state.data.count).toBe(41);
    expect(fs.readFileSync(file,'utf8')).toContain("document.querySelector('#increment').onclick=");
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);
  }finally{await fx.close();}
});
test('请求批准模式：按声明放行读取动作，写操作被拒绝后不执行；错误有真实对象与原因',async()=>{
  const fx=await launch();try{
    const {page}=fx;await page.locator('[data-action="toggle-trial"]').click();await page.locator('#approval-mode').selectOption('ask');
    await fx.send([call('callWorkbenchBackend',{action:'fs.list'}),call('callWorkbenchBackend',{action:'increment'})]);
    await expect(page.locator('#agent-ui-form')).toContainText('批准 Agent 操作',{timeout:30000});
    expect(fx.answers[0].result.action).toBe('fs.list');await expect(page.locator('#agent-ui-form')).toContainText('increment');
    await page.locator('#agent-ui-form button[value="false"]').click();await fx.settle();expect(String(fx.answers[1])).toContain('用户未批准');
    await fx.send([call('callWorkbenchBackend',{action:'readState'}),call('callWorkbenchBackend',{action:'does.not.exist'}),call('callWorkbenchBackend',{action:'fail'})]);await fx.settle();
    expect(fx.answers[0].state.count).toBe(0);expect(String(fx.answers[1])).toContain('does.not.exist');expect(String(fx.answers[2])).toContain('测试设备未连接');expect(String(fx.answers[2])).toContain('DEVICE_OFFLINE');expect(String(fx.answers[2])).toContain('fixture-device');
    await fx.send([call('callWorkbenchBackend',{action:'privileged'})]);await expect(page.locator('#agent-ui-form')).toContainText('批准 Agent 操作',{timeout:30000});await page.locator('#agent-ui-form button[value="false"]').click();await fx.settle();expect(String(fx.answers[0])).toContain('用户未批准');
    await page.locator('#approval-mode').selectOption('full');await fx.send([call('callWorkbenchBackend',{action:'privileged'}),call('actWorkbenchUI',{operation:'click',selector:'#increment'})]);await fx.settle();
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);expect(fx.answers[0].result.action).toBe('privileged');expect(fx.answers[1].ok,JSON.stringify(fx.answers)).toBe(true);
  }finally{await fx.close();}
});
test('Agent 启动后台计算，与网页共享进度，取消后仍能读取会话',async()=>{
  const fx=await launch();try{
    const {page}=fx,file=path.join(fx.dir,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));manifest.actions.push({name:'calculate',access:'compute'});fs.writeFileSync(file,JSON.stringify(manifest));
    fs.writeFileSync(path.join(fx.dir,'server/index.cjs'),`exports.dispatch=async({action,state={},signal,progress})=>{if(action==='calculate'){for(let i=0;i<200;i++){if(signal.aborted)throw new Error('已取消');progress(i/200,'计算中');await new Promise(r=>setTimeout(r,100));}return {state:{revision:1,data:{answer:42}},result:{answer:42}};}return {state,result:state};};`);
    await fx.send([call('startWorkbenchTrial'),call('startWorkbenchJob',{action:'calculate'}),call('listWorkbenchJobs'),result=>call('cancelWorkbenchJob',{id:result?.jobs?.[0]?.id||'missing-job'})]);await fx.settle();
    expect(fx.answers[1].id).toBeTruthy();expect(fx.answers[2].jobs).toHaveLength(1);await expect(page.locator('#workbench-jobs')).toContainText('已取消');
    await fx.send([call('listWorkbenchJobs'),call('callWorkbenchBackend',{action:'readState'})]);await fx.settle();expect(fx.answers[0].jobs[0].status).toBe('cancelled');expect(fx.answers[1].ok).toBe(true);
  }finally{await fx.close();}
});
test('发布后的实际工作台同样支持 Agent 操作，关闭后卸载动作上下文',async()=>{
  const fx=await launch();try{
    const {page}=fx;
    const source=await page.evaluate(async()=>{const r=await window.piDesktop.workbench.scaffold({name:'正式运行测试'});return r.result.path;});
    require('./fixtures/workbench-ui.cjs').counter(source);
    fs.writeFileSync(path.join(source,'agent/CONTEXT.md'),'专业工作台约定：SHARED_DOMAIN_PROMPT');
    const knowledgeFile=path.join(fx.profile,'knowledge.txt');fs.writeFileSync(knowledgeFile,'校准规则：参考相位固定为三十度。');
    const knowledge=await page.evaluate(file=>window.piDesktop.knowledge.import([file]),knowledgeFile);expect(knowledge.ok).toBe(true);
    const verified=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),source);expect(verified.ok,JSON.stringify(verified)).toBe(true);
    const published=await page.evaluate(({path,knowledge})=>window.piDesktop.workbench.publish({path,knowledge}),{path:source,knowledge:knowledge.report});expect(published.ok,published.error).toBe(true);
    await page.evaluate(entry=>{const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);delete t.design;t.use={workbenchId:entry.id};t.workbenchSession={key:entry.id,mode:'use',sourcePath:entry.path,name:entry.name,open:true};localStorage.setItem(k,JSON.stringify(s));},published.result);await page.reload();
    await expect(page.frameLocator('#module-frame').locator('#increment')).toBeVisible();
    await fx.send([call('inspectWorkbenchRuntime'),call('callWorkbenchBackend',{action:'updateState',payload:{baseRevision:0,patch:{count:1}}})]);await fx.settle();expect(fx.answers[0].sourcePath).toBe(published.result.path);expect(fx.answers[1].state.data.count).toBe(1);
    await expect(page.frameLocator('#module-frame').locator('#value')).toHaveText('1');
    await fx.send([call('inspectWorkbenchUI'),call('actWorkbenchUI',{operation:'click',selector:'#increment'}),call('callWorkbenchBackend',{action:'readState'})]);await fx.settle();
    expect(fx.answers[0].controls.some(c=>c.selector==='#increment')).toBe(true);expect(fx.answers[1].ok,JSON.stringify(fx.answers)).toBe(true);expect(fx.answers[2].state.data.count).toBe(2);
    await expect(page.frameLocator('#module-frame').locator('#value')).toHaveText('2');
    await fx.send([call('captureWorkbenchUI')]);await fx.settle();
    const capture=await page.evaluate(()=>window.__events.find(e=>e.type==='tool_execution_end'&&e.toolName==='workbench_action')?.result?.details);
    expect(capture?.path).toBeTruthy();expect(fs.statSync(capture.path).size).toBeGreaterThan(100);
    await fx.send([call('searchWorkbenchKnowledge',{query:'参考相位'}),result=>call('readWorkbenchKnowledge',{sourceId:result.matches[0].sourceId})]);await fx.settle();expect(fx.answers[1].text).toContain('三十度');expect(String(fx.requests.at(-1).messages[0].content)).toContain('SHARED_DOMAIN_PROMPT');
    await page.locator('[data-action="close-side-tab"][data-tab="workbench"]').click();await fx.send([call('inspectWorkbenchRuntime')]);await fx.settle();expect(String(fx.answers[0])).toContain('未声明');
    expect(String(fx.requests.at(-1).messages[0].content)).not.toContain('"workbench-host"');
    expect(String(fx.requests.at(-1).messages[0].content)).not.toContain('SHARED_DOMAIN_PROMPT');
  }finally{await fx.close();}
});
test('完全批准模式下支持对话直接创建工作台并同回合试运行与全自动完成设计发布',async()=>{
  const fx=await launch();try{
    const {page}=fx;
    await page.evaluate(async()=>{await window.PiPersistence.flush();const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath='';if(t.workbenches?.builder)t.workbenches.builder.workspacePath='';localStorage.setItem(k,JSON.stringify(s));});
    await page.reload();
    await fx.send([call('scaffoldWorkbench',{name:'对话直建工作台'}),call('startWorkbenchTrial'),call('inspectWorkbenchUI')]);await fx.settle();
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);
    expect(fx.answers[0].sourcePath).toBeTruthy();expect(fx.answers[1].runtimeReady).toBe(true);expect(fx.answers[2].ready).toBe(true);expect(fx.answers[2].title).toBe('对话直建工作台');
    const scaffoldedPath=fx.answers[0].sourcePath;
    require('./fixtures/workbench-ui.cjs').counter(scaffoldedPath);
    await fx.send([call('stopWorkbenchTrial')]);await fx.settle();
    fx.setPlan([
      ()=>call('readDesignWorkflow'),
      last=>{const v=last?.result||last;return v.stage===3?call('verifyWorkbench'):call('reportDesignStage',{stage:v.stage,attemptId:v.attempt?.id,summary:'阶段'+v.stage+'全自动完成',evidence:['tests/workbench-agent.spec.cjs']});},
      ()=>call('readDesignWorkflow'),
      last=>{const v=last?.result||last;return call('reportDesignStage',{stage:v.stage,attemptId:v.attempt?.id,summary:'阶段'+v.stage+'全自动验证完成',evidence:['tests/workbench-agent.spec.cjs']});}
    ]);
    await page.locator('[data-action="auto-design"]').click();
    await expect(page.locator('.design-confirm-card')).toContainText('设计流程已确认完成',{timeout:90000});
    await expect(page.locator('[data-action="run-published-workbench"]')).toBeVisible();
    await expect(page.locator('#agent-ui-form')).toHaveCount(0);
  }finally{await fx.close();}
});
