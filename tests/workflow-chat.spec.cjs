'use strict';
// 端到端：聊天 → 拆解（直连模型一次）→ 右侧画布同步 → Agent 按计划回答。
// 假模型同时扮演拆解器和聊天模型，靠系统提示词区分；记录每一次请求，以便断言“开关关闭时零额外调用”。
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const MULTI = '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。';
const node = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', brief: '做' + id, prompt: '指令 ' + id, tier: 'standard', dependsOn: [], ...extra });
const PLAN = JSON.stringify({ decision: 'split', goal: '选型汇报', nodes: [node('n1', { title: '调研' }), node('n2', { dependsOn: ['n1'], title: '对比' }), node('n3', { dependsOn: ['n1'], title: '风险' }), node('n4', { dependsOn: ['n2', 'n3'], title: '汇总' })] });

function sse(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const choices of [[{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: 'stop' }]]) res.write('data: ' + JSON.stringify({ id: 'wf', object: 'chat.completion.chunk', model: 'wf-local', choices }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
async function launch(initialReply, { nodeDelay = 0 } = {}) {
  let plannerReply = initialReply;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw);
    const sys = String(body.messages?.[0]?.content || ''), isPlanner = sys.includes('任务拆解器'), isNode = !isPlanner && sys.includes('只完成本步骤');
    requests.push({ kind: isPlanner ? 'planner' : isNode ? 'node' : 'chat', body });
    if (isNode) { if (nodeDelay) await new Promise(r => setTimeout(r, nodeDelay)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'NODE_OUT ' + String(body.messages[1].content).slice(0, 12) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); return; }
    if (isPlanner) { if (plannerReply instanceof Error) { res.writeHead(500); res.end('{}'); return; } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: plannerReply } }], usage: { prompt_tokens: 300, completion_tokens: 200 } })); return; }
    sse(res, 'CHAT_DONE');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(ROOT, '.wfchat-')); const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace } });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await page.evaluate(async port => {
    await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-test-only', model: 'wf-local', models: ['wf-local'] });
    window.__events = []; window.piDesktop.agent.onEvent(e => window.__events.push(e));
  }, server.address().port);
  return { app, page, requests, profile, setPlanner: r => { plannerReply = r; }, close: async () => { try { await app.close(); } finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); } } };
}
const send = async (page, text) => { await page.locator('#message-input').fill(text); await page.locator('#composer').evaluate(f => f.requestSubmit()); };
const settled = page => page.waitForFunction(() => window.__events.some(e => e.type === 'agent_settled'), null, { timeout: 60000 });
const built = page => page.waitForFunction(() => /已搭好/.test(document.querySelector('#messages')?.innerText || '') || /没有替换|没能写入/.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 60000 });
const reset = page => page.evaluate(() => { window.__events = []; });
const setMode = (page, mode) => page.locator('#task-mode').selectOption(mode);

test('默认没有工作流按钮；开关关闭时聊天请求里没有任何拆解调用、也没有计划文字（零额外 token）', async () => {
  const fx = await launch(PLAN);
  try {
    await expect(fx.page.locator('#task-mode')).toHaveValue('basic');                  // 默认是基础模式
    await expect(fx.page.locator('.workflow-canvas-toggle')).toHaveCount(0);           // 基础模式下页头没有画布开关
    await fx.page.locator('#approval-mode').selectOption('full');
    await send(fx.page, MULTI); await settled(fx.page);
    expect(fx.requests.filter(r => r.kind === 'planner')).toHaveLength(0);           // 没有拆解调用
    const chat = fx.requests.filter(r => r.kind === 'chat'); expect(chat.length).toBeGreaterThan(0);
    expect(JSON.stringify(chat[0].body.messages)).not.toContain('[工作流] 已拆成');          // 没有任何计划文字混入
  } finally { await fx.close(); }
});

