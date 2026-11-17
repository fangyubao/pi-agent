'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'..'),K='pi-workbench-design-v2';
test.use({video:'off'});
async function launch(){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-purpose-'));
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,960));
  return {page,app,profile,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}
const saved=page=>page.evaluate(async()=>{await window.PiPersistence.flush();return (await window.piDesktop.storage.load()).result.state;});
const current=s=>s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
async function create(page){await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();await expect(page.locator('.task-purpose')).toHaveText('创建');return current(await saved(page));}
const canvas=page=>page.locator('[data-action="select-side-tab"][data-tab="preview"]');
const toggle=page=>page.locator('[data-action="toggle-task-workbench"]');

test('创建任务自动进入设计画布，导航保留打开意图，显式收起与重启保持关闭',async({},info)=>{
  const fx=await launch();try{const {page}=fx,errors=[];page.on('pageerror',e=>errors.push(e.message));const draft=await create(page);
    await expect(canvas(page)).toHaveText('设计画布');await expect(canvas(page)).toHaveAttribute('aria-selected','true');
    await expect(page.locator('[data-action="select-side-tab"][data-tab="workbench"]')).toHaveText('设计设置');
    await expect(page.locator('#design-panel')).toBeVisible();await expect(page.locator('[data-action="toggle-trial"]')).toBeDisabled();await expect(page.locator('[data-action="open-active-workbench-source"]')).toBeDisabled();
    await page.locator('[data-action="select-task"][data-id="bell"]').click();await expect(page.locator('#workbench-panel')).toBeHidden();
    expect(current((await saved(page)))).not.toHaveProperty('design');
    expect((await saved(page)).projects.flatMap(p=>p.tasks).find(t=>t.id===draft.id).workbenchSession.open).toBe(true);
    await page.locator('[data-action="select-task"][data-id="'+draft.id+'"]').click();await expect(canvas(page)).toHaveAttribute('aria-selected','true');
    await page.reload();await expect(canvas(page)).toHaveAttribute('aria-selected','true');
    await page.screenshot({path:info.outputPath('create-workspace.png')});
    await toggle(page).click();await expect(toggle(page)).toContainText('继续设计');await expect(page.locator('#design-panel')).toBeHidden();
    await page.reload();await expect(toggle(page)).toContainText('继续设计');await expect(canvas(page)).toHaveCount(0);
    await toggle(page).click();await expect(canvas(page)).toHaveAttribute('aria-selected','true');expect(errors).toEqual([]);
  }finally{await fx.close();}
});

test('旧创建任务误绑使用会话：恢复草稿且保留发布数据、聊天和其他使用任务',async()=>{
  const fx=await launch();try{const {page}=fx;await create(page);
    const dir=await page.evaluate(async()=>{const r=await window.piDesktop.workbench.scaffold({name:'旧设计'});return r.result.path;});
    fs.writeFileSync(path.join(dir,'ui/index.html'),'<html><body><h1>这是设计草稿</h1></body></html>');
    await page.evaluate(async({K,dir})=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
      t.design.workspacePath=dir;t.design.publishedPath=dir+'/old-publication';t.design.workflow.status='idle';
      t.messages=[{id:'keep',role:'user',text:'原始聊天必须保留',time:1}];t.workbenches['old-published']={revision:17,result:99};
      t.workbenchSession={key:'old-published',mode:'use',sourcePath:dir+'/old-publication',name:'旧已发布版本',open:true};
      s.projects[0].tasks.push({id:'separate-use',name:'单独的使用任务',messages:[],use:{workbenchId:'old-published'},workbenches:{'old-published':{revision:3,result:7}},workbenchSession:{key:'old-published',mode:'use',sourcePath:dir,open:false}});
      localStorage.setItem(K,JSON.stringify(s));
    },{K,dir});
    await page.reload();await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('这是设计草稿');
    const after=current(await saved(page));expect(after.design.kind).toBe('create');expect(after.workbenchSession.mode).toBe('design');expect(after.workbenchSession.key).toBe('builder');
    expect(after.workbenchSessionHistory[0].session.key).toBe('old-published');expect(after.messages[0].text).toBe('原始聊天必须保留');expect(after.workbenches['old-published']).toEqual({revision:17,result:99});
    expect((await saved(page)).projects.flatMap(p=>p.tasks).find(t=>t.id==='separate-use').workbenches['old-published']).toEqual({revision:3,result:7});
    await page.reload();expect(current(await saved(page)).workbenchSessionHistory).toHaveLength(1);
  }finally{await fx.close();}
});

test('内置修改使用独立源码副本与设计画布，试运行真实求解且原使用任务不变',async({},info)=>{
  const fx=await launch();try{const {page}=fx;
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    const ui=page.frameLocator('#module-frame');await ui.locator('[aria-label="QUBO q00"]').fill('-8');await ui.locator('[aria-label="QUBO q00"]').press('Tab');
    await expect.poll(async()=>current(await saved(page)).workbenches.qubo?.matrix?.[0]?.[0]).toBe(-8);
    const original=current(await saved(page));
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="qubo"][data-mode="edit"]').click();
    const preview=page.frameLocator('#preview-frame');await expect(preview.locator('[aria-label="QUBO q00"]')).toHaveValue('-8');
    await expect(page.locator('.task-purpose')).toHaveText('修改');await expect(page.locator('#design-panel')).toBeVisible();
    const modified=current(await saved(page));expect(modified.id).not.toBe(original.id);expect(modified.design.workspacePath).toContain('workbench-projects');
    expect(fs.existsSync(path.join(modified.design.workspacePath,'ui/index.html'))).toBe(true);
    await page.locator('[data-action="toggle-trial"]').click();await expect(preview.locator('script[data-pi-runtime]')).toHaveCount(1);
    await preview.locator('[data-cmd="run"]').click();await expect(preview.locator('.event-status')).toContainText('结果已同步');
    await page.screenshot({path:info.outputPath('modify-trial.png')});
    await page.locator('[data-action="toggle-trial"]').click();await expect(preview.locator('.design-mode-switch')).toBeVisible();
    expect(current(await saved(page)).workbenchSession.mode).toBe('edit');
    const unchanged=(await saved(page)).projects.flatMap(p=>p.tasks).find(t=>t.id===original.id);expect(unchanged.workbenches).toEqual(original.workbenches);expect(unchanged.workbenchSession.open).toBe(true);
    await page.locator('[data-action="select-task"][data-id="'+original.id+'"]').click();await expect(ui.locator('[aria-label="QUBO q00"]')).toHaveValue('-8');await expect(page.locator('#design-panel')).toBeHidden();
  }finally{await fx.close();}
});

