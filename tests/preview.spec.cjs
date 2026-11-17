'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

test('design preview tab renders the real ui/, stays sandboxed and refreshes on change', async () => {
  const profile = fs.mkdtempSync(path.join(ROOT, '.preview-test-'));
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, chromiumSandbox: true });
  try {
    const page = await app.firstWindow(); await page.waitForLoadState('load');
    if (await page.locator('#first-launch').isVisible()) await page.locator('[data-action="dismiss-first-launch"]').click();
    const dir = await page.evaluate(async () => (await window.piDesktop.workbench.scaffold({ name: '预览测试' })).result.path);
    const ui = path.join(dir, 'ui');
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><html><body><h1 id="t">v1</h1><script type="module" src="./main.js"></script></body></html>');
    fs.writeFileSync(path.join(ui, 'main.js'), "import {v} from './m.js'; let r='';try{r=typeof parent.document.body}catch{r='blocked'}document.getElementById('t').textContent='module '+v+' parent:'+r+' bridge:'+typeof window.piDesktop;");
    fs.writeFileSync(path.join(ui, 'm.js'), 'export const v=7;');
    const first = await page.evaluate(p => window.piDesktop.workbench.preview({ path: p }), dir);
    expect(first.ok && first.exists).toBeTruthy();
    expect(first.url).toMatch(/^pi-preview:\/\//);
    const bad = await page.evaluate(() => window.piDesktop.workbench.preview({ path: 'C:\Windows' }));
    expect(bad.ok).toBe(false);
    await page.evaluate(url => { const f = document.createElement('iframe'); f.id = 'probe'; f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals'); f.src = url; document.body.appendChild(f); }, first.url);
    const frame = page.frameLocator('#probe');
    await expect(frame.locator('#t')).toHaveText('module 7 parent:blocked bridge:undefined');
    const trav = await page.evaluate(async url => { const r = await fetch(url.replace('/index.html', '/..%2f..%2fmanifest.json')); return r.status; }, first.url).catch(() => 'blocked');
    expect([403, 404, 'blocked']).toContain(trav);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><html><body>changed</body></html>');
    const second = await page.evaluate(p => window.piDesktop.workbench.preview({ path: p }), dir);
    expect(second.stamp).toBeGreaterThanOrEqual(first.stamp);
  } finally { await app.close(); }
});