test('开启后：复杂问题先拆解，画布同步出现节点，Agent 收到按计划回答的提示；短问题不拆、不多花一次调用', async () => {
  const fx = await launch(PLAN);
  try {
    await setMode(fx.page, 'workflow');
    await expect(fx.page.locator('#task-mode')).toHaveValue('workflow');
    await expect(fx.page.locator('.workflow-canvas-toggle')).toContainText('关闭画布');   // 页头出现画布开关
    await expect(fx.page.locator('#module-frame')).toBeVisible();                     // 右侧弹出工作流窗口
    await fx.page.locator('#approval-mode').selectOption('full');

    // 纯寒暄：本地预判放行，没有任何拆解调用
    await reset(fx.page); await send(fx.page, '你好'); await settled(fx.page);
    expect(fx.requests.filter(r => r.kind === 'planner')).toHaveLength(0);

    // 复杂问题：一次拆解 + 一次聊天
    fx.requests.length = 0; await reset(fx.page);
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });         // 画布同步出现节点
    await expect(fr.locator('.wf-meta')).toContainText('1 处并行');
    await built(fx.page);
    expect(fx.requests.filter(r => r.kind === 'planner')).toHaveLength(1);
    // 拆完只搭建：不启动主 Agent（没有聊天请求），不自动运行节点（没有节点请求），聊天里写明结果并提示用户检查后再运行
    expect(fx.requests.filter(r => r.kind === 'chat')).toHaveLength(0);
    expect(fx.requests.filter(r => r.kind === 'node')).toHaveLength(0);
    await expect(fx.page.locator('#messages')).toContainText('工作流已搭好：4 步');
    await expect(fx.page.locator('#messages')).toContainText('n10 对比');                // 写入后重新编号，聊天里显示的也是新编号
    await expect(fx.page.locator('#messages')).toContainText('运行全部');
  } finally { await fx.close(); }
});

test('拆解失败（服务商 500）：降级为普通对话，用户的问题照常发出，画布保持空', async () => {
  const fx = await launch(new Error('boom'));
  try {
    await setMode(fx.page, 'workflow');
    await fx.page.locator('#approval-mode').selectOption('full'); await reset(fx.page);
    await send(fx.page, MULTI); await settled(fx.page);
    const chat = fx.requests.filter(r => r.kind === 'chat'); expect(chat.length).toBeGreaterThan(0);
    expect(JSON.stringify(chat[0].body.messages)).not.toContain('[工作流] 已拆成');
    await expect(fx.page.frameLocator('#module-frame').locator('.wf-node')).toHaveCount(0);
  } finally { await fx.close(); }
});

test('关闭开关后不再拆分，但已有计划保留', async () => {
  const fx = await launch(PLAN);
  try {
    await setMode(fx.page, 'workflow');
    await fx.page.locator('#approval-mode').selectOption('full');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame'); await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 }); await built(fx.page);
    await setMode(fx.page, 'basic');
    await expect(fx.page.locator('#task-mode')).toHaveValue('basic');
    await expect(fx.page.locator('.workflow-canvas-toggle')).toHaveCount(0);          // 回到基础模式，页头的画布开关消失
    fx.requests.length = 0; await reset(fx.page);
    await send(fx.page, MULTI + ' 再来一遍'); await settled(fx.page);
    expect(fx.requests.filter(r => r.kind === 'planner')).toHaveLength(0);
    // 切回基础模式：画布跟着关闭（页头也没有画布开关了）；但计划数据保留，再切回工作流模式时重新出现
    await expect(fx.page.locator('#module-frame')).toBeHidden();
    await setMode(fx.page, 'workflow');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 15000 });
  } finally { await fx.close(); }
});

test('模式切换：项目聊天不会被转进「工作台」栏目；页头画布开关可关可开；画布关闭后仍是工作流模式；刷新后模式保留', async () => {
  const fx = await launch(PLAN);
  try {
    const task = () => fx.page.evaluate(() => { const raw = localStorage.getItem('pi-workbench-design-v2'); if (!raw) return null; const s = JSON.parse(raw); return s.projects.flatMap(p => p.tasks).find(t => t.id === s.activeTask); });
    await setMode(fx.page, 'workflow');                                                    // 切换会触发保存
    await expect.poll(async () => (await task())?.workflowOn).toBe(true);
    const id = (await task()).id;
    await expect(fx.page.locator('#module-frame')).toBeVisible();
    const t = await task(); expect(t.id).toBe(id);
    expect(t.use).toBeUndefined();                                                         // 没有被当成“使用工作台”而转走
    await expect(fx.page.locator('#projects [data-action="select-task"][data-id="' + id + '"]')).toHaveCount(1);      // 仍在项目里
    await expect(fx.page.locator('#workbench-section [data-action="select-task"][data-id="' + id + '"]')).toHaveCount(0);
    await fx.page.locator('.workflow-canvas-toggle').click();
    await expect(fx.page.locator('#module-frame')).toBeHidden();
    await expect(fx.page.locator('.workflow-canvas-toggle')).toContainText('打开画布');
    await expect(fx.page.locator('#task-mode')).toHaveValue('workflow');
    await fx.page.locator('.workflow-canvas-toggle').click();
    await expect(fx.page.locator('#module-frame')).toBeVisible();
    await setMode(fx.page, 'basic');
    const wording = await fx.page.evaluate(() => [...document.querySelectorAll('.main-header *')].filter(e => !e.children.length).map(e => (e.innerText || '') + ' ' + (e.title || '')).filter(x => /工作台|工作流|画布|开启|关闭/.test(x)));
    expect(wording).toEqual([]);
    await setMode(fx.page, 'workflow');
    await fx.page.reload(); await expect(fx.page.locator('#message-input')).toBeVisible();
    await expect(fx.page.locator('#task-mode')).toHaveValue('workflow');                  // 模式随任务保存
    await expect(fx.page.locator('.workflow-canvas-toggle')).toHaveCount(1);
  } finally { await fx.close(); }
});

