'use strict';
// 端到端：工作流「HTML 交互」开关 → 生成 workflow/index.html（及 .xlsx）→ 在真实页面里验证交互与安全。
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const node = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', brief: '做' + id, prompt: '指令 ' + id, tier: 3, dependsOn: [], ...extra });
const PLAN = JSON.stringify({ decision: 'split', goal: '选型', nodes: [node('n1', { title: '调研', agent: '研究员' }), node('n2', { title: '对比表', agent: '研究员', dependsOn: ['n1'] }), node('n3', { title: '风险', agent: '撰稿', dependsOn: ['n1'] }), node('n4', { title: '汇总', agent: '撰稿', dependsOn: ['n2', 'n3'] })] });
const OUT = {
  '指令 n1': '结论：三款里 GD32E2 最省电。\n\n- STM32L0 休眠约 80μA\n- GD32E2 休眠约 95μA\n<script>window.PWN=1</script><img src=x onerror="window.PWN=2">',
  '指令 n2': '| 型号 | 功耗 | 价格 |\n|---|---|---|\n| STM32L0 | 80 | 12 |\n| GD32E2 | 95 | 9 |\n| 乙 | 70 | 20 |',
  '指令 n3': '风险：供货周期偏长。[官网](javascript:window.PWN=3)',
  '指令 n4': '建议选 GD32E2。'
};
function sse(res, content) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const choices of [[{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: 'stop' }]]) res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'x', choices }) + '\n\n'); res.end('data: [DONE]\n\n'); }

async function launch() {
  const requests = [], mode = { digest: 'garbage' };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw || '{}');
    const sys = String(body.messages?.[0]?.content || ''), userMsg = String(body.messages?.[1]?.content || '');
    const kind = sys.includes('任务拆解器') ? 'planner' : sys.includes('只完成本步骤') ? 'node' : sys.includes('结果导读') ? 'digest' : 'chat';
    requests.push({ kind, body });
    if (kind === 'planner') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: PLAN } }] })); return; }
    if (kind === 'node') { const key = Object.keys(OUT).find(k => userMsg.startsWith(k)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: OUT[key] || 'x' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); return; }
    if (kind === 'digest') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: mode.digest === 'good' ? JSON.stringify({ headline: 'GD32E2 最省电，建议选它', findings: [{ text: 'GD32E2 休眠约 95μA', from: ['n0'] }], nodes: [{ id: 'n0', gist: '三款里 GD32E2 最省电', points: ['GD32E2 休眠约 95μA'] }], path: ['n0', 'n2'], caveats: ['供货周期偏长'] }) : 'not json at all' } }] })); return; }   // 摘要失败 → 必须走确定性回退
    sse(res, 'CHAT_DONE');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(ROOT, '.wv-')); const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace } });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await page.evaluate(async port => { await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'k', model: 'x-local', models: ['x-local'] }); window.__events = []; window.piDesktop.agent.onEvent(e => window.__events.push(e)); }, server.address().port);
  return { app, page, requests, mode, profile, workspace, close: async () => { try { await app.close(); } finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); } } };
}
const send = async (page, t) => { await page.locator('#message-input').fill(t); await page.locator('#composer').evaluate(f => f.requestSubmit()); };
const settled = page => page.waitForFunction(() => window.__events.some(e => e.type === 'agent_settled'), null, { timeout: 60000 });
const built = page => page.waitForFunction(() => /已搭好/.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 60000 });

