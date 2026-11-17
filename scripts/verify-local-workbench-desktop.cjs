'use strict';
// Exercise the user's workbench in a disposable desktop profile. Never load its
// saved connections: only a fresh local shell is created, then explicitly closed.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {expect,_electron:electron}=require('@playwright/test');
const {copyDependencies}=require('../runtime/workbench-dependencies.cjs');
const ROOT=path.resolve(__dirname,'..');
async function main(){
  if(!process.argv[2])throw new Error('Provide the SSH/serial workbench source directory');
  const source=path.resolve(process.argv[2]),base=path.resolve(os.tmpdir()),profile=await fs.mkdtemp(path.join(base,'pi-terminal-verification-'));
  let app,page;
  try{
    const dir=path.join(profile,'workbench-projects','terminal-verification');await fs.mkdir(dir,{recursive:true});
    for(const name of ['ui','server','manifest.json','package.json'])await fs.cp(path.join(source,name),path.join(dir,name),{recursive:true});
    await copyDependencies(source,dir);
    const exe=process.env.PI_WORKBENCH_TEST_EXE;
    app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    page=await app.firstWindow();page.on('dialog',dialog=>dialog.accept().catch(()=>{}));await page.waitForLoadState('load');
    if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('[data-action="dismiss-first-launch"]').click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1700,1000));
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await page.evaluate(dir=>{const key='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(key)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=dir;localStorage.setItem(key,JSON.stringify(s));},dir);await page.reload();
    await page.locator('[data-action="toggle-trial"]').click();const frame=page.frameLocator('#preview-frame');
    await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);
    await frame.locator('#btn-new-local').click();await expect(frame.locator('#terminal-status')).toContainText('已连接',{timeout:20000});
    console.log('PASS: local terminal connected');
    // Capture the backend stream separately from DOM rendering to distinguish
    // input echo from the actual command output received after execution.
    const reply=await frame.locator('body').evaluate(async()=>{
      const state=(await window.__wbTransport('readState')).state;
      const item=Object.values(state.data.sessions).find(x=>x.kind==='local');
      if(!item)throw new Error('Local session missing');
      const marker='PI_RUNTIME_'+Date.now();let output='';const off=window.__wbOnEvent(e=>{if(e.type==='terminal.data')output+=e.payload.data||'';});
      await window.__wbTransport('session.write',{sessionId:item.id,data:'echo '+marker+'\r\n'});
      const deadline=Date.now()+15000;while(Date.now()<deadline&&!output.includes(marker))await new Promise(r=>setTimeout(r,50));off();
      return {sessionId:item.id,marker,received:output.includes(marker)};
    });
    expect(reply.received,'真实本地 shell 的命令输出应经事件通道返回').toBe(true);
    console.log('PASS: local terminal event stream received');
    await expect(frame.locator('.wb-term-holder').filter({hasText:reply.marker})).toBeVisible({timeout:10000});
    await page.screenshot({path:path.join(ROOT,'verification-terminal.png')});
    const disconnected=await frame.locator('body').evaluate((_element,id)=>window.__wbTransport('session.disconnect',{sessionId:id}),reply.sessionId);expect(disconnected.ok).toBe(true);
    await page.locator('[data-action="toggle-trial"]').click();await expect(frame.locator('.design-mode-switch')).toBeVisible();
    console.log('PASS: isolated real workbench UI, local shell connect, command output stream, DOM rendering, disconnect, return to layout');
  }catch(error){if(page)await page.screenshot({path:path.join(ROOT,'verification-terminal-failed.png')}).catch(()=>{});throw error;}finally{
    if(page)await page.frameLocator('#preview-frame').locator('body').evaluate(async()=>{
      if(!window.__piRuntime||!window.__wbTransport)return;
      const state=(await window.__wbTransport('readState')).state;
      for(const item of Object.values(state?.data?.sessions||{}))if(item.conn?.status==='connected')await window.__wbTransport('session.disconnect',{sessionId:item.id});
    },null,{timeout:3000}).catch(()=>{});
    if(app)await app.close();
    if(path.dirname(profile)!==base||!path.basename(profile).startsWith('pi-terminal-verification-'))throw new Error('Unexpected cleanup path');
    await fs.rm(profile,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