test('Agent 的系统提示跟着模式走：工作流模式（即使画布已关闭）才带工作流指令；基础模式一个字都不带；切换任务时跟着变', async () => {
  const systems = [];
  const fx = await launch(PLAN);
  // 记录每次聊天请求的系统提示（launch 里的假服务已经记录了 body）
  const sysOf = () => fx.requests.filter(r => r.kind === 'chat').map(r => String(r.body.messages?.[0]?.content || ''));
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    const ask = async text => { await reset(fx.page); await send(fx.page, text); await settled(fx.page); return sysOf().at(-1); };

    // 基础模式：没有任何工作流内容
    const basic = await ask('你好，随便聊聊');
    expect(basic).not.toContain('工作流模式'); expect(basic).not.toContain('readNode');

    // 工作流模式 + 画布打开
    await setMode(fx.page, 'workflow');
    const open = await ask('你好');
    expect(open).toContain('工作流模式'); expect(open).toContain('直接开始做'); expect(open).toContain('不要先去读项目目录');

    // 工作流模式 + 画布关闭：指令仍然在（模式没变，只是面板收起了）
    await fx.page.locator('.workflow-canvas-toggle').click();
    await expect(fx.page.locator('#module-frame')).toBeHidden();
    const closed = await ask('谢谢');
    expect(closed).toContain('工作流模式'); expect(closed).toContain('直接开始做');

    // 新建一个任务（基础模式）再切回来：每个任务各自的模式各自生效
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('另一个聊天'); await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    await expect(fx.page.locator('#task-mode')).toHaveValue('basic');
    const other = await ask('这是另一个聊天');
    expect(other).not.toContain('工作流模式');                                              // 另一个任务是基础模式，不应带上
    await fx.page.locator('#projects [data-action="select-task"]').first().click();
    await expect(fx.page.locator('#task-mode')).toHaveValue('workflow');
    const back = await ask('好的');
    expect(back).toContain('工作流模式');                                                    // 切回来又带上
    void systems;
  } finally { await fx.close(); }
});

test('五档模型：拆解用最便宜的档；节点按难度自动分配；用户手选的不被覆盖；没配档位时画布提示', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '分档', nodes: [node('n1', { tier: 1 }), node('n2', { tier: 3 }), node('n3', { tier: 5, dependsOn: ['n1'] }), node('n4', { dependsOn: ['n2', 'n3'], tier: 1 })] });
  const fx = await launch(plan);
  try {
    await fx.page.evaluate(async () => { await window.PiProviderManager.saveConfig({ model: 'wf-local', models: ['wf-local', 'wf-big'] }); });
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-empty')).toBeVisible();
    // 没配档位：全部用主模型，并在画布提示
    await send(fx.page, MULTI);
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await expect(fr.locator('.wf-node .wf-model').first()).toContainText('主模型');
    await expect(fr.locator('.wf-hint')).toContainText('档位');
    await built(fx.page);
    // 配两档（档位 1 = 小模型，档位 5 = 大模型），持久化并随配置返回
    const cfg = await fx.page.evaluate(async () => { const c = await window.piDesktop.provider.getConfig(); const r = await window.piDesktop.provider.saveTiers([{ profileId: c.profileId, model: 'wf-local' }, null, null, null, { profileId: c.profileId, model: 'wf-big' }]); return r.config.modelTiers; });
    expect(cfg.map(t => t && t.model)).toEqual(['wf-local', null, null, null, 'wf-big']);
    await fx.page.evaluate(() => { window.__events = []; });
    fx.requests.length = 0;
    await send(fx.page, MULTI + ' 再来一次');
    await expect(fr.locator('.wf-node[data-node="n1"] .wf-model')).toContainText('wf-big', { timeout: 20000 });   // 等新计划落到画布（旧计划也是 4 个节点）
    const planner = fx.requests.find(r => r.kind === 'planner');
    expect(planner.body.model).toBe('wf-local');                               // 拆解用最便宜的已配置档
    const names = await fr.locator('.wf-node .wf-model').allInnerTexts();
    expect(names.join('|')).toContain('wf-big'); expect(names.join('|')).toContain('wf-local');
    await expect(fr.locator('.wf-node[data-node="n1"] .wf-model')).toContainText('wf-big');   // 难度 5 → 最强档
    await expect(fr.locator('.wf-node[data-node="n00"] .wf-model')).toContainText('wf-local'); // 难度 1 → 最轻档
    await expect(fr.locator('.wf-hint')).toHaveCount(0);
    await built(fx.page);
  } finally { await fx.close(); }
});

