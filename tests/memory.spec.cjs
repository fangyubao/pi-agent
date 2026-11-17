'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('项目/任务记忆可审阅恢复，并与工作台标签并存', async ({}, testInfo) => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-memory-'));
  const executablePath = process.env.PI_WORKBENCH_TEST_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = await electron.launch({
    executablePath,
    args: [...(process.env.PI_WORKBENCH_TEST_EXE ? [] : [ROOT]), `--user-data-dir=${profile}`],
    cwd: process.env.PI_WORKBENCH_TEST_EXE ? path.dirname(executablePath) : ROOT
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.evaluate(() => { localStorage.clear(); location.reload(); });
    await expect(page.locator('#message-input')).toBeVisible();

    await page.locator('[data-action="project-menu"][data-id="quantum"]').click();
    await page.locator('#menu [data-action="project-memory-menu"]').hover();
    await expect(page.locator('#menu')).toBeVisible();
    await expect(page.locator('#submenu')).toBeVisible();
    await expect(page.locator('#submenu button')).toHaveCount(3);
    await expect(page.locator('#submenu')).toContainText('全部记忆');
    await expect(page.locator('#submenu')).toContainText('长期记忆');
    await expect(page.locator('#submenu')).toContainText('短期记忆');
    await expect(page.locator('#submenu')).not.toContainText('历史');
    await expect(page.locator('#submenu')).not.toContainText('待确认');
    await page.locator('#menu [data-action="project-copy-menu"]').hover();
    await expect(page.locator('#submenu')).toContainText('导出 Markdown');
    await page.locator('#menu [data-action="project-memory-menu"]').hover();
    await expect(page.locator('#submenu')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('memory-cascade-menu.png'),fullPage:false});
    await page.locator('#submenu [data-action="open-project-memory-long"]').click();

    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('#memory-surface')).toBeVisible();
    await expect(page.locator('.memory-page-head')).toContainText('项目记忆 · 长期记忆');
    await page.locator('[data-memory-action="generate"]').first().click();
    await expect(page.locator('#memory-generate-form')).toBeVisible();
    await expect(page.locator('input[name="sourceMode"][value="context"]')).toBeChecked();
    await expect(page.locator('[data-memory-context-source]')).toContainText('量子算法研究');
    await page.locator('input[name="sourceMode"][value="manual"]').check();
    await expect(page.locator('#memory-generate-form textarea[name="text"]')).toBeVisible();
    await page.locator('input[name="sourceMode"][value="context"]').check();
    await expect(page.locator('#memory-generate-form textarea[name="text"]')).toBeHidden();
    await page.locator('[data-memory-action="cancel-generate"]').click();
    await page.locator('[data-memory-action="new"]').first().click();
    await page.locator('#memory-editor textarea[name="content"]').fill('所有量子算法工作台必须支持完全离线运行。');
    await page.locator('#memory-editor select[name="kind"]').selectOption('core');
    await page.locator('#memory-editor').evaluate(form => form.requestSubmit());
    await expect(page.locator('.memory-card')).toContainText('所有量子算法工作台必须支持完全离线运行。');
    await expect(page.locator('.memory-card')).toContainText('已确认');

    await page.locator('.memory-card [data-memory-action="edit"]').click();
    await page.locator('#memory-editor textarea[name="content"]').fill('所有量子算法工作台必须支持完全离线运行，并优先使用本地算力。');
    await page.locator('#memory-editor').evaluate(form => form.requestSubmit());
    await expect(page.locator('.memory-card')).toContainText('版本 2');
    await page.locator('.memory-card [data-memory-action="versions"]').click();
    await expect(page.locator('.memory-history-view')).toContainText('当前 v2');
    await expect(page.locator('.memory-history-view')).toContainText('v1');
    await page.locator('[data-memory-action="restore-version"][data-version="1"]').click();
    await expect(page.locator('.memory-card p')).toHaveText('所有量子算法工作台必须支持完全离线运行。');
    await page.locator('[data-memory-action="undo"]').click();
    await expect(page.locator('.memory-card p')).toHaveText('所有量子算法工作台必须支持完全离线运行，并优先使用本地算力。');

    await page.locator('#message-input').fill('@qu');
    await page.locator('.composer-palette-option').click();
    await expect(page.locator('#module-frame')).toBeVisible();
    await expect(page.locator('.side-panel-tab')).toHaveCount(2);
    const qubo = page.frameLocator('#module-frame');
    await expect(qubo.locator('[aria-label="QUBO q00"]')).toBeVisible();
    await qubo.locator('[aria-label="QUBO q00"]').fill('-7');

    await page.locator('.task-row.selected [data-action="task-menu"]').click();
    await page.locator('#menu [data-action="task-memory-menu"]').hover();
    await page.locator('#submenu [data-action="open-task-memory-short"]').click();
    await expect(page.locator('#memory-surface')).toBeVisible();
    await expect(page.locator('.side-panel-tab')).toHaveCount(3);
    await expect(page.locator('.memory-inherited')).toContainText('继承自项目 · 只读');
    await expect(page.locator('.memory-inherited')).toContainText('优先使用本地算力');

    await page.locator('[data-memory-action="new"]').first().click();
    await page.locator('#memory-editor textarea[name="content"]').fill('本任务中 QUBO 对角项采用负值表示奖励。');
    await page.locator('#memory-editor select[name="kind"]').selectOption('correction');
    await page.locator('#memory-editor').evaluate(form => form.requestSubmit());
    await expect(page.locator('.memory-list > .memory-card')).toContainText('本任务中 QUBO 对角项采用负值表示奖励。');
    await page.screenshot({path:testInfo.outputPath('memory-panel-open.png'),fullPage:false});

    const capsule = await page.evaluate(() => {
      const project={name:'测试项目'}, task={name:'测试任务'};
      PiMemoryManager.create(project,{content:'量子工作台必须离线运行',kind:'core',lifespan:'long'});
      PiMemoryManager.create(project,{content:'量子工作台待确认规则',kind:'core',lifespan:'long',source:'agent'});
      PiMemoryManager.create(task,{content:'当前量子任务使用 QUBO',kind:'continuation',lifespan:'short'});
      const result=PiMemoryManager.buildCapsule(project,task,'请继续量子 QUBO 工作',{maxItems:6,maxChars:2400});
      return {result,keys:result.items.map(item=>Object.keys(item).sort())};
    });
    expect(capsule.result.items.map(item=>item.content)).toEqual(expect.arrayContaining(['量子工作台必须离线运行','当前量子任务使用 QUBO']));
    expect(capsule.result.items.map(item=>item.content)).not.toContain('量子工作台待确认规则');
    expect(capsule.keys.every(keys=>!keys.includes('history')&&!keys.includes('status'))).toBe(true);

    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();
    await expect(page.locator('#module-frame')).toBeVisible();
    await expect(qubo.locator('[aria-label="QUBO q00"]')).toHaveValue('-7');
    await page.locator('[data-action="select-side-tab"][data-tab^="memory:task:"]').click();
    await page.locator('[data-action="close-side-tab"][data-tab^="memory:task:"]').click();
    await expect(page.locator('#module-frame')).toBeVisible();
    await page.locator('[data-action="close-side-tab"][data-tab="workbench"]').click();
    await expect(page.locator('#memory-surface')).toBeVisible();
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await page.locator('[data-action="close-side-tab"][data-tab^="memory:project:"]').click();
    await expect(page.locator('#workbench-panel')).toBeHidden();

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pi-workbench-design-v2')));
    const project = stored.projects.find(item => item.id === 'quantum');
    const task = project.tasks.find(item => item.id === stored.activeTask);
    expect(project.memory.entries).toHaveLength(1);
    expect(project.memory.entries[0].version).toBe(2);
    expect(task.memory.entries).toHaveLength(1);
    expect(task.memory.entries[0].lifespan).toBe('short');
    await page.screenshot({path:testInfo.outputPath('memory-panel.png'),fullPage:true});
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile,{recursive:true,force:true});
  }
});
