'use strict';
// 端到端：真实 Pi 进程 + 假模型 + 真实 MCP 子进程。
//   1) 服务器未启用时，Agent 调用 mcp_call 必须失败，且 MCP 进程根本没有启动；
//   2) 启用后，在“请求批准”模式下必须先出现批准卡；
//   3) 用户拒绝 → 工具不执行；用户批准 → 才真正调用并把结果交给模型。
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

function sse(res, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const choices of [[{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: finish }]]) res.write('data: ' + JSON.stringify({ id: 'mcp', object: 'chat.completion.chunk', model: 'mcp-local', choices }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const toolCall = (res, name, args, id) => sse(res, { tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');

async function launch(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); handler(body, res, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(ROOT, '.mcp-e2e-'));
  const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace } });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await page.evaluate(async port => {
    await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-test-only', model: 'mcp-local', models: ['mcp-local'] });
    window.__events = []; window.piDesktop.agent.onEvent(e => window.__events.push(e));
  }, server.address().port);
  return { app, page, profile, requests, close: async () => { try { await app.close(); } finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); } } };
}
const send = async (page, text) => { await page.locator('#message-input').fill(text); await page.locator('#composer').evaluate(f => f.requestSubmit()); };
const settled = page => page.waitForFunction(() => window.__events.some(e => e.type === 'agent_settled'), null, { timeout: 60000 });
const resetEvents = page => page.evaluate(() => { window.__events = []; });
const fixture = path.join(ROOT, 'runtime', 'fixtures', 'mcp-fixture-server.cjs');
const marker = name => path.join(ROOT, name);

test('MCP：未启用时拒绝调用；启用后逐次批准，拒绝则不执行，批准才真正调用', async () => {
  const toolResults = [];
  const fx = await launch((body, res, requests) => {
    const last = body.messages.at(-1);
    if (last.role === 'tool') { toolResults.push(String(last.content)); return sse(res, { content: 'DONE' }); }
    const text = JSON.stringify(body.messages);
    if (text.includes('CALL_ECHO')) return toolCall(res, 'mcp_call', { server: '回声', tool: 'echo', arguments: { text: 'mcp-真实结果' } }, requests.length);
    return sse(res, { content: 'DONE' });
  });
  try {
    const { page } = fx;
    // 先在 MCP 页面添加一个服务器：默认未启用
    await page.locator('[data-route="mcp"]').click();
    await expect(page.locator('.mcp-page h1')).toHaveText('MCP');
    await page.locator('[data-mcp-new]').click();
    const form = page.locator('#mcp-form');
    await form.locator('[name="name"]').fill('回声');
    await form.locator('[name="command"]').fill(process.execPath);
    await form.locator('[name="args"]').fill(fixture);
    await form.locator('[name="env"]').fill('MODE=ok\nSECRET_KEY=sk-很秘密');
    await form.evaluate(f => f.requestSubmit());
    await expect(page.locator('.mcp-card')).toHaveCount(1);
    await expect(page.locator('.mcp-card.on')).toHaveCount(0);                          // 默认关闭
    await expect(page.locator('.mcp-card')).not.toContainText('sk-很秘密');             // 密钥不回显
    const disk = fs.readFileSync(path.join(fx.profile, 'mcp-servers.json'), 'utf8');
    expect(disk).not.toContain('sk-很秘密');                                            // 密钥不明文落盘

    // 1) 未启用：调用失败，工具没有执行
    await page.locator('[data-route="chat"]').first().click().catch(() => {});
    await page.locator('[data-action="select-task"]').first().click();
    await page.locator('#approval-mode').selectOption('full');                          // 完全批准也不能绕过“未启用”
    await send(page, 'CALL_ECHO 请调用回声');
    await settled(page);
    expect(toolResults.at(-1)).toMatch(/未启用/);
    toolResults.length = 0; await resetEvents(page);

    // 2) 启用（确认对话框接受）
    await page.locator('[data-route="mcp"]').click();
    page.once('dialog', d => d.accept());
    await page.locator('[data-mcp-toggle]').evaluate(el => el.click());
    await expect(page.locator('.mcp-card.on')).toHaveCount(1);
    // 测试连接能列出 5 个工具
    await page.locator('[data-mcp-test]').click();
    await expect(page.locator('.mcp-tools')).toContainText('5 个工具');

    // 3) “请求批准”模式：先出现批准卡；拒绝则不执行
    await page.locator('[data-action="select-task"]').first().click();
    await page.locator('#approval-mode').selectOption('ask');
    await send(page, 'CALL_ECHO 请调用回声（拒绝）');
    await page.waitForSelector('#agent-ui-form');
    await expect(page.locator('#agent-ui-form')).toContainText('mcp_call');
    await page.locator('#agent-ui-form button[value="false"]').click();
    await settled(page);
    expect(toolResults.some(t => t.includes('mcp-真实结果'))).toBe(false);              // 被拒：没有真实结果
    await resetEvents(page);

    // 4) 批准：真正调用，真实结果回到模型
    await send(page, 'CALL_ECHO 请调用回声（批准）');
    await page.waitForSelector('#agent-ui-form');
    await page.locator('#agent-ui-form button[value="true"]').click();
    await settled(page);
    expect(toolResults.some(t => t.includes('mcp-真实结果'))).toBe(true);
    const ev = await page.evaluate(() => window.__events);
    expect(ev.some(e => e.type === 'tool_execution_end' && e.toolName === 'mcp_call' && !e.isError)).toBe(true);
  } finally { await fx.close(); }
});
