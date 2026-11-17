'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectPackage, copyPackage } = require('./workbench-package.cjs');

const manifest = (extra = {}) => ({ protocolVersion: '1.0', id: 'demo', name: '演示', version: '1.0.0', ui: { entry: 'index.html' }, server: { entry: 'index.cjs', runtime: 'node' }, state: { schema: 'demo.v1' }, actions: [{ name: 'readState', access: 'read' }], ...extra });
function make(files = {}, manifestExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-'));
  const all = { 'manifest.json': JSON.stringify(manifest(manifestExtra)), 'ui/index.html': '<!doctype html><p>x</p>', 'server/index.cjs': "module.exports={dispatch:async()=>({})};", 'tests/a.test.cjs': '', ...files };
  for (const [rel, content] of Object.entries(all)) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const levels = r => r.issues.map(i => i.level + ':' + i.text);

test('合规的包通过检查', async () => {
  const p = make(); try { const r = await inspectPackage(p.dir, { requireTests: true }); assert.equal(r.ok, true, levels(r).join('\n')); assert.equal(r.serverEntry, 'index.cjs'); } finally { p.done(); }
});

test('传输层入口被识别并自动修正为 index.cjs，而不是放行也不是报废', async () => {
  const p = make({ 'server/transport/stdio.cjs': 'process.stdin.on("data",()=>{})' }, { server: { entry: 'transport/stdio.cjs', runtime: 'node' } });
  try { const r = await inspectPackage(p.dir); assert.equal(r.ok, true); assert.equal(r.serverEntry, 'index.cjs'); assert.ok(r.issues.some(i => /修正为/.test(i.text))); } finally { p.done(); }
});

test('找不到任何可加载后端入口时是错误，并说明原因', async () => {
  const p = make({}, { server: { entry: 'missing.cjs', runtime: 'node' } }); fs.rmSync(path.join(p.dir, 'server/index.cjs'));
  try { const r = await inspectPackage(p.dir); assert.equal(r.ok, false); assert.ok(r.issues.some(i => /找不到可被宿主加载的后端入口/.test(i.text))); } finally { p.done(); }
});

test('manifest 缺失、不是 JSON、字段缺失都给出可读错误', async () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-')); try { assert.match((await inspectPackage(none)).issues[0].text, /manifest\.json/); } finally { fs.rmSync(none, { recursive: true }); }
  const bad = make({ 'manifest.json': '{ not json' }); try { assert.match((await inspectPackage(bad.dir)).issues[0].text, /不是有效 JSON/); } finally { bad.done(); }
  const noName = make({ 'manifest.json': JSON.stringify({ ...manifest(), name: '' }) }); try { assert.match((await inspectPackage(noName.dir)).issues[0].text, /name/); } finally { noName.done(); }
  assert.match((await inspectPackage(path.join(os.tmpdir(), 'definitely-not-here-xyz'))).issues[0].text, /目录不存在/);
});

test('界面入口不存在、没有声明任何动作都是错误', async () => {
  const a = make({}, { ui: { entry: 'nope.html' } }); try { assert.ok(levels(await inspectPackage(a.dir)).some(x => /error:界面入口不存在/.test(x))); } finally { a.done(); }
  const b = make({}, { actions: [] }); try { assert.ok(levels(await inspectPackage(b.dir)).some(x => /error:manifest 没有声明任何动作/.test(x))); } finally { b.done(); }
});

test('ui.entry / server.entry 用 .. 越出包目录会被拒绝', async () => {
  const a = make({}, { ui: { entry: '../../manifest.json' } }); try { const r = await inspectPackage(a.dir); assert.equal(r.ok, false); assert.match(r.issues[0].text, /越界/); } finally { a.done(); }
});

test('符号链接、过深目录、超大文件、文件过多都会被拒绝', async () => {
  const link = make(); try {
    try { fs.symlinkSync(os.tmpdir(), path.join(link.dir, 'ui', 'escape'), 'junction'); } catch { return; }       // 没权限创建链接的环境跳过
    const r = await inspectPackage(link.dir); assert.equal(r.ok, false); assert.ok(r.issues.some(i => /符号链接/.test(i.text)));
  } finally { link.done(); }
  const deep = make({ 'ui/a/b/c/d/e/f/g/h/i/j.txt': 'x' }); try { assert.ok((await inspectPackage(deep.dir)).issues.some(i => /层级过深/.test(i.text))); } finally { deep.done(); }
  const big = make({ 'ui/big.json': 'x'.repeat(4 * 1024 * 1024 + 1) }); try { assert.ok((await inspectPackage(big.dir)).issues.some(i => /文件过大/.test(i.text))); } finally { big.done(); }
  const many = make(Object.fromEntries(Array.from({ length: 401 }, (_, i) => ['ui/f' + i + '.txt', 'x']))); try { assert.ok((await inspectPackage(many.dir)).issues.some(i => /文件数量过多/.test(i.text))); } finally { many.done(); }
});

test('危险写法被标出：后端引用 electron 与删除绝对路径是错误；启动程序、联网、eval 是警告', async () => {
  const p = make({ 'server/index.cjs': "const {app}=require('electron');const fs=require('fs');fs.rmSync('C:/Users',{});const cp=require('child_process');cp.spawn('x');fetch('https://evil.example');eval('1');process.exit(1);module.exports={dispatch(){}}" });
  try {
    const r = await inspectPackage(p.dir); const l = levels(r).join('\n');
    assert.equal(r.ok, false);
    assert.match(l, /error:server\/index\.cjs：引用了 Electron/); assert.match(l, /error:server\/index\.cjs：会删除绝对路径上的文件/);
    assert.match(l, /warn:server\/index\.cjs：会启动其他程序/); assert.match(l, /warn:server\/index\.cjs：会访问网络/); assert.match(l, /warn:server\/index\.cjs：使用了 eval/); assert.match(l, /warn:server\/index\.cjs：会结束进程/);
  } finally { p.done(); }
});

test('测试文件里的危险写法不算（宿主不运行测试）；node_modules 与隐藏目录不被打包', async () => {
  const p = make({ 'tests/x.test.cjs': "require('child_process').spawn('node')", 'node_modules/evil/index.js': "require('electron')", '.git/config': 'x' });
  try {
    const r = await inspectPackage(p.dir); assert.equal(r.ok, true, levels(r).join('\n')); assert.ok(!levels(r).some(x => /child_process|electron/.test(x)));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-out-'));
    try { await copyPackage(p.dir, out, { manifest: r.manifest, serverEntry: r.serverEntry }); assert.ok(!fs.existsSync(path.join(out, 'node_modules'))); assert.ok(!fs.existsSync(path.join(out, '.git'))); assert.ok(fs.existsSync(path.join(out, 'server/index.cjs'))); } finally { fs.rmSync(out, { recursive: true, force: true }); }
  } finally { p.done(); }
});

test('复制后 manifest 被规范化（入口修正），并写入来源记录', async () => {
  const p = make({ 'server/transport/stdio.cjs': 'x' }, { server: { entry: 'transport/stdio.cjs', runtime: 'node' } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-out-'));
  try {
    const r = await inspectPackage(p.dir); await copyPackage(p.dir, out, { manifest: r.manifest, serverEntry: r.serverEntry, source: { kind: 'import', from: 'x.zip' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).server.entry, 'index.cjs');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, '.pi-package.json'), 'utf8')).source.kind, 'import');
  } finally { p.done(); fs.rmSync(out, { recursive: true, force: true }); }
});
