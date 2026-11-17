'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
async function enableComposer(page,ids){await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-toggles').click();for(const id of ids){const box=page.locator('[data-composer-toggle="'+id+'"]');if(!(await box.isChecked()))await box.evaluate(el=>el.click());}await page.locator('.brand').click();}
test('联动选择、工作台恢复、项目菜单、多 API 与文件审核',async({},testInfo)=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-features-'));
  const calls=[];
  const server=http.createServer((req,res)=>{calls.push({url:req.url,key:req.headers.authorization||req.headers['x-api-key']||''});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:Array.from({length:7},(_,i)=>({id:'model-'+(i+1)}))}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  await require('./helpers/clipboard.cjs').useClipboardMemory(app);
  const page=await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function state(){return page.evaluate(async()=>{await window.PiPersistence.flush();return (await window.piDesktop.storage.load()).result.state;});}
  // 任务可能在项目栏，也可能在「工作台」栏。
  async function menu(action,id){await page.locator('#projects [data-action="'+action+'"][data-id="'+id+'"], #workbench-section [data-action="'+action+'"][data-id="'+id+'"]').first().click();}
  try{
    await expect(page.locator('#projects .project-group')).toHaveCount(2);
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toHaveCount(0);
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();
    await page.locator('#use-project').selectOption('embedded');
    await expect(page.locator('#use-task option')).toHaveCount(2);
    await expect(page.locator('#use-task')).not.toContainText('Bell');
    await page.locator('#use-task').selectOption('__new__');
    await page.locator('#dialog-form').evaluate(form=>form.requestSubmit());
    await expect(page.locator('#workbench-panel')).toBeVisible();
    const usedId=(await state()).activeTask;
    expect((await state()).projects.find(p=>p.id==='embedded').tasks.some(t=>t.id===usedId)).toBe(true);
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect(page.locator('#workbench-panel')).toBeHidden();
    await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toHaveCount(0);
    await page.locator('[data-action="select-task"][data-id="'+usedId+'"]').click();
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect(page.frameLocator('#module-frame').locator('[aria-label="QUBO q00"]')).toBeVisible();
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await menu('task-menu',usedId);
    await expect(page.locator('#menu')).toContainText('复制');
    await page.locator('#menu [data-action="task-copy-menu"]').hover();
    await expect(page.locator('#submenu')).toContainText('导出 Markdown');
    await expect(page.locator('#submenu')).toContainText('复制深度链接');
    await page.locator('#menu [data-action="task-branch-menu"]').hover();
    await expect(page.locator('#submenu')).toContainText('从消息创建分支');
    await page.locator('#menu [data-action="move-task"]').click();
    await page.locator('#move-project').selectOption('quantum');
    await page.locator('#dialog-form').evaluate(form=>form.requestSubmit());
    expect((await state()).projects.find(p=>p.id==='quantum').tasks.some(t=>t.id===usedId)).toBe(true);
    await menu('task-menu',usedId);await page.locator('#menu [data-action="task-copy-menu"]').hover();await page.locator('#submenu [data-action="copy-task-link"]').click();
    await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText())).toBe('pi-workbench://task/'+usedId);

    // API A: seven discovered models, four imported slots only.
    await page.locator('[data-route="settings"]').click();
    await page.locator('#provider-name').fill('API A');await page.locator('#provider-url').fill(baseUrl);await page.locator('#provider-key').fill('test-key-a');
    await page.locator('#refresh-models').click();
    await expect(page.locator('#provider-status')).toContainText('已读取 7 个模型');
    await expect(page.locator('[data-model-slot]')).toHaveCount(4);
    await page.locator('[data-model-slot="3"]').selectOption('model-7');
    await page.locator('#provider-advanced summary').click();
    await page.locator('[data-effort-slot="3"]').selectOption('high');
    await page.locator('#provider-form').evaluate(form=>form.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText('配置已保存');
    const a=(await page.evaluate(()=>window.PiProviderManager.getConfig())).profileId;
    await page.locator('#provider-add').click();await page.locator('#provider-name').fill('API B');await page.locator('#provider-url').fill(baseUrl);
    const before=calls.length;
    await page.locator('#refresh-models').click();
    await expect(page.locator('#provider-status')).toContainText('已读取 7 个模型');
    expect(calls[before].key).toBe(''); // Never borrow the active profile's API key.
    await page.locator('#provider-key').fill('test-key-b');
    for(const slot of ['1','2','3'])await page.locator('[data-model-slot="'+slot+'"]').selectOption('');
    await page.locator('[data-model-slot="0"]').selectOption('model-6');
    await page.locator('#provider-form').evaluate(form=>form.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText('配置已保存');
    const cfg=await page.evaluate(()=>window.PiProviderManager.getConfig());const b=cfg.profiles.find(x=>x.name==='API B').id;
    expect(cfg.profiles.length).toBe(2);expect(JSON.stringify(cfg)).not.toContain('test-key');
    await enableComposer(page,['provider','effort']);
    await page.locator('[data-action="select-task"][data-id="'+usedId+'"]').click();
    await expect(page.locator('#composer-provider option')).toHaveCount(2);
    await page.locator('#composer-provider').selectOption(b);
    await expect(page.locator('#composer-model option:not([disabled])')).toHaveCount(6); // 所有 API 的模型（A 4 个 + B 1 个）+ 设置
    await expect(page.locator('#composer-model')).toHaveValue(b+'::model-6');
    await page.locator('#composer-provider').selectOption(a);
    await expect(page.locator('#composer-model option:not([disabled])')).toHaveCount(6);
    await page.locator('#composer-model').selectOption(a+'::model-7');
    await expect(page.locator('#composer-effort')).toHaveValue('high');
    await page.evaluate(()=>window.PiProviderManager.listModels({profileId:window.document.querySelector('#composer-provider').value}));
    expect(calls.at(-1).key).toBe('Bearer test-key-a');
    await page.reload();await expect(page.locator('#composer-model')).toHaveValue(a+'::model-7');

    // Deterministic review fixture, with a real writable export directory.
    await page.evaluate(({id,cwd})=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));const t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===id);t.messages=[{id:'fixture-user',role:'user',text:'修改测试文件',time:Date.now()},{id:'fixture-answer',role:'assistant',text:'已修改测试文件。',time:Date.now(),run:{cwd,status:'complete',steps:[],changedFiles:[{path:'demo.txt',operation:'修改',before:'old line\n',after:'new line\n'}],startedAt:Date.now()-1000,finishedAt:Date.now(),label:'本轮已结束'}}];localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));},{id:usedId,cwd:profile});
    await page.reload();await page.locator('#page-actions [data-action="toggle-summary"]').click();
    await expect(page.locator('.review-panel')).toBeVisible();
    await page.locator('.review-panel [data-action="review-file"]').click();
    await expect(page.locator('.diff-line.removed')).toContainText('old line');
    await expect(page.locator('.diff-line.added')).toContainText('new line');
    await page.screenshot({path:testInfo.outputPath('file-review.png')});
    await page.locator('#dialog [data-action="close-dialog"]').first().click();
    const output=path.join(profile,'export.md');
    await app.evaluate(({dialog,shell},output)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:output});shell.openPath=async target=>{global.__openedPath=target;return '';};},output);
    await menu('task-menu',usedId);await page.locator('#menu [data-action="task-copy-menu"]').hover();await page.locator('#submenu [data-action="export-task"]').click();
    await expect.poll(()=>fs.existsSync(output)).toBe(true);expect(fs.readFileSync(output,'utf8')).toContain('修改测试文件');
    await menu('task-menu',usedId);await page.locator('#menu [data-action="open-task-path"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__openedPath)).toBe(profile);
    await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await page.evaluate(id=>location.hash='task/'+encodeURIComponent(id),usedId);
    await expect(page.locator('#breadcrumb')).toContainText('使用');
    const linked=spawn(exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),[...(exe?[]:[ROOT]),'--user-data-dir='+profile,'pi-workbench://task/bell'],{cwd:ROOT,windowsHide:true,stdio:'ignore'});
    const linkedExit=new Promise((resolve,reject)=>{linked.once('exit',resolve);linked.once('error',reject);});
    await expect(page.locator('#breadcrumb')).toContainText('Bell');
    expect(await linkedExit).toBe(0);
    const workspace=await page.evaluate(()=>window.piDesktop.paths.workspace());
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    await page.locator('[data-route="settings"]').click();await expect(page.locator('#provider-name')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('multi-api-settings.png')});
    expect(errors).toEqual([]);
  }finally{await app.close();server.close();fs.rmSync(profile,{recursive:true,force:true});}
});

