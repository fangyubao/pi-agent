'use strict';

// Deterministic harness test: this exercises the desktop Agent supervisor and
// Pi RPC lifecycle, not the quality of a vendor model. The first provider
// response is deliberately disconnected; the retry must rebuild the session,
// finish the same run, and expose the recovery events to the UI.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = event => { const message = JSON.parse(event.data); const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } };
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
  async waitFor(expression, label, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await this.eval(expression); if (value) return value; await pause(100); } throw new Error('等待超时：' + label); }
  close() { this.ws?.close(); }
}

function readBody(request) { return new Promise((resolve, reject) => { let body = ''; request.setEncoding('utf8'); request.on('data', chunk => body += chunk); request.on('end', () => resolve(body)); request.on('error', reject); }); }
function answer(response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.write(`data: ${JSON.stringify({ id: 'recovery-ok', object: 'chat.completion.chunk', model: 'recovery-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'RECOVERY_OK：已完成恢复并验证。' }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'recovery-ok', object: 'chat.completion.chunk', model: 'recovery-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function main() {
  let completionRequests = 0;
  const provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'recovery-test' }] })); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    await readBody(request); completionRequests += 1;
    if (completionRequests === 1) { response.socket.destroy(); return; }
    answer(response);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const profile = path.join(__dirname, '.agent-recovery-profile'); fs.rmSync(profile, { recursive: true, force: true });
  const port = provider.address().port, cdpPort = 9383;
  const electron = process.env.PI_WORKBENCH_ELECTRON || path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [__dirname, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let pages = [];
    for (let i = 0; i < 160; i++) { try { pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then(x => x.json()); if (pages.length) break; } catch {} await pause(125); }
    const page = pages.find(x => x.type === 'page' && x.url.includes('index.html')); assert(page, '没有找到 Electron 页面');
    cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
    await cdp.eval(`localStorage.clear(); location.reload(); true`);
    await cdp.waitFor(`document.readyState==='complete' && !!document.querySelector('#message-input')`, '桌面初始化');
    await cdp.eval(`window.PiProviderManager.saveConfig({provider:'openai-compatible',baseUrl:'http://127.0.0.1:${port}/v1',apiKey:'recovery-test-key',model:'recovery-test'})`);
    await cdp.eval(`window.piDesktop.agent.stop(); window.__agentEvents=[]; window.piDesktop.agent.onEvent(e=>window.__agentEvents.push(e)); document.querySelector('#message-input').value='RECOVERY_TRANSPORT_TEST：完成一个简单任务。'; document.querySelector('#composer').requestSubmit(); true`);
    await cdp.waitFor(`window.__agentEvents.some(x=>x.type==='agent_settled')`, '恢复后完成', 90000);
    const result = await cdp.eval(`(async()=>{await window.PiPersistence.flush();const stored=await window.piDesktop.storage.load();const s=stored.result.state;const task=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);return {events:window.__agentEvents.map(x=>x.type),text:document.querySelector('#messages')?.innerText||'',status:task?.messages.at(-1)?.run?.status}})()`);
    assert.ok(result.events.includes('agent_recovery_start'), '没有显示恢复开始事件');
    assert.ok(result.events.includes('agent_recovery_complete'), '没有显示恢复完成事件');
    assert.equal(result.status, 'complete', '恢复后运行没有完成');
    assert.match(result.text, /RECOVERY_OK/);
    assert.equal(completionRequests, 2, '恢复应只产生一次重试');
    process.stdout.write(JSON.stringify({ ok: true, completionRequests, events: result.events.filter(x => x.includes('recovery') || x === 'agent_settled') }, null, 2) + '\n');
  } catch (error) {
    const state = await cdp?.eval(`({events:window.__agentEvents,chat:document.querySelector('#messages')?.innerText})`).catch(() => null);
    process.stderr.write(JSON.stringify({ ok: false, error: error.stack || error.message, completionRequests, state }, null, 2) + '\n');
    process.exitCode = 1;
  } finally { cdp?.close(); child.kill(); provider.close(); }
}
main();
