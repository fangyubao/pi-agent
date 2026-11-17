'use strict';

// Agent integration test. The local provider below is deliberately scripted:
// it drives Pi Agent through the OpenAI-compatible protocol, while assertions
// score only Agent/tool/UI behavior—not natural-language answer quality.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class CdpClient {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
      } else this.events.push(message);
    };
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    await this.send('Runtime.enable'); await this.send('Page.enable'); await this.send('Log.enable');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async waitFor(expression, label, timeout = 20000) {
    const deadline = Date.now() + timeout; let value;
    while (Date.now() < deadline) { value = await this.eval(expression); if (value) return value; await pause(100); }
    throw new Error(`等待超时：${label}; last=${JSON.stringify(value)}`);
  }
  close() { this.ws?.close(); }
}

function readBody(request) {
  return new Promise((resolve, reject) => { let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => resolve(body)); request.on('error', reject); });
}

function sse(response, payloads) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const payload of payloads) response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  response.end();
}

function toolChunk(name, args, id) {
  return [
    { id: `agent-test-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: `agent-test-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

function answerChunk(text, id) {
  return [
    { id: `agent-test-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: `agent-test-${id}`, object: 'chat.completion.chunk', model: 'agent-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

async function main() {
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
    const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
    const userContent = messages[lastUserIndex]?.content || '';
    const userText = (typeof userContent === 'string' ? userContent : userContent.filter(x=>x.type==='text').map(x=>x.text).join('\n')).split('\n')[0];
    const hasToolResult = messages.slice(lastUserIndex + 1).some(message => message.role === 'tool');
    const id = requests.length;
    if (hasToolResult) { sse(response, answerChunk('AGENT_TEST_OK', id)); return; }
    if (userText.includes('AGENT_FILE_TEST')) { sse(response, toolChunk('read', { path: 'README.md' }, id)); return; }
    if (userText.includes('AGENT_CMD_TEST')) { sse(response, toolChunk('cmd', { command: 'cd && echo PI_CMD_TEST_OK' }, id)); return; }
    if (userText.includes('AGENT_WSL_TEST')) { sse(response, toolChunk('bash', { command: 'pwd && printf PI_WSL_TEST_OK' }, id)); return; }
    if (userText.includes('AGENT_APPROVAL_TEST') || userText.includes('AGENT_SOLVE_TEST')) { sse(response, toolChunk('workbench_action', { command: 'solve', payload: {} }, id)); return; }
    if (userText.includes('AGENT_INTERACTION_TEST')) { sse(response, toolChunk('interaction_request', { method: 'confirm', title: 'Agent 集成测试确认', message: '请确认交互卡链路。' }, id)); return; }
    sse(response, answerChunk('AGENT_TEST_UNEXPECTED_PROMPT', id));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cdpPort = 9382;
  const profile = path.join(__dirname, '.agent-integration-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const electron = process.env.PI_WORKBENCH_ELECTRON || path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [__dirname, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
  let cdp;
  const checks = [];
  const check = (name, detail) => checks.push({ name, detail });
  try {
    let pages = [];
    for (let attempt = 0; attempt < 160; attempt++) {
      try { pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then(result => result.json()); if (pages.length) break; } catch {}
      await pause(125);
    }
    const page = pages.find(item => item.type === 'page' && item.url.includes('index.html'));
    assert(page, '没有找到集成测试桌面窗口');
    cdp = new CdpClient(page.webSocketDebuggerUrl); await cdp.connect();
    await cdp.eval(`localStorage.clear(); location.reload(); true`);
    await cdp.waitFor(`document.readyState==='complete' && !!document.querySelector('#projects .project-group')`, '桌面初始化');
    await cdp.eval(`window.PiProviderManager.saveConfig({provider:'openai-compatible',baseUrl:'http://127.0.0.1:${port}/v1',apiKey:'agent-test-key',model:'agent-test'})`);
    await cdp.eval(`window.piDesktop.agent.stop(); true`);
    await cdp.eval(`document.querySelector('[data-action="dismiss-first-launch"]')?.click(); document.querySelector('[data-route="workbenches"]').click(); true`);
    await cdp.eval(`document.querySelector('[data-action="open-use-workbench"][data-key="qubo"]').click(); true`);
    await cdp.waitFor(`!!document.querySelector('#dialog[open]')`, '工作台挂载选择');
    await cdp.eval(`document.querySelector('#dialog-form').requestSubmit(); true`);
    await cdp.waitFor(`window.PiContextManager.snapshot().workbench==='qubo'`, 'QUBO 工作台打开');
    await pause(500);
    await cdp.eval(`window.__agentEvents=[]; window.piDesktop.agent.onEvent(event=>window.__agentEvents.push(event)); true`);

    async function sendPrompt(text) {
      await cdp.eval(`window.__agentEvents=[]; document.querySelector('#message-input').value=${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit(); true`);
      await cdp.waitFor(`window.__agentEvents.some(x=>x.type==='agent_settled')`, `${text} 完成`, 60000);
    }
    async function setApproval(mode) {
      await cdp.eval(`{const x=document.querySelector('#approval-mode');x.value='${mode}';x.dispatchEvent(new Event('change'));} true`);
      await pause(250);
    }

    await setApproval('full');
    await sendPrompt('AGENT_FILE_TEST：读取 README.md。');
    const fileCheck = await cdp.eval(`({tool:window.__agentEvents.some(x=>x.type==='tool_execution_start'&&x.toolName==='read'),io:[...document.querySelectorAll('.tool-entry code')].map(x=>x.textContent).join('|'),done:document.querySelector('.tool-group')?.textContent||''})`);
    assert.equal(fileCheck.tool, true, 'Agent 没有执行 read 工具');
    assert.match(fileCheck.io, /README\.md/i, '状态栏没有记录文件 I/O');
    check('文件 I/O 状态', 'Agent read 工具事件、文件路径和完成状态均可见');

    await sendPrompt('AGENT_SOLVE_TEST：调用 QUBO 工作台的 solve 动作。');
    const solveFull = await cdp.eval(`(async()=>{await window.PiPersistence.flush();const stored=await window.piDesktop.storage.load();const s=stored.result.state;const t=s.projects.flatMap(p=>p.tasks).find(x=>x.id===s.activeTask);return {tool:window.__agentEvents.some(x=>x.type==='tool_execution_end'&&x.toolName==='workbench_action'&&!x.isError),result:t?.workbenches?.qubo?.result||null}})()`);
    assert.equal(solveFull.tool, true, '完全批准模式下工作台动作未完成');
    assert.match(solveFull.result?.bits || '', /^[01]{4}$/, 'QUBO 结果没有写回任务状态');
    check('工作台桥接与完全批准', `solve 写回结果 ${solveFull.result.bits}`);

    await setApproval('ask');
    await cdp.eval(`window.__agentEvents=[]; document.querySelector('#message-input').value='AGENT_APPROVAL_TEST：调用 QUBO 工作台的 solve 动作。'; document.querySelector('#composer').requestSubmit(); true`);
    await cdp.waitFor(`!!document.querySelector('#agent-ui-form')`, '工作台动作审批卡');
    assert.match(await cdp.eval(`document.querySelector('#agent-ui-form').innerText`), /批准 Agent 操作/);
    await cdp.eval(`document.querySelector('#agent-ui-form button[value="true"]').click(); true`);
    await cdp.waitFor(`window.__agentEvents.some(x=>x.type==='agent_settled')`, '审批后 Agent 完成');
    assert.equal(await cdp.eval(`window.__agentEvents.some(x=>x.type==='tool_execution_end'&&x.toolName==='workbench_action'&&!x.isError)`), true);
    check('请求批准链路', '修改工作台前出现批准卡，确认后动作执行并完成');

    await setApproval('full');
    await cdp.eval(`window.__agentEvents=[]; document.querySelector('#message-input').value='AGENT_INTERACTION_TEST：请通过交互卡确认一个明确问题。'; document.querySelector('#composer').requestSubmit(); true`);
    await cdp.waitFor(`!!document.querySelector('#agent-ui-form')`, '全局交互卡');
    assert.match(await cdp.eval(`document.querySelector('#agent-ui-form').innerText`), /全局交互能力/);
    await cdp.eval(`document.querySelector('#agent-ui-form button[value="true"]').click(); true`);
    await cdp.waitFor(`window.__agentEvents.some(x=>x.type==='agent_settled')`, '交互确认后 Agent 完成');
    assert.equal(await cdp.eval(`window.__agentEvents.some(x=>x.type==='tool_execution_end'&&x.toolName==='interaction_request'&&!x.isError)`), true);
    check('全局交互卡', '交互开关开启时出现确认卡，确认结果回传 Agent 并完成');

    await cdp.eval(`document.querySelector('[data-route="settings"]').click(); true`);
    await cdp.waitFor(`!!document.querySelector('#agent-environment-setting')`, '运行环境设置');
    await cdp.eval(`{const x=document.querySelector('#agent-environment-setting');x.value='cmd';x.dispatchEvent(new Event('change'));} true`);
    await cdp.waitFor(`JSON.parse(localStorage.getItem('pi-workbench-design-v2')).settings.agentEnvironment==='cmd'`, 'CMD 环境设置生效', 10000);
    await cdp.eval(`(document.querySelector('[data-action="select-task"][data-id="bell"]') || document.querySelector('[data-route="chat"]'))?.click(); true`);
    await cdp.waitFor(`!!document.querySelector('#message-input')`, '切回任务对话');
    await sendPrompt('AGENT_CMD_TEST：执行一条 Windows CMD 命令。');
    const cmdCheck = await cdp.eval(`({tool:window.__agentEvents.some(x=>x.type==='tool_execution_end'&&x.toolName==='cmd'&&!x.isError),output:[...document.querySelectorAll('.tool-entry')].map(x=>x.textContent).join('|')})`);
    assert.equal(cmdCheck.tool, true, 'CMD 环境没有执行 cmd 工具');
    assert.match(cmdCheck.output, /PI_CMD_TEST_OK/i, 'CMD 工具没有返回命令输出');
    check('CMD 环境执行', '切换到 Windows CMD 后，Agent 通过 cmd 工具执行并显示命令输出');
    await cdp.eval(`document.querySelector('[data-route="settings"]').click(); true`);
    await cdp.waitFor(`!!document.querySelector('#agent-environment-setting')`, '再次打开运行环境设置');
    await cdp.eval(`{const x=document.querySelector('#agent-environment-setting');x.value='wsl';x.dispatchEvent(new Event('change'));} true`);
    await cdp.waitFor(`JSON.parse(localStorage.getItem('pi-workbench-design-v2')).settings.agentEnvironment==='wsl'`, 'WSL 环境设置生效', 10000);
    await cdp.eval(`(document.querySelector('[data-action="select-task"][data-id="bell"]') || document.querySelector('[data-route="chat"]'))?.click(); true`);
    await cdp.waitFor(`!!document.querySelector('#message-input')`, '切回任务对话');
    await sendPrompt('AGENT_WSL_TEST：执行一条 WSL Bash 命令。');
    const wslCheck = await cdp.eval(`({tool:window.__agentEvents.some(x=>x.type==='tool_execution_end'&&x.toolName==='bash'&&!x.isError),output:[...document.querySelectorAll('.tool-entry')].map(x=>x.textContent).join('|')})`);
    assert.equal(wslCheck.tool, true, 'WSL 环境没有执行 bash 工具');
    assert.match(wslCheck.output, /PI_WSL_TEST_OK/i, 'WSL Bash 工具没有返回命令输出');
    check('WSL 环境执行', '切换到 WSL Bash 后，Agent 通过 bash 工具执行并显示命令输出');
    process.stdout.write(JSON.stringify({ ok: true, checks, providerRequests: requests.length }, null, 2) + '\n');
  } catch (error) {
    const diagnostics = cdp?.events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded').map(event => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text || event.params.entry?.text || event.method) || [];
    const agent = await cdp?.eval(`({events:window.__agentEvents,chat:document.querySelector('#messages')?.innerText,status:document.querySelector('.run-indicator, .tool-group')?.innerText})`).catch(() => null);
    process.stderr.write(JSON.stringify({ ok: false, error: error.stack || error.message, diagnostics, agent, providerRequests: requests.length }, null, 2) + '\n');
    process.exitCode = 1;
  } finally {
    cdp?.close();
    child.kill();
    server.close();
  }
}

main();
