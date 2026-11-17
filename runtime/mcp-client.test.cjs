'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { McpClient, McpError, resolveCommand } = require('./mcp-client.cjs');
const server = path.join(__dirname, 'fixtures', 'mcp-fixture-server.cjs');
const make = (mode = 'ok', options = {}) => new McpClient({ command: process.execPath, args: [server], env: { MODE: mode } }, { startTimeoutMs: 4000, callTimeoutMs: 1500, ...options });

test('握手、列出工具、调用工具走真实子进程', async () => {
  const client = make(); try {
    const tools = await client.start();
    assert.deepEqual(tools.map(t => t.name), ['echo', 'fail', 'slow', 'crash', 'big']);
    assert.equal(client.serverInfo.name, 'fixture');
    const result = await client.callTool('echo', { text: '你好 MCP' });
    assert.deepEqual(result, { isError: false, text: '你好 MCP' });
  } finally { client.close(); }
});

test('工具自己报错（isError）原样带回，不当作协议错误', async () => {
  const client = make(); try { await client.start(); const r = await client.callTool('fail'); assert.equal(r.isError, true); assert.match(r.text, /工具内部错误/); } finally { client.close(); }
});

test('调用不存在的工具在本地就被拒绝，不会发给服务器', async () => {
  const client = make(); try { await client.start(); await assert.rejects(() => client.callTool('rm_rf'), e => e instanceof McpError && e.code === 'UNKNOWN_TOOL'); } finally { client.close(); }
});

test('服务器启动时输出非 JSON 日志不会破坏握手', async () => {
  const client = make('noisy'); try { assert.equal((await client.start()).length, 5); } finally { client.close(); }
});

test('工具列表分页会被取全', async () => {
  const client = make('paged'); try { assert.equal((await client.start()).length, 5); } finally { client.close(); }
});

test('调用超时会报明确错误，并且之后客户端仍可用', async () => {
  const client = make('ok', { callTimeoutMs: 300 }); try {
    await client.start();
    await assert.rejects(() => client.callTool('slow'), e => e.code === 'TIMEOUT');
    assert.equal((await client.callTool('echo', { text: 'after' })).text, 'after');
  } finally { client.close(); }
});

test('握手超时、启动即崩溃、命令不存在都给出可读错误而不是挂起', async () => {
  const hang = make('hang-init', { startTimeoutMs: 400 });
  await assert.rejects(() => hang.start(), e => e.code === 'TIMEOUT'); hang.close();
  const dead = make('crash-at-start');
  await assert.rejects(() => dead.start(), e => e.code === 'EXITED'); dead.close();
  const missing = new McpClient({ command: 'definitely-not-a-real-command-xyz' }, { startTimeoutMs: 3000 });
  await assert.rejects(() => missing.start(), e => ['SPAWN_FAILED', 'EXITED'].includes(e.code)); missing.close();
});

test('调用途中服务器崩溃：挂起的请求被立即拒绝', async () => {
  const client = make(); try { await client.start(); await assert.rejects(() => client.callTool('crash'), e => e.code === 'EXITED'); } finally { client.close(); }
});

test('超长结果被截断并提示', async () => {
  const client = make(); try { await client.start(); const r = await client.callTool('big'); assert.ok(r.text.length < 61000); assert.match(r.text, /已截断/); } finally { client.close(); }
});

test('Windows 下 npx 等 .cmd 命令经 cmd /c 启动，含空格的参数被加引号', () => {
  const r = resolveCommand('npx', ['-y', '@scope/server', 'C:\My Files']);
  if (process.platform === 'win32') { assert.match(r.file, /cmd(\.exe)?$/i); assert.match(r.args.join(' '), /"C:\My Files"/); } else assert.equal(r.file, 'npx');
});
