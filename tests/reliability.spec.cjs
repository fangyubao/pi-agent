'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
test('UI/后端状态、审计、快照对比恢复、完整备份与分层工程',async({},info)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-reliability-'));
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  const page=await app.firstWindow();await page.waitForLoadState('load');const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  const task=()=>page.evaluate(async()=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state;return s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);});
  async function wbMenu(action){await page.locator('.task-row.selected [data-action="task-menu"]').click();await page.locator('#menu [data-action="task-workbench-menu"]').hover();await page.locator('#submenu [data-action="'+action+'"]').click();}
  try{
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    const frame=page.frameLocator('#module-frame');await expect(frame.locator('[data-cell="0,0"]')).toBeVisible();
    await frame.locator('[data-cell="0,0"]').fill('-8');await frame.locator('[data-cell="0,0"]').press('Tab');
    await expect.poll(async()=>(await task()).workbenches.qubo?.matrix?.[0]?.[0]).toBe(-8);
    await frame.locator('[data-cmd="run"]').click();await expect(frame.locator('.event-status')).toContainText('结果已同步');
    await expect.poll(async()=>(await task()).workbenchAudit?.length||0).toBeGreaterThan(0);
    await wbMenu('audit-task-workbench');await expect(page.locator('.workbench-audit-list')).toContainText('solve');await page.locator('#dialog [data-action="close-dialog"]').first().click();
    await frame.locator('[data-cell="0,0"]').fill('-3');await frame.locator('[data-cell="0,0"]').press('Tab');
    await expect.poll(async()=>(await task()).workbenches.qubo?.matrix?.[0]?.[0]).toBe(-3);
    await wbMenu('restore-task-workbench');const options=await page.locator('#workbench-snapshot option').allTextContents();const index=options.findIndex(x=>x.includes('solve'));expect(index).toBeGreaterThanOrEqual(0);
    await page.locator('#workbench-snapshot').selectOption({index});await expect(page.locator('#snapshot-diff')).toContainText('-8');
    await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(frame.locator('[data-cell="0,0"]')).toHaveValue('-8');
    const backups=await page.evaluate(async()=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state;return window.piDesktop.vault.backup({project:s.projects[0]});});expect(backups.ok).toBe(true);
    await page.locator('#projects [data-action="project-menu"]').first().click();await page.locator('#menu [data-action="restore-project-backup"]').click();await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await expect(page.locator('#projects .project-group')).toHaveCount(3);
    await page.locator('[data-route="workbenches"]').click();await page.locator('[data-key="builder"][data-action="open-workbench"]').click();
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();   // 打开设计任务默认落在「界面预览」
    await frame.locator('#create-project').click();await expect(frame.locator('#create-project')).toContainText('打开工程目录');
    const designed=await task();expect(fs.existsSync(path.join(designed.design.workspacePath,'ui/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(designed.design.workspacePath,'server/application/actions.cjs'))).toBe(true);
    await page.screenshot({path:info.outputPath('workbench-architecture.png')});
    expect(errors).toEqual([]);
  }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
});
