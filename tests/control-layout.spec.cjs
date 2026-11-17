'use strict';

const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

async function launch(){
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-controls-'));
  const packaged=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:packaged||path.join(ROOT,'node_modules','electron','dist','electron.exe'),args:[...(packaged?[]:[ROOT]),'--user-data-dir='+profile],cwd:packaged?path.dirname(packaged):ROOT});
  const page=await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  await page.evaluate(()=>{localStorage.clear();location.reload();});
  await expect(page.locator('#message-input')).toBeVisible();
  return {app,page,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}

function outside(selector,parentSelector){
  return page=>page.locator(selector).evaluateAll((nodes,parentSelector)=>nodes.map(node=>{
    const parent=node.closest(parentSelector),r=node.getBoundingClientRect(),p=parent?.getBoundingClientRect();
    return {text:node.textContent.trim(),outside:!p||r.left<p.left-1||r.right>p.right+1||r.top<p.top-1||r.bottom>p.bottom+1};
  }).filter(item=>item.outside),parentSelector);
}

test('工作台、插件和设置控件不越界，空记忆与上下文显示明确',async()=>{
  const {app,page,close}=await launch();
  try{
    await page.locator('[data-route="workbenches"]').click();
    await expect(page.locator('.workbench-card')).toHaveCount(5);   // 创建卡 + 4 个内置工作台
    expect(await outside('.workbench-card .button','.workbench-card')(page)).toEqual([]);
    expect(await page.locator('.card-actions').evaluateAll(nodes=>nodes.filter(node=>node.scrollWidth>node.clientWidth+1).length)).toBe(0);

    await page.locator('[data-route="plugins"]').click();
    expect(await outside('.plugin-row .button','.plugin-row')(page)).toEqual([]);
    await page.locator('[data-route="settings"]').click();
    expect(await outside('.setting-row button','.setting-row')(page)).toEqual([]);
    await page.locator('#settings-tab-ui').click();
    expect(await outside('.setting-row button','.setting-row')(page)).toEqual([]);
    expect(await outside('.shortcut-control button','.shortcut-row')(page)).toEqual([]);
    await expect(page.locator('#agent-environment-setting')).toHaveValue('auto');
    await expect(page.locator('#agent-environment-setting option[value="git-bash"]')).toBeEnabled();
    await expect(page.locator('#agent-environment-setting option[value="wsl"]')).toBeEnabled();
    await expect(page.locator('#agent-environment-setting option[value="cmd"]')).toBeEnabled();
    await expect(page.locator('#agent-environment-status')).toBeVisible();
    await page.locator('#agent-environment-setting').selectOption('cmd');
    await expect(page.locator('#agent-environment-setting')).toHaveValue('cmd');
    await expect(page.locator('#agent-environment-status')).toContainText('cmd');
    await page.locator('#agent-environment-setting').selectOption('wsl');
    await expect(page.locator('#agent-environment-setting')).toHaveValue('wsl');
    await page.locator('#agent-environment-setting').selectOption('git-bash');
    await expect(page.locator('#agent-environment-setting')).toHaveValue('git-bash');

    await page.locator('.task-row.selected [data-action="task-menu"]').click();
    await page.locator('#menu [data-action="task-memory-menu"]').hover();
    await page.locator('#submenu [data-action="open-task-memory-all"]').click();
    await expect(page.locator('.memory-empty').first()).toContainText('空状态是正常的');
    await expect(page.locator('.memory-empty-action').first()).toBeVisible();

    await page.locator('.task-row.selected [data-action="task-menu"]').click();
    await page.locator('#menu [data-action="task-context-menu"]').hover();
    await page.locator('#submenu [data-action="open-task-context"]').click();
    expect(await page.locator('.context-source-row').count()).toBeGreaterThan(0);
    await expect(page.locator('.context-source-row').first()).toBeVisible();
  }finally{await close();}
});
