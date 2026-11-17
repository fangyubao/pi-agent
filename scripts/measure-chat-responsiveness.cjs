'use strict';
// Read an existing store into an isolated, offline diagnostic profile. Only
// aggregate timings are printed; no credentials, message text or source files.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const { _electron:electron }=require('@playwright/test');
const {createStateStore}=require('../runtime/state-store.cjs');
const ROOT=path.resolve(__dirname,'..');
(async()=>{
  const source=process.argv[2];if(!source)throw new Error('Pass a chat-store directory');
  const {state}=await createStateStore(path.resolve(source)).load();
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pi-ui-measure-'));
  let app;
  try{
    state.settings={...state.settings,autoTranslate:false,firstLaunchSeen:true};
    state.plugins=[];
    for(const project of state.projects){delete project.path;delete project.workspacePath;project.expanded=true;
      for(const task of project.tasks){delete task.workspacePath;delete task.path;task.pending=null;if(task.workbenchSession)task.workbenchSession.open=false;if(task.design)delete task.design.workspacePath;}}
    await createStateStore(path.join(profile,'chat-store')).save(state);
    const exe=process.env.PI_WORKBENCH_TEST_EXE;
    app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const page=await app.firstWindow();await page.waitForLoadState('load');
    await page.locator('#message-input').waitFor();
    if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
    const tasks=state.projects.flatMap(p=>p.tasks).sort((a,b)=>JSON.stringify(b.messages).length-JSON.stringify(a.messages).length),heavy=tasks[0],light=tasks.find(t=>!t.messages.length)||tasks.at(-1);
    await page.locator('[data-action="select-task"][data-id="'+light.id+'"]').first().click();
    const result=[];
    for(const [name,id] of [['heavy',heavy.id],['light',light.id],['heavy',heavy.id]]){
      result.push(await page.evaluate(async({name,id})=>{
        const p=window.PiTranscript,old=p.progressMarkup;let progress=0;
        p.progressMarkup=function(...args){const t=performance.now();try{return old.apply(this,args);}finally{progress+=performance.now()-t;}};
        const start=performance.now();document.querySelector('[data-action="select-task"][data-id="'+id+'"]').click();const handlerMs=performance.now()-start;
        await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
        const paintMs=performance.now()-start;p.progressMarkup=old;
        return {name,handlerMs,paintMs,progressMs:progress,nodes:document.querySelector('#messages').querySelectorAll('*').length,commentaries:document.querySelectorAll('.agent-commentary').length};
      },{name,id}));
    }
    await page.locator('#message-input').fill('isolated diagnostic draft');
    const started=Date.now(),closed=page.waitForEvent('close');const hideMs=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0],start=Date.now();win.close();return !win.isVisible()?Date.now()-start:null;});await closed;
    console.log(JSON.stringify({messages:heavy.messages.length,maxSteps:Math.max(...heavy.messages.map(m=>m.run?.steps?.length||0)),samples:result,hideMs,closeMs:Date.now()-started}));
  }finally{if(app)await app.close().catch(()=>{});if(path.dirname(profile)!==os.tmpdir()||!path.basename(profile).startsWith('pi-ui-measure-'))throw new Error('Invalid cleanup path');await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
