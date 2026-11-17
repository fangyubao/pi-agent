'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
test.use({video:'off'});

test('后台持续回答时切换长对话、输入及滚动，不被其他任务结束或交互重绘',async({},info)=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.switch-performance-')),exe=process.env.PI_WORKBENCH_TEST_EXE,baseline=process.env.PI_UI_PERF_BASELINE==='1';
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  try{
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      BrowserWindow.getAllWindows()[0].setContentSize(1600,960);
      ipcMain.removeHandler('provider:get-config');ipcMain.handle('provider:get-config',()=>({provider:'openai-compatible',model:'local-fixture',models:['local-fixture'],profiles:[],hasApiKey:false}));
      ipcMain.removeHandler('agent:send');ipcMain.handle('agent:send',(_e,input)=>{globalThis.__switchRun=input.runId;return {ok:true};});
      ipcMain.removeHandler('agent:abort');ipcMain.handle('agent:abort',()=>({ok:true}));
    });
    const page=await app.firstWindow();await page.waitForLoadState('load');
    if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.locator('#message-input').fill('初始化性能测试');
    await page.evaluate(async()=>{
      await window.PiPersistence.flush();const loaded=await window.piDesktop.storage.load(),s=loaded.result.state;
      s.settings.autoTranslate=false;s.settings.composer={...s.settings.composer,capacity:false};
      for(const t of s.projects[0].tasks){
        t.messages=Array.from({length:301},(_,i)=>{const m={id:t.id+'-history-'+i,role:i%2?'user':'assistant',text:'历史记录 '+i+'\n\n'+('保持界面与状态一致。'.repeat(40)),time:1700000000000+i*60000};
          if(m.role==='assistant'){
            const steps=Array.from({length:26},(_,j)=>({kind:'tool',id:t.id+'-tool-'+i+'-'+j,tool:'read',label:'读取文件',target:'ui/control-'+j+'.js',status:'done',output:'读取结果：状态同步正常。'.repeat(12)}));
            m.run={status:'complete',label:'本轮已结束',hasFinal:true,startedAt:m.time,finishedAt:m.time+1000,steps,changedFiles:[],graph:{version:1,nodes:steps.map((x,j)=>({id:x.id,stepId:x.id,kind:'tool',label:'读取文件',status:'done',target:x.target,dependencies:j?[steps[j-1].id]:[],startedAt:m.time+j*30,finishedAt:m.time+j*30+20,startOrder:j*2,finishOrder:j*2+1}))}};
          }return m;});
      }
      localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));
    });await page.reload();await expect(page.locator('#message-input')).toBeVisible();await page.waitForTimeout(500);
    await page.locator('#message-input').fill('持续运行测试');await page.locator('#composer').evaluate(f=>f.requestSubmit());await expect(page.locator('[data-action="stop-agent"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{
      const wc=BrowserWindow.getAllWindows()[0].webContents;globalThis.__streamCount=0;
      globalThis.__streamTimer=setInterval(()=>wc.send('agent:event',{runId:globalThis.__switchRun,taskId:'bell',type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'后台分片'+(++globalThis.__streamCount)+'。'}}),15);
    });
    const samples=[];
    for(const id of ['qubo','bell','qubo','bell','qubo']){
      const result=await page.evaluate(async id=>{
        let renders=0,builds=0;const old=window.PiTranscript.progressMarkup,inspector=window.PiContextInspector;
        window.PiTranscript.progressMarkup=function(...args){renders++;return old.apply(this,args);};
        window.PiContextInspector={...inspector,buildSnapshot(...args){builds++;return inspector.buildSnapshot(...args);}};
        const start=performance.now();document.querySelector('[data-action="select-task"][data-id="'+id+'"]').click();const handlerMs=performance.now()-start;
        await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));const paintMs=performance.now()-start;
        window.PiTranscript.progressMarkup=old;window.PiContextInspector=inspector;
        return {id,handlerMs,paintMs,renders,builds,messages:document.querySelectorAll('.message').length,nodes:document.querySelector('#page').querySelectorAll('*').length};
      },id);samples.push(result);await page.waitForTimeout(150);
    }
    await page.locator('#message-input').fill('另一任务未发送的草稿');
    await page.evaluate(()=>{
      const input=document.querySelector('#message-input'),box=document.querySelector('#messages');input.focus();input.setSelectionRange(3,6);box.scrollTop=Math.max(0,box.scrollHeight-box.clientHeight-500);
      window.__switchView={input,box,top:box.scrollTop,frames:[],last:performance.now(),long:[],done:false};
      const p=window.__switchView;p.observer=new PerformanceObserver(list=>p.long.push(...list.getEntries().map(x=>x.duration)));p.observer.observe({type:'longtask'});
      const tick=now=>{p.frames.push(now-p.last);p.last=now;if(!p.done)requestAnimationFrame(tick);};requestAnimationFrame(tick);
    });
    await page.waitForTimeout(2800);
    await app.evaluate(({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;wc.send('agent:event',{runId:globalThis.__switchRun,taskId:'bell',type:'extension_ui_request',id:'switch-question',method:'input',title:'后台任务的问题'});});
    await page.waitForTimeout(120);
    await app.evaluate(({BrowserWindow})=>{clearInterval(globalThis.__streamTimer);const wc=BrowserWindow.getAllWindows()[0].webContents;wc.send('agent:event',{runId:globalThis.__switchRun,taskId:'bell',type:'message_end',message:{role:'assistant',content:[{type:'text',text:'后台任务已完成'}],stopReason:'stop'}});wc.send('agent:event',{runId:globalThis.__switchRun,taskId:'bell',type:'agent_settled'});});
    await page.waitForTimeout(350);
    const background=await page.evaluate(()=>{const p=window.__switchView;p.done=true;p.observer.disconnect();return {retainedInput:p.input===document.querySelector('#message-input'),retainedMessages:p.box===document.querySelector('#messages'),selection:[document.querySelector('#message-input').selectionStart,document.querySelector('#message-input').selectionEnd],scrollDelta:document.querySelector('#messages').scrollTop-p.top,frameMax:Math.max(0,...p.frames),longTaskMax:Math.max(0,...p.long),wrongQuestion:Boolean(document.querySelector('#agent-ui-form'))};});
    console.log('CHAT_SWITCH_PERFORMANCE '+JSON.stringify({samples,background}));await info.attach('switch-performance.json',{body:JSON.stringify({samples,background},null,2),contentType:'application/json'});
    if(!baseline){for(const x of samples){expect(x.handlerMs).toBeLessThan(180);expect(x.paintMs).toBeLessThan(250);expect(x.nodes).toBeLessThan(6000);expect(x.builds).toBe(0);}expect(background.retainedInput).toBe(true);expect(background.retainedMessages).toBe(true);expect(background.selection).toEqual([3,6]);expect(Math.abs(background.scrollDelta)).toBeLessThan(3);expect(background.wrongQuestion).toBe(false);expect(background.longTaskMax).toBeLessThan(120);}
    await expect(page.locator('#message-input')).toHaveValue('另一任务未发送的草稿');
    await page.locator('[data-action="select-task"][data-id="bell"]').click();await expect(page.locator('.message.assistant').last()).toContainText('后台任务已完成');
    await page.evaluate(()=>window.PiPersistence.flush());const disk=await page.evaluate(()=>window.piDesktop.storage.load());expect(disk.result.state.projects[0].tasks[0].messages).toHaveLength(303);
    await page.screenshot({path:info.outputPath('switching-after-stream.png')});
    if(!baseline){
      // Exercise real snapshot compression without transmitting a project from
      // the renderer, while animation and input remain usable.
      const backup=await page.evaluate(async()=>{
        const long=[];const observer=new PerformanceObserver(list=>long.push(...list.getEntries().map(x=>x.duration)));observer.observe({type:'longtask'});
        const result=await window.piDesktop.vault.backupSaved();await new Promise(r=>setTimeout(r,30));observer.disconnect();return {ok:result.ok,longTaskMax:Math.max(0,...long)};
      });expect(backup.ok).toBe(true);expect(backup.longTaskMax).toBeLessThan(100);console.log('CHAT_BACKUP_PERFORMANCE '+JSON.stringify(backup));
      await page.locator('#message-input').fill('后台连续操作压力测试');await page.locator('#composer').evaluate(f=>f.requestSubmit());await expect(page.locator('[data-action="stop-agent"]')).toBeVisible();
      await page.locator('[data-action="select-task"][data-id="qubo"]').click();
      await page.evaluate(()=>{window.__toolLong=[];window.__toolObserver=new PerformanceObserver(list=>window.__toolLong.push(...list.getEntries().map(x=>x.duration)));window.__toolObserver.observe({type:'longtask'});window.__toolInput=document.querySelector('#message-input');});
      await app.evaluate(({BrowserWindow})=>{
        const wc=BrowserWindow.getAllWindows()[0].webContents;let i=0;
        globalThis.__toolTimer=setInterval(()=>{const id='stress-'+i;wc.send('agent:event',{runId:globalThis.__switchRun,type:'tool_execution_start',toolCallId:id,toolName:'read',args:{path:'ui/'+i+'.js'}});wc.send('agent:event',{runId:globalThis.__switchRun,type:'tool_execution_end',toolCallId:id,result:{content:[{type:'text',text:'后台工具结果。'.repeat(200)}]}});if(++i===350){clearInterval(globalThis.__toolTimer);wc.send('agent:event',{runId:globalThis.__switchRun,type:'message_end',message:{role:'assistant',content:[{type:'text',text:'连续操作完成'}],stopReason:'stop'}});wc.send('agent:event',{runId:globalThis.__switchRun,type:'agent_settled'});}},6);
      });
      await expect(page.locator('#composer .send-button')).toBeEnabled({timeout:20000});
      const tools=await page.evaluate(()=>{window.__toolObserver.disconnect();return {longTaskMax:Math.max(0,...window.__toolLong),inputRetained:window.__toolInput===document.querySelector('#message-input')};});
      expect(tools.inputRetained).toBe(true);expect(tools.longTaskMax).toBeLessThan(120);console.log('CHAT_TOOL_PERFORMANCE '+JSON.stringify(tools));
      await page.locator('[data-action="select-task"][data-id="bell"]').click();await expect(page.locator('.message.assistant').last()).toContainText('连续操作完成');
      await page.evaluate(()=>window.PiPersistence.flush());const final=(await page.evaluate(()=>window.piDesktop.storage.load())).result.state.projects[0].tasks[0];expect(final.messages.at(-1).run.steps.filter(x=>x.kind==='tool')).toHaveLength(350);
    }
  }finally{await app.close();const resolved=path.resolve(profile);if(resolved.startsWith(ROOT+path.sep+'.switch-performance-'))fs.rmSync(resolved,{recursive:true,force:true});}
});
