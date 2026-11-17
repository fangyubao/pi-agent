'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
test.use({video:'off'});

test('长设计对话继续设计：立即显示侧栏且保留消息、草稿、展开状态与滚动位置',async({},info)=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.open-performance-'));
  const packaged=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:packaged||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(packaged?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  try{
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,960));
    const page=await app.firstWindow();await page.waitForLoadState('load');
    if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    const dir=await page.evaluate(async()=>(await window.piDesktop.workbench.scaffold({name:'重新打开性能检查'})).result.path);
    fs.writeFileSync(path.join(dir,'ui/index.html'),'<!doctype html><html><body><h1>已保存的设计</h1><button id="ready">可编辑控件</button></body></html>');
    await page.evaluate(async dir=>{
      await window.PiPersistence.flush();const saved=await window.piDesktop.storage.load(),s=saved.result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
      s.settings.autoTranslate=false;s.settings.composer={...s.settings.composer,capacity:false};t.design.workspacePath=dir;t.workbenchSession.open=false;t.draft='尚未发送的设计要求';
      t.messages=Array.from({length:121},(_,i)=>{
        const m={id:'open-history-'+i,role:i%2?'user':'assistant',text:'布局记录 '+i+'\n\n保留控件的布局与数据绑定。'.repeat(12),time:1700000000000+i*60000};
        if(m.role==='assistant'){
          const steps=Array.from({length:26},(_,j)=>({kind:'tool',id:'tool-'+i+'-'+j,tool:'read',label:'读取文件',target:'ui/control-'+j+'.js',status:'done',output:'操作返回：布局与绑定一致。'.repeat(125)}));
          m.run={status:'complete',label:'本轮已结束',hasFinal:true,startedAt:m.time,finishedAt:m.time+55000,steps,changedFiles:[],graph:{version:1,nodes:steps.map((s,j)=>({id:s.id,stepId:s.id,kind:'tool',tool:'read',label:'读取文件',target:s.target,status:'done',dependencies:j?[steps[j-1].id]:[],startedAt:m.time+j*1000,finishedAt:m.time+j*1000+900,startOrder:j*2,finishOrder:j*2+1}))}};
        }return m;
      });localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));await window.piDesktop.storage.save({state:s,mirrorHash:''});
    },dir);
    await page.reload();await expect(page.locator('.message')).toHaveCount(process.env.PI_UI_PERF_BASELINE==='1'?121:24);
    expect((await page.evaluate(()=>window.piDesktop.storage.load())).result.state.projects.flatMap(p=>p.tasks).find(t=>t.design).messages).toHaveLength(121);
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toContainText('继续设计');
    await page.waitForTimeout(700);
    const samples=[];
    for(let attempt=0;attempt<3;attempt++){
      const result=await page.evaluate(async()=>{
        const box=document.querySelector('#messages'),message=box.querySelector('[data-message-id="open-history-118"]'),input=document.querySelector('#message-input');
        box.scrollTop=Math.max(0,box.scrollHeight-box.clientHeight-1600);
        const detail=message.querySelector('.tool-group');detail.open=true;window.PiChatHistory?.hydrate(detail);
        const anchor=[...box.querySelectorAll('.message')].find(el=>{const r=el.getBoundingClientRect(),b=box.getBoundingClientRect();return r.bottom>b.top;});
        const anchorId=anchor.dataset.messageId,offset=anchor.getBoundingClientRect().top-box.getBoundingClientRect().top;
        const model=document.querySelector('#composer-model'),approval=document.querySelector('#approval-mode');
        let renders=0,contextBuilds=0,saveMs=0;const oldMarkup=window.PiTranscript.progressMarkup,oldInspector=window.PiContextInspector,oldSave=window.PiPersistence.save;
        window.PiTranscript.progressMarkup=function(...args){renders++;return oldMarkup.apply(this,args);};
        window.PiContextInspector={...oldInspector,buildSnapshot(...args){contextBuilds++;return oldInspector.buildSnapshot(...args);}};
        window.PiPersistence.save=function(...args){const start=performance.now();try{return oldSave.apply(this,args);}finally{saveMs+=performance.now()-start;}};
        const start=performance.now();document.querySelector('[data-action="toggle-task-workbench"]').click();const handlerMs=performance.now()-start;
        await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));const firstPaintMs=performance.now()-start;
        const sideVisible=!document.querySelector('#workbench-panel').hidden;
        await new Promise(r=>setTimeout(r,600));
        window.PiTranscript.progressMarkup=oldMarkup;window.PiContextInspector=oldInspector;window.PiPersistence.save=oldSave;
        const newBox=document.querySelector('#messages'),newAnchor=newBox.querySelector('[data-message-id="'+anchorId+'"]');
        return {handlerMs,firstPaintMs,renders,contextBuilds,saveMs,sideVisible,retainedMessage:message.isConnected,retainedInput:input===document.querySelector('#message-input'),retainedControls:model===document.querySelector('#composer-model')&&approval===document.querySelector('#approval-mode'),detailOpen:detail.isConnected&&detail.open,anchorDelta:newAnchor.getBoundingClientRect().top-newBox.getBoundingClientRect().top-offset};
      });samples.push(result);
      await expect(page.frameLocator('#preview-frame').locator('#ready')).toBeVisible();
      await expect(page.locator('#message-input')).toHaveValue('尚未发送的设计要求');
      await page.locator('[data-action="toggle-task-workbench"]').click();await expect(page.locator('#workbench-panel')).toBeHidden();
    }
    console.log('WORKBENCH_OPEN_PERFORMANCE '+JSON.stringify(samples));await info.attach('open-performance.json',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
    if(process.env.PI_UI_PERF_BASELINE!=='1')for(const sample of samples){expect(sample.retainedMessage).toBe(true);expect(sample.retainedInput).toBe(true);expect(sample.retainedControls).toBe(true);expect(sample.detailOpen).toBe(true);expect(sample.renders).toBe(0);expect(sample.contextBuilds).toBe(0);expect(sample.sideVisible).toBe(true);expect(Math.abs(sample.anchorDelta)).toBeLessThan(3);expect(sample.handlerMs).toBeLessThan(150);}
    await page.locator('[data-action="toggle-task-workbench"]').click();await expect(page.frameLocator('#preview-frame').locator('#ready')).toBeVisible();
    await page.screenshot({path:info.outputPath('resume-design.png')});
    // Closing must unload the page and its Agent context even though chat DOM is retained.
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect.poll(()=>page.evaluate(()=>window.PiContextManager.snapshot().mode)).toBe('base');
    expect(await page.locator('#preview-frame').getAttribute('src')).toBeFalsy();
    await page.reload();await expect(page.locator('[data-action="toggle-task-workbench"]')).toContainText('继续设计');await expect(page.locator('#message-input')).toHaveValue('尚未发送的设计要求');
  }finally{await app.close();const resolved=path.resolve(profile);if(resolved.startsWith(ROOT+path.sep+'.open-performance-'))fs.rmSync(resolved,{recursive:true,force:true});}
});

