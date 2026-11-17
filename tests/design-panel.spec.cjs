'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('设计中框：满高 2:1 分区、独立滚动且设计进度只读', async ({}, testInfo) => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-design-'));
  const packaged = process.env.PI_WORKBENCH_TEST_EXE;
  const app = await electron.launch({
    executablePath: packaged || path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [...(packaged ? [] : [ROOT]), `--user-data-dir=${profile}`],
    cwd: packaged ? path.dirname(packaged) : ROOT
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const stage = page.locator('.design-stage.current');
  const toggle = page.locator('[data-action="toggle-task-workbench"]');
  async function resize(width, height) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    // 无边框窗口的内容区可能比请求值多出 1-2px（系统缩放边框），容忍这点误差。
    await expect.poll(() => page.evaluate(([w,h]) => Math.max(Math.abs(innerWidth-w),Math.abs(innerHeight-h)), [width,height])).toBeLessThanOrEqual(3);
  }
  async function checkGeometry() {
    await expect(page.locator('.design-dock')).toBeVisible();
    // Native window resize precedes ResizeObserver delivery. Wait for the
    // stage rows to use the new viewport size before asserting exact geometry.
    await expect.poll(() => page.evaluate(() => {
      const viewport=document.querySelector('.design-stage-viewport');
      return Math.abs(Number(viewport.dataset.rowHeight)-Math.max(24,viewport.clientHeight/3));
    })).toBeLessThan(0.1);
    const result = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
      const history = box('.design-history'), workflow = box('.design-workflow');
      const current = document.querySelector('.design-stage.current');
      const viewport = document.querySelector('.design-stage-viewport');
      return {
        panel:box('#design-panel'), dock:box('.design-dock'), history, workflow, breadcrumb:box('#breadcrumb'),
        chat:box('#main'), bench:box('#workbench-panel'), viewport:box('.design-stage-viewport'),
        current:current ? box('.design-stage.current') : null,
        next:document.querySelector('.design-stage.next') ? box('.design-stage.next') : null,
        historyColor:getComputedStyle(document.querySelector('.design-history')).backgroundColor,
        workflowColor:getComputedStyle(document.querySelector('.design-workflow')).backgroundColor,
        mask:getComputedStyle(viewport).maskImage,
        row:Number(viewport.dataset.rowHeight),
        actionButtons:document.querySelectorAll('.design-stage-action button').length,
        status:document.querySelector('.design-flow-status')?.textContent||''
      };
    });
    expect(result.history.height / result.workflow.height).toBeCloseTo(2, 1);
    expect(result.dock.height / result.panel.height).toBeGreaterThan(.96);
    expect(result.workflow.bottom).toBeGreaterThan(result.panel.bottom - 16);
    expect(result.panel.x).toBeGreaterThanOrEqual(result.chat.right - 1);
    expect(result.bench.x).toBeGreaterThan(result.panel.right);
    expect(result.historyColor).not.toBe(result.workflowColor);
    expect(result.breadcrumb.width).toBeGreaterThan(70);
    expect(result.mask).toContain('linear-gradient');
    expect(result.viewport.height).toBeGreaterThan(64);
    expect(result.actionButtons).toBe(0);
    expect(result.status).toMatch(/待开始|执行中|待确认|已确认完成/);
    for (const card of [result.current,result.next].filter(Boolean)) {
      expect(card.y).toBeGreaterThanOrEqual(result.viewport.y + result.row/2 - 2);
      expect(card.bottom).toBeLessThanOrEqual(result.viewport.bottom - result.row/2 + 2);
    }
    return result;
  }
  async function screenshot(name) {
    await expect(page.locator('#toast')).toBeHidden();
    const output = testInfo.outputPath(name + '.png');
    await page.screenshot({ path:output });
    await testInfo.attach(name, { path:output, contentType:'image/png' });
  }
  try {
    await expect(page.locator('#projects .project-group')).toHaveCount(2);
    await resize(1440, 900);
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(stage).toContainText('需求确认');
    await expect(page.locator('[data-action="design-stage-next"]')).toHaveCount(0);
    await expect(page.locator('[data-action="design-stage-back"]')).toHaveCount(0);
    await expect(page.locator('[data-action="confirm-design"]')).toBeVisible();
    await expect(page.frameLocator('#module-frame').locator('#wb-next')).toHaveCount(0);
    await checkGeometry();
    await screenshot('design-create');

    const scroll = page.locator('.design-stage-viewport');
    const initialScroll = await scroll.evaluate(el => el.scrollTop);
    await scroll.hover();
    await page.mouse.wheel(0, 180);
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(initialScroll + 10);
    await expect(stage).toContainText('需求确认');

    await toggle.click();
    await expect(page.locator('#design-panel')).toBeHidden();
    await toggle.click();
    await expect(stage).toContainText('需求确认');
    await page.reload();
    await expect(stage).toContainText('需求确认');
    await checkGeometry();
    await screenshot('design-history');

    await resize(1280, 720);
    await checkGeometry();
    await screenshot('design-compact');

    await resize(1440, 900);
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="qubo"][data-mode="edit"]').click();
    await expect(page.frameLocator('#preview-frame').locator('[aria-label="QUBO q00"]')).toHaveValue('-1');
    await expect(stage).toContainText('需求确认');
    await expect(page.locator('[data-action="confirm-design"]')).toBeVisible();
    await expect(page.locator('[data-action="design-stage-next"]')).toHaveCount(0);
    await checkGeometry();
    await screenshot('design-modify');

    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();
    await page.locator('#dialog-form').evaluate(form => form.requestSubmit());
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('#design-panel')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive:true, force:true });
  }
});
