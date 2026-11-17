'use strict';
// 标准 stdio MCP Server（JSON-RPC 2.0），将桌面端 workbenchBridge 与能力探针暴露给外部 Agent CLI / MCP 客户端。
const net = require('node:net');
const http = require('node:http');

const BRIDGE_PORT = Number(process.env.PI_WORKBENCH_BRIDGE_PORT || 0);
const BRIDGE_TOKEN = String(process.env.PI_WORKBENCH_BRIDGE_TOKEN || '');
const APPROVAL_MODE = process.env.PI_WORKBENCH_APPROVAL_MODE === 'full' ? 'full' : 'ask';
const PROBE_PORT = Number(process.env.PI_WORKBENCH_PROBE_PORT || 0);
const PROBE_TOKEN = String(process.env.PI_WORKBENCH_PROBE_TOKEN || '');

function callBridge(command, payload = {}) {
  if (!BRIDGE_PORT || !BRIDGE_TOKEN) {
    return Promise.reject(new Error('工作台桥接未启动'));
  }
  return new Promise((resolve, reject) => {
    const id = 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const socket = net.createConnection({ host: '127.0.0.1', port: BRIDGE_PORT }, () => {
      socket.write(JSON.stringify({ id, token: BRIDGE_TOKEN, command, payload }) + '\n');
    });
    let buf = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(val);
    };
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, idx));
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || '工作台桥接调用失败'));
      } catch (err) {
        finish(reject, err);
      }
    });
    socket.on('error', err => finish(reject, err));
  });
}

function reportProbe(nonce) {
  if (!PROBE_PORT || !PROBE_TOKEN) {
    return Promise.reject(new Error('未处于能力探针会话'));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token: PROBE_TOKEN, nonce: String(nonce || '') });
    const req = http.request({
      host: '127.0.0.1',
      port: PROBE_PORT,
      path: '/probe-ping',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, nonce: String(nonce || '') });
        else reject(new Error(data || 'Probe rejected'));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function listTools() {
  const tools = [];
  if (PROBE_PORT) {
    tools.push({
      name: 'workbench_probe_ping',
      description: 'Read-only capability verification probe. Echoes the provided nonce back to the workbench host.',
      inputSchema: {
        type: 'object',
        properties: { nonce: { type: 'string', description: 'Verification nonce from prompt' } },
        required: ['nonce'],
        additionalProperties: false
      }
    });
  }
  if (BRIDGE_PORT) {
    tools.push(
      {
        name: 'workbench_action',
        description: '读取或操作 Pi Workbench 当前打开的本地工作台（inspectWorkbenchRuntime、scaffoldWorkbench、startWorkbenchTrial、stopWorkbenchTrial、inspectWorkbenchUI、actWorkbenchUI、captureWorkbenchUI、callWorkbenchBackend、readWorkbenchEvents、verifyWorkbench 等）。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '工作台动作名' },
            payload: { type: 'object', additionalProperties: true }
          },
          required: ['command'],
          additionalProperties: false
        }
      },
      {
        name: 'read_task_context',
        description: '读取当前任务的工作目录、目标、工作台状态等只读上下文。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'memory_proposal',
        description: '提交一条待用户确认的候选记忆。',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['task', 'project'] },
            lifespan: { type: 'string', enum: ['long', 'short'] },
            kind: { type: 'string', enum: ['core', 'continuation', 'decision', 'experience', 'correction', 'preference', 'constraint', 'fact'] },
            content: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['scope', 'lifespan', 'kind', 'content'],
          additionalProperties: false
        }
      }
    );
  }
  return tools;
}

async function callTool(name, args = {}) {
  if (name === 'workbench_probe_ping') {
    const res = await reportProbe(args?.nonce);
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  }
  if (name === 'read_task_context') {
    const res = await callBridge('readTaskContext', args || {});
    return { content: [{ type: 'text', text: JSON.stringify(res ?? null) }] };
  }
  if (name === 'memory_proposal') {
    const res = await callBridge('__memory_proposal__', args || {});
    return { content: [{ type: 'text', text: JSON.stringify(res ?? null) }] };
  }
  if (name === 'workbench_action') {
    const command = String(args?.command || '').trim();
    const payload = args?.payload && typeof args.payload === 'object' ? args.payload : {};
    const access = await callBridge('__workbench_access__', { command, payload });
    if (APPROVAL_MODE !== 'full' && (access?.requiresConfirmation || access?.access !== 'read')) {
      return {
        isError: true,
        content: [{ type: 'text', text: `当前处于「请求批准」模式，外部 MCP 通道未自动批准写操作：${command}。请在聊天底部切为「完全批准」后重试。` }]
      };
    }
    const res = await callBridge(command, payload);
    const content = [{ type: 'text', text: JSON.stringify(res?.image ? { ...res, image: undefined } : res ?? null) }];
    if (res?.image?.data && res.image.mimeType === 'image/png') {
      content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
    }
    return { isError: res?.ok === false, content };
  }
  return { isError: true, content: [{ type: 'text', text: `未知 MCP 工具：${name}` }] };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (!method) return;
  if (method === 'notifications/initialized' || id === undefined) return;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pi-workbench-bridge', version: '1.0.0' }
        }
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
      return;
    }
    if (method === 'tools/call') {
      const result = await callTool(String(params?.name || ''), params?.arguments || {});
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] } });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.length) {
    const headerMatch = buffer.match(/^Content-Length:\s*(\d+)\r?\n(?:\r?\n|[^\n]*\r?\n\r?\n)/i);
    if (headerMatch) {
      const len = Number(headerMatch[1]);
      const start = headerMatch[0].length;
      if (buffer.length < start + len) break;
      const body = buffer.slice(start, start + len);
      buffer = buffer.slice(start + len);
      try { void handleMessage(JSON.parse(body)); } catch {}
      continue;
    }
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { void handleMessage(JSON.parse(line)); } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));
