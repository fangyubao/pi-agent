'use strict';
// 测试用的最小 MCP 服务器（stdio）。行为由环境变量 MODE 控制，用来制造各种故障。
const readline = require('node:readline');
const mode = process.env.MODE || 'ok';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
if (mode === 'noisy') process.stdout.write('starting up (not json)\n');
if (mode === 'crash-at-start') process.exit(3);
const tools = [
  { name: 'echo', description: '原样返回 text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: '总是返回工具错误', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: '很慢', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: '调用时崩溃', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: '返回超长文本', inputSchema: { type: 'object', properties: {} } }
];
readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return mode === 'hang-init' ? undefined : send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0.0.1' } } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    if (mode === 'paged' && !msg.params?.cursor) return send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: mode === 'paged' ? tools.slice(2) : tools } });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'echo') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args?.text ?? '') }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: '工具内部错误' }] } });
    if (name === 'slow') return undefined;
    if (name === 'crash') process.exit(9);
    if (name === 'big') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x'.repeat(200000) }] } });
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: '未知工具' } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
