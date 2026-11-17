'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./mcp-store.cjs');

// 假加密：能区分“明文落盘”和“加密落盘”。
const encrypt = v => 'ENC(' + Buffer.from(v).toString('base64') + ')';
const decrypt = v => Buffer.from(v.slice(4, -1), 'base64').toString();
const make = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-')); const file = path.join(dir, 'mcp.json'); return { dir, file, store: createStore({ file, encrypt, decrypt }) }; };

test('新添加的服务器默认关闭，必须手动启用', async () => {
  const { dir, store } = make(); try {
    const s = await store.save({ name: '文件', command: 'npx', args: ['-y', '@x/server'] });
    assert.equal(s.enabled, false);
    assert.equal((await store.setEnabled(s.id, true)).enabled, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('环境变量（密钥）加密落盘，界面读取只返回“已设置”，不回显明文', async () => {
  const { dir, file, store } = make(); try {
    const s = await store.save({ name: '搜索', command: 'node', env: { API_KEY: 'sk-secret-123' } });
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes('sk-secret-123'), '明文密钥不应落盘');
    assert.deepEqual(s.envKeys, [{ key: 'API_KEY', set: true }]);
    assert.ok(!JSON.stringify(await store.list()).includes('secret'));
    assert.equal((await store.resolveForLaunch(s.id)).env.API_KEY, 'sk-secret-123');    // 只有主进程启动时能解出来
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('编辑时留空密钥表示保持原值；null 表示删除', async () => {
  const { dir, store } = make(); try {
    const s = await store.save({ name: 'a', command: 'node', env: { K: 'v1' } });
    await store.save({ id: s.id, name: 'a', command: 'node', env: { K: '' } });
    assert.equal((await store.resolveForLaunch(s.id)).env.K, 'v1');
    await store.save({ id: s.id, name: 'a', command: 'node', env: { K: null } });
    assert.deepEqual((await store.list())[0].envKeys, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('修改启动命令后自动回到关闭状态，避免“改了命令仍在运行旧授权”', async () => {
  const { dir, store } = make(); try {
    const s = await store.save({ name: 'a', command: 'node', args: ['x.js'] });
    await store.setEnabled(s.id, true);
    assert.equal((await store.save({ id: s.id, name: 'a2', command: 'node', args: ['x.js'] })).enabled, true);   // 只改名字，保持启用
    assert.equal((await store.save({ id: s.id, name: 'a2', command: 'node', args: ['evil.js'] })).enabled, false); // 改了命令 → 重新关闭
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('校验：空命令、非法名称、非法环境变量名、同名、数量上限', async () => {
  const { dir, store } = make(); try {
    await assert.rejects(() => store.save({ name: 'a', command: '  ' }), /启动命令/);
    await assert.rejects(() => store.save({ name: '../x', command: 'node' }), /名称/);
    await assert.rejects(() => store.save({ name: 'a', command: 'node', env: { 'BAD KEY': 'x' } }), /环境变量名/);
    await store.save({ name: 'dup', command: 'node' });
    await assert.rejects(() => store.save({ name: 'dup', command: 'node' }), /同名/);
    for (let i = 0; i < 23; i++) await store.save({ name: 'n' + i, command: 'node' });
    await assert.rejects(() => store.save({ name: 'overflow', command: 'node' }), /最多/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('并发保存不会互相覆盖；文件损坏时当作空列表而不是崩溃', async () => {
  const { dir, file, store } = make(); try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.save({ name: 'p' + i, command: 'node' })));
    assert.equal((await store.list()).length, 8);
    fs.writeFileSync(file, '{ this is not json');
    assert.deepEqual(await store.list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('控制字符被清除，删除不存在的服务器会报错', async () => {
  const { dir, store } = make(); try {
    const s = await store.save({ name: 'ok', command: 'no\u0000de', args: ['a\nb'] });
    assert.equal(s.command, 'node'); assert.deepEqual(s.args, ['ab']);
    await assert.rejects(() => store.remove('nope'), /找不到/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
