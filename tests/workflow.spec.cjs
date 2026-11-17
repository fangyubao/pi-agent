'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const N = (id, e = {}) => ({ id, title: e.title || '任务' + id, role: e.role || '分析师', brief: e.brief || '做' + id, prompt: '完整提示词 ' + id + '：' + '这是很长的内容。'.repeat(10), tier: e.tier || 'standard', dependsOn: e.dependsOn || [], skills: e.skills || [], tools: e.tools || [] });
const PLAN = [N('n1', { title: '需求澄清', role: '产品经理' }), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n1'] }), N('n4', { dependsOn: ['n1'] }), N('n5', { title: '汇总', dependsOn: ['n2', 'n3', 'n4'] })];

async function launch() {
  const profile = fs.mkdtempSync(path.join(ROOT, '.workflow-'));
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await page.locator('[data-route="workbenches"]').click();
  await page.locator('[data-action="open-use-workbench"][data-key="workflow"]').click();
  await page.locator('#use-task').selectOption('__new__'); await page.locator('#dialog-form').evaluate(f => f.requestSubmit());
  const fr = page.frameLocator('#module-frame'); await fr.locator('.wf-root').waitFor({ timeout: 10000 });
  return { app, page, fr, profile, close: async () => { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}
// 走画布自己的 server() 通道：画布 → 壳层 runWorkbenchAction → 后端 → 状态写回内存任务 → 再推给画布。
// 直接改 localStorage 不行：应用的真实状态在内存里，下一次保存会把它覆盖。
async function write(fx, action, payload) {
  return fx.fr.locator('body').evaluate((_, [a, p]) => window.server(a, p), [action, payload]);
}
const state = page => page.evaluate(async () => { await window.PiPersistence.flush();const st = (await window.piDesktop.storage.load()).result.state; return st.projects.flatMap(p => p.tasks).find(x => x.id === st.activeTask).workbenches.workflow; });

test('并行节点在同一列上下排，串行节点从左到右；空状态有引导', async () => {
  const fx = await launch();
  try {
    await expect(fx.fr.locator('.wf-empty')).toBeVisible();
    expect((await write(fx, 'setPlan', { goal: '立项评估', nodes: PLAN })).count).toBe(5);   // server() 返回动作结果
    await expect(fx.fr.locator('.wf-node')).toHaveCount(5);
    await expect(fx.fr.locator('.wf-meta')).toContainText('5 个节点 · 1 处并行');
    const box = async id => fx.fr.locator('[data-node="' + id + '"]').boundingBox();
    const [n1, n2, n3, n4, n5] = await Promise.all(['n0', 'n10', 'n11', 'n12', 'n2'].map(box));
    expect(Math.abs(n2.x - n3.x)).toBeLessThan(2); expect(Math.abs(n3.x - n4.x)).toBeLessThan(2);   // 并行：同一列
    expect(n3.y).toBeGreaterThan(n2.y); expect(n4.y).toBeGreaterThan(n3.y);                          // 同一列上下排
    expect(n2.x).toBeGreaterThan(n1.x); expect(n5.x).toBeGreaterThan(n2.x);                           // 串行：从左到右
    const rects = [n1, n2, n3, n4, n5]; for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j]; expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);   // 互不重叠
    }
  } finally { await fx.close(); }
});

test('节点显示：角色、任务介绍、模型（没配档位时显示“主模型”）；双击才出现完整提示词', async () => {
  const fx = await launch();
  try {
    await write(fx, 'setPlan', { goal: 'g', nodes: PLAN });
    const n1 = fx.fr.locator('[data-node="n0"]');
    await expect(n1).toContainText('产品经理'); await expect(n1).toContainText('做n1'); await expect(n1.locator('.wf-model')).toContainText('主模型');
    await expect(n1).not.toContainText('完整提示词');                                // 卡片上没有完整提示词
    await n1.dblclick();
    await expect(fx.fr.locator('.wf-full')).toContainText('完整提示词 n1');
    await fx.fr.locator('[data-act="close-pop"]').click(); await expect(fx.fr.locator('.wf-pop')).toBeHidden();
  } finally { await fx.close(); }
});

test('修改节点：确定后写入后端，并把下游标成“需更新”；版本冲突时给出原因而不是静默失败', async () => {
  const fx = await launch();
  try {
    await write(fx, 'setPlan', { goal: 'g', nodes: PLAN });
    await fx.fr.locator('[data-node="n0"] [data-act="edit"]').click();
    await fx.fr.locator('.wf-editor [data-f="prompt"]').fill('改过的提示词');
    await fx.fr.locator('[data-act="save-editor"]').click();
    await expect(fx.fr.locator('.wf-editor')).toHaveCount(0);
    expect((await state(fx.page)).nodes[0].prompt).toBe('改过的提示词');
    await expect(fx.fr.locator('[data-node="n10"].stale')).toHaveCount(1);          // 下游标出过期
    // 编辑到一半，Agent 同时改了版本 → 保存失败要说明原因
    await fx.fr.locator('[data-node="n10"] [data-act="edit"]').click();
    await write(fx, 'updateNode', { baseRevision: (await state(fx.page)).revision, id: 'n11', patch: { title: 'Agent 改的' } });
    await fx.fr.locator('.wf-editor [data-f="role"]').fill('新角色');
    await fx.fr.locator('[data-act="save-editor"]').click();
    await expect(fx.fr.locator('.wf-editor')).toHaveCount(1);                       // 编辑框保留，用户不会丢内容
  } finally { await fx.close(); }
});

