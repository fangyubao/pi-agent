'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

function wsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x81; h[1] = 126; h.writeUInt16BE(payload.length, 2);
    return Buffer.concat([h, payload]);
  }
  const h = Buffer.alloc(10);
  h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([h, payload]);
}

function parseWsFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) { if (pos + 2 > buf.length) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (pos + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    const need = pos + (masked ? 4 : 0) + len;
    if (need > buf.length) break;
    const mask = masked ? buf.subarray(pos, pos + 4) : null;
    const raw = Buffer.from(buf.subarray(pos + (masked ? 4 : 0), need));
    if (mask) for (let i = 0; i < raw.length; i++) raw[i] ^= mask[i % 4];
    frames.push({ opcode, text: raw.toString('utf8') });
    offset = need;
  }
  return { frames, rest: buf.subarray(offset) };
}

async function startMockOpenClaw(expectedToken = 'oc-tok-1') {
  const calls = [];
  const sessions = new Map();
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(wsFrame(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1', ts: Date.now() } })));

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseWsFrames(buf);
      buf = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode === 9) { socket.write(Buffer.from([0x8a, 0])); continue; }
        if (frame.opcode !== 1) continue;
        const msg = JSON.parse(frame.text);
        if (msg.type === 'req' && msg.method === 'connect') {
          const tok = msg.params?.auth?.token || '';
          if (expectedToken && tok !== expectedToken) {
            socket.write(wsFrame(JSON.stringify({ type: 'res', id: msg.id, ok: false, error: { message: 'token invalid' } })));
            return;
          }
          socket.write(wsFrame(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { type: 'hello-ok', protocol: 3 } })));
        } else if (msg.type === 'req' && msg.method === 'chat.send') {
          const sessionKey = String(msg.params?.sessionKey || 'main');
          const prompt = String(msg.params?.message || '');
          calls.push({ sessionKey, message: prompt });
          const prev = sessions.get(sessionKey) || [];
          prev.push(prompt);
          sessions.set(sessionKey, prev);

          const runId = 'oc-run-' + calls.length;
          socket.write(wsFrame(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { runId, status: 'started' } })));

          let reply = 'OC_PLAIN_REPLY';
          if (prompt.includes('Reply with OK.')) reply = 'OK';
          else if (prompt.includes('If no secret code')) reply = prev.some(x => x.includes('Code is SEC_')) ? 'LEAK' : 'NONE';
          else if (prompt.includes('workbench_probe_ping')) reply = 'NO_MCP_TOOL_AVAILABLE'; // intentionally ignores MCP -> workbench: false
          else if (prompt.includes('DATA_BEGIN')) {
            const hasStrong = prompt.includes('阿强') && prompt.includes('9527');
            reply = hasStrong ? 'OC_INHERITED_阿强_9527' : 'OC_MISSING_HANDOFF';
          }
          socket.write(wsFrame(JSON.stringify({ type: 'event', event: 'agent', payload: { runId, stream: 'assistant', data: { delta: reply } } })));
          socket.write(wsFrame(JSON.stringify({ type: 'event', event: 'chat', payload: { runId, sessionKey, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })));
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'ws://127.0.0.1:' + server.address().port,
    calls,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(() => r())); }
  };
}

async function startMockHttpApi() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body });
    if (req.url.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'api-model-1' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = 'API_RECEIVED_OK';
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    calls,
    close: () => new Promise(r => server.close(() => r()))
  };
}

function writeMockCliScript(dir) {
  const file = path.join(dir, 'mock-cli-agent.cjs');
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function callMcpTool(toolName, toolArgs) {
  const cfgPath = process.env.PI_WORKBENCH_MCP_CONFIG;
  if (!cfgPath) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const entry = Object.values(cfg.mcpServers || {})[0];
  if (!entry) return null;
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args || [], {
      env: { ...process.env, ...(entry.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let buf = '';
    const send = obj => child.stdin.write(JSON.stringify(obj) + '\\n');
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      for (const line of buf.split(/\\r?\\n/)) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) { child.kill(); resolve(msg.result); return; }
        } catch {}
      }
    });
    child.once('error', reject);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-cli', version: '1.0' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
    setTimeout(() => { try { child.kill(); } catch {} reject(new Error('mcp timeout')); }, 10000);
  });
}