test('旧 API 迁移、并发保存与首次自动获取模型',async()=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-migration-'));
  const calls=[];
  const server=http.createServer((req,res)=>{calls.push(req.headers.authorization||'');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:Array.from({length:6},(_,i)=>({id:'auto-'+i}))}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  const page=await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  try{
    await expect(page.locator('#projects .project-group')).toHaveCount(2);
    const encrypted=await app.evaluate(({safeStorage})=>safeStorage.encryptString('test-legacy-key').toString('base64'));
    const file=path.join(profile,'provider-config.json');
    fs.writeFileSync(file,JSON.stringify({provider:'openai-compatible',baseUrl,model:'legacy-model',apiKeyEncrypted:encrypted}));
    await page.reload();
    const legacy=await page.evaluate(()=>window.PiProviderManager.getConfig());
    expect(legacy.profileId).toBe('default');expect(legacy.hasApiKey).toBe(true);
    expect(JSON.stringify(legacy)).not.toContain(encrypted);
    await page.evaluate(()=>window.PiProviderManager.listModels({profileId:'default'}));
    expect(calls.at(-1)).toBe('Bearer test-legacy-key');
    const results=await page.evaluate(baseUrl=>Promise.all(['one','two'].map(profileId=>window.PiProviderManager.saveConfig({profileId,name:profileId,baseUrl,models:['auto-0'],model:'auto-0',apiKey:'test-'+profileId,makeActive:false}))),baseUrl);
    expect(results.every(x=>x.ok)).toBe(true);
    const migrated=JSON.parse(fs.readFileSync(file,'utf8'));
    expect(migrated.profiles).toHaveLength(3);
    expect(migrated.profiles.find(p=>p.id==='default').apiKeyEncrypted).toBe(encrypted);
    expect(fs.readFileSync(file,'utf8')).not.toContain('test-legacy-key');
    await page.locator('[data-route="settings"]').click();
    await page.locator('#provider-add').click();
    await page.locator('#provider-name').fill('自动读取 API');
    await page.locator('#provider-url').fill(baseUrl);
    await page.locator('#provider-key').fill('test-auto-key');
    await page.locator('#provider-form').evaluate(form=>form.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText('已读取 6 个模型，已导入 4 个');
    const config=await page.evaluate(()=>window.PiProviderManager.getConfig());
    expect(config.profiles.find(p=>p.name==='自动读取 API').models).toHaveLength(4);
    expect(config.profiles.find(p=>p.id==='default').hasApiKey).toBe(true);
    expect(calls.at(-1)).toBe('Bearer test-auto-key');
  }finally{await app.close();server.close();fs.rmSync(profile,{recursive:true,force:true});}
});
