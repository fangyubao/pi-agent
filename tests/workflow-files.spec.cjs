'use strict';
// 端到端：节点交付类型与附件。假模型记录每次请求，断言：
//   · 附件（xlsx/csv/文本）被读成文字、放进该节点请求的 DATA 围栏；没勾交付类型的节点不多加任何文件协议文字
//   · 勾了交付类型的节点：模型按 <<<FILE 协议返回 → 文件落进该节点自己的文件夹，表格另存 .xlsx
//   · 改编号/标题后节点文件夹整体改名，附件（inputs/）和产物跟着走
//   · 移除附件会删除文件、让旧结果过期
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const MULTI = '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。';
const node = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', brief: '做' + id, prompt: '指令 ' + id, tier: 3, dependsOn: [], ...extra });
const PLAN = JSON.stringify({ decision: 'split', goal: '选型汇报', nodes: [node('n1', { title: '调研' }), node('n2', { dependsOn: ['n1'], title: '对比' }), node('n3', { dependsOn: ['n2'], title: '汇总' })] });
const FILE_REPLY = '结论：已生成对比表 对比.csv。\n<<<FILE 对比.csv\n型号,功耗(uA)\nSTM32L0,80\nGD32E2,95\n>>>END';

function sse(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const choices of [[{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: 'stop' }]]) res.write('data: ' + JSON.stringify({ id: 'wf', object: 'chat.completion.chunk', model: 'wf-local', choices }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
async function launch() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw);
    const sys = String(body.messages?.[0]?.content || ''), isPlanner = sys.includes('任务拆解器'), isNode = !isPlanner && sys.includes('只完成本步骤');
    const userRaw = body.messages[1]?.content; const user = typeof userRaw === 'string' ? userRaw : '';
    requests.push({ kind: isPlanner ? 'planner' : isNode ? 'node' : 'chat', user, body });
    if (isNode) { const wantsFile = user.includes('<<<FILE'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: wantsFile ? FILE_REPLY : '结论：NODE_OUT ' + user.slice(0, 10) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); return; }
    if (isPlanner) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: PLAN } }], usage: { prompt_tokens: 300, completion_tokens: 200 } })); return; }
    sse(res, 'CHAT_DONE');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(ROOT, '.wff-')); const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  const attach = path.join(profile, 'attach'); fs.mkdirSync(attach);
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace } });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await page.evaluate(async port => {
    await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-test-only', model: 'wf-local', models: ['wf-local'] });
    window.__events = []; window.piDesktop.agent.onEvent(e => window.__events.push(e));
  }, server.address().port);
  return { app, page, requests, workspace, attach, close: async () => { try { await app.close(); } finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); } } };
}
const send = async (page, text) => { await page.locator('#message-input').fill(text); await page.locator('#composer').evaluate(f => f.requestSubmit()); };
const built = page => page.waitForFunction(() => /已搭好/.test(document.querySelector('#messages')?.innerText || '') || /没有替换|没能写入/.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 60000 });
const nodeReqs = fx => fx.requests.filter(r => r.kind === 'node');
const wfDir = fx => path.join(fx.workspace, 'workflow');
const folders = fx => fs.existsSync(wfDir(fx)) ? fs.readdirSync(wfDir(fx), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() : [];

// 让“选择文件”对话框直接返回我们准备好的文件
const stubPicker = (fx, files) => fx.app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, files);

async function setup(fx) {
  await fx.page.locator('#approval-mode').selectOption('full');
  // 工作文件夹是新建任务时指定的：用一个新任务，并把“选择文件夹”对话框指向 fx.workspace
  await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, fx.workspace);
  await fx.page.locator('[data-action="new-task"]').first().click();
  await fx.page.locator('#entity-name').fill('文件测试');
  await fx.page.locator('#task-path-pick').click();
  await expect(fx.page.locator('#task-path')).toHaveValue(fx.workspace);
  await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
  await fx.page.locator('#task-mode').selectOption('workflow');
  const fr = fx.page.frameLocator('#module-frame');
  await send(fx.page, MULTI);
  await expect(fr.locator('.wf-node')).toHaveCount(3, { timeout: 20000 });
  await built(fx.page);
  return fr;
}