test('节点运行：卡片写出模型名；上游没结果时单独运行报错；运行全部按依赖执行；改上游后下游结果标为过期', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '运行', nodes: [node('n1', { title: '调研' }), node('n2', { title: '对比', dependsOn: ['n1'] }), node('n3', { title: '风险', dependsOn: ['n1'] }), node('n4', { title: '汇总', dependsOn: ['n2', 'n3'] })] });
  const fx = await launch(plan);
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await built(fx.page);
    // 1) 卡片上有真实模型名（没配档位 = 主模型的名字）
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-model')).toContainText('wf-local');
    // 2) 依赖未运行的节点：报错并指出缺谁，且不调用模型
    fx.requests.length = 0;
    await fr.locator('.wf-node[data-node="n2"] [data-act="run"]').click();
    await expect(fr.locator('.wf-pop [role="alert"]')).toContainText('先运行');
    await expect(fr.locator('.wf-pop [role="alert"]')).toContainText('n10');
    expect(fx.requests.filter(r => r.kind === 'node')).toHaveLength(0);
    await fr.locator('.wf-pop [data-act="close-pop"]').click({ force: true });
    // 3) 单独运行没有上游的节点：只发该节点的指令
    await fr.locator('.wf-node[data-node="n0"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    const first = fx.requests.filter(r => r.kind === 'node');
    expect(first).toHaveLength(1); expect(first[0].body.messages[1].content).toBe('指令 n1');
    await fr.locator('.wf-node[data-node="n0"] .wf-runstate').click();
    await expect(fr.locator('.wf-pop pre')).toContainText('NODE_OUT');
    await fr.locator('.wf-pop [data-act="close-pop"]').click();
    // 4) 运行未完成：n0 已有结果保留不重跑，其余 3 个按依赖执行；n2 收到 n0 的结论
    fx.requests.length = 0;
    await fr.locator('[data-act="run-pending"]').click();
    for (const id of ['n10', 'n11', 'n2']) await expect(fr.locator('.wf-node[data-node="' + id + '"] .wf-runstate')).toContainText('已运行', { timeout: 30000 });
    await expect(fr.locator('[data-act="run-all"]')).toBeVisible();                       // 运行结束，按钮恢复
    const all = fx.requests.filter(r => r.kind === 'node');
    expect(all).toHaveLength(3);
    const n2 = all.find(r => r.body.messages[1].content.startsWith('指令 n2')); expect(n2.body.messages[1].content).toContain('NODE_OUT');
    expect(all.at(-1).body.messages[1].content).toMatch(/^指令 n4/);                    // 汇总最后
    // 4b) 全部已完成时再点「运行未完成」：没有可运行的，不发任何请求
    fx.requests.length = 0;
    await fr.locator('[data-act="run-pending"]').click();
    await expect(fr.locator('[data-act="run-all"]')).toBeVisible();
    await fx.page.waitForTimeout(800);
    expect(fx.requests.filter(r => r.kind === 'node')).toHaveLength(0);
    // 4c) 运行全部：四个节点都重新运行
    fx.requests.length = 0;
    await fr.locator('[data-act="run-all"]').click();
    await expect.poll(() => fx.requests.filter(r => r.kind === 'node').length, { timeout: 30000 }).toBe(4);
    await expect(fr.locator('[data-act="run-all"]')).toBeVisible({ timeout: 30000 });
    // 5) 修改上游节点：自己的结果清空，下游标为过期
    await fr.locator('.wf-node[data-node="n0"] [data-act="edit"]').click();
    await fr.locator('.wf-editor [data-f="brief"]').fill('改过的介绍');
    await fr.locator('[data-act="save-editor"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toHaveCount(0);
    await expect(fr.locator('.wf-node[data-node="n10"] .wf-runstate')).toContainText('过期');
    // 6) 过期的上游不算有结果：n2 再单独运行会被拒绝
    await fr.locator('.wf-node[data-node="n10"] [data-act="run"]').click();
    await expect(fr.locator('.wf-pop [role="alert"]')).toContainText('n0');
  } finally { await fx.close(); }
});

