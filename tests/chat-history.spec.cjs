'use strict';
const {test,expect,_electron:electron}=require('@playwright/test'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');test.use({video:'off'});
async function fixture(){
  const profile=fs.mkdtempSync(path.join(ROOT,'.history-regression-')),exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  const page=await app.firstWindow();await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
  return {app,page,close:async()=>{await app.close();if(path.resolve(profile).startsWith(ROOT+path.sep+'.history-regression-'))fs.rmSync(profile,{recursive:true,force:true});}};
}
test('历史分页可读到每一条消息，保留展开与阅读位置，旧页发送后显示最新回复且存档完整',async()=>{
  const fx=await fixture(),{page}=fx;
  try{
    await page.locator('#message-input').fill('分页草稿');
    await page.evaluate(async()=>{
      await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state;
      s.settings.autoTranslate=false;
      s.projects[0].tasks[0].messages=Array.from({length:121},(_,i)=>({id:'page-'+i,role:i%2?'user':'assistant',time:Date.now(),text:'历史消息 '+i+'\n\n'+'分页不会删除内容。'.repeat(35),...(i%2?{}:{run:{status:'complete',label:'已完成',startedAt:1,finishedAt:2,hasFinal:true,steps:Array.from({length:20},(_,j)=>({kind:'tool',id:'tool-'+i+'-'+j,status:'done',label:'读取文件',target:'ui/'+j+'.js',output:'完整输出 '+j})),changedFiles:[]}})}));
      localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));
    });await page.reload();await expect(page.locator('.message')).toHaveCount(24);
    const group=page.locator('[data-message-id="page-118"] .tool-group');await expect(group.locator('.tool-entry')).toHaveCount(0);
    await group.locator(':scope>summary').click();await expect(group.locator('.tool-entry')).toHaveCount(20);
    await group.locator('.tool-entry').first().locator('summary').click();await expect(group.locator('.tool-entry pre').first()).toBeVisible();
    const top=await page.locator('#messages').evaluate(el=>el.scrollTop);
    await page.locator('[data-action="select-task"][data-id="qubo"]').click();await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await expect(group).toHaveAttribute('open','');await expect(group.locator('.tool-entry').first()).toHaveAttribute('open','');
    expect(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-top)).toBeLessThan(3);
    const seen=new Set();
    for(let pageIndex=0;pageIndex<7;pageIndex++){
      for(const id of await page.locator('.message').evaluateAll(els=>els.map(el=>el.dataset.messageId)))seen.add(id);
      expect(await page.locator('.message').count()).toBeLessThanOrEqual(72);
      const older=page.locator('[data-history-page="older"]');if(!await older.count())break;await older.click();
    }
    expect(seen.size).toBe(121);await expect(page.locator('[data-message-id="page-0"]')).toHaveCount(1);
    // At the bottom of an old page, a task switch must not jump to the latest.
    await page.locator('#messages').evaluate(el=>el.scrollTop=el.scrollHeight);
    const first=await page.locator('.message').first().getAttribute('data-message-id');
    await page.locator('[data-action="select-task"][data-id="qubo"]').click();await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await expect(page.locator('.message').first()).toHaveAttribute('data-message-id',first);
    await page.locator('#message-input').fill('从旧页发送新的需求');await page.locator('#composer').evaluate(f=>f.requestSubmit());
    await expect(page.locator('.message').last()).toContainText('尚未配置模型');await expect(page.locator('[data-history-page="latest"]')).toHaveCount(0);
    await page.evaluate(()=>window.PiPersistence.flush());await page.reload();
    const disk=(await page.evaluate(()=>window.piDesktop.storage.load())).result.state.projects[0].tasks[0];
    expect(disk.messages).toHaveLength(123);expect(disk.messages[0].id).toBe('page-0');expect(disk.messages[120].id).toBe('page-120');
    await expect(page.locator('.message').last()).toContainText('尚未配置模型');
  }finally{await fx.close();}
});

for(const ending of ['failed-send','stop'])test('切到其他任务后原任务'+ending+'不替换当前输入框',async()=>{
  const fx=await fixture(),{app,page}=fx;
  try{
    await app.evaluate(({ipcMain},ending)=>{
      ipcMain.removeHandler('provider:get-config');ipcMain.handle('provider:get-config',()=>({model:'local-fixture',provider:'openai-compatible',profiles:[]}));
      ipcMain.removeHandler('agent:send');ipcMain.handle('agent:send',()=>ending==='failed-send'?new Promise(r=>globalThis.__failSend=()=>r({ok:false,error:'local test failure'})):{ok:true});
      ipcMain.removeHandler('agent:abort');ipcMain.handle('agent:abort',()=>new Promise(r=>globalThis.__stopRun=()=>r({ok:true})));
    },ending);
    await page.locator('#message-input').fill('后台异常检查');await page.locator('#composer').evaluate(f=>f.requestSubmit());await expect(page.locator('[data-action="stop-agent"]')).toBeVisible();
    if(ending==='stop')await page.locator('[data-action="stop-agent"]').click();
    await page.locator('[data-action="select-task"][data-id="qubo"]').click();await page.locator('#message-input').fill('保留输入与光标');
    await page.evaluate(()=>{window.__input=document.querySelector('#message-input');window.__input.focus();window.__input.setSelectionRange(2,4);});
    await app.evaluate((_,ending)=>ending==='failed-send'?globalThis.__failSend():globalThis.__stopRun(),ending);
    await expect(page.locator('#composer .send-button')).toBeEnabled();
    expect(await page.evaluate(()=>window.__input===document.querySelector('#message-input'))).toBe(true);
    expect(await page.locator('#message-input').evaluate(el=>[el.selectionStart,el.selectionEnd])).toEqual([2,4]);
    await expect(page.locator('#message-input')).toHaveValue('保留输入与光标');
    await page.locator('[data-action="select-task"][data-id="bell"]').click();await expect(page.locator('.run-summary')).toContainText(ending==='stop'?'停止':'请求未完成');
    if(ending==='failed-send')await expect(page.locator('.message.assistant')).toContainText('local test failure');
  }finally{await fx.close();}
});