(async () => {
  let prompt = '';
  for await (const c of process.stdin) prompt += c.toString();
  const mNonce = prompt.match(/workbench_probe_ping with \\{"nonce":"([^"]+)"\\}/);
  if (mNonce) {
    await callMcpTool('workbench_probe_ping', { nonce: mNonce[1] });
    process.stdout.write('DONE\\n');
    return;
  }
  if (prompt.includes('If no secret code')) { process.stdout.write('NONE\\n'); return; }
  if (prompt.includes('Reply with OK.') || prompt.includes('Reply P')) { process.stdout.write('OK\\n'); return; }
  if (prompt.includes('READ_WB_TOOL') && process.env.PI_WORKBENCH_MCP_CONFIG) {
    const res = await callMcpTool('workbench_action', { command: 'readDesignWorkflow', payload: {} });
    process.stdout.write('CLI_WORKBENCH_DONE:' + JSON.stringify(res?.content?.[0]?.text || '') + '\\n');
    return;
  }
  process.stdout.write('CLI_REPLY_OK\\n');
})();
`, 'utf8');
  return file;
}

test('导入外部 Agent（OpenClaw 与本地 CLI+MCP）：自动探测能力、按模式显隐下拉菜单、跨引擎继承上下文并执行工作台工具', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ext-e2e-'));
  const cliScript = writeMockCliScript(tempDir);
  const apiSrv = await startMockHttpApi();
  const ocSrv = await startMockOpenClaw('oc-tok-1');
  const profileDir = fs.mkdtempSync(path.join(ROOT, '.pset-'));
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT, '--user-data-dir=' + profileDir],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    if (await page.locator('#first-launch').isVisible().catch(() => false)) {
      await page.locator('[data-action="dismiss-first-launch"]').click();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 960));

    // 打开设置 -> 开关：显示“API 选择”下拉方便测试与验证两个下拉菜单同步过滤
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-toggles').click();
    await page.locator('#ui-toggles input[data-composer-toggle="provider"]').check({ force: true });

    // 切回 LLM 配置页：先保存一个普通 API
    await page.locator('#settings-tab-llm').click();
    await page.locator('#provider-name').fill('API 主力');
    await page.locator('#provider-url').fill(apiSrv.baseUrl);
    await page.locator('#provider-key').fill('api-key-1');
    await page.locator('#provider-manual-model').fill('api-model-1');
    await page.locator('#provider-import').click();
    await page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText(/配置已保存/, { timeout: 15000 });

    // 导入外部 Agent 1：OpenClaw Gateway（仅对话+工作流，不支持工作台 MCP）
    await page.locator('#provider-import-agent').click();
    await page.locator('#provider-manual-details > summary').click();
    await page.locator('#provider-name').fill('OpenClaw Bot');
    await page.locator('#provider-url').fill(ocSrv.url);
    await page.locator('#provider-key').fill('oc-tok-1');
    await page.locator('#provider-probe-caps').click();
    await expect(page.locator('[data-cap-key="chat"]')).toHaveClass(/ok/, { timeout: 15000 });
    await expect(page.locator('[data-cap-key="workflow"]')).toHaveClass(/ok/, { timeout: 15000 });
    await expect(page.locator('[data-cap-key="workbench"]')).toHaveClass(/off/, { timeout: 15000 });
    await page.locator('#provider-active').uncheck();
    await page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText(/配置已保存/, { timeout: 15000 });

    // 导入外部 Agent 2：本地 CLI + MCP（全能力通过，含 workbench_probe_ping 实测回环）
    await page.locator('#provider-import-agent').click();
    await page.locator('#provider-manual-details > summary').click();
    await page.locator('#provider-agent-transport').selectOption('external-cli');
    await page.locator('#provider-name').fill('CLI 全能助手');
    await page.locator('#provider-cli-command').fill(process.execPath);
    await page.locator('#provider-cli-args').fill(cliScript);
    await page.locator('#provider-active').uncheck();
    await page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(page.locator('[data-cap-key="workbench"]')).toHaveClass(/ok/, { timeout: 20000 });

    // 确认设置页模型档位里仅支持工作流的厂商出现
    const tierOptions = await page.locator('[data-tier-vendor="0"] option').allTextContents();
    expect(tierOptions).toEqual(expect.arrayContaining(['API 主力', 'OpenClaw Bot', 'CLI 全能助手']));

    // 回到聊天：基础模式下 3 个引擎都在下拉列表
    await page.locator('.task-select').first().click();
    await expect(page.locator('#composer-provider option')).toHaveText(['API 主力', 'OpenClaw Bot', 'CLI 全能助手']);
    const chatOptGroups = await page.locator('#composer-model optgroup').evaluateAll(els => els.map(e => e.label));
    expect(chatOptGroups).toEqual(['API 主力', 'OpenClaw Bot', 'CLI 全能助手']);

    // 在基础模式下切换工作流模式：OpenClaw 依然可见
    await page.locator('#task-mode').selectOption('workflow');
    await expect(page.locator('#composer-provider option')).toHaveText(['API 主力', 'OpenClaw Bot', 'CLI 全能助手']);
    await page.locator('#task-mode').selectOption('basic');

    // 第 1 轮先用 API 主力聊天（建立上下文）
    await page.locator('#composer-provider').selectOption({ label: 'API 主力' });
    await page.evaluate(() => { window.__ev = []; window.piDesktop.agent.onEvent(e => window.__ev.push(e)); });
    await page.locator('#message-input').fill('我叫阿强，暗号是9527');
    await page.locator('#composer').evaluate(f => f.requestSubmit());
    await page.waitForFunction(() => window.__ev?.some(e => e.type === 'agent_settled'), null, { timeout: 30000 });
    await expect(page.locator('.messages')).toContainText('API_RECEIVED_OK');

    // 第 2 轮在聊天框切换成 OpenClaw Bot：自动携带交接上下文
    await page.locator('#composer-provider').selectOption({ label: 'OpenClaw Bot' });
    await expect(page.locator('#toast')).toContainText('自动继承当前上下文');
    await page.evaluate(() => { window.__ev = []; });
    await page.locator('#message-input').fill('请复述我刚才告诉你的名字和暗号');
    await page.locator('#composer').evaluate(f => f.requestSubmit());
    await page.waitForFunction(() => window.__ev?.some(e => e.type === 'agent_settled'), null, { timeout: 30000 });
    await expect(page.locator('.messages')).toContainText('OC_INHERITED_阿强_9527');
    const lastOc = ocSrv.calls.at(-1);
    expect(lastOc.message).toContain('DATA_BEGIN');
    expect(lastOc.message).toContain('阿强');
    expect(lastOc.message).toContain('9527');

    // 打开工作台：不支持工作台的 OpenClaw Bot 立即从下拉菜单消失，并自动切换为兼容配置！
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('#composer-provider option')).toHaveText(['API 主力', 'CLI 全能助手'], { timeout: 10000 });
    const wbOptGroups = await page.locator('#composer-model optgroup').evaluateAll(els => els.map(e => e.label));
    expect(wbOptGroups).toEqual(['API 主力', 'CLI 全能助手']);
    const selectedText = await page.locator('#composer-provider option:checked').textContent();
    expect(['API 主力', 'CLI 全能助手']).toContain(selectedText);

    // 用具备 MCP 工作台能力的 CLI 全能助手在工作台中实际调用工作台动作
    await page.locator('#composer-provider').selectOption({ label: 'CLI 全能助手' });
    await page.evaluate(() => { window.__ev = []; });
    await page.locator('#message-input').fill('READ_WB_TOOL');
    await page.locator('#composer').evaluate(f => f.requestSubmit());
    await page.waitForFunction(() => window.__ev?.some(e => e.type === 'agent_settled'), null, { timeout: 30000 });
    await expect(page.locator('.messages')).toContainText('CLI_WORKBENCH_DONE');

    // 切回普通聊天任务：OpenClaw Bot 重新恢复显示在聊天框下拉列表里！
    await page.locator('.task-select').first().click();
    await expect(page.locator('#composer-provider option')).toHaveText(['API 主力', 'OpenClaw Bot', 'CLI 全能助手'], { timeout: 10000 });
  } finally {
    await app.close().catch(() => {});
    await apiSrv.close().catch(() => {});
    await ocSrv.close().catch(() => {});
    await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
});

test('Agent Connect MCP 自包含目录：源 Agent 仅凭读文件+MCP自主连接，桌面端自动刷新并标明工作台可用性', async () => {
  const { spawn } = require('node:child_process');
  const ocSrv = await startMockOpenClaw('oc-tok-1');
  const profileDir = fs.mkdtempSync(path.join(ROOT, '.pset-'));
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT, '--user-data-dir=' + profileDir],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  let mcpChild = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    if (await page.locator('#first-launch').isVisible().catch(() => false)) {
      await page.locator('[data-action="dismiss-first-launch"]').click();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 960));

    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-toggles').click();
    await page.locator('#ui-toggles input[data-composer-toggle="provider"]').check({ force: true });
    await page.locator('#settings-tab-llm').click();

    await page.locator('#provider-import-agent').click();
    await expect(page.locator('#provider-copy-prompt')).toBeEnabled({ timeout: 10000 });
    await expect(page.locator('#provider-pairing-status')).toContainText('本地 Connect MCP 已就绪', { timeout: 10000 });

    // 验证极简提示词指向本机 agent-connect/CONNECT.md，且完整 MCP 包已自动部署就绪
    await page.locator('#provider-prompt-preview summary').click();
    const promptText = await page.locator('#provider-pairing-prompt-text').inputValue();
    expect(promptText).toContain('CONNECT.md');
    expect(promptText.split('\n').length).toBeLessThanOrEqual(6);

    const connectDir = path.join(profileDir, 'agent-connect');
    expect(fs.existsSync(path.join(connectDir, 'CONNECT.md'))).toBe(true);
    expect(fs.existsSync(path.join(connectDir, 'pairing.json'))).toBe(true);
    expect(fs.existsSync(path.join(connectDir, 'mcp-config.json'))).toBe(true);
    expect(fs.existsSync(path.join(connectDir, 'mcp-server.cjs'))).toBe(true);

    // 模拟外部源 Agent 读取 mcp-config.json 并启动本地 Connect MCP Server
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(connectDir, 'mcp-config.json'), 'utf8'));
    const entry = mcpCfg.mcpServers['pi-workbench-connect'];
    mcpChild = spawn(entry.command, entry.args, {
      env: { ...process.env, ...(entry.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const pendingRpc = new Map();
    let rpcBuf = '';
    mcpChild.stdout.on('data', chunk => {
      rpcBuf += chunk.toString();
      let nl;
      while ((nl = rpcBuf.indexOf('\n')) >= 0) {
        const line = rpcBuf.slice(0, nl).trim();
        rpcBuf = rpcBuf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (pendingRpc.has(msg.id)) {
          const resolve = pendingRpc.get(msg.id);
          pendingRpc.delete(msg.id);
          resolve(msg);
        }
      }
    });
    const callRpc = (method, params) => new Promise((resolve, reject) => {
      const id = 'e2e_' + Math.random().toString(36).slice(2, 8);
      pendingRpc.set(id, resolve);
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pendingRpc.delete(id)) reject(new Error('MCP RPC timeout: ' + method)); }, 15000);
    });

    await callRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mock-source-agent', version: '1.0' } });

    // 前置判断：若不支持任何本地访问会被过滤；支持则通过 pi_workbench_register_agent 自主接入
    const compatNo = await callRpc('tools/call', { name: 'pi_workbench_check_compatibility', arguments: { hasMcp: false, hasShellOrHttp: false, hasDirectEntry: false } });
    expect(JSON.parse(compatNo.result.content[0].text).eligible).toBe(false);

    // 场景 A：源 Agent 上报 OpenClaw（不支持工作台） -> 桌面端不点任何按钮自动刷新并标明“工作台：不可用 ✕”
    await callRpc('tools/call', {
      name: 'pi_workbench_register_agent',
      arguments: { name: '自主OpenClaw', agentTransport: 'openclaw-gateway', baseUrl: ocSrv.url, apiKey: 'oc-tok-1', models: ['main'] }
    });
    await expect(page.locator('#provider-pairing-status')).toContainText('已连入：自主OpenClaw', { timeout: 15000 });
    await expect(page.locator('#provider-pairing-status')).toContainText('工作台：不可用', { timeout: 10000 });
    await expect(page.locator('[data-cap-key="workbench"]')).toHaveClass(/off/);

    // 场景 B：第二个源 Agent 接入 MCP 在线接力（支持工作台） -> 自动刷新标明“工作台：可用 ✓”并在工作台接力执行
    await page.locator('#provider-import-agent').click();
    const relayReg = await callRpc('tools/call', {
      name: 'pi_workbench_register_agent',
      arguments: { name: 'WorkBuddy接力', agentTransport: 'mcp-relay', models: ['relay-main'] }
    });
    const relayProfileId = JSON.parse(relayReg.result.content[0].text).profileId;
    const reportedModels=['wb-model-a','wb-model-b','wb-model-c','wb-model-d','wb-model-e'];
    const update=await callRpc('tools/call',{name:'pi_workbench_update_models',arguments:{profileId:relayProfileId,models:reportedModels}});
    expect(JSON.parse(update.result.content[0].text).count).toBe(5);
    await expect(page.locator('[data-model-slot="0"] option')).toHaveText(['不启用',...reportedModels]);
    await page.locator('[data-model-slot="0"]').selectOption('wb-model-e');
    await page.locator('#provider-form').evaluate(f=>f.requestSubmit());
    await expect(page.locator('#provider-status')).toContainText('配置已保存');
    const savedProfile=await page.evaluate(async id=>(await window.piDesktop.provider.getConfig()).profiles.find(p=>p.id===id),relayProfileId);
    expect(savedProfile.ephemeral).toBe(true);
    expect(savedProfile.discoveredModels).toEqual(reportedModels);
    expect(savedProfile.model).toBe('wb-model-e');
    const diskConfig = JSON.parse(fs.readFileSync(path.join(profileDir, 'provider-config.json'), 'utf8'));
    expect(diskConfig.profiles.some(p => p.id === relayProfileId)).toBe(false);
    expect(diskConfig.profiles.some(p => p.name === '自主OpenClaw')).toBe(true);
    await expect(page.locator('#provider-pairing-status')).toContainText('已连入：WorkBuddy接力', { timeout: 15000 });
    await expect(page.locator('#provider-pairing-status')).toContainText('工作台：可用', { timeout: 10000 });
    await expect(page.locator('[data-cap-key="workbench"]')).toHaveClass(/ok/);

    // 切到聊天再打开工作台：不支持工作台的“自主OpenClaw”自动隐藏，“WorkBuddy接力”可用且在同连接完成工作台动作
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('#composer-provider option')).toHaveText(['WorkBuddy接力'], { timeout: 10000 });

    // 后台模拟源 MCP Agent 持续轮询接单 + 调用 workbench_action + 提交结果
    let workerActive = true;
    const workerLoop = (async () => {
      while (workerActive) {
        const res = await callRpc('tools/call', { name: 'pi_workbench_await_task', arguments: { profileId: relayProfileId, timeoutMs: 5000 } }).catch(() => null);
        if (!res) break;
        const data = JSON.parse(res.result.content[0].text);
        if (!data.idle && data.task) {
          expect(data.task.model).toBe('wb-model-e');
          const wbRes = await callRpc('tools/call', { name: 'workbench_action', arguments: { command: 'readDesignWorkflow', payload: {} } });
          await callRpc('tools/call', {
            name: 'pi_workbench_submit_result',
            arguments: { profileId: relayProfileId, requestId: data.task.requestId, text: 'RELAY_WB_OK:' + wbRes.result.content[0].text }
          });
          break;
        }
      }
    })();

    await page.evaluate(() => { window.__ev = []; window.piDesktop.agent.onEvent(e => window.__ev.push(e)); });
    await page.locator('#message-input').fill('用MCP接力读取工作台');
    await page.locator('#composer').evaluate(f => f.requestSubmit());
    await page.waitForFunction(() => window.__ev?.some(e => e.type === 'agent_settled'), null, { timeout: 30000 });
    workerActive = false;
    await workerLoop;
    await expect(page.locator('.messages')).toContainText('RELAY_WB_OK:');

    // 验证设置页勾选批量删除外部 Agent
    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-llm').click();
    await page.locator('#provider-select-ext').click();
    await expect(page.locator('#provider-delete-selected')).toContainText('删除勾选（1）');
    await page.locator('#provider-delete-selected').click();
    await expect(page.locator('.provider-item')).toHaveCount(1);
    await expect(page.locator('.provider-item-name')).toContainText('WorkBuddy接力');
  } finally {
    mcpChild?.kill();
    await app.close().catch(() => {});
    await ocSrv.close().catch(() => {});
    await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
});
