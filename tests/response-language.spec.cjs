'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const ROOT=path.resolve(__dirname,'..');test.use({video:'off'});
test('英文过程说明下方自动显示中文，缓存持久化，开关及语言选择生效',async({},info)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-language-'));const calls=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;res.setHeader('Content-Type','application/json');if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'local-translate'}]}));return;}
    const body=JSON.parse(raw);calls.push(body);const input=JSON.parse(body.messages.at(-1).content),english=body.messages[0].content.includes('into English');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({items:input.items.map(i=>({id:i.id,text:english?'The toolbar has been updated.':'让我检查 CSS 是否有效，并运行测试。'}))})}}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const exe=process.env.PI_WORKBENCH_TEST_EXE,app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await page.waitForLoadState('load');if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('[data-action="dismiss-first-launch"]').click();await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await page.evaluate(async baseUrl=>window.PiProviderManager.saveConfig({provider:'openai-compatible',baseUrl,apiKey:'local-test-key',model:'local-translate',models:['local-translate']}),'http://127.0.0.1:'+server.address().port+'/v1');
    await page.evaluate(async()=>{await window.PiPersistence.flush();const key='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(key)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.messages=[{id:'translate-demo',role:'assistant',text:'已调整工具栏。',time:Date.now(),run:{status:'complete',steps:[{kind:'text',text:'Let me verify CSS validity and run the tests.'}],changedFiles:[],startedAt:Date.now()-1000,finishedAt:Date.now(),label:'本轮已结束'}}];localStorage.setItem(key,JSON.stringify(s));});await page.reload();
    await expect(page.locator('.agent-commentary')).toContainText('Let me verify');await expect(page.locator('.response-translation')).toContainText('让我检查 CSS 是否有效，并运行测试。');expect(calls).toHaveLength(1);
    await page.screenshot({path:info.outputPath('chinese-translation.png')});await page.reload();await expect(page.locator('.response-translation')).toContainText('让我检查 CSS 是否有效');expect(calls).toHaveLength(1);
    await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-ui').click();await page.locator('#auto-translate-setting').uncheck();await page.locator('.brand').click();await expect(page.locator('.response-translation')).toHaveCount(0);
    await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-ui').click();await page.locator('#response-language-setting').selectOption('en');await page.locator('#auto-translate-setting').check();await page.locator('.brand').click();await expect(page.locator('.response-translation')).toContainText('The toolbar has been updated.');
    const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('pi-workbench-design-v2')).projects.flatMap(p=>p.tasks).find(t=>t.id==='bell').messages[0]);expect(stored.text).toBe('已调整工具栏。');expect(stored.run.steps[0].text).toBe('Let me verify CSS validity and run the tests.');expect(errors).toEqual([]);
  }finally{await app.close();server.close();fs.rmSync(profile,{recursive:true,force:true});}
});
