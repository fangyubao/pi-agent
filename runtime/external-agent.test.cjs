'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ext = require('./external-agent.cjs');

// Minimal RFC 6455 WebSocket test server using only Node built-ins.
function startMockOpenClawServer(handler) {
  const frames = [];
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    const sendJson = obj => {
      const data = Buffer.from(JSON.stringify(obj), 'utf8');
      const header = data.length < 126
        ? Buffer.from([0x81, data.length])
        : Buffer.from([0x81, 126, (data.length >> 8) & 0xff, data.length & 0xff]);
      socket.write(Buffer.concat([header, data]));
    };

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf.length < offset + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buf.subarray(offset, offset + len));
        buf = buf.subarray(offset + len);
        if (opcode === 8) { socket.end(); return; }
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          frames.push(msg);
          handler({ msg, sendJson });
        } catch {}
      }
    });

    sendJson({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1', ts: Date.now() } });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, frames, close: () => new Promise(r => server.close(() => r())) })));
}

test('OpenClaw WebSocket Gateway：challenge 握手、流式 delta、会话隔离探针与不支持工作台自动识别', async () => {
  const memoryBySession = new Map();
  const mock = await startMockOpenClawServer(({ msg, sendJson }) => {
    if (msg.type === 'req' && msg.method === 'connect') {
      if (msg.params?.auth?.token !== 'secret-tok') {
        sendJson({ type: 'res', id: msg.id, error: { message: 'bad token' } });
        return;
      }
      sendJson({ type: 'res', id: msg.id, result: { ok: true } });
      return;
    }
    if (msg.type === 'req' && msg.method === 'chat.send') {
      const sk = msg.params.sessionKey;
      const txt = msg.params.message || '';
      sendJson({ type: 'res', id: msg.id, result: { runId: 'r-' + msg.id } });
      const codeMatch = txt.match(/Code is (SEC_[a-f0-9]+)/i);
      if (codeMatch) memoryBySession.set(sk, codeMatch[1]);
      let reply = 'OK';
      if (txt.includes('secret code')) reply = memoryBySession.get(sk) || 'NONE';
      else if (txt.includes('workbench_probe_ping')) reply = 'I cannot execute local MCP tools here.';
      sendJson({ type: 'event', event: 'agent', payload: { runId: 'r-' + msg.id, sessionKey: sk, stream: 'assistant', data: { delta: reply.slice(0, 2) } } });
      sendJson({ type: 'event', event: 'agent', payload: { runId: 'r-' + msg.id, sessionKey: sk, stream: 'assistant', data: { delta: reply.slice(2) } } });
      sendJson({ type: 'event', event: 'chat', payload: { runId: 'r-' + msg.id, sessionKey: sk, state: 'final', message: { content: [{ type: 'text', text: reply }] } } });
    }
  });
  try {
    const deltas = [];
    const out = await ext.openClawExchange({
      gatewayUrl: `ws://127.0.0.1:${mock.port}`,
      token: 'secret-tok',
      agentId: 'coder',
      sessionKey: 'agent:coder:main',
      prompt: 'hello openclaw',
      onDelta: d => deltas.push(d)
    });
    assert.equal(out.text, 'OK');
    assert.equal(deltas.join(''), 'OK');

    const probed = await ext.probeCapabilities({
      id: 'claw-1',
      name: 'OpenClaw Test',
      kind: 'external-agent',
      agentTransport: 'openclaw-gateway',
      baseUrl: `ws://127.0.0.1:${mock.port}`,
      apiKey: 'secret-tok',
      model: 'coder',
      models: ['coder']
    });
    assert.equal(probed.ok, true);
    assert.equal(probed.capabilities.chat, true);
    assert.equal(probed.capabilities.workflow, true);
    assert.equal(probed.capabilities.maxConcurrency, 3);
    assert.equal(probed.capabilities.workbench, false);
  } finally {
    await mock.close();
  }
});

test('本地 CLI Agent + 标准 MCP 探针：真实触发 workbench_probe_ping 才判定支持工作台', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ext-cli-test-'));
  const mcpAgent = path.join(dir, 'mcp-agent.cjs');
  const plainAgent = path.join(dir, 'plain-agent.cjs');

  fs.writeFileSync(mcpAgent, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  const m = input.match(/"nonce":"([^"]+)"/);
  if (m && process.env.PI_WORKBENCH_MCP_CONFIG) {
    const cfg = JSON.parse(fs.readFileSync(process.env.PI_WORKBENCH_MCP_CONFIG, 'utf8'));
    const srv = cfg.mcpServers['pi-workbench'];
    const child = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waitMsg = () => new Promise(res => {
      let buf = '';
      const onData = c => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\\n');
        if (nl >= 0) { child.stdout.off('data', onData); res(JSON.parse(buf.slice(0, nl))); }
      };
      child.stdout.on('data', onData);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
    await waitMsg();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workbench_probe_ping', arguments: { nonce: m[1] } } }) + '\\n');
    const r = await waitMsg();
    child.stdin.end();
    process.stdout.write(JSON.stringify({ type: 'result', result: 'DONE ' + r.result.content[0].text }) + '\\n');
    return;
  }
  const reply = input.includes('secret code') ? 'NONE' : 'OK';
  process.stdout.write(JSON.stringify({ type: 'result', result: reply }) + '\\n');
});`);

  fs.writeFileSync(plainAgent, `'use strict';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  process.stdout.write(input.includes('secret code') ? 'NONE' : 'OK');
});`);

  try {
    const withMcp = await ext.probeCapabilities({
      id: 'cli-mcp',
      name: 'CLI+MCP',
      kind: 'external-agent',
      agentTransport: 'external-cli',
      command: process.execPath,
      args: [mcpAgent],
      promptMode: 'stdin',
      mcpSupport: 'mcp-config',
      model: 'local',
      models: ['local']
    });
    assert.equal(withMcp.ok, true);
    assert.equal(withMcp.capabilities.chat, true);
    assert.equal(withMcp.capabilities.workflow, true);
    assert.equal(withMcp.capabilities.workbench, true);

    const noMcp = await ext.probeCapabilities({
      id: 'cli-plain',
      name: 'PlainCLI',
      kind: 'external-agent',
      agentTransport: 'external-cli',
      command: process.execPath,
      args: [plainAgent],
      promptMode: 'stdin',
      mcpSupport: 'none',
      model: 'local',
      models: ['local']
    });
    assert.equal(noMcp.ok, true);
    assert.equal(noMcp.capabilities.chat, true);
    assert.equal(noMcp.capabilities.workflow, true);
    assert.equal(noMcp.capabilities.workbench, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenAI 兼容 API 工具调用探测：返回 tool_calls 判支持工作台，仅回纯文本判不支持', async () => {
  const resWithTool = await ext.probeApiToolCalling(
    { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'workbench_probe_ping' } }] } }] }) }) }
  );
  assert.equal(resWithTool.ok, true);

  const resTextOnly = await ext.probeApiToolCalling(
    { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Sure!' } }] }) }) }
  );
  assert.equal(resTextOnly.ok, false);
});
