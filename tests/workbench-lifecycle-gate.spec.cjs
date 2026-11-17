'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

test('工作台完整生命周期门禁：实际验证后才能发布，源码变化后失效', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lifecycle-gate-'));
  const app = await electron.launch({
    executablePath: process.env.PI_WORKBENCH_TEST_EXE || path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [...(process.env.PI_WORKBENCH_TEST_EXE ? [] : [ROOT]), '--user-data-dir=' + profile],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    const dir = await page.evaluate(async () => (await window.piDesktop.workbench.scaffold({ name: '生命周期门禁' })).result.path);
    const blank=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),dir);
    expect(blank.ok).toBe(false);expect(blank.error).toContain('前端');
    expect((await page.evaluate(path=>window.piDesktop.workbench.publish({path}),dir)).ok).toBe(false);
    require('./fixtures/workbench-ui.cjs').counter(dir);
    const before = await page.evaluate(path => window.piDesktop.workbench.verify({ path, checkOnly: true }), dir);
    expect(before.ok).toBe(false);
    const verified = await page.evaluate(path => window.piDesktop.workbench.verify({ path }), dir);
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    expect(verified.result.scope).toBe('workbench-full-lifecycle');
    expect(verified.result.lifecycle.reopened).toBe(true);
    expect(verified.result.frontend.cases[0].lifecycle.uiRestored).toBe(true);
    expect(verified.result.counts.actualPass).toBeGreaterThanOrEqual(9);
    expect((await page.evaluate(path => window.piDesktop.workbench.verify({ path, checkOnly: true }), dir)).ok).toBe(true);

    fs.appendFileSync(path.join(dir, 'ui', 'index.html'), '\n<!-- changed after verification -->\n');
    const stale = await page.evaluate(path => window.piDesktop.workbench.verify({ path, checkOnly: true }), dir);
    expect(stale.ok).toBe(false);
    const blocked = await page.evaluate(path => window.piDesktop.workbench.publish({ path }), dir);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/源码已变化|尚未完成/);
    const uiFile=path.join(dir,'ui/index.html');fs.writeFileSync(uiFile,fs.readFileSync(uiFile,'utf8').replace("document.querySelector('#increment').onclick=",'window.unbound='));
    const broken=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),dir);expect(broken.ok).toBe(false);expect(broken.result.frontend.failure.step).toBe(1);
    expect((await page.evaluate(path=>window.piDesktop.workbench.publish({path}),dir)).ok).toBe(false);
    require('./fixtures/workbench-ui.cjs').counter(dir);
    const repaired=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),dir);expect(repaired.ok,JSON.stringify(repaired)).toBe(true);
    const published=await page.evaluate(path=>window.piDesktop.workbench.publish({path}),dir);expect(published.ok,published.error).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