test('节点运行使用该节点自己的模型（档位分配/手选），卡片显示来源', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '模型', nodes: [node('n1', { tier: 1 }), node('n2', { tier: 5 }), node('n3', { tier: 3 }), node('n4', { tier: 3, dependsOn: ['n1', 'n2', 'n3'] })] });
  const fx = await launch(plan);
  try {
    await fx.page.evaluate(async () => { await window.PiProviderManager.saveConfig({ model: 'wf-local', models: ['wf-local', 'wf-big'] }); const c = await window.piDesktop.provider.getConfig(); await window.piDesktop.provider.saveTiers([{ profileId: c.profileId, model: 'wf-local' }, null, null, null, { profileId: c.profileId, model: 'wf-big' }]); });
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node[data-node="n01"] .wf-model')).toContainText('wf-big', { timeout: 20000 });
    await expect(fr.locator('.wf-node[data-node="n01"] .wf-model')).toContainText('档位');
    await built(fx.page);
    // 手选 n1 → wf-big，应显示“手选”
    await fr.locator('.wf-node[data-node="n00"] [data-act="model"]').click();
    await fr.locator('.wf-vendor-btn').first().click();
    await fr.locator('.wf-sub [data-model$="::wf-big"]').click();
    await expect(fr.locator('.wf-node[data-node="n00"] .wf-model')).toContainText('手选');
    fx.requests.length = 0;
    await fr.locator('[data-act="run-all"]').click();
    await expect(fr.locator('.wf-node[data-node="n1"] .wf-runstate')).toContainText('已运行', { timeout: 30000 });
    const used = fx.requests.filter(r => r.kind === 'node').map(r => r.body.model + ':' + r.body.messages[1].content.slice(0, 5));
    expect(used.find(x => x.endsWith('指令 n1'))).toBe('wf-big:指令 n1'); expect(used.find(x => x.endsWith('指令 n2'))).toBe('wf-big:指令 n2'); expect(used.find(x => x.endsWith('指令 n3'))).toBe('wf-local:指令 n3');
  } finally { await fx.close(); }
});

test('运行中的连线会流动、节点高亮；完成后连线变为已完成色', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '流动', nodes: [node('n1'), node('n2', { dependsOn: ['n1'] }), node('n3', { dependsOn: ['n2'] })] });
  const fx = await launch(plan, { nodeDelay: 1500 });
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(3, { timeout: 20000 });
    await built(fx.page);
    await fr.locator('[data-act="run-all"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"].running')).toBeVisible({ timeout: 10000 });
    await expect(fr.locator('.wf-node[data-node="n1"].running')).toBeVisible({ timeout: 10000 });   // 阶段推进到 n2
    await expect(fr.locator('.wf-edge.flow')).toHaveCount(1);                                         // 只有流向 n2 的那条在流动
    await expect(fr.locator('.wf-edge.ok')).toHaveCount(0);                                           // 下游还没完成，已完成的上游连线不算 ok
    await expect(fr.locator('.wf-node[data-node="n2"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    await expect(fr.locator('.wf-edge.flow')).toHaveCount(0);
    await expect(fr.locator('.wf-edge.ok')).toHaveCount(2);
  } finally { await fx.close(); }
});

