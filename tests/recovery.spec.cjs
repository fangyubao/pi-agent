'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });
function stream(res, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const choices of [ [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: finish }] ]) res.write('data: ' + JSON.stringify({ id: 'recovery-fixture', object: 'chat.completion.chunk', model: 'recovery-local', choices }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function tool(res, name, args, id) { stream(res, { tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls'); }
async function launch(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    try { handler(body, res, requests); } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(ROOT, '.recovery-test-'));
  const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  let app;
  try {
    app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, chromiumSandbox: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace }, timeout: 30000 });
    const page = await app.firstWindow(); await page.waitForLoadState('load');
    if (await page.locator('#first-launch').isVisible()) await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.evaluate(async port => {
      await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-test-only', model: 'recovery-local', models: ['recovery-local'] });
      window.__recoveryEvents = []; window.piDesktop.agent.onEvent(e => window.__recoveryEvents.push(e));
    }, server.address().port);
    return { app, page, workspace, requests, async close() { try { await app.close(); } finally { server.close(); } /* Keep isolated evidence; do not delete user profiles. */ } };
  } catch (error) { if (app) await app.close(); server.close(); throw error; }
}
async function send(page, text) { await page.locator('#message-input').fill(text); await page.locator('#composer').evaluate(form => form.requestSubmit()); }
async function settled(page) { await page.waitForFunction(() => window.__recoveryEvents.some(e => e.type === 'agent_settled'), null, { timeout: 60000 }); }
async function events(page) { return page.evaluate(() => window.__recoveryEvents); }
function allText(body) { return JSON.stringify(body.messages); }

test('length continuation retains prior file/tool results, same process, bounded requests and configurable output budget', async () => {
  const fx = await launch((body, res, requests) => {
    if (requests.length === 1) tool(res, 'write', { path: 'completed.txt', content: 'KEEP_COMPLETED_ONCE' }, requests.length);
    else if (requests.length === 2) stream(res, { content: 'partial result' }, 'length');
    else { if (!allText(body).includes('KEEP_COMPLETED_ONCE')) throw new Error('successful tool result lost'); stream(res, { content: 'RECOVERY_LENGTH_OK' }); }
  });
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await send(fx.page, '完成文件后继续，不要重放成功操作'); await settled(fx.page);
    await expect(fx.page.locator('.message.assistant').last()).toContainText('RECOVERY_LENGTH_OK');
    await expect(fx.page.locator('.run-diagnostic')).toHaveCount(0);
    expect(fs.readFileSync(path.join(fx.workspace, 'completed.txt'), 'utf8')).toBe('KEEP_COMPLETED_ONCE');
    expect(fx.requests).toHaveLength(3);
    const ev = await events(fx.page), starts = ev.filter(e => e.type === 'agent_recovery_start');
    expect(starts).toHaveLength(1); expect(starts[0].failure.code).toBe('OUTPUT_LIMIT');
    expect(ev.some(e => e.type === 'agent_recovery_complete')).toBe(true);
    expect(ev.filter(e => e.type === 'tool_execution_start' && e.toolName === 'write')).toHaveLength(1);
    expect(ev.some(e => e.type === 'agent_settled' && e.failure)).toBe(false);
    await fx.page.locator('[data-route="settings"]').click();
    await fx.page.locator('#provider-advanced summary').click();
    await fx.page.locator('[data-output-slot="0"]').fill('12000');
    await fx.page.locator('#provider-form').evaluate(form => form.requestSubmit());
    await expect(fx.page.locator('#provider-status')).toContainText('配置已保存');
    const cfg = await fx.page.evaluate(() => window.PiProviderManager.getConfig());
    expect(cfg.modelLimits['recovery-local'].maxOutputTokens).toBe(12000);
    await fx.page.locator('.brand').click();
    await fx.page.evaluate(() => { window.__recoveryEvents = []; });
    await send(fx.page, '检查新的输出预算'); await settled(fx.page);
    const request = fx.requests.at(-1);
    expect(request.max_completion_tokens || request.max_tokens).toBe(12000);
  } finally { await fx.close(); }
});