test('继续设计保留输入与权限控件，开启的上下文容量在动态加载后更新',async()=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.open-performance-')),packaged=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:packaged||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(packaged?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  try{
    const page=await app.firstWindow();await page.waitForLoadState('load');
    if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-toggles').click();
    await page.locator('[data-composer-toggle="capacity"]').check();
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect.poll(()=>page.evaluate(()=>window.PiContextManager.snapshot().mode)).toBe('base');
    await page.locator('#message-input').fill('保留草稿与选择位置');
    await page.waitForTimeout(300);
    const synchronousBuilds=await page.evaluate(()=>{
      const original=window.PiContextInspector;window.__capacitySnapshots=[];
      window.PiContextInspector={...original,buildSnapshot(...args){const snapshot=original.buildSnapshot(...args);window.__capacitySnapshots.push({mode:window.PiContextManager.snapshot().mode,used:snapshot.usedTokens});return snapshot;}};
      window.__retainedComposer=document.querySelector('#message-input');window.__retainedApproval=document.querySelector('#approval-mode');
      document.querySelector('[data-action="toggle-task-workbench"]').click();return window.__capacitySnapshots.length;
    });
    expect(synchronousBuilds).toBe(0);
    await expect.poll(()=>page.evaluate(()=>window.__capacitySnapshots.at(-1)?.mode)).toBe('design');
    expect(await page.evaluate(()=>window.__retainedComposer===document.querySelector('#message-input')&&window.__retainedApproval===document.querySelector('#approval-mode'))).toBe(true);
    await expect(page.locator('#message-input')).toHaveValue('保留草稿与选择位置');
    await page.locator('#approval-mode').selectOption('full');
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('pi-workbench-design-v2')).settings.approval)).toBe('full');
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect.poll(()=>page.evaluate(()=>window.__capacitySnapshots.at(-1)?.mode)).toBe('base');
    await expect(page.locator('#context-capacity')).toBeVisible();
  }finally{await app.close();const resolved=path.resolve(profile);if(resolved.startsWith(ROOT+path.sep+'.open-performance-'))fs.rmSync(resolved,{recursive:true,force:true});}
});