test('工作路径：新建任务要选工作文件夹（默认在文档下）；工作流文件落在其 workflow/ 下；聊天框下的下拉列出用到的文件夹', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '落盘', nodes: [node('n1', { title: '调研' }), node('n2', { title: '汇总', dependsOn: ['n1'] }), node('n3', { title: '收尾', dependsOn: ['n2'] })] });
  const fx = await launch(plan);
  const chosen = path.join(fx.profile, '我选的文件夹');
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    // 1) 新建任务对话框：有工作文件夹字段，默认路径带项目名与任务名
    await fx.page.locator('[data-action="new-task"]').first().click();
    await expect(fx.page.locator('#task-path')).toBeVisible();
    await fx.page.locator('#entity-name').fill('路径测试');
    await expect(fx.page.locator('#task-path')).toHaveValue(/Pi Workbench.*路径测试$/);
    // 2) 改选一个现有位置（替换系统选择框）
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, chosen);
    fs.mkdirSync(chosen, { recursive: true });
    await fx.page.locator('#task-path-pick').click();
    await expect(fx.page.locator('#task-path')).toHaveValue(chosen);
    await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    // 3) 聊天框下面的路径下拉：可展开，列出工作文件夹
    await expect(fx.page.locator('.path-toggle')).toContainText('我选的文件夹');
    await fx.page.locator('.path-toggle').click();
    await expect(fx.page.locator('#path-menu')).toBeVisible();
    await expect(fx.page.locator('#path-menu .path-item.primary small')).toHaveText(chosen);
    await fx.page.locator('.path-toggle').click();
    await expect(fx.page.locator('#path-menu')).toBeHidden();
    // 4) 工作流模式拆出计划后，文件写进 <工作文件夹>/workflow/
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(3, { timeout: 20000 });
    await built(fx.page);
    await expect.poll(() => fs.existsSync(path.join(chosen, 'workflow', 'plan.md')), { timeout: 10000 }).toBe(true);
    expect(fs.readFileSync(path.join(chosen, 'workflow', 'plan.md'), 'utf8')).toContain('n1 · 汇总');
    // 5) 运行一个节点 → 结果文件出现在 workflow/<节点>/
    await fr.locator('.wf-node[data-node="n0"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    await expect.poll(() => fs.existsSync(path.join(chosen, 'workflow', 'n0-调研', '结果.md')), { timeout: 10000 }).toBe(true);
    // 6) 下拉里出现“工作流文件”这一项
    await fx.page.locator('.path-toggle').click();
    await expect(fx.page.locator('#path-menu')).toContainText('工作流文件');
    await expect(fx.page.locator('#path-menu .path-item', { hasText: '工作流文件' }).locator('small')).toHaveText(path.join(chosen, 'workflow'));
  } finally { await fx.close(); }
});

test('Agent 以任务的工作文件夹为工作目录（事件里的 cwd 就是所选文件夹）', async () => {
  const fx = await launch('{}');
  const chosen = path.join(fx.profile, '代理目录');
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, chosen);
    fs.mkdirSync(chosen, { recursive: true });
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('代理目录测试');
    await fx.page.locator('#task-path-pick').click();
    await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    await fx.page.evaluate(() => { window.__events = []; });
    await send(fx.page, '你好');
    await settled(fx.page);
    const cwd = await fx.page.evaluate(() => (window.__events.find(e => e.cwd) || {}).cwd);
    expect(path.resolve(cwd).toLowerCase()).toBe(path.resolve(chosen).toLowerCase());
  } finally { await fx.close(); }
});

test('旧聊天找回文件夹：下拉里列出以前运行用过的文件夹（不含程序目录），可一键设为工作文件夹', async () => {
  const fx = await launch('{}');
  const old = path.join(fx.profile, '以前用过的目录');
  try {
    fs.mkdirSync(old, { recursive: true });
    // 模拟旧聊天：没有 workspacePath，但历史运行记录里有 cwd（一个是程序目录，一个是用户目录）
    await fx.page.locator('#message-input').fill('草稿'); await fx.page.waitForFunction(() => !!localStorage.getItem('pi-workbench-design-v2'), null, { timeout: 10000 });   // 先让应用写出一次状态
    const injected = await fx.page.evaluate(async ({ old, root }) => {
      const key = 'pi-workbench-design-v2';
      if (!localStorage.getItem(key)) return false;
      const st = JSON.parse(localStorage.getItem(key));
      const t = st.projects.flatMap(p => p.tasks).find(x => x.id === st.activeTask) || st.projects[0].tasks[0];
      delete t.workspacePath;
      t.messages = [{ id: 'a1', role: 'assistant', text: '旧回复', run: { cwd: root, steps: [] } }, { id: 'a2', role: 'assistant', text: '旧回复2', run: { cwd: old, steps: [] } }, { id: 'a3', role: 'assistant', text: '旧回复3', run: { cwd: old, steps: [] } }];
      localStorage.setItem(key, JSON.stringify(st)); return true;
    }, { old, root: ROOT });
    expect(injected).toBe(true);
    await fx.page.reload(); await fx.page.waitForLoadState('load');
    if (await fx.page.locator('#first-launch').isVisible().catch(() => false)) await fx.page.locator('[data-action="dismiss-first-launch"]').click();
    await fx.page.locator('.path-toggle').click();
    const menu = fx.page.locator('#path-menu');
    await expect(menu).toContainText('以前的运行里找到');
    await expect(menu.locator('.path-recover')).toHaveCount(1);                       // 程序目录被排除
    await expect(menu.locator('.path-recover small')).toHaveText(old);
    await expect(menu.locator('.path-recover em')).toContainText('用过 2 次');
    await menu.locator('[data-action="path-adopt"]').click();
    await expect(fx.page.locator('.path-toggle')).toContainText('以前用过的目录');
  } finally { await fx.close(); }
});