test('readTaskContext works without an open workbench and only returns active task metadata', async () => {
  const fx = await launch((body, res, requests) => {
    const last = body.messages.at(-1);
    if (last.role !== 'tool') tool(res, 'workbench_action', { command: 'readTaskContext' }, requests.length);
    else { const data = JSON.parse(last.content); if (!data.task || typeof data.messageCount !== 'number') throw new Error('invalid task context'); stream(res, { content: 'TASK_CONTEXT_OK ' + data.task }); }
  });
  try {
    await fx.page.locator('[data-route="plugins"]').click();
    await fx.page.locator('[data-action="toggle-plugin"]').click();
    await fx.page.locator('.brand').click();
    await send(fx.page, '读取当前任务上下文'); await settled(fx.page);
    await expect(fx.page.locator('.message.assistant').last()).toContainText('TASK_CONTEXT_OK');
    expect(fx.requests).toHaveLength(2);
    expect((await events(fx.page)).some(e => e.type === 'tool_execution_end' && e.isError)).toBe(false);
  } finally { await fx.close(); }
});

test('repeated length stops after two recoveries and reports output, not context overflow', async () => {
  const fx = await launch((_body, res) => stream(res, { content: 'truncated' }, 'length'));
  try {
    await send(fx.page, '测试连续输出截断'); await settled(fx.page);
    expect(fx.requests).toHaveLength(3);
    const ev = await events(fx.page);
    expect(ev.filter(e => e.type === 'agent_recovery_start')).toHaveLength(2);
    expect(ev.find(e => e.type === 'agent_settled').failure.exhausted).toBe(true);
    await expect(fx.page.locator('.run-diagnostic')).toContainText('单次模型输出被截断');
    await expect(fx.page.locator('.run-diagnostic')).not.toContainText('压缩上下文并重试');
  } finally { await fx.close(); }
});

test('design report survives truncation, remains same attempt, and awaits user confirmation', async () => {
  let reportPayload;
  const fx = await launch((body, res, requests) => {
    const last = body.messages.at(-1);
    if (requests.length === 1) tool(res, 'workbench_action', { command: 'readDesignWorkflow' }, requests.length);
    else if (requests.length === 2) {
      const view = JSON.parse(last.content); reportPayload = { stage: view.stage, attemptId: view.attempt.id, summary: '阶段依据已提交', evidence: ['本地模拟语义动作链路，不代表真实工程已构建'] };
      tool(res, 'workbench_action', { command: 'reportDesignStage', payload: reportPayload }, requests.length);
    } else if (requests.length === 3) stream(res, { content: 'long final truncated' }, 'length');
    else { if (!allText(body).includes('阶段结果已记录')) throw new Error('stage report lost'); stream(res, { content: 'DESIGN_RECOVERED_OK' }); }
  });
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.page.locator('[data-route="workbenches"]').click();
    await fx.page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await fx.page.locator('[data-action="confirm-design"]').click(); await settled(fx.page);
    await expect(fx.page.locator('.design-confirm-card')).toContainText('待确认');
    await expect(fx.page.frameLocator('#module-frame').locator('#wb-progress .wb-pill')).toHaveText('待确认');
    await expect(fx.page.locator('.design-stage.current')).toContainText('需求确认');
    await expect(fx.page.locator('.message.assistant').last()).toContainText('DESIGN_RECOVERED_OK');
    expect(fx.requests).toHaveLength(4);
    const ev = await events(fx.page), ids = new Set(ev.filter(e => e.runId).map(e => e.runId));
    expect(ids.size).toBe(1); expect(ev.filter(e => e.type === 'agent_recovery_start')).toHaveLength(1);
    const flow = await fx.page.evaluate(async () => { await window.PiPersistence.flush();const s = (await window.piDesktop.storage.load()).result.state; return s.projects.flatMap(p => p.tasks).find(t => t.id === s.activeTask).design.workflow; });
    expect(flow.attempt.id).toBe(reportPayload.attemptId); expect(flow.report.summary).toBe(reportPayload.summary); expect(flow.stage).toBe(0);
  } finally { await fx.close(); }
});
