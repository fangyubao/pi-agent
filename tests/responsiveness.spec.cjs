'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createStateStore}=require('../runtime/state-store.cjs');
const ROOT=path.resolve(__dirname,'..');
async function launch(profile){
  const exe=process.env.PI_WORKBENCH_TEST_EXE,app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();await page.waitForLoadState('load');await page.locator('#message-input').waitFor();
  if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
  return {app,page};
}
async function cleanup(profile){if(path.dirname(profile)!==os.tmpdir()||!path.basename(profile).startsWith('pi-response-'))throw new Error('Invalid cleanup path');await fs.rm(profile,{recursive:true,force:true});}
test('长轮次交错过程按需显示：切换快，历史可翻阅，执行图可定位旧步骤',async({},info)=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-response-'));let app;
  try{
    const heavy={id:'heavy',name:'长轮次设计任务',draft:'',messages:[],workbenches:{}};
    for(let turn=0;turn<12;turn++){
      heavy.messages.push({id:'u'+turn,role:'user',text:'检查全部控件并完成验证',time:turn});
      const steps=Array.from({length:700},(_,i)=>i%5?{id:'step-'+turn+'-'+i,kind:'tool',tool:'read',label:'读取文件',target:'ui/control-'+i+'.js',status:'done',output:'字段与页面保持同步。'.repeat(60)}:{id:'step-'+turn+'-'+i,kind:'text',text:'进度说明 '+turn+' / '+i+'：已经核对状态，现在检查下一项。'});
      heavy.messages.push({id:'a'+turn,role:'assistant',text:'第 '+turn+' 轮最终回复：页面和后端已完成检查。',time:turn,run:{status:'complete',hasFinal:true,label:'本轮已结束',startedAt:1000,finishedAt:2000,steps,changedFiles:[]}});
    }
    const state={schema:2,activeTask:'light',settings:{autoTranslate:false},deleted:[],plugins:[],projects:[{id:'p',name:'性能回归',expanded:true,tasks:[heavy,{id:'light',name:'空白任务',messages:[],draft:'',workbenches:{}}]}]};
    await createStateStore(path.join(profile,'chat-store')).save(state);
    const fx=await launch(profile);app=fx.app;const {page}=fx;const samples=[];
    for(const id of ['heavy','light','heavy']){
      samples.push(await page.evaluate(async id=>{const start=performance.now();document.querySelector('[data-action="select-task"][data-id="'+id+'"]').click();const handler=performance.now()-start;await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));return {id,handler,paint:performance.now()-start,nodes:document.querySelector('#messages').querySelectorAll('*').length};},id));
    }
    console.log('INTERLEAVED_PROCESS_PERFORMANCE '+JSON.stringify(samples));
    for(const sample of samples){expect(sample.handler).toBeLessThan(200);expect(sample.paint).toBeLessThan(350);expect(sample.nodes).toBeLessThan(4200);}
    const latest=page.locator('[data-message-id="a11"]');await expect(latest.locator('.assistant-bubble')).toContainText('第 11 轮最终回复');
    expect(await latest.locator('.agent-commentary').count()).toBeLessThan(5);
    await latest.locator('[data-process-page="older"]').click();await expect(latest.locator('[data-process-page="latest"]')).toBeVisible();
    const firstText=await latest.locator('.agent-commentary').first().textContent();
    await page.locator('[data-action="select-task"][data-id="light"]').click();await page.locator('[data-action="select-task"][data-id="heavy"]').click();
    await expect(latest.locator('.agent-commentary').first()).toHaveText(firstText);
    // Execution-graph navigation can reach a step outside the current page.
    await page.evaluate(()=>{const b=document.createElement('button');Object.assign(b.dataset,{action:'focus-run-step',message:'a11',step:'step-11-1'});document.body.append(b);b.click();b.remove();});
    await expect(latest.locator('[data-step="step-11-1"]')).toHaveAttribute('open','');
    await expect(latest.locator('[data-step="step-11-1"] pre')).toBeVisible();
    await latest.locator('[data-process-page="latest"]').click();await expect(latest.locator('.agent-commentary').last()).toContainText('11 / 695');
    await page.evaluate(()=>window.PiPersistence.flush());const saved=(await page.evaluate(()=>window.piDesktop.storage.load())).result.state.projects[0].tasks[0];
    expect(saved.messages.at(-1).run.steps).toHaveLength(700);expect(saved.messages).toHaveLength(24);
    await page.screenshot({path:info.outputPath('long-turn.png')});
  }finally{await app?.close();await cleanup(profile);}
});

test('关闭在慢保存时立即隐藏，异步保存最后草稿，重新打开完整恢复',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-response-'));let app;
  try{
    const fx=await launch(profile);app=fx.app;const {page}=fx;await page.evaluate(()=>window.PiPersistence.flush());
    await app.evaluate(({ipcMain})=>{
      const original=ipcMain._invokeHandlers.get('storage:save');ipcMain.removeHandler('storage:save');
      ipcMain.handle('storage:save',async(...args)=>{globalThis.__saveStarted=true;await new Promise(r=>globalThis.__releaseSave=r);return original(...args);});
      ipcMain.removeAllListeners('storage:save-sync');ipcMain.on('storage:save-sync',event=>{globalThis.__syncSave=true;event.returnValue={ok:false,error:'Synchronous close forbidden'};});
    });
    await page.locator('#message-input').fill('关闭前尚未发送的最后草稿');
    const closed=page.waitForEvent('close'),start=Date.now();await page.locator('#win-close').click();
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()))).toBe(true);
    expect(Date.now()-start).toBeLessThan(800);
    await expect.poll(()=>app.evaluate(()=>Boolean(globalThis.__saveStarted))).toBe(true);
    expect(page.isClosed()).toBe(false);expect(await app.evaluate(()=>Boolean(globalThis.__syncSave))).toBe(false);
    await app.evaluate(()=>globalThis.__releaseSave());await closed;await app.close();app=null;
    const again=await launch(profile);app=again.app;await expect(again.page.locator('#message-input')).toHaveValue('关闭前尚未发送的最后草稿');
  }finally{await app?.close();await cleanup(profile);}
});

test('关闭保存失败恢复窗口并允许重试，不丢草稿',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-response-'));let app;
  try{
    const fx=await launch(profile);app=fx.app;const {page}=fx;await page.evaluate(()=>window.PiPersistence.flush());
    await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('storage:save');globalThis.__failSave=true;ipcMain.removeHandler('storage:save');ipcMain.handle('storage:save',(...args)=>globalThis.__failSave?{ok:false,error:'测试：磁盘暂时不可写'}:original(...args));});
    await page.locator('#message-input').fill('失败后保留');await page.locator('#win-close').click();
    await expect(page.locator('#toast')).toContainText('关闭前保存失败');
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await expect(page.locator('#message-input')).toHaveValue('失败后保留');await app.evaluate(()=>globalThis.__failSave=false);
    const closed=page.waitForEvent('close');await page.locator('#win-close').click();await closed;
    const loaded=await createStateStore(path.join(profile,'chat-store')).load();expect(loaded.state.projects[0].tasks[0].draft).toBe('失败后保留');
  }finally{await app?.close();await cleanup(profile);}
});
