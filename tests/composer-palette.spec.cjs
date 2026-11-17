'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('输入 / 可筛选并执行 Pi 桌面指令', async ({}, testInfo) => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-commands-'));
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
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(require('../package.json').version);
    await page.evaluate(() => { localStorage.clear(); location.reload(); });
    await expect(page.locator('#message-input')).toBeVisible();

    await page.locator('#message-input').fill('/');
    await expect(page.locator('.composer-palette')).toBeVisible();
    await expect(page.locator('.composer-palette-head')).toContainText('Pi 指令');
    await expect(page.locator('.composer-palette-option')).toHaveCount(27);
    await page.screenshot({ path: testInfo.outputPath('slash-command-palette.png') });

    await page.locator('#message-input').fill('/hotk');
    await expect(page.locator('.composer-palette-option')).toHaveCount(1);
    await expect(page.locator('.composer-palette-option')).toContainText('/hotkeys');
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialog')).toContainText('键盘快捷键');
    await page.locator('#dialog [data-action="close-dialog"]').first().click();

    await page.locator('#message-input').fill('/name');
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#message-input')).toHaveValue('/name ');
    await page.locator('#message-input').fill('/name 指令测试任务');
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#breadcrumb')).toContainText('指令测试任务');
    await expect(page.locator('.message.user')).toHaveCount(0);

    await page.locator('#message-input').fill('/set');
    await expect(page.locator('.composer-palette-option').filter({ hasText: '/settings' })).toBeVisible();
    await page.locator('#message-input').press('Escape');
    await expect(page.locator('.composer-palette')).toBeHidden();
    await expect(page.locator('#message-input')).toHaveValue('/set');
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('输入 @ 在当前任务中使用工作台和插件', async ({}, testInfo) => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-mentions-'));
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
    const taskId = await page.locator('.task-row.selected .task-select').getAttribute('data-id');

    await page.locator('#message-input').fill('@');
    await expect(page.locator('.composer-palette')).toBeVisible();
    await expect(page.locator('.composer-palette-head')).toContainText('使用插件或工作台');
    await expect(page.locator('.composer-palette-option')).toHaveCount(5);   // 4 个工作台（含工作流）+ 1 个插件
    await expect(page.locator('.composer-palette-badge').filter({ hasText: '工作台' })).toHaveCount(4);
    await expect(page.locator('.composer-palette-badge').filter({ hasText: '插件' })).toHaveCount(1);

    await page.locator('#message-input').fill('@qu');
    await expect(page.locator('.composer-palette-option')).toHaveCount(1);
    await expect(page.locator('.composer-palette-option')).toContainText('QUBO 求解器');
    await page.screenshot({ path: testInfo.outputPath('mention-workbench-palette.png') });
    await page.locator('.composer-palette-option').click();
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('#workbench-title')).toContainText('QUBO 求解器');
    await expect(page.locator('#dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(async() => {
      await window.PiPersistence.flush();
      const state = (await window.piDesktop.storage.load()).result.state;
      const task = state.projects.flatMap(project => project.tasks).find(item => item.id === state.activeTask);
      return { activeTask: state.activeTask, key: task?.workbenchSession?.key, open: task?.workbenchSession?.open };
    })).toEqual({ activeTask: taskId, key: 'qubo', open: true });
    await expect(page.locator('#message-input')).toHaveValue('');

    await page.locator('#message-input').fill('@任务上下');
    await expect(page.locator('.composer-palette-option')).toHaveCount(1);
    await expect(page.locator('.composer-palette-option')).toContainText('任务上下文');
    await page.locator('.composer-palette-option').click();
    await expect.poll(() => page.evaluate(async() => {await window.PiPersistence.flush();return JSON.parse(localStorage.getItem('pi-workbench-design-v2')).plugins;})).toEqual(['task-context']);
    await expect(page.locator('.composer-context')).toContainText('QUBO 求解器');
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