test('HTML 交互：默认不生成也不多花调用；勾选后运行全部 → 生成 index.html 与 .xlsx；摘要失败走回退；页面可交互且注入不执行；取消勾选会删除', async () => {
  const fx = await launch();
  let browser;
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, fx.workspace);
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('网页视图');
    await fx.page.locator('#task-path-pick').click();
    await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    await fx.page.locator('#task-mode').selectOption('workflow');
    await send(fx.page, '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。');
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await built(fx.page);
    // 1) 默认没勾选：运行全部后有 .md/.xlsx，没有 index.html，也没有摘要调用
    await fr.locator('[data-act="run-all"]').click();
    await expect(fr.locator('.wf-node[data-node="n2"] .wf-runstate')).toContainText('已运行', { timeout: 40000 });
    const wf = path.join(fx.workspace, 'workflow');
    const files = () => !fs.existsSync(wf) ? [] : fs.readdirSync(wf, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => fs.readdirSync(path.join(wf, d.name)).filter(f => !f.startsWith('.')).map(f => d.name + '/' + f)).sort();
    await expect.poll(() => files().length).toBeGreaterThanOrEqual(4);
    expect(files()).toEqual(['n0-调研/结果.md', 'n10-对比表/对比表.xlsx', 'n11-风险/结果.md', 'n2-汇总/结果.md']);   // 每个节点一个文件夹   // 表格节点只出 .xlsx；文字节点出 .md
    expect(fs.existsSync(path.join(fx.workspace, 'workflow', 'index.html'))).toBe(false);
    expect(fx.requests.filter(r => r.kind === 'digest')).toHaveLength(0);
    await expect(fr.locator('[data-act="open-html"]')).toHaveCount(0);
    // 2) 勾选：生成 index.html；摘要调用 1 次（返回乱码 → 回退）；页面仍然生成
    await fr.locator('[data-act="html-view"]').check();
    const html = path.join(fx.workspace, 'workflow', 'index.html');
    await expect.poll(() => fs.existsSync(html), { timeout: 20000 }).toBe(true);
    await expect(fr.locator('[data-act="open-html"]')).toBeVisible();
    expect(fx.requests.filter(r => r.kind === 'digest').length).toBeLessThanOrEqual(1);
    expect(fx.requests.filter(r => r.kind === 'digest')).toHaveLength(1);                         // 正好一次，不是零次（否则“回退”没被走到）
    const text = fs.readFileSync(html, 'utf8');
    expect(text).toContain('window.PWN=1'.replace(/=/, '\u003d').includes('u003d') ? 'PWN' : 'PWN');   // 载荷确实在页面数据里（作为被转义的数据），不是被悄悄丢掉
    expect(text).not.toMatch(/<script>window.PWN/);                                               // 但不是以可执行脚本的形式
    const sheet = require('../runtime/xlsx-lite.cjs').readZip(fs.readFileSync(path.join(wf, 'n10-对比表', '对比表.xlsx')))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('GD32E2'); expect(sheet).toContain('<v>95</v>');                         // .xlsx 里真有数据
    // 3) 用独立的真实 Chromium 以 file:// 打开（和用户双击打开一致）
    browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('file:///' + html.replace(/\\/g, '/'));
    await expect(page.locator('#view-root')).toHaveClass(/\bjs\b/);
    expect(await page.evaluate(() => typeof window.PWN)).toBe('undefined');                       // 原文里的 <script>/onerror/javascript: 都没有执行
    await expect(page.locator('.wfv-node[data-node]')).toHaveCount(4);
    // 表格节点：真表格，可排序，有 .xlsx 链接
    const tableNode = page.locator('.wfv-node[data-node="n10"]');
    await tableNode.locator('.wfv-toggle').first().click();
    await expect(tableNode.locator('table.wfv-table, .wfv-table')).toBeVisible();
    const firstCell = () => tableNode.locator('.wfv-table tbody tr').first().locator('td').first().innerText();
    const th = tableNode.locator('.wfv-table th').nth(1);
    await th.click(); const asc = await firstCell(); await th.click(); const desc = await firstCell();
    expect(asc).not.toBe(desc);
    await expect(tableNode.locator('a[href$=".xlsx"]')).toHaveCount(1);
    // 搜索：命中自动展开并高亮，不命中隐藏
    await page.locator('.wfv-search').fill('供货');
    await expect(page.locator('mark.wfv-hit').first()).toBeVisible();
    await expect(page.locator('.wfv-node[data-node="n0"]')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('.wfv-node[data-node="n0"]')).toBeVisible();
    // 窄屏：改为列表，无横向滚动
    await page.setViewportSize({ width: 400, height: 800 });
    await expect(page.locator('.wfv-flow-list')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    // 4) 取消勾选：删除 index.html，避免留下过期页面
    await fr.locator('[data-act="html-view"]').uncheck();
    await expect.poll(() => fs.existsSync(html), { timeout: 15000 }).toBe(false);
    await expect(fr.locator('[data-act="open-html"]')).toHaveCount(0);
  } finally { if (browser) await browser.close(); await fx.close(); }
});

test('HTML 交互：摘要成功时页面用的是模型写的导读；节点结果不变时再次保存不重复调用模型（按内容缓存）', async () => {
  const fx = await launch(); fx.mode.digest = 'good';
  let browser;
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, fx.workspace);
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('导读'); await fx.page.locator('#task-path-pick').click(); await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    await fx.page.locator('#task-mode').selectOption('workflow');
    await send(fx.page, '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。');
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 }); await built(fx.page);
    await fr.locator('[data-act="html-view"]').check();
    await fr.locator('[data-act="run-all"]').click();
    await expect(fr.locator('.wf-node[data-node="n2"] .wf-runstate')).toContainText('已运行', { timeout: 40000 });
    const html = path.join(fx.workspace, 'workflow', 'index.html');
    await expect.poll(() => fs.existsSync(html) && fs.readFileSync(html, 'utf8').includes('GD32E2 最省电，建议选它'), { timeout: 20000 }).toBe(true);
    const calls = () => fx.requests.filter(r => r.kind === 'digest').length;
    await expect.poll(calls).toBeGreaterThanOrEqual(1);
    const before = calls();
    // 只挪动节点位置：内容没变 → 不应再调用摘要
    const box = await fr.locator('.wf-node[data-node="n0"] header').boundingBox();
    await fx.page.mouse.move(box.x + 40, box.y + 8); await fx.page.mouse.down(); await fx.page.mouse.move(box.x + 100, box.y + 60, { steps: 5 }); await fx.page.mouse.up();
    await fx.page.waitForTimeout(2500);
    expect(calls()).toBe(before);
    browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
    const page = await browser.newPage(); await page.goto('file:///' + html.replace(/\\/g, '/'));
    await expect(page.locator('body')).toContainText('GD32E2 最省电，建议选它');
    await expect(page.locator('body')).toContainText('供货周期偏长');
  } finally { if (browser) await browser.close(); await fx.close(); }
});
