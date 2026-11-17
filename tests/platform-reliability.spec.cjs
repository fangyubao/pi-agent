'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'..');
async function launch(){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-platform-ui-'));const exe=process.env.PI_WORKBENCH_TEST_EXE;const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});const page=await app.firstWindow();await page.waitForLoadState('load');await expect(page.locator('#projects .project-group')).toHaveCount(2);if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();return {app,page,profile,close:async()=>{await app.close();if(path.dirname(profile)!==os.tmpdir())throw new Error('清理路径越界');fs.rmSync(profile,{recursive:true,force:true});}};}
test('长计算从网页启动，Agent 同一会话查看并取消，状态和完成结果显示到界面',async({},info)=>{
  const fx=await launch();try{
    const {page}=fx;const source=await page.evaluate(async()=> (await window.piDesktop.workbench.scaffold({name:'后台计算验收'})).result.path);
    const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json')));manifest.actions.push({name:'calculate',access:'compute'});fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(manifest));
    fs.writeFileSync(path.join(source,'server/index.cjs'),`module.exports={dispatch:async({action,state={},payload={},signal,progress})=>{if(action==='calculate'){for(let i=0;i<20;i++){if(signal.aborted)throw new Error('用户取消计算');progress(i/20,'计算进度');await new Promise(r=>setTimeout(r,50));}return {state:{revision:(state.revision||0)+1,data:{answer:42}},result:{answer:42}};}return {state,result:state};}};`);
    fs.writeFileSync(path.join(source,'ui/index.html'),`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body><main><h1>后台计算验收</h1><button id="run">计算</button><pre id="state"></pre><pre id="job"></pre></main><script>window.__wbOnEvent(e=>{if(e.type==='job.updated')document.querySelector('#job').textContent=e.payload.status});window.addEventListener('workbench-state',e=>document.querySelector('#state').textContent=JSON.stringify(e.detail));document.querySelector('#run').onclick=()=>window.__wbJobs.start('calculate');</script></body></html>`);
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-key="builder"][data-action="open-workbench"]').click();
    await page.evaluate(source=>{const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=source;localStorage.setItem(k,JSON.stringify(s));},source);await page.reload();
    await expect(page.locator('[data-action="toggle-trial"]')).toBeEnabled();await page.locator('[data-action="toggle-trial"]').click();
    const frame=page.frameLocator('#preview-frame');await frame.locator('#run').click();await expect(page.locator('#workbench-jobs')).toContainText('运行中');
    const listed=await frame.locator('body').evaluate(async()=>{const {jobs}=await window.__wbJobs.list();return window.__wbJobs.get(jobs[0].id);});expect(listed.id).toBeTruthy();expect(listed.action).toBe('calculate');
    await page.locator('#workbench-jobs button').click();await expect(frame.locator('#job')).toHaveText('cancelled');
    await frame.locator('#run').click();await expect(frame.locator('#state')).toContainText('"answer":42');await expect(frame.locator('#job')).toHaveText('completed');
    await page.screenshot({path:info.outputPath('shared-job-state.png')});
  }finally{await fx.close();}
});
test('本地全文索引不阻塞桌面，检索可见来源；存储不依赖浏览器容量',async()=>{
  const fx=await launch();try{
    const file=path.join(fx.profile,'knowledge.txt');fs.writeFileSync(file,'普通资料。'.repeat(12000)+'末尾知识：QUBO 目标变量是二进制。');
    const report=await fx.page.evaluate(file=>window.piDesktop.knowledge.import([file]),file);expect(report.ok,report.error).toBe(true);
    expect(report.report.files[0].content).toBeUndefined();const hit=await fx.page.evaluate(indexId=>window.piDesktop.knowledge.search({indexId,query:'目标变量'}),report.report.indexId);expect(hit.ok,hit.error).toBe(true);expect(hit.result.matches[0].text).toContain('二进制');
    const documents=await require('./fixtures/knowledge-documents.cjs').createDocuments(fx.profile);const parsed=await fx.page.evaluate(files=>window.piDesktop.knowledge.import(files),documents);expect(parsed.ok,parsed.error).toBe(true);expect(parsed.report.readCount,JSON.stringify(parsed.report)).toBe(2);
    const saved=await fx.page.evaluate(async()=>{const key='pi-workbench-design-v2',state={schema:2,settings:{},deleted:[],projects:[{id:'test',tasks:[{id:'test',draft:'大对话'.repeat(600000)}]}]};const result=await window.piDesktop.storage.save({state});localStorage.removeItem(key);return result;});expect(saved.ok).toBe(true);
    const restored=await fx.page.evaluate(()=>window.piDesktop.storage.load());expect(restored.result.state.projects[0].tasks[0].draft.length).toBe(1800000);
  }finally{await fx.close();}
});
test('目录版本回退、停用与恢复具有可见操作入口',async({},info)=>{
  const fx=await launch();try{
    const {page}=fx;const source=await page.evaluate(async()=> (await window.piDesktop.workbench.scaffold({name:'版本管理验收'})).result.path);
    require('./fixtures/workbench-ui.cjs').counter(source);
    const first=await page.evaluate(async path=>{const v=await window.piDesktop.workbench.verify({path});if(!v.ok)throw new Error(v.error);return window.piDesktop.workbench.publish({path});},source);expect(first.ok).toBe(true);
    fs.appendFileSync(path.join(source,'ui/index.html'),'\n<!-- 第二版 -->');
    const second=await page.evaluate(async path=>{const v=await window.piDesktop.workbench.verify({path});if(!v.ok)throw new Error(v.error);return window.piDesktop.workbench.publish({path});},source);expect(second.result.id).toBe(first.result.id);expect(second.result.path).not.toBe(first.result.path);
    await page.reload();await page.locator('[data-route="workbenches"]').click();const card=page.locator('.workbench-card').filter({has:page.getByRole('heading',{name:'版本管理验收'})});
    await card.getByRole('button',{name:'版本与管理'}).click();await page.locator('[name="operation"]').selectOption('disable');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(card.locator('[data-action="open-use-workbench"]')).toBeDisabled();
    await card.getByRole('button',{name:'版本与管理'}).click();await page.locator('[name="operation"]').selectOption('enable');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(card.locator('[data-action="open-use-workbench"]')).toBeEnabled();
    await card.getByRole('button',{name:'版本与管理'}).click();await page.locator('[name="release"]').selectOption(first.result.releaseId);await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    await expect.poll(async()=>(await page.evaluate(()=>window.piDesktop.workbench.list())).entries[0].path).toBe(first.result.path);
    await page.screenshot({path:info.outputPath('workbench-versions.png')});
    await card.getByRole('button',{name:'版本与管理'}).click();await page.locator('[name="operation"]').selectOption('uninstall');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(card).toHaveCount(0);
    await page.getByRole('button',{name:'恢复已卸载'}).click();await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(card).toHaveCount(1);
  }finally{await fx.close();}
});