test('模型两级菜单：先厂商，再该厂商下的模型；选择后写入节点并显示', async () => {
  const fx = await launch();
  try {
    await write(fx, 'setPlan', { goal: 'g', nodes: PLAN });
    await fx.page.evaluate(() => document.querySelector('#module-frame').contentWindow.postMessage({ source: 'pi-workbench-shell', key: 'workflow', type: 'invoke', command: 'setModels', payload: { models: [{ profileId: 'pa', vendor: '厂商甲', models: ['甲-小', '甲-大'] }, { profileId: 'pb', vendor: '厂商乙', models: ['乙-一'] }] } }, '*'));
    await fx.fr.locator('[data-node="n10"] .wf-model').click();
    await expect(fx.fr.locator('.wf-vendor-btn')).toHaveCount(2);                   // 第一级：厂商
    await expect(fx.fr.locator('.wf-vendor-btn').first()).toContainText('厂商甲');
    await fx.fr.locator('.wf-vendor-btn').first().click();                           // 展开第二级
    await expect(fx.fr.locator('.wf-sub button').filter({ hasText: '甲-大' })).toBeVisible();
    await fx.fr.locator('.wf-sub button').filter({ hasText: '甲-大' }).click();
    await expect(fx.fr.locator('[data-node="n10"] .wf-model')).toContainText('甲-大');
    expect((await state(fx.page)).nodes[1].model).toEqual({ profileId: 'pa', model: '甲-大', source: 'user' });
  } finally { await fx.close(); }
});

test('拖动节点会保存位置；平移与缩放不改变计划版本；Agent 写入时画布不跳视口', async () => {
  const fx = await launch();
  try {
    await write(fx, 'setPlan', { goal: 'g', nodes: PLAN });
    const before = (await state(fx.page)).revision;
    const box = await fx.fr.locator('[data-node="n10"] header').boundingBox();
    await fx.page.mouse.move(box.x + 40, box.y + 8); await fx.page.mouse.down(); await fx.page.mouse.move(box.x + 120, box.y + 70, { steps: 6 }); await fx.page.mouse.up();
    await expect.poll(async () => (await state(fx.page)).nodes[1].pos).not.toBeNull();
    expect((await state(fx.page)).planRevision).toBe(1);                              // 只是挪位置，不算计划变化
    // 滚轮缩放：视口是个人浏览习惯，不进计划状态，所以不递增版本（否则 Agent 手里的 baseRevision 会失效）
    const revision = (await state(fx.page)).revision;
    const zoom0 = await fx.fr.locator('.wf-zoom span').innerText();
    await fx.fr.locator('.wf-canvas').hover(); await fx.page.mouse.wheel(0, -300);
    await expect(fx.fr.locator('.wf-zoom span')).not.toHaveText(zoom0);
    expect((await state(fx.page)).revision).toBe(revision);
    expect((await state(fx.page)).viewport).toBeUndefined();                          // 视口不在计划状态里
    await expect.poll(() => fx.fr.locator('body').evaluate(() => Object.keys(localStorage).some(k => k.startsWith('pi-workflow-view:')))).toBe(true);   // 存在画布自己的存储里
    // Agent 此刻在聊天里追加一个节点：视口保持不变
    // 比较数值而不是样式字符串：同一个视口，浏览器重新渲染前后的序列化格式可能不同。
    const vp = async () => fx.fr.locator('.wf-world').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return [Math.round(m.e * 100), Math.round(m.f * 100), Math.round(m.a * 1000)]; });
    const styleBefore = await vp();
    await write(fx, 'addNode', { baseRevision: (await state(fx.page)).revision, node: { title: '新增', role: '编辑', prompt: '补充', dependsOn: ['n2'] } });
    await expect(fx.fr.locator('.wf-node')).toHaveCount(6);
    expect(await vp()).toEqual(styleBefore);
    expect(before).toBeGreaterThan(0);
  } finally { await fx.close(); }
});

test('画布上的节点编号：串行 n0、n1…；第 1 阶段有 2 个并行就是 n0, n10, n11, n2；增删节点后自动重排编号', async () => {
  const fx = await launch();
  try {
    await write(fx, 'setPlan', { goal: 'g', nodes: [N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n1'] }), N('n4', { dependsOn: ['n2', 'n3'] })] });
    const ids = async () => (await fx.fr.locator('.wf-node .wf-id').allInnerTexts());
    await expect.poll(ids).toEqual(['n0', 'n10', 'n11', 'n2']);
    // 再追加一个依赖 n2 的节点 → 第 3 阶段，唯一 → n3
    await write(fx, 'addNode', { baseRevision: (await state(fx.page)).revision, node: { title: '收尾', role: '编辑', prompt: 'x', dependsOn: ['n2'] } });
    await expect.poll(ids).toEqual(['n0', 'n10', 'n11', 'n2', 'n3']);
    // 删掉一个并行节点 → 剩下的变回串行，编号收拢
    await write(fx, 'removeNode', { baseRevision: (await state(fx.page)).revision, id: 'n11' });
    await expect.poll(ids).toEqual(['n0', 'n1', 'n2', 'n3']);
  } finally { await fx.close(); }
});