test('交付类型与附件：编辑器里选类型、加附件；运行时附件进该节点请求；产物落在节点自己的文件夹，表格另存 xlsx', async () => {
  const fx = await launch();
  try {
    const xlsx = require('../runtime/xlsx-lite.cjs');
    fs.writeFileSync(path.join(fx.attach, 'BOM.xlsx'), xlsx.buildXlsx({ head: ['位号', '型号', '数量'], rows: [['U1', 'STM32L051K8T6', '1'], ['R1', '10k 0603', '20']] }, { sheetName: 'BOM' }));
    fs.writeFileSync(path.join(fx.attach, '说明.txt'), '供电 3.3V，工作温度 -40~85℃\n');
    const fr = await setup(fx);

    await stubPicker(fx, [path.join(fx.attach, 'BOM.xlsx'), path.join(fx.attach, '说明.txt')]);
    await fr.locator('.wf-node[data-node="n0"] [data-act="edit"]').click();
    await fr.locator('.wf-editor [data-act="add-input"]').click();
    await expect(fr.locator('.wf-editor .wf-inputs li')).toHaveCount(2, { timeout: 10000 });
    await expect(fr.locator('.wf-editor .wf-inputs')).toContainText('BOM.xlsx');
    await expect(fr.locator('.wf-editor .wf-inputs')).toContainText('表格');
    const n0dir = path.join(wfDir(fx), folders(fx).find(f => f.startsWith('n0-')), 'inputs');
    expect(fs.readdirSync(n0dir).sort()).toEqual(['BOM.xlsx', '说明.txt']);
    await fr.locator('[data-act="save-editor"]').click();

    await fr.locator('.wf-node[data-node="n1"] [data-act="edit"]').click();
    await fr.locator('.wf-editor [data-deliver="table"]').check();
    await fr.locator('[data-act="save-editor"]').click();

    // 勾选上限 2：第三个会被拦住
    await fr.locator('.wf-node[data-node="n1"] [data-act="edit"]').click();
    await expect(fr.locator('.wf-editor [data-deliver="table"]')).toBeChecked();
    await fr.locator('.wf-editor [data-deliver="html"]').check();
    await fr.locator('.wf-editor [data-deliver="image"]').click({ force: true });                // 第三个：被拦住（界面把它撤回并提示）
    await expect(fr.locator('.wf-editor [data-deliver]:checked')).toHaveCount(2);
    await expect(fr.locator('.wf-editor [data-deliver="image"]')).not.toBeChecked();
    await fr.locator('.wf-editor [data-deliver="html"]').uncheck();
    await fr.locator('[data-act="save-editor"]').click();

    // 运行 n0：请求里带附件内容（xlsx 读成了表格文字，型号原样），且没有任何文件协议文字
    fx.requests.length = 0;
    await fr.locator('.wf-node[data-node="n0"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    const r0 = nodeReqs(fx)[0].user;
    expect(r0).toContain('DATA_BEGIN'); expect(r0).toContain('STM32L051K8T6'); expect(r0).toContain('供电 3.3V'); expect(r0).toContain('BOM.xlsx');
    expect(r0).not.toContain('<<<FILE');

    // 运行 n1（勾了表格）：请求带文件协议；回复里的 CSV 落进 n1 自己的文件夹，并另存 xlsx
    fx.requests.length = 0;
    await fr.locator('.wf-node[data-node="n1"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n1"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    expect(nodeReqs(fx)[0].user).toContain('<<<FILE');
    const n1 = path.join(wfDir(fx), folders(fx).find(f => f.startsWith('n1-')));
    await expect.poll(() => fs.existsSync(n1) && fs.readdirSync(n1).join('|')).toContain('对比.csv');
    expect(fs.readdirSync(n1).filter(f => !f.startsWith('.')).sort()).toEqual(['对比.csv', '对比.xlsx']);
    const sheet = xlsx.readZip(fs.readFileSync(path.join(n1, '对比.xlsx')))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('STM32L0'); expect(sheet).toContain('<v>80</v>');
    await fr.locator('.wf-node[data-node="n1"] button.wf-runstate').click();
    await expect(fr.locator('.wf-pop pre')).toBeVisible();
    await expect(fr.locator('.wf-pop pre')).not.toContainText('<<<FILE');
  } finally { await fx.close(); }
});

test('节点文件夹跟着节点走：重新编号后整个文件夹（附件和产物）改名；移除附件会删文件并让结果过期', async () => {
  const fx = await launch();
  try {
    fs.writeFileSync(path.join(fx.attach, '说明.txt'), '供电 3.3V\n');
    const fr = await setup(fx);
    await stubPicker(fx, [path.join(fx.attach, '说明.txt')]);
    await fr.locator('.wf-node[data-node="n0"] [data-act="edit"]').click();
    await fr.locator('.wf-editor [data-act="add-input"]').click();
    await expect(fr.locator('.wf-editor .wf-inputs li')).toHaveCount(1, { timeout: 10000 });
    await fr.locator('[data-act="save-editor"]').click();
    await fr.locator('.wf-node[data-node="n0"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    await expect.poll(() => folders(fx).join()).toContain('n0-调研');
    expect(fs.existsSync(path.join(wfDir(fx), 'n0-调研', 'inputs', '说明.txt'))).toBe(true);
    await expect.poll(() => fs.existsSync(path.join(wfDir(fx), 'n0-调研', '结果.md'))).toBe(true);

    // 新增一个没有依赖的节点 → 第 0 阶段变成两个并行节点，“调研”的编号从 n0 变成 n00/n01 之一；文件夹要整体改名，附件不丢
    await fr.locator('.wf-canvas').click({ button: 'right', position: { x: 400, y: 80 }, force: true });   // 空白处右键 → 新增节点（没有依赖，和 n0 并行）
    await fr.locator('[data-act="ctx-add"]').click();
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 10000 });
    await expect.poll(() => folders(fx).filter(f => f.includes('调研')).join()).not.toBe('n0-调研');
    const moved = folders(fx).find(f => f.includes('调研'));
    await expect.poll(() => fs.existsSync(path.join(wfDir(fx), moved, 'inputs', '说明.txt'))).toBe(true);
    await expect.poll(() => fs.existsSync(path.join(wfDir(fx), moved, '结果.md'))).toBe(true);
    expect(folders(fx).filter(f => f.includes('调研'))).toHaveLength(1);

    // 移除附件：文件被删、该节点结果过期
    const nid = await fr.locator('.wf-node', { hasText: '调研' }).first().getAttribute('data-node');
    await fr.locator('.wf-node[data-node="' + nid + '"] [data-act="edit"]').click();
    fx.page.once('dialog', d => d.accept());
    await fr.locator('.wf-editor [data-act="remove-input"]').click();
    await expect(fr.locator('.wf-editor .wf-inputs li')).toHaveCount(0, { timeout: 10000 });
    expect(fs.existsSync(path.join(wfDir(fx), moved, 'inputs', '说明.txt'))).toBe(false);
    await fr.locator('[data-act="close-editor"]').first().click();
    await expect(fr.locator('.wf-node[data-node="' + nid + '"] .wf-runstate')).toHaveCount(0);
  } finally { await fx.close(); }
});
