'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./mcp-store.cjs');
const { McpClient } = require('./mcp-client.cjs');
const { createPool } = require('./mcp-pool.cjs');

const fixture = path.join(__dirname, 'fixtures', 'mcp-fixture-server.cjs');
const encrypt = v => 'ENC(' + Buffer.from(v).toString('base64') + ')';
const decrypt = v => Buffer.from(v.slice(4, -1), 'base64').toString();

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-pool-'));
  const store = createStore({ file: path.join(dir, 'mcp.json'), encrypt, decrypt });
  let started = 0;
  const createClient = (launch, options) => { started++; return new McpClient(launch, { ...options, startTimeoutMs: 4000, callTimeoutMs: 1500 }); };
  const pool = createPool({ store, createClient });
  return { dir, store, pool, get started() { return started; }, cleanup() { pool.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const add = (store, name, mode = 'ok') => store.save({ name, command: process.execPath, args: [fixture], env: { MODE: mode } });

test('未启用的服务器绝不会被启动（既不列工具也不允许调用）', async () => {
  const s = setup(); try {
    await add(s.store, 'off');
    assert.deepEqual(await s.pool.listTools(), []);
    await assert.rejects(() => s.pool.call('off', 'echo', { text: 'x' }), /未启用/);
    assert.equal(s.started, 0);
  } finally { s.cleanup(); }
});

test('启用后可列出并调用工具；同一服务器只启动一次并复用', async () => {
  const s = setup(); try {
    const server = await add(s.store, 'files'); await s.store.setEnabled(server.id, true);
    const [listed] = await s.pool.listTools();
    assert.equal(listed.server, 'files'); assert.equal(listed.tools.length, 5);
    assert.equal((await s.pool.call('files', 'echo', { text: 'hi' })).text, 'hi');
    assert.equal((await s.pool.call('files', 'echo', { text: 'again' })).text, 'again');
    assert.equal(s.started, 1);
  } finally { s.cleanup(); }
});

test('并发调用同一个服务器会串行化，结果不串位', async () => {
  const s = setup(); try {
    const server = await add(s.store, 'p'); await s.store.setEnabled(server.id, true);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => s.pool.call('p', 'echo', { text: 'm' + i })));
    assert.deepEqual(results.map(r => r.text), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    assert.equal(s.started, 1);
  } finally { s.cleanup(); }
});

test('关闭开关后，下一次调用立刻被拒绝并断开旧连接', async () => {
  const s = setup(); try {
    const server = await add(s.store, 'a'); await s.store.setEnabled(server.id, true);
    await s.pool.call('a', 'echo', { text: 'x' });
    await s.store.setEnabled(server.id, false); s.pool.invalidate(server.id);
    await assert.rejects(() => s.pool.call('a', 'echo', { text: 'x' }), /未启用/);
    assert.equal(s.pool.size, 0);
  } finally { s.cleanup(); }
});

test('服务器中途崩溃：本次调用报错，下一次调用自动重新启动', async () => {
  const s = setup(); try {
    const server = await add(s.store, 'c'); await s.store.setEnabled(server.id, true);
    await assert.rejects(() => s.pool.call('c', 'crash', {}), /退出|关闭/);
    assert.equal((await s.pool.call('c', 'echo', { text: 'alive' })).text, 'alive');
    assert.equal(s.started, 2);
  } finally { s.cleanup(); }
});

test('一个服务器启动失败不影响其他服务器的工具列表', async () => {
  const s = setup(); try {
    const good = await add(s.store, 'good'); const bad = await add(s.store, 'bad', 'crash-at-start');
    await s.store.setEnabled(good.id, true); await s.store.setEnabled(bad.id, true);
    const listed = await s.pool.listTools();
    assert.equal(listed.find(x => x.server === 'good').tools.length, 5);
    assert.match(listed.find(x => x.server === 'bad').error, /退出|启动/);
  } finally { s.cleanup(); }
});

test('工具调用超时返回错误，且服务器仍可继续使用', async () => {
  const s = setup(); try {
    const server = await add(s.store, 't'); await s.store.setEnabled(server.id, true);
    await assert.rejects(() => s.pool.call('t', 'slow', {}), /超时/);
    assert.equal((await s.pool.call('t', 'echo', { text: 'ok' })).text, 'ok');
  } finally { s.cleanup(); }
});

test('调用不存在的服务器或工具会给出明确错误', async () => {
  const s = setup(); try {
    const server = await add(s.store, 'x'); await s.store.setEnabled(server.id, true);
    await assert.rejects(() => s.pool.call('nope', 'echo', {}), /没有名为/);
    await assert.rejects(() => s.pool.call('x', 'no_such_tool', {}), /没有这个工具/);
  } finally { s.cleanup(); }
});
