'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function enableComposer(page,ids){await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-toggles').click();for(const id of ids){const box=page.locator('[data-composer-toggle="'+id+'"]');if(!(await box.isChecked()))await box.evaluate(el=>el.click());}await page.locator('.brand').click();}
test('任务上下文可查看、审计、编辑、排除并恢复历史', async ({}, testInfo) => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-context-'));
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
    await enableComposer(page,['capacity']);
    await expect(page.locator('#context-capacity')).toContainText('上下文');

    const taskMenu = page.locator('.task-row.selected [data-action="task-menu"]');
    await taskMenu.click();
    await page.locator('#menu [data-action="task-context-menu"]').hover();
    await expect(page.locator('#submenu')).toBeVisible();
    await expect(page.locator('#submenu button')).toHaveCount(4);
    await expect(page.locator('#submenu')).toContainText('查看上下文');
    await expect(page.locator('#submenu')).toContainText('重建干净上下文');
    await page.locator('#submenu [data-action="open-task-context"]').click();

    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('#context-surface')).toBeVisible();
    await expect(page.locator('.context-page-head')).toContainText('上下文查看');
    await expect(page.locator('.context-capacity-card')).toBeVisible();
    await expect(page.locator('.context-source-row')).not.toHaveCount(0);
    await page.locator('.context-page .help-button[data-help-key="context-preview"]').first().click();
    await expect(page.locator('.help-popover')).toContainText('上下文内容');
    await page.keyboard.press('Escape');
    await expect(page.locator('.help-popover')).toHaveCount(0);

    await page.locator('.context-tab[data-context-view="content"]').click();
    await page.locator('[data-context-action="edit-goal"]').click();
    await page.locator('.context-edit-form textarea[name="goal"]').fill('保持本任务的设计约束，并优先使用本地工作台状态。');
    await page.locator('.context-edit-form textarea[name="notes"]').fill('只载入与当前请求相关的记忆。');
    await page.locator('.context-edit-form').evaluate(form => form.requestSubmit());
    await expect(page.locator('.context-goal-preview')).toContainText('保持本任务的设计约束');
    await expect(page.locator('.context-revision')).not.toContainText('r0');

    const firstToggle = page.locator('[data-context-toggle]:not(:disabled)').first();
    await firstToggle.uncheck();
    await expect(firstToggle).not.toBeChecked();

    await page.locator('.context-tab[data-context-view="audit"]').click();
    await expect(page.locator('.audit-banner')).toBeVisible();
    await page.locator('.context-tab[data-context-view="history"]').click();
    await expect(page.locator('.context-history-item')).not.toHaveCount(0);
    await page.locator('.context-history-item [data-context-restore]').first().click();
    await expect(page.locator('.context-page')).toBeVisible();

    await page.locator('[data-context-action="rebuild"]').click();
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('pi-workbench-design-v2'));
      const task = saved.projects.flatMap(project => project.tasks).find(item => item.id === saved.activeTask);
      return task?.context?.cleanStart === true;
    })).toBe(true);
    await page.locator('.context-tab[data-context-view="content"]').click();
    await expect(page.locator('.context-block-card').filter({ hasText: '旧对话（已重建时排除）' })).toBeVisible();

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pi-workbench-design-v2')));
    const task = stored.projects.flatMap(project => project.tasks).find(item => item.id === stored.activeTask);
    expect(task.context).toBeTruthy();
    expect(task.context.history.length).toBeGreaterThan(0);
    expect(task.context.overrides.goal).toContain('保持本任务的设计约束');

    await page.screenshot({ path: testInfo.outputPath('context-panel.png'), fullPage: false });
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
