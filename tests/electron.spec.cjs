'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function stream(response, chunks) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const chunk of chunks) response.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
  response.end();
}

function toolResponse(name, args, id) {
  return [
    { id: `pw-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: `pw-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

function textResponse(text, id) {
  return [
    { id: `pw-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: `pw-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

async function startScriptedProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'agent-test' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(await readBody(request));
    requests.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    const content = messages[lastUser]?.content || '';
    const userText = (typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n')).split('\n')[0];
    const hasToolResult = messages.slice(lastUser + 1).some(message => message.role === 'tool');
    if (userText.includes('PW_STOP')) { await pause(12000); stream(response, textResponse('AGENT_PLAYWRIGHT_SHOULD_NOT_FINISH', requests.length)); return; }
    const toolMessages = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
    if (userText.includes('工作台设计阶段')) {
      if (!toolMessages.length) {
        stream(response, toolResponse('workbench_action', { command: 'readDesignWorkflow', payload: {} }, requests.length));
        return;
      }
      if (toolMessages.length === 1) {
        let view = {};
        try {
          const parsed = JSON.parse(toolMessages.at(-1).content || '{}');
          view = parsed.result || parsed;
        } catch {}
        stream(response, toolResponse('workbench_action', { command: 'reportDesignStage', payload: {
          stage: Number.isInteger(view.stage) ? view.stage : 0,
          attemptId: view.attempt?.id,
          summary: '阶段工作已完成并提交可核对依据。',
          evidence: ['tests/electron.spec.cjs：真实 Agent 工具链验收']
        } }, requests.length));
        return;
      }
      stream(response, textResponse('DESIGN_STAGE_PLAYWRIGHT_OK', requests.length));
      return;
    }
    if (userText.includes('PW_DESIGN')) {
      if (!toolMessages.length) { stream(response, toolResponse('workbench_action', { command: 'readDraft', payload: {} }, requests.length)); return; }
      if (toolMessages.length === 1) {
        let revision = 0;
        try { revision = Number(JSON.parse(toolMessages.at(-1).content || '{}').revision) || 0; } catch {}
        stream(response, toolResponse('workbench_action', { command: 'setKnowledgePrompt', payload: { prompt: 'Agent 设计摘要：结构化状态、语义动作与用户可见反馈。', baseRevision: revision } }, requests.length));
        return;
      }
      stream(response, textResponse('AGENT_PLAYWRIGHT_DESIGN_OK', requests.length));
      return;
    }
    if (userText.includes('PW_MEMORY')) {
      if (!toolMessages.length) { stream(response, toolResponse('memory_proposal', { scope: 'task', lifespan: 'long', kind: 'preference', content: '当前任务的结果说明优先使用中文。', reason: '用户明确指定了稳定的输出偏好。' }, requests.length)); return; }
      stream(response, textResponse('候选记忆已提交，等待用户确认。', requests.length));
      return;
    }
    if (hasToolResult) { stream(response, textResponse('**AGENT_PLAYWRIGHT_OK**\n\n- 工具结果已同步\n- `状态` 已更新', requests.length)); return; }
    if (userText.includes('PW_FILE')) { stream(response, toolResponse('read', { path: 'README.md' }, requests.length)); return; }
    if (userText.includes('PW_WRITE')) { stream(response, toolResponse('write', { path: 'review.txt', content: 'new line\n' }, requests.length)); return; }
    if (userText.includes('PW_SOLVE') || userText.includes('PW_APPROVAL')) { stream(response, toolResponse('workbench_action', { command: 'solve', payload: {} }, requests.length)); return; }
    if (userText.includes('PW_INTERACTION')) { stream(response, toolResponse('interaction_request', { method: 'confirm', title: 'Playwright 集成确认', message: '确认 Agent 交互链路。' }, requests.length)); return; }
    stream(response, textResponse('AGENT_PLAYWRIGHT_UNEXPECTED', requests.length));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, requests };
}

async function enableComposer(page,ids){await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-toggles').click();for(const id of ids){const box=page.locator('[data-composer-toggle="'+id+'"]');if(!(await box.isChecked()))await box.evaluate(el=>el.click());}await page.locator('.brand').click();}
test('Pi Agent 工作台完整链路', async () => {
  test.setTimeout(240000); // Multiple cold RPC starts, design, memory and stop/resume in one chain.
  const provider = await startScriptedProvider();
  const profile = fs.mkdtempSync(path.join(ROOT, '.playwright-launch-'));
  const packagedExe = process.env.PI_WORKBENCH_TEST_EXE;
  fs.mkdirSync(path.join(profile, 'workspace'));
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(profile, 'workspace', 'README.md'));
  fs.writeFileSync(path.join(profile,'workspace','review.txt'),'old line\n');
  const launchEnv = { ...process.env, PI_WORKBENCH_WORKSPACE:path.join(profile,'workspace') };
  if (process.env.PI_WORKBENCH_TEST_MINIMAL_PATH === '1') {
    for (const key of Object.keys(launchEnv)) if (key.toLowerCase() === 'path') delete launchEnv[key];
    launchEnv.PATH = path.join(process.env.SystemRoot, 'System32');
    delete launchEnv.PI_WORKBENCH_NODE;
    delete launchEnv.PI_WORKBENCH_PI_ROOT;
    delete launchEnv.PI_WORKBENCH_PI_CLI;
  }
  const app = await electron.launch({
    executablePath: packagedExe || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [...(packagedExe ? [] : [ROOT]), `--user-data-dir=${profile}`],
    cwd: packagedExe ? path.dirname(packagedExe) : ROOT,
    env: launchEnv,
    timeout: 30000
  });
  const page = await app.firstWindow();
  // Keep the integration chain independent of desktop clipboard availability;
  // native denial and the product error path are covered by clipboard.spec.cjs.
  await require('./helpers/clipboard.cjs').useClipboardMemory(app);
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(Boolean(packagedExe));
    await page.evaluate(() => { localStorage.clear(); location.reload(); });
    await expect(page.locator('#projects .project-group')).toHaveCount(2);
    await enableComposer(page,['capacity','interactive','rate','provider','effort']);

    const designerPath = path.join(profile, 'designer.md');
    fs.writeFileSync(designerPath, '# 专属设计知识\n工作台应优先展示结构化状态和语义动作。\n', 'utf8');
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('#workbench-section .task-select .kind-badge.kind-create')).toBeVisible();   // 创建任务带颜色徽标
    await expect(page.locator('#projects .task-select span').filter({ hasText: '设计 · 新工作台' })).toHaveCount(0);   // 项目栏默认不再混入工作台任务
    await expect(page.locator('.design-dock')).toBeVisible();
    await expect(page.locator('.design-history')).toContainText('操作历史');
    await expect(page.locator('.design-workflow')).toContainText('设计进度');
    await expect(page.locator('.design-stage.current')).toContainText('需求确认');
    await page.locator('[data-action="toggle-task-workbench"]').click();
    // 关闭“创建工作台”后，整个工作台侧栏收起；再次点击任务上的开启按钮重新打开。
    await expect(page.locator('#side-panel-tabs [data-action="select-side-tab"][data-tab="workbench"]')).toHaveCount(0);
    await expect(page.locator('#side-panel-tabs [data-action="select-side-tab"][data-tab="preview"]')).toHaveCount(0);
    await expect(page.locator('#workbench-panel')).toBeHidden();
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toContainText('继续设计');
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await page.reload();
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('#workbench-title')).toContainText('设计设置');
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();   // 重载后默认落在「界面预览」，这里检查创建工作台自身的数据
    const builder = page.frameLocator('#module-frame');
    await expect(builder.locator('#wb-kb')).toBeVisible();
    await builder.locator('details').first().locator('summary').click();
    await builder.locator('#wb-name').fill('通用领域工作台');
    await builder.locator('#wb-kb').fill(designerPath);
    await builder.locator('#kb-import').click();
    await expect(builder.locator('.knowledge-summary')).toContainText('已读取 1 份');
    await expect(builder.locator('#wb-prompt')).not.toHaveValue('');
    await builder.locator('#prompt-apply').click();
    await expect(builder.locator('.tag').filter({ hasText: '已应用' })).toBeVisible();
    await expect(builder.locator('#wb-next')).toHaveCount(0);
    await expect(page.locator('[data-action="design-stage-next"]')).toHaveCount(0);
    await expect(page.locator('[data-action="confirm-design"]')).toBeVisible();
    await expect(builder.locator('#wb-progress h3')).toHaveText('需求确认');

    await page.evaluate(async config => window.PiProviderManager.saveConfig(config), {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: 'playwright-local', model: 'agent-test'
    });
    await page.evaluate(() => { window.__playwrightAgentEvents = []; window.__playwrightAllAgentEvents = []; window.piDesktop.agent.onEvent(event => { window.__playwrightAgentEvents.push(event); window.__playwrightAllAgentEvents.push(event); }); });

    async function send(prompt) {
      await page.locator('#message-input').fill(prompt);
      await page.locator('#composer').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => window.__playwrightAgentEvents?.some(event => event.type === 'agent_settled') || document.querySelector('#messages')?.textContent.includes('Pi Agent 未完成请求'), null, { timeout: 60000 });
      await expect(page.locator('#messages')).not.toContainText('Pi Agent 未完成请求');
      await expect.poll(() => page.locator('.message.assistant').last().locator('.message-text').textContent()).toMatch(/\S/);
      await expect(page.locator('.message.assistant').last().locator('.run-progress')).toBeVisible();
      await expect(page.locator('.message.assistant').last().locator('.run-summary')).toContainText('用时');
    }
    async function clearEvents() { await page.evaluate(() => { window.__playwrightAgentEvents = []; }); }
    async function setApproval(value) { await page.locator('#approval-mode').selectOption(value); await pause(250); }

    await setApproval('full');
    await clearEvents();
    await page.locator('[data-action="confirm-design"]').click();
    await page.waitForFunction(() => window.__playwrightAgentEvents?.some(event => event.type === 'agent_settled'), null, { timeout: 60000 });
    await expect(page.locator('.design-confirm-card')).toContainText('待确认');
    await expect(page.locator('.design-confirm-card details')).toContainText('tests/electron.spec.cjs');
    await expect(page.locator('.design-stage.current')).toContainText('需求确认');
    await expect(builder.locator('#wb-progress .wb-pill')).toHaveText('待确认');
    await clearEvents();
    // Completion events can reach the UI before the original IPC acknowledgement.
    // A finished design stage must already allow the next chat to be submitted.
    await app.evaluate(({ipcMain})=>{
      const original=ipcMain._invokeHandlers.get('agent:send');let hold=true;
      ipcMain._invokeHandlers.set('agent:send',async(...args)=>{
        const delayed=hold;hold=false;
        const result=await original(...args);
        if(delayed)await new Promise(resolve=>globalThis.__releaseStageSend=resolve);
        return result;
      });
    });
    await page.locator('[data-action="confirm-design"]').click();
    await page.waitForFunction(() => window.__playwrightAgentEvents?.some(event => event.type === 'agent_settled'), null, { timeout: 60000 });
    await expect(page.locator('.design-confirm-card')).toContainText('待确认');
    await expect(page.locator('.design-stage.current')).toContainText('结构设计');
    await expect(builder.locator('#wb-progress .wb-pill')).toHaveText('待确认');

    await clearEvents();
    await send('PW_DESIGN：请读取设计草稿并更新工作台提示词');
    await app.evaluate(()=>globalThis.__releaseStageSend());
    await expect(builder.locator('#wb-prompt')).toContainText('Agent 设计摘要');
    const latestRun = page.locator('.message.assistant').last();
    await expect(latestRun.locator('.tool-group')).toContainText('操作工作台');
    await expect(latestRun.locator('.tool-state.done')).toHaveCount(2);
    await page.locator('#context-capacity').click();
    await expect(page.locator('#context-surface')).toBeVisible();
    await page.locator('.context-tab[data-context-view="content"]').click();
    await expect(page.locator('.context-block-card').filter({ hasText: '工作台结构化状态' })).toBeVisible();
    expect(provider.requests.some(request => JSON.stringify(request).includes('contextManifest'))).toBe(true);
    await page.locator('[data-context-action="compact"]').click();
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('pi-workbench-design-v2'));
      const task = saved.projects.flatMap(project => project.tasks).find(item => item.id === saved.activeTask);
      return task?.context?.history?.some(item => /上下文压缩|压缩检查/.test(item.label)) || false;
    }), { timeout: 30000 }).toBe(true);
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();
    await expect(page.locator('#module-frame')).toBeVisible();
    await page.locator('.message.assistant').last().locator('[data-action="copy-message"]').click();
    await expect(page.locator('#toast')).toContainText('已复制到剪贴板');

    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="qubo"][data-mode="edit"]').click();
    const editor = page.frameLocator('#preview-frame');
    await expect(editor.locator('#design-mode-banner')).toBeVisible();
    await expect(editor.locator('[aria-label="QUBO q00"]')).toHaveValue('-1');
    await expect(editor.locator('.design-mode-switch')).toBeVisible();
    await page.locator('[data-action="toggle-trial"]').click();await expect(editor.locator('script[data-pi-runtime]')).toHaveCount(1);
    await editor.locator('[aria-label="QUBO q00"]').fill('-2');
    await editor.locator('[aria-label="QUBO q00"]').press('Tab');
    await expect.poll(()=>page.evaluate(async()=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);return t.workbenches['trial:'+t.id]?.matrix?.[0]?.[0];})).toBe(-2);
    await page.locator('[data-action="toggle-trial"]').click();await expect(editor.locator('#design-mode-banner')).toBeVisible();
    await editor.locator('.design-mode-switch').click();
    await editor.locator('button[title="图层与嵌套元素"]').click();
    const editedLayer = editor.locator('.design-layer').filter({ hasText: 'input · QUBO q00' });
    await editedLayer.click();
    const editedNodeId = await editedLayer.getAttribute('data-node');
    await expect(editor.locator('.design-selected-name')).toHaveText('QUBO q00');
    await expect(editedLayer).toHaveClass(/selected/);
    await editor.locator('input[name="x"]').fill('36');
    await editor.locator('input[name="x"]').press('Tab');
    await editor.locator('input[name="y"]').fill('22');
    await editor.locator('input[name="y"]').press('Tab');
    await expect(editor.locator('input[name="x"]')).toHaveValue('36');
    await expect(editor.locator('input[name="y"]')).toHaveValue('22');
    await editor.locator('[data-design="zoom-in"]').click();
    await expect(editor.locator('[data-design="zoom-value"]')).toContainText('120%');
    const designPath=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));return s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask).design.workspacePath;});
    await expect.poll(()=>{try{return JSON.parse(fs.readFileSync(path.join(designPath,'ui/layout.json'),'utf8')).nodes[editedNodeId]?.x;}catch{return -1;}}).toBe(36);
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialog')).toContainText('先选择项目');
    await expect(page.locator('#use-project')).toBeVisible();
    await expect(page.locator('#use-task')).toBeVisible();
    await page.locator('#dialog-form').evaluate(form => form.requestSubmit());
    await expect(page.locator('#workbench-panel')).toBeVisible();
    await expect(page.locator('.design-dock')).toHaveCount(0);
    await expect(page.frameLocator('#module-frame').locator('[aria-label="QUBO q00"]')).toHaveValue('-1'); // Original is isolated from the editable draft.

    await clearEvents();
    await send('PW_FILE：读取 README.md');
    await expect(page.locator('.message.assistant').last().locator('.assistant-bubble')).toBeVisible();
    await expect(page.locator('.message.assistant').last().locator('strong')).toContainText('AGENT_PLAYWRIGHT_OK');
    expect(await page.evaluate(() => window.__playwrightAgentEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'read' && !event.isError))).toBe(true);
    await expect(page.locator('.tool-entry code').filter({ hasText: 'README.md' })).toHaveCount(1);
    await expect(page.locator('.message.assistant').last().locator('.changed-files')).toHaveCount(0);

    await clearEvents();
    await send('PW_WRITE：修改 review.txt');
    await expect(page.locator('.message.assistant').last().locator('.changed-files')).toContainText('review.txt');
    await page.locator('.message.assistant').last().locator('[data-action="review-file"]').click();
    await expect(page.locator('.diff-line.removed')).toContainText('old line');
    await expect(page.locator('.diff-line.added')).toContainText('new line');
    await page.locator('#dialog [data-action="close-dialog"]').first().click();

    await setApproval('ask');
    await clearEvents();
    await page.locator('#message-input').fill('PW_APPROVAL：调用 QUBO solve');
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await expect(page.locator('#agent-ui-form')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#agent-ui-form')).toContainText('批准 Agent 操作');
    await page.locator('#agent-ui-form button[value="true"]').click();
    await page.waitForFunction(() => window.__playwrightAgentEvents?.some(event => event.type === 'agent_settled'), null, { timeout: 60000 });

    await setApproval('full');
    await clearEvents();
    await page.locator('#message-input').fill('PW_INTERACTION：请显示交互确认');
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await expect(page.locator('#agent-ui-form')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#agent-ui-form')).toContainText('全局交互能力');
    await page.locator('#agent-ui-form button[value="true"]').click();
    await page.waitForFunction(() => window.__playwrightAgentEvents?.some(event => event.type === 'agent_settled'), null, { timeout: 60000 });
    await expect.poll(() => page.evaluate(() => window.__playwrightAgentEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'interaction_request' && !event.isError))).toBe(true);

    await clearEvents();
    await send('PW_SOLVE：调用 QUBO solve');
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pi-workbench-design-v2'));
      const task = state.projects.flatMap(project => project.tasks).find(item => item.id === state.activeTask);
      return task?.workbenches?.qubo?.result?.bits || '';
    }), { timeout: 10000 }).toMatch(/^[01]{4}$/);
    const solved = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pi-workbench-design-v2'));
      const task = state.projects.flatMap(project => project.tasks).find(item => item.id === state.activeTask);
      return task?.workbenches?.qubo?.result || null;
    });
    expect(solved?.bits).toMatch(/^[01]{4}$/);
    await expect.poll(() => page.evaluate(() => window.__playwrightAgentEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'workbench_action' && !event.isError))).toBe(true);

    await clearEvents();
    await send('PW_MEMORY：把稳定偏好提交为候选记忆');
    await expect.poll(() => page.evaluate(() => window.__playwrightAgentEvents.some(event => event.type === 'tool_execution_end' && event.toolName === 'memory_proposal' && !event.isError))).toBe(true);
    await page.locator('.task-row.selected [data-action="task-menu"]').click();
    await page.locator('#menu [data-action="task-memory-menu"]').hover();
    await page.locator('#submenu [data-action="open-task-memory-all"]').click();
    await page.locator('[data-memory-action="status"][data-value="pending"]').click();
    await expect(page.locator('.memory-list > .memory-card')).toContainText('当前任务的结果说明优先使用中文。');
    await expect(page.locator('.memory-list > .memory-card')).toContainText('待确认');
    await expect(page.locator('.memory-list > .memory-card')).toContainText('用户明确指定了稳定的输出偏好');
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();

    await clearEvents();
    await page.locator('#message-input').fill('PW_STOP：等待后停止');
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await expect(page.locator('.stop-button')).toContainText('停止');
    await page.locator('.stop-button').click();
    await expect(page.locator('.run-indicator')).toHaveCount(0);
    await expect(page.locator('.message.assistant').last().locator('.message-text')).toContainText('已停止本次运行');
    await expect(page.locator('.stop-button')).toHaveCount(0);
    await clearEvents();
    const requestCount=provider.requests.length;
    await page.locator('#message-input').fill('PW_STOP：暂停后继续，再强制终止');
    await page.locator('#composer').evaluate(form=>form.requestSubmit());
    // Stopping disposes the RPC process. Cold startup includes environment and
    // runtime initialization; keep UI-response budgets in the performance tests.
    await expect.poll(()=>provider.requests.length,{timeout:30000}).toBeGreaterThan(requestCount);
    await page.locator('[data-action="pause-agent"]').click();
    await expect(page.locator('.message.assistant').last().locator('.run-summary')).toContainText('已暂停');
    await expect(page.locator('[data-action="resume-agent"]')).toBeVisible();
    const resumeCount=provider.requests.length;
    await page.locator('[data-action="resume-agent"]').click();
    await expect.poll(()=>provider.requests.length,{timeout:30000}).toBeGreaterThan(resumeCount);
    await page.locator('[data-action="force-stop-agent"]').click();
    await expect(page.locator('.run-indicator')).toHaveCount(0);
    await expect(page.locator('[data-action="resume-agent"]')).toBeVisible();
    await clearEvents();
    await send('PW_SOLVE：强制终止后重新启动 Agent 并求解');
    await expect(page.locator('.message.assistant').last().locator('.message-text')).toContainText('AGENT_PLAYWRIGHT_OK');
    await page.screenshot({ path: path.join(ROOT, 'test-results', 'agent-status-final.png'), fullPage: false });
    expect(provider.requests.length).toBeGreaterThanOrEqual(8);
    if(packagedExe){
      const runtime=await app.evaluate(async({app})=>{const root=app.getAppPath(),resources=process.resourcesPath;const require=process.getBuiltinModule('node:module').createRequire(root+'/package.json'),path=require('node:path');const info=require(path.join(root,'runtime/agent-runtime.cjs')).resolveRuntime({appRoot:root,resourcesPath:resources});const launch=await require(path.join(root,'runtime/agent-launch.cjs')).prepareAgentLaunch({isPackaged:true,appPath:root,userDataPath:app.getPath('userData'),resourcesPath:resources,cliPath:info.cliPath});return {packageRoot:info.packageRoot,nodePath:launch.nodePath,resources};});
      expect(runtime.packageRoot).toContain(path.join(runtime.resources,'pi-runtime'));
      expect(runtime.nodePath).toBe(path.join(runtime.resources,'runtime','node.exe'));
    }
    const trace = { packaged: Boolean(packagedExe), minimalPath: process.env.PI_WORKBENCH_TEST_MINIMAL_PATH === '1', events: await page.evaluate(() => window.__playwrightAllAgentEvents), providerRequests: provider.requests.length };
    fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'test-results', 'pi-agent-trace.json'), JSON.stringify(trace, null, 2), 'utf8');
  } finally {
    await app.close();
    provider.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('启动中停止后立即发送：迟到的旧启动不能创建进程或覆盖新会话',async()=>{
  const provider=await startScriptedProvider(),profile=fs.mkdtempSync(path.join(ROOT,'.playwright-launch-race-')),exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  try{
    const page=await app.firstWindow();await page.waitForLoadState('load');await page.locator('#message-input').waitFor();
    if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.evaluate(async port=>window.PiProviderManager.saveConfig({provider:'openai-compatible',baseUrl:'http://127.0.0.1:'+port+'/v1',apiKey:'local-only',model:'agent-test'}),provider.port);
    await app.evaluate(()=>{
      const module=process.getBuiltinModule('node:module'),fs=process.getBuiltinModule('node:fs/promises'),cp=process.getBuiltinModule('node:child_process');
      const read=fs.readFile,spawn=cp.spawn;globalThis.__raceSpawns=0;globalThis.__raceBlocked=false;globalThis.__raceOnce=true;
      fs.readFile=async function(file,...args){if(globalThis.__raceOnce&&/pi-agent[\\/]settings\.json$/.test(String(file))){globalThis.__raceOnce=false;globalThis.__raceBlocked=true;await new Promise(r=>globalThis.__raceRelease=r);}return read.call(this,file,...args);};
      cp.spawn=function(command,args,...rest){if(args?.includes('--mode')&&args?.includes('rpc'))globalThis.__raceSpawns++;return spawn.call(this,command,args,...rest);};module.syncBuiltinESMExports();
    });
    await page.locator('#message-input').fill('先启动再停止');await page.locator('#composer').evaluate(f=>f.requestSubmit());
    await expect.poll(()=>app.evaluate(()=>globalThis.__raceBlocked),{timeout:30000}).toBe(true);
    await page.locator('[data-action="stop-agent"]').click();await expect(page.locator('[data-action="stop-agent"]')).toHaveCount(0);
    await page.locator('#message-input').fill('新的请求');await page.locator('#composer').evaluate(f=>f.requestSubmit());
    await expect.poll(()=>provider.requests.length,{timeout:30000}).toBe(1);await expect(page.locator('[data-action="stop-agent"]')).toHaveCount(0);
    await app.evaluate(()=>globalThis.__raceRelease());
    await page.waitForTimeout(1800);
    expect(await app.evaluate(()=>globalThis.__raceSpawns)).toBe(1);
    await expect(page.locator('.message.assistant').last()).toContainText('AGENT_PLAYWRIGHT_UNEXPECTED');
  }finally{await app.close();provider.server.close();const resolved=path.resolve(profile);if(!resolved.startsWith(ROOT+path.sep+'.playwright-launch-race-'))throw new Error('Invalid cleanup path');fs.rmSync(resolved,{recursive:true,force:true});}
});