test('子智能体：节点显示所属子智能体；按子智能体统一设置模型并在运行时生效；节点手选优先；并行兄弟互相看不到结果', async () => {
  const plan = JSON.stringify({ decision: 'split', goal: '分工', nodes: [
    node('n1', { title: '调研', agent: '研究员' }),
    node('n2', { title: '甲方案', agent: '研究员', dependsOn: ['n1'] }),
    node('n3', { title: '乙方案', agent: '撰稿', dependsOn: ['n1'] }),
    node('n4', { title: '汇总', agent: '撰稿', dependsOn: ['n2', 'n3'] })] });
  const fx = await launch(plan);
  try {
    await fx.page.evaluate(async () => { await window.PiProviderManager.saveConfig({ model: 'wf-local', models: ['wf-local', 'wf-big'] }); });
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await built(fx.page);
    // 1) 卡片上有子智能体标签；工具栏有“子智能体 2”
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-agent')).toHaveText('研究员');
    await expect(fr.locator('.wf-node[data-node="n11"] .wf-agent')).toHaveText('撰稿');
    await expect(fr.locator('[data-act="agents"]')).toContainText('2');
    // 重绘期间元素可能刚被替换、样式还没算出来：等拿到非空颜色再比较
    const colorOf = async id => { let c = ''; await expect.poll(async () => (c = await fr.locator('.wf-node[data-node="' + id + '"] .wf-agent').evaluate(e => getComputedStyle(e).color).catch(() => ''))).not.toBe(''); return c; };
    expect(await colorOf('n0')).toBe(await colorOf('n10'));                       // 同一个子智能体同色
    expect(await colorOf('n0')).not.toBe(await colorOf('n11'));                   // 不同子智能体不同色
    // 2) 给“研究员”选 wf-big
    await fr.locator('[data-act="agents"]').click();
    await fr.locator('.wf-agentrow', { hasText: '研究员' }).locator('.wf-vendor-btn').click();
    await fr.locator('[data-agent-model$="::wf-big"]').first().click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-model')).toContainText('wf-big');
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-model')).toContainText('子智能体');
    await expect(fr.locator('.wf-node[data-node="n11"] .wf-model')).toContainText('wf-local');     // 撰稿没设置 → 不受影响
    // 3) n10（研究员）手选 wf-local → 手选优先
    await fr.locator('.wf-node[data-node="n10"] [data-act="model"]').click();
    await fr.locator('.wf-vendor-btn').first().click();
    await fr.locator('.wf-sub [data-model$="::wf-local"]').click();
    await expect(fr.locator('.wf-node[data-node="n10"] .wf-model')).toContainText('手选');
    // 4) 运行全部：实际请求用的模型符合优先级；并行的 n10 与 n11 互相看不到对方结论
    fx.requests.length = 0;
    await fr.locator('[data-act="run-all"]').click();
    await expect(fr.locator('.wf-node[data-node="n2"] .wf-runstate')).toContainText('已运行', { timeout: 40000 });
    const nodeReqs = fx.requests.filter(r => r.kind === 'node');
    const by = text => nodeReqs.find(r => r.body.messages[1].content.startsWith(text));
    expect(by('指令 n1').body.model).toBe('wf-big');                                // 研究员 → wf-big
    expect(by('指令 n2').body.model).toBe('wf-local');                              // n10 手选
    expect(by('指令 n3').body.model).toBe('wf-local');                              // 撰稿 → 主模型
    const n10 = by('指令 n2').body.messages[1].content, n11 = by('指令 n3').body.messages[1].content;
    expect(n10).toContain('[n0 调研 的结论]'); expect(n11).toContain('[n0 调研 的结论]');   // 都带直接上游
    expect(n10).not.toContain('n11 '); expect(n11).not.toContain('n10 ');                   // 彼此不带
    // 5) 系统提示词里带的是节点自己的职责
    expect(by('指令 n2').body.messages[0].content).toContain('分析师');
  } finally { await fx.close(); }
});

