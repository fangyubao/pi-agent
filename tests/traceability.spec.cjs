'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
async function launch(){
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-trace-')),exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  const page=await app.firstWindow();await page.waitForLoadState('load');
  await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  await page.evaluate(()=>{localStorage.clear();location.reload();});
  await page.waitForLoadState('load');
  await expect(page.locator('#projects .project-group')).toHaveCount(2);
  await page.locator('.task-row').first().click();
  await expect.poll(()=>page.evaluate(()=>Boolean(localStorage.getItem('pi-workbench-design-v2')))).toBe(true);
  await app.evaluate(({shell})=>{global.__opened=[];shell.openPath=async folder=>{global.__opened.push(folder);return '';};});
  return {app,page,profile,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}
test('文件夹入口在主菜单，路径按项目任务追溯，错误可见',async()=>{
  const {app,page,profile,close}=await launch();
  try{
    await expect(page.locator('.sidebar-foot')).toHaveCount(0);
    await page.locator('#projects [data-action="project-menu"][data-id="quantum"]').click();
    await page.locator('#menu [data-action="open-project-path"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(1);
    const p=await app.evaluate(()=>global.__opened.at(-1));expect(p).toContain(path.join(profile,'projects'));
    await page.locator('#projects [data-action="task-menu"][data-id="bell"]').click();
    await page.locator('#menu [data-action="open-task-path"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(2);
    const dir=await app.evaluate(()=>global.__opened.at(-1));expect(path.dirname(path.dirname(dir))).toBe(p);expect(fs.existsSync(path.join(dir,'.pi-trace/conversation.md'))).toBe(true);
    await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));s.projects[0].tasks[0].workspacePath='Z:/missing-pi-folder';localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));});
    await page.reload();await page.locator('#projects [data-action="task-menu"][data-id="bell"]').click();await page.locator('#menu [data-action="open-task-path"]').click();
    await expect(page.locator('#toast')).toContainText('目录不存在');expect(await app.evaluate(()=>global.__opened.length)).toBe(2);
  }finally{await close();}
});
test('工作台目录、侧栏、快捷键打开正确源码，设计副本不混入其他工作台',async({},testInfo)=>{
  const {app,page,profile,close}=await launch();
  try{
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench-source"][data-key="qubo"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(1);
    const qubo=await app.evaluate(()=>global.__opened.at(-1));expect(qubo.endsWith(path.join('workbenches','qubo'))).toBe(true);expect(fs.existsSync(path.join(qubo,'server/index.cjs'))).toBe(true);
    await page.locator('[data-action="open-workbench"][data-key="circuit"][data-mode="edit"]').click();
    await expect(page.locator('#side-panel-actions [data-action="open-active-workbench-source"]')).toBeVisible();
    await page.locator('#side-panel-actions [data-action="open-active-workbench-source"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(2);
    const copy=await app.evaluate(()=>global.__opened.at(-1));expect(copy).toContain(path.join(profile,'workbench-projects'));expect(JSON.parse(fs.readFileSync(path.join(copy,'manifest.json'),'utf8')).id).toBe('circuit');expect(fs.existsSync(path.join(copy,'ui/index.html'))).toBe(true);
    await page.locator('[data-action="toggle-trial"]').click();await page.frameLocator('#preview-frame').locator('[data-cmd="bell"]').click();
    await page.keyboard.press('Control+Shift+O');
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(3);expect(await app.evaluate(()=>global.__opened.at(-1))).toBe(copy);
    await page.locator('[data-action="toggle-trial"]').click();
    await page.frameLocator('#preview-frame').locator('.design-mode-switch').click();
    await page.keyboard.press('Control+Shift+O');
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(4);expect(await app.evaluate(()=>global.__opened.at(-1))).toBe(copy);
    await page.screenshot({path:testInfo.outputPath('source-control.png')});
    const actual=path.join(profile,'my-source');fs.mkdirSync(actual);fs.mkdirSync(path.join(actual,'ui'));fs.mkdirSync(path.join(actual,'server'));
    await page.evaluate(actual=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2')),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=actual;localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));},actual);
    await page.reload();await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench-source"][data-key="qubo"]').click();
    await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(5);expect(await app.evaluate(()=>global.__opened.at(-1))).toBe(qubo);
    await page.keyboard.press('Control+Shift+O');await expect.poll(()=>app.evaluate(()=>global.__opened.length)).toBe(6);expect(await app.evaluate(()=>global.__opened.at(-1))).toBe(actual);
  }finally{await close();}
});
test('过程说明使用紧凑气泡，工具详情可折叠滚动，最终回答仍直接显示',async({},testInfo)=>{
  const {page,close}=await launch();
  try{
    await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2')),t=s.projects[0].tasks[0];t.messages=[{id:'u',role:'user',text:'检查工作台布局并调整按钮位置。',time:Date.now()},{id:'a',role:'assistant',text:'已调整完成。你可以在右侧查看效果，或通过源码按钮打开工程。',time:Date.now(),run:{status:'complete',label:'本轮已结束',startedAt:Date.now()-12000,finishedAt:Date.now(),changedFiles:[],steps:[{kind:'text',text:'我先读取当前布局，确认需要移动的控件与所在容器。'},...Array.from({length:12},(_,i)=>({kind:'tool',id:'t'+i,label:'读取文件',target:'ui/components/control-'+i+'.js',status:i===4?'error':'done',output:'检查结果：控件位置已读取。'})),{kind:'text',text:'布局信息已确认，正在调整按钮位置并保留原有绑定。'}]}}];localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));});
    await page.reload();await expect(page.locator('.agent-commentary')).toHaveCount(2);
    await expect(page.locator('.agent-commentary').first()).toHaveCSS('border-top-left-radius','12px');
    await expect(page.locator('.tool-group')).not.toHaveAttribute('open');await page.locator('.tool-group>summary').click();
    await expect(page.locator('.tool-group')).toHaveAttribute('open','');
    expect(await page.locator('.tool-list').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await page.locator('.tool-entry').first().locator('summary').click();await expect(page.locator('.tool-entry pre').first()).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('progress-bubbles.png')});
    await expect(page.locator('.assistant-bubble .message-text')).toContainText('已调整完成');
    await expect(page.locator('.message.assistant')).toHaveCSS('white-space','normal');
  }finally{await close();}
});
