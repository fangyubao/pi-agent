'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
test.use({video:'off'});

// Deterministic renderer workload; no model calls or user profile are involved.
test('宽屏对话与复杂设计画布的刷新开销',async({},info)=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.ui-performance-'));
  const app=await electron.launch({executablePath:process.env.PI_WORKBENCH_TEST_EXE||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(process.env.PI_WORKBENCH_TEST_EXE?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  try{
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      BrowserWindow.getAllWindows()[0].setContentSize(1920,1080);
      ipcMain.removeHandler('provider:get-config');ipcMain.handle('provider:get-config',()=>({provider:'openai-compatible',model:'local-renderer-fixture',models:['local-renderer-fixture'],hasApiKey:false,profiles:[]}));
      ipcMain.removeHandler('agent:send');ipcMain.handle('agent:send',(_e,input)=>{global.__perfRun=input.runId;return {ok:true};});
      ipcMain.removeHandler('agent:abort');ipcMain.handle('agent:abort',()=>({ok:true}));
    });
    const page=await app.firstWindow();await page.waitForLoadState('load');
    await page.evaluate(()=>localStorage.setItem('pi-workbench-onboarding-v1','done'));await page.reload();
    await expect(page.locator('#message-input')).toBeVisible();
    await page.locator('#message-input').fill('本地测试');
    await page.evaluate(async()=>{
      await window.PiPersistence.flush();const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k));s.settings.autoTranslate=false;
      const t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
      t.messages=Array.from({length:80},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',time:Date.now(),text:('本地工作台操作记录，界面和后端状态同步。\n').repeat(35)}));
      t.messages.at(-1).text='已完成工作台检查。\n\n| 项目 | 结果 |\n| --- | --- |\n| 人机交互 | 状态同步正常 |\n| 本地运行 | 支持离线使用 |\n\n```js\nconst result = await workbench.run();\n```';
      localStorage.setItem(k,JSON.stringify(s));
    });await page.reload();await expect(page.locator('.message')).toHaveCount(process.env.PI_UI_PERF_BASELINE==='1'?80:24);
    expect((await page.evaluate(()=>window.piDesktop.storage.load())).result.state.projects[0].tasks[0].messages).toHaveLength(80);
    const dimensions=await page.evaluate(()=>({main:document.querySelector('.main').clientWidth,chat:document.querySelector('.chat-page').clientWidth,composer:document.querySelector('.composer').clientWidth,scrollbar:getComputedStyle(document.querySelector('#messages')).scrollbarColor}));
    await page.screenshot({path:info.outputPath('wide-chat.png')});
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    const dir=await page.evaluate(async()=>(await window.piDesktop.workbench.scaffold({name:'交互性能检查'})).result.path);
    fs.writeFileSync(path.join(dir,'ui','index.html'),'<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}main{display:grid;grid-template-columns:repeat(5,76px);gap:10px;padding:20px}button{height:32px}h1{font-size:18px}</style></head><body><h1>控件布局</h1><main>'+Array.from({length:500},(_,i)=>'<button id="control-'+i+'">控件 '+i+'</button>').join('')+'</main></body></html>');
    await page.evaluate(async dir=>{await window.PiPersistence.flush();const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k));s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask).design.workspacePath=dir;localStorage.setItem(k,JSON.stringify(s));},dir);
    await page.reload();await expect(page.locator('.task-preview-toggle')).toBeVisible();
    if(!await page.locator('#preview-surface').isVisible())await page.locator('.task-preview-toggle').click();
    const preview=page.frameLocator('#preview-frame');await expect(preview.locator('#control-0')).toBeVisible();
    await preview.locator('.design-mode-switch').click();await preview.locator('[data-design="layers"]').first().click();
    await preview.locator('.design-layer').filter({hasText:'button · control-0'}).first().click();
    const layout=await preview.locator('body').evaluate(async()=>{
      const list=document.querySelector('.design-layer-list'),first=list.firstChild,target=document.querySelector('#control-0'),input=document.querySelector('[name="x"]');
      const before=target.getBoundingClientRect().x,samples=[];let added=0;const observer=new MutationObserver(records=>{added+=records.reduce((n,r)=>n+r.addedNodes.length,0);});observer.observe(list,{childList:true});
      for(let i=1;i<=30;i++){await new Promise(requestAnimationFrame);const start=performance.now();input.value=String(i);input.dispatchEvent(new Event('change',{bubbles:true}));samples.push(performance.now()-start);}
      await new Promise(requestAnimationFrame);observer.disconnect();
      return {totalMs:samples.reduce((a,b)=>a+b,0),maxMs:Math.max(...samples),p95Ms:samples.sort((a,b)=>a-b)[Math.floor(samples.length*.95)],addedLayers:added,retainedLayer:first===list.firstChild,moved:target.getBoundingClientRect().x-before};
    });
    expect(layout.moved).toBeCloseTo(30);
    await expect(preview.locator('.design-mode-switch')).toHaveAttribute('aria-checked','true');
    await preview.locator('[aria-label="关闭图层"]').click();
    await page.locator('#message-input').fill('界面性能检查');await page.locator('#composer').evaluate(el=>el.requestSubmit());
    await expect(page.locator('[data-action="stop-agent"]')).toBeVisible();
    const emit=events=>app.evaluate(({BrowserWindow},events)=>{for(const event of events)BrowserWindow.getAllWindows()[0].webContents.send('agent:event',{...event,runId:global.__perfRun});},events);
    for(let i=0;i<20;i++)await emit([{type:'message_start',message:{role:'assistant'}},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'已检查控件 '+i+'，继续核对布局。'},{type:'toolCall',id:'call-'+i}]}},{type:'tool_execution_start',toolName:'read',toolCallId:'call-'+i,args:{path:'ui/control-'+i+'.js'}},{type:'tool_execution_end',toolCallId:'call-'+i,result:{content:[{type:'text',text:'本地数据读取完成。'.repeat(40)}]}}]);
    await emit([{type:'message_start',message:{role:'assistant'}}]);
    await page.waitForTimeout(300);
    await page.evaluate(()=>{
      window.__perf={progressRenders:0,mirrorWrites:0,saveMs:0,longTasks:[],frames:[],lastFrame:performance.now(),done:false};
      const p=window.__perf,markup=window.PiTranscript.progressMarkup,save=window.PiPersistence.save,setItem=Storage.prototype.setItem;
      window.PiTranscript.progressMarkup=function(...args){p.progressRenders++;return markup.apply(this,args);};
      window.PiPersistence.save=function(...args){const start=performance.now();try{return save.apply(this,args);}finally{p.saveMs+=performance.now()-start;}};
      Storage.prototype.setItem=function(k,v){if(k==='pi-workbench-design-v2')p.mirrorWrites++;return setItem.call(this,k,v);};
      p.observer=new PerformanceObserver(list=>p.longTasks.push(...list.getEntries().map(e=>e.duration)));p.observer.observe({type:'longtask'});
      const frame=now=>{p.frames.push(now-p.lastFrame);p.lastFrame=now;if(!p.done)requestAnimationFrame(frame);};requestAnimationFrame(frame);
      p.message=document.querySelector('.message.assistant:last-of-type');p.progress=p.message.querySelector('.run-progress');
    });
    for(let i=0;i<120;i++){await emit([{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'正在同步界面状态。'}}]);await page.waitForTimeout(8);}
    await page.waitForTimeout(180);
    const stream=await page.evaluate(()=>{const p=window.__perf;p.done=true;p.observer.disconnect();return {progressRenders:p.progressRenders,mirrorWrites:p.mirrorWrites,saveMs:p.saveMs,longTasks:p.longTasks.length,longTaskMaxMs:Math.max(0,...p.longTasks),frameP95Ms:p.frames.sort((a,b)=>a-b)[Math.floor(p.frames.length*.95)],retainedProgress:p.progress===document.querySelector('.message.assistant:last-of-type .run-progress')};});
    await expect(page.locator('.message.assistant').last().locator('.assistant-bubble .message-text')).toContainText('正在同步界面状态。'.repeat(120));
    await page.locator('[data-action="stop-agent"]').click();await expect(page.locator('[data-action="stop-agent"]')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('design-performance.png')});
    const result={dimensions,layout,stream};console.log('UI_PERFORMANCE '+JSON.stringify(result));
    await info.attach('performance.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
    if(process.env.PI_UI_PERF_BASELINE!=='1'){
      expect(dimensions.chat).toBeGreaterThan(1200);expect(dimensions.scrollbar).not.toBe('auto');
      expect(layout.retainedLayer).toBe(true);expect(layout.addedLayers).toBe(0);
      expect(stream.retainedProgress).toBe(true);expect(stream.progressRenders).toBeLessThan(5);expect(stream.mirrorWrites).toBeLessThan(20);
    }
  }finally{await app.close();const resolved=path.resolve(profile);if(resolved.startsWith(ROOT+path.sep+'.ui-performance-'))fs.rmSync(resolved,{recursive:true,force:true});}
});
