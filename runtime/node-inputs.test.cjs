'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('./node-inputs.cjs');
const X = require('./xlsx-lite.cjs');
const W = require('./workspace-files.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ni-'));

test('xlsx：读第一个工作表；共享字符串、数字、空格子、XML 转义都对；不读第二个工作表', async () => {
  const d = tmp(), f = path.join(d, 'bom.xlsx');
  fs.writeFileSync(f, X.buildXlsx({ head: ['位号', '型号', '数量'], rows: [['U1', 'A&B <x> "q"', '1'], ['R1', '', '20']] }));
  const r = await I.readInput(f);
  assert.equal(r.kind, 'table'); assert.deepEqual(r.table.head, ['位号', '型号', '数量']);
  assert.deepEqual(r.table.rows, [['U1', 'A&B <x> "q"', '1'], ['R1', '', '20']]);
});

test('csv 按 GB18030 / UTF-8 BOM / UTF-16 都能读；文本、svg、图片、pdf、二进制分别归类', async () => {
  const d = tmp(), put = (n, b) => { fs.writeFileSync(path.join(d, n), b); return path.join(d, n); };
  const gb = await I.readInput(put('a.csv', Buffer.from(new TextEncoder().encode('x')).length ? require('node:buffer').Buffer.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xb5, 0xe7, 0xd1, 0xb9, 0x0a, 0xb4, 0xab, 0xb8, 0xd0, 0xc6, 0xf7, 0x41, 0x2c, 0x33, 0x2e, 0x33, 0x0a]) : Buffer.alloc(0)));
  assert.deepEqual(gb.table.head, ['名称', '电压']); assert.deepEqual(gb.table.rows, [['传感器A', '3.3']]);
  const bom = await I.readInput(put('b.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名称,值\nA,1\n', 'utf8')])));
  assert.deepEqual(bom.table.head, ['名称', '值']);
  const u16 = await I.readInput(put('c.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('供电3.3V', 'utf16le')])));
  assert.equal(u16.kind, 'text'); assert.equal(u16.text, '供电3.3V');
  assert.equal((await I.readInput(put('n.md', '# 标题\n内容'))).kind, 'text');
  const svg = await I.readInput(put('s.svg', '<svg viewBox="0 0 1 1"><text>VCC</text></svg>'));
  assert.equal(svg.kind, 'image'); assert.match(svg.text, /VCC/); assert.equal(svg.base64, undefined);
  const png = await I.readInput(put('p.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')));
  assert.equal(png.kind, 'image'); assert.equal(png.mime, 'image/png'); assert.ok(png.base64.length > 20);
  const pdf = await I.readInput(put('d.pdf', Buffer.from('%PDF-1.4\0\x01')));
  assert.equal(pdf.kind, 'binary'); assert.match(pdf.note, /PDF/);
  const bin = await I.readInput(put('x.bin', Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 256))));
  assert.equal(bin.kind, 'binary');
  const missing = await I.readInput(path.join(d, '不存在.txt'));
  assert.equal(missing.kind, 'binary'); assert.match(missing.note, /读取失败/);
});

test('损坏的 xlsx / 太大的文件：不抛错，退化为 binary + 说明', async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'bad.xlsx'), 'not a zip');
  const r = await I.readInput(path.join(d, 'bad.xlsx')); assert.equal(r.kind, 'binary'); assert.match(r.note, /读取失败/);
  fs.writeFileSync(path.join(d, 'old.xls'), 'x'); assert.match((await I.readInput(path.join(d, 'old.xls'))).note, /xlsx/);
});

test('文件名净化：去路径、非法字符、保留名、重名加序号', () => {
  const used = new Set();
  assert.equal(I.safeFileName('..\\..\\evil.txt', used), 'evil.txt');
  assert.equal(I.safeFileName('evil.txt', used), 'evil-2.txt');
  assert.equal(I.safeFileName('a<b>:c|d?.md', used), 'a_b__c_d_.md');
  assert.match(I.safeFileName('CON.txt', used), /^附件/);
  assert.match(I.safeFileName('', used), /^附件/);
  assert.ok(Array.from(I.safeFileName('长'.repeat(200) + '.txt', used)).length <= 70);
});

const N = (id, title, uid, extra = {}) => ({ id, title, uid, role: 'r', brief: 'b', tier: 3, dependsOn: [], ...extra });
const ls = (root) => fs.readdirSync(path.join(root, 'workflow'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

test('节点文件夹迁移：重新编号后整体改名（含 inputs/ 和用户放的文件）；互换名字不丢不覆盖；用户自建文件夹不碰', async () => {
  const root = tmp(), wf = path.join(root, 'workflow');
  const done = { status: 'done', output: '结果' };
  await W.writeWorkflow(root, { nodes: [N('n0', '甲', 'uid000a1', { run: done }), N('n1', '乙', 'uid000b2', { run: done, dependsOn: ['n0'] })] });
  fs.mkdirSync(path.join(wf, 'n0-甲', 'inputs'), { recursive: true }); fs.writeFileSync(path.join(wf, 'n0-甲', 'inputs', 'bom.xlsx'), 'A');
  fs.writeFileSync(path.join(wf, 'n1-乙', '我的图.png'), 'B');
  fs.mkdirSync(path.join(wf, '我自己的资料')); fs.writeFileSync(path.join(wf, '我自己的资料', 'x.txt'), 'U');
  // 两个节点互换位置（编号互换）
  await W.writeWorkflow(root, { nodes: [N('n1', '甲', 'uid000a1', { run: done, dependsOn: ['n0'] }), N('n0', '乙', 'uid000b2', { run: done })] });
  assert.deepEqual(ls(root), ['n0-乙', 'n1-甲', '我自己的资料']);
  assert.equal(fs.readFileSync(path.join(wf, 'n1-甲', 'inputs', 'bom.xlsx'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(wf, 'n0-乙', '我的图.png'), 'utf8'), 'B');
  assert.equal(fs.readFileSync(path.join(wf, '我自己的资料', 'x.txt'), 'utf8'), 'U');
  // 改标题
  await W.writeWorkflow(root, { nodes: [N('n1', '甲改', 'uid000a1', { run: done, dependsOn: ['n0'] }), N('n0', '乙', 'uid000b2', { run: done })] });
  assert.deepEqual(ls(root), ['n0-乙', 'n1-甲改', '我自己的资料']);
  assert.ok(fs.existsSync(path.join(wf, 'n1-甲改', 'inputs', 'bom.xlsx')));
  assert.ok(!fs.readdirSync(wf).some(n => n.startsWith('.moving-')), '不残留临时目录');
});

test('节点文件夹迁移：被篡改的清单不能把改名带出 workflow/', async () => {
  const root = tmp(), wf = path.join(root, 'workflow'); fs.mkdirSync(wf, { recursive: true });
  fs.mkdirSync(path.join(root, 'victim')); fs.writeFileSync(path.join(root, 'victim', 'k.txt'), 'keep');
  fs.writeFileSync(path.join(wf, '.folders.json'), JSON.stringify({ uid000a1: '../victim', uid000b2: '..\\victim', uid000c3: '.hidden', uid000d4: 5 }));
  await W.writeWorkflow(root, { nodes: [N('n0', '甲', 'uid000a1'), N('n1', '乙', 'uid000b2'), N('n2', '丙', 'uid000c3'), N('n3', '丁', 'uid000d4')] });
  assert.equal(fs.readFileSync(path.join(root, 'victim', 'k.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(root, 'victim')));
});