test('验证与发布仍停留设计任务，使用另选位置，修改已发布版获得独立草稿',async()=>{
  const fx=await launch();try{const {page}=fx;await create(page);
    const dir=await page.evaluate(async()=>{const r=await window.piDesktop.workbench.scaffold({name:'用途隔离'});return r.result.path;});
    fs.writeFileSync(path.join(dir,'ui/index.html'),'<html><body><h1>用途隔离</h1><button id="run">运行</button><pre id="out"></pre><script>document.querySelector("#run").onclick=async()=>{const r=await __wbTransport("readState");document.querySelector("#out").textContent=JSON.stringify(r.state)}</script></body></html>');
    require('./fixtures/workbench-ui.cjs').restoreOutput(dir);require('./fixtures/workbench-ui.cjs').scenario(dir,{state:{revision:0},contains:'revision',actions:['readState']});
    await page.evaluate(async({K,dir})=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=dir;localStorage.setItem(K,JSON.stringify(s));},{K,dir});await page.reload();
    const verified=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),dir);expect(verified.ok,JSON.stringify(verified)).toBe(true);
    const published=await page.evaluate(path=>window.piDesktop.workbench.publish({path}),dir);expect(published.ok,published.error).toBe(true);
    await page.evaluate(async({K,entry})=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);Object.assign(t.design,{publishedId:entry.id,publishedPath:entry.path,publishedName:entry.name,completed:true});t.design.workflow.status='complete';t.design.workflow.stage=5;localStorage.setItem(K,JSON.stringify(s));},{K,entry:published.result});await page.reload();
    await expect(canvas(page)).toHaveAttribute('aria-selected','true');const draft=current(await saved(page));
    await page.locator('[data-action="run-published-workbench"]').click();await expect(page.locator('#use-task option[value="'+draft.id+'"]')).toHaveCount(0);await expect(page.locator('#use-task')).toHaveValue('__new__');
    await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(page.locator('.task-purpose')).toHaveText('使用');await expect(page.locator('#design-panel')).toBeHidden();
    const use=current(await saved(page));expect(use.id).not.toBe(draft.id);expect(use.design).toBeUndefined();await page.frameLocator('#module-frame').locator('#run').click();await expect(page.frameLocator('#module-frame').locator('#out')).toContainText('revision');
    await page.locator('[data-action="select-task"][data-id="'+draft.id+'"]').click();await expect(canvas(page)).toHaveAttribute('aria-selected','true');expect(current(await saved(page)).design.workspacePath).toBe(dir);
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="'+published.result.id+'"][data-mode="edit"]').click();
    await expect(page.locator('.task-purpose')).toHaveText('修改');await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('用途隔离');
    const edit=current(await saved(page));expect(edit.design.workspacePath).not.toBe(dir);expect(edit.design.workspacePath).not.toBe(published.result.path);expect(edit.design.sourceWorkbenchId).toBe(published.result.id);
  }finally{await fx.close();}
});

test('工作流修改副本可试运行节点，宿主调度与副本后端同步且不改原计划',async()=>{
  const fx=await launch();try{const {page,app}=fx;
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-use-workbench"][data-key="workflow"]').click();await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    const source=page.frameLocator('#module-frame');await expect(source.locator('.wf-root')).toBeVisible();
    await source.locator('body').evaluate(()=>window.server('setPlan',{goal:'副本测试',nodes:[{id:'n1',title:'本地测试步骤',role:'检查',brief:'验证同步',prompt:'检查',dependsOn:[]}]}));
    const original=current(await saved(page));
    // External model boundary only. The renderer, scheduler and both real
    // workbench backends still execute normally, without spending API tokens.
    await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('workflow:run-node');ipcMain.handle('workflow:run-node',async()=>({ok:true,result:{text:'NODE_COPY_OK',artifacts:[],warnings:[],usage:{input:1,output:1}}}));});
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="workflow"][data-mode="edit"]').click();
    const preview=page.frameLocator('#preview-frame');await expect(preview.locator('.wf-node')).toHaveCount(1);await expect(page.locator('.task-purpose')).toHaveText('修改');
    await page.locator('[data-action="toggle-trial"]').click();await expect(preview.locator('script[data-pi-runtime]')).toHaveCount(1);await preview.locator('[data-act="run"]').first().click();
    await expect.poll(async()=>{const t=current(await saved(page));return t.workbenches['trial:'+t.id]?.nodes?.[0]?.run?.output;}).toBe('NODE_COPY_OK');
    expect((await saved(page)).projects.flatMap(p=>p.tasks).find(t=>t.id===original.id).workbenches.workflow).toEqual(original.workbenches.workflow);
    await page.locator('[data-action="toggle-trial"]').click();await expect(preview.locator('.design-mode-switch')).toBeVisible();
  }finally{await fx.close();}
});