test('画布已有工作流时再发消息：追问不重拆、画布与结果保留；要替换有结果的工作流时先确认，取消则原样保留', async () => {
  // 假服务按用户消息返回不同判断：含“追问”→ followup；含“全新任务”→ 再给一份新计划
  const NEW_PLAN = JSON.stringify({ decision: 'split', goal: '新任务', nodes: [node('n1', { title: '全新A' }), node('n2', { title: '全新B', dependsOn: ['n1'] }), node('n3', { title: '全新C', dependsOn: ['n2'] })] });
  const fx = await launch(PLAN);
  const base = fx.requests;
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    await send(fx.page, MULTI);
    const fr = fx.page.frameLocator('#module-frame');
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await built(fx.page);
    // 先跑出一个节点的结果
    await fr.locator('.wf-node[data-node="n0"] [data-act="run"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行', { timeout: 20000 });
    // 1) 追问：规划调用会带上画布摘要，让模型判断为 followup → 不重拆，画布不变，当普通聊天回答
    fx.setPlanner(JSON.stringify({ decision: 'followup' }));
    base.length = 0; await reset(fx.page);
    await send(fx.page, '第二点再解释一下');
    await settled(fx.page);
    const planReq = base.find(r => r.kind === 'planner');
    expect(planReq.body.messages[1].content).toContain('[当前工作流]'); expect(planReq.body.messages[1].content).toContain('已有结果');
    expect(base.filter(r => r.kind === 'chat').length).toBeGreaterThan(0);                       // 当普通聊天回答了
    await expect(fr.locator('.wf-node')).toHaveCount(4);                                        // 画布没被重拆
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行');   // 结果还在
    // 2) 新任务且画布有结果：先确认。取消 → 原样保留
    fx.setPlanner(NEW_PLAN);
    base.length = 0; await reset(fx.page);
    await send(fx.page, '全新任务：另一件事');
    await expect(fx.page.locator('#dialog')).toBeVisible({ timeout: 20000 });
    await expect(fx.page.locator('#dialog')).toContainText('替换当前工作流');
    await expect(fx.page.locator('#dialog')).toContainText('1 个节点已经运行出结果');
    await fx.page.locator('#dialog [data-action="close-dialog"]').first().click();
    await expect(fx.page.locator('#messages')).toContainText('已保留当前工作流');
    await expect(fr.locator('.wf-node')).toHaveCount(4);
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-runstate')).toContainText('已运行');
    // 3) 同样的新任务，这次确认替换 → 画布换成新计划
    base.length = 0; await reset(fx.page);
    await send(fx.page, '全新任务：另一件事');
    await expect(fx.page.locator('#dialog')).toBeVisible({ timeout: 20000 });
    await fx.page.locator('#dialog-form button[type="submit"]').click();
    await expect(fr.locator('.wf-node')).toHaveCount(3, { timeout: 20000 });
    await expect(fr.locator('.wf-node[data-node="n0"]')).toContainText('全新A');
    await expect(fx.page.locator('#messages')).toContainText('工作流已搭好：3 步');
  } finally { await fx.close(); }
});

test('在设置里新增 API 后，回到工作流：节点模型菜单列出所有厂家，手选后生效', async () => {
  const fx = await launch(PLAN);
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await setMode(fx.page, 'workflow');
    const fr = fx.page.frameLocator('#module-frame');
    await send(fx.page, MULTI);
    await expect(fr.locator('.wf-node')).toHaveCount(4, { timeout: 20000 });
    await built(fx.page);
    // 去设置里新增第二个 API（经界面保存，走 onChange 同步路径）
    const base = await fx.page.evaluate(async () => (await window.piDesktop.provider.getConfig()).baseUrl);
    await fx.page.locator('[data-route="settings"]').click();
    await fx.page.locator('#provider-add').click();
    await fx.page.locator('#provider-name').fill('厂家乙');
    await fx.page.locator('#provider-url').fill(base);
    await fx.page.locator('#provider-key').fill('k-b');
    await fx.page.locator('#provider-manual-model').fill('yi-model');
    await fx.page.locator('#provider-import').click();
    await fx.page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(fx.page.locator('#provider-status')).toContainText(/配置已保存|已读取|已保存/, { timeout: 15000 });
    // 回到聊天（画布还在）
    await fx.page.locator('[data-route="chat"], [data-action="select-task"]').first().click();
    await expect(fr.locator('.wf-node')).toHaveCount(4);
    await fr.locator('.wf-node[data-node="n0"] [data-act="model"]').click();
    const menu = fr.locator('.wf-pop .wf-menu');
    await expect(menu).toContainText('厂家乙', { timeout: 10000 });
    await expect(menu.locator('.wf-vendor')).toHaveCount(2);
    await menu.locator('.wf-vendor', { hasText: '厂家乙' }).locator('.wf-vendor-btn').click();
    await menu.locator('[data-model$="::yi-model"]').click();
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-model')).toContainText('yi-model');
    await expect(fr.locator('.wf-node[data-node="n0"] .wf-model')).toContainText('手选');
  } finally { await fx.close(); }
});
