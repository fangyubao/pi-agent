'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('./workspace-files.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ws-'));

test('默认路径：文档/Pi Workbench/项目/任务；名字里的非法字符被替换', () => {
  assert.equal(W.defaultPath('C:\\Docs', '量子:研究', 'a/b?'), path.join('C:\\Docs', 'Pi Workbench', '量子_研究', 'a_b_'));
  assert.equal(W.defaultPath('C:\\Docs', 'P', ''), path.join('C:\\Docs', 'Pi Workbench', 'P'));
  assert.equal(W.safe('...'), '未命名');
});
test('ensureDir：创建不存在的文件夹；相对路径与 asar 内路径被拒绝', async () => {
  const d = path.join(tmp(), 'a', 'b'); assert.equal(await W.ensureDir(d), path.resolve(d)); assert.ok(fs.statSync(d).isDirectory());
  await assert.rejects(W.ensureDir('relative/dir'), /完整路径/); await assert.rejects(W.ensureDir(path.join(tmp(), 'x.asar', 'y')), /完整路径/);
});
const N = (id, title, extra = {}) => ({ id, title, role: '分析师', brief: '做' + id, tier: 3, dependsOn: [], model: null, run: null, ...extra });
const nodeFiles = root => { const base = path.join(root, 'workflow'), out = []; for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) for (const f of fs.readdirSync(path.join(base, d.name))) if (!f.startsWith('.')) out.push(d.name + '/' + f); return out.sort(); };
test('工作流文件：固定写在 <工作路径>/workflow/ 下，含 plan.md、plan.json 和每个已运行节点的结果', async () => {
  const root = tmp(), state = { goal: '选型', revision: 3, nodes: [N('n1', '调研', { run: { status: 'done', output: '结论A' } }), N('n2', '对比/风险', { dependsOn: ['n1'] })] };
  const r = await W.writeWorkflow(root, state);
  assert.equal(r.dir, path.join(root, 'workflow'));
  assert.ok(fs.readFileSync(path.join(r.dir, 'plan.md'), 'utf8').includes('## n2 · 对比/风险'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'plan.json'), 'utf8')).nodes[0].run, undefined);
  assert.ok(fs.readFileSync(path.join(r.dir, 'n1-调研', '结果.md'), 'utf8').includes('结论A'));
  assert.deepEqual(nodeFiles(root), ['n1-调研/结果.md']);                 // 每个节点一个文件夹
  assert.deepEqual(fs.readdirSync(root), ['workflow']);
});
test('工作流文件：节点被删或结果清空后旧结果文件被移除；过期结果带说明', async () => {
  const root = tmp();
  await W.writeWorkflow(root, { nodes: [N('n1', 'A', { run: { status: 'done', output: 'x' } }), N('n2', 'B', { run: { status: 'stale', output: 'y' } })] });
  assert.match(fs.readFileSync(path.join(root, 'workflow', 'n2-B', '结果.md'), 'utf8'), /旧结果/);
  await W.writeWorkflow(root, { nodes: [N('n2', 'B', { run: { status: 'stale', output: 'y' } })] });
  assert.deepEqual(nodeFiles(root), ['n2-B/结果.md']);                    // n1 没了 → 它的文件夹连同空目录一起清掉
});
test('用到的文件夹：工作路径排第一；工具读写过的文件所在文件夹去重加入；命令行文本不算路径', () => {
  const ws = path.resolve('C:\\work\\proj');
  const msgs = [{ run: { steps: [
    { kind: 'tool', label: '读取文件', target: 'src/a.js' }, { kind: 'tool', label: '写入文件', target: 'src/b.js' },
    { kind: 'tool', label: '读取文件', target: 'D:\\data\\in.csv' }, { kind: 'tool', label: '命令', target: 'npm test --silent' }, { kind: 'text', text: 'hi' }] } }];
  const list = W.foldersUsed(ws, msgs);
  assert.deepEqual(list.map(x => x.path), [ws, path.join(ws, 'src'), path.resolve('D:\\data')]);
  assert.equal(list[0].primary, true); assert.equal(list[1].primary, false); assert.match(list[1].why, /读取文件/);
  assert.deepEqual(W.foldersUsed('', []), []);
});

test('找回旧聊天的文件夹：取历史运行里记录的 cwd，排除程序自己的目录，按最近使用排序并计数', () => {
  const app = path.resolve('C:\\app\\pi'), data = path.resolve('C:\\data\\workspace');
  const msgs = [{ run: { cwd: path.resolve('D:\\proj\\a') } }, { run: { cwd: app } }, { run: { cwd: data } }, { run: { cwd: path.resolve('D:\\proj\\b') } }, { run: { cwd: path.resolve('D:\\PROJ\\A') } }, { run: {} }, { run: { cwd: 'relative' } }, null];
  const r = W.recoverFolders(msgs, [app, data]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.count), [2, 1]);                          // A 用了两次（大小写不同算同一个），B 一次
  assert.equal(r[0].path.toLowerCase(), path.resolve('D:\\proj\\a').toLowerCase());
  assert.deepEqual(W.recoverFolders([], [app]), []);
  assert.equal(W.recoverFolders([{ run: { cwd: path.join(app, 'mine') } }], [app]).length, 1);   // 程序目录里用户自建的子文件夹要保留
});

test('右键菜单的路径检查：相对路径按所在目录解析；只允许工作文件夹与聊天用到的文件夹之内；拒绝越界、网络路径、控制字符', () => {
  const ws = path.resolve('C:\\work\\proj'), other = path.resolve('D:\\data');
  assert.deepEqual(W.resolveTarget('src/a.js', ws, [ws]), { ok: true, path: path.join(ws, 'src', 'a.js') });
  assert.equal(W.resolveTarget(path.join(other, 'in.csv'), ws, [ws, other]).ok, true);
  assert.equal(W.resolveTarget(ws, ws, [ws]).ok, true);                                                       // 根本身
  assert.equal(W.resolveTarget('..\\secret.txt', ws, [ws]).ok, false);                                       // 越界
  assert.equal(W.resolveTarget(path.resolve('C:\\work\\proj-evil\\x'), ws, [ws]).ok, false);                  // 前缀相同的兄弟目录
  assert.equal(W.resolveTarget(path.join(other, 'in.csv'), ws, [ws]).ok, false);                              // 没在允许的根里
  assert.equal(W.resolveTarget(path.resolve('C:\\WORK\\PROJ\\a'), ws, [ws]).ok, true);                        // Windows 大小写不敏感
  for (const bad of ['', '   ', 'a\u0000b', 'http://x.com/a', '\\\\server\\share\\a', 'file:///c:/a']) assert.equal(W.resolveTarget(bad, ws, [ws]).ok, false, JSON.stringify(bad));
  assert.match(W.resolveTarget('a.txt', '', []).error, /还没有工作文件夹/);                                    // 相对路径又没有基准目录
  assert.equal(W.resolveTarget('a.txt', ws, []).ok, false);                                                   // 没有任何允许的根
});

const TABLE_ONLY = '| 型号 | 功耗 |\n|---|---|\n| STM32L0 | 80 |\n| GD32E2 | 95 |';
const TABLE_IN_TEXT = '这是一大段分析文字。'.repeat(60) + '\n\n| a | b |\n|--|--|\n| 1 | 2 |';
test('结果格式按内容选：整段是表格 → 只出 .xlsx；长文里夹着表格 → .xlsx 和 .md 都出；纯文字 → 只出 .md', async () => {
  const root = tmp(), done = o => ({ status: 'done', output: o });
  const r = await W.writeWorkflow(root, { goal: 'g', nodes: [N('n0', '对比表', { run: done(TABLE_ONLY) }), N('n1', '分析', { dependsOn: ['n0'], run: done(TABLE_IN_TEXT) }), N('n2', '总结', { dependsOn: ['n1'], run: done('只是文字结论。') })] });
  assert.deepEqual(nodeFiles(root), ['n0-对比表/对比表.xlsx', 'n1-分析/分析.xlsx', 'n1-分析/结果.md', 'n2-总结/结果.md']);
  assert.deepEqual(r.perNode.n0, { md: null, xlsx: 'n0-对比表/对比表.xlsx', table: { head: ['型号', '功耗'], rows: [['STM32L0', '80'], ['GD32E2', '95']] } });
  assert.equal(r.perNode.n1.md, 'n1-分析/结果.md'); assert.equal(r.perNode.n2.xlsx, null);
  const sheet = require('./xlsx-lite.cjs').readZip(fs.readFileSync(path.join(r.dir, 'n0-对比表', '对比表.xlsx')))['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /STM32L0/); assert.match(sheet, /<v>80<\/v>/);
});
test('结果格式：结果内容变了（表格→文字）后，旧的 .xlsx 被清掉，不留陈旧文件', async () => {
  const root = tmp();
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: TABLE_ONLY } })] });
  assert.deepEqual(nodeFiles(root), ['n0-A/A.xlsx']);
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: '现在只有文字' } })] });
  assert.deepEqual(nodeFiles(root), ['n0-A/结果.md']);
});
test('HTML 交互视图是可选的：传入 view 才生成 workflow/index.html；之后关掉会删除，避免留下过期页面；传给 render 的数据结构正确', async () => {
  const root = tmp(); let seen = null;
  const view = { render: d => { seen = d; return '<!doctype html><title>x</title>'; } };
  const nodes = [N('n0', '对比', { agent: '研究员', run: { status: 'done', output: TABLE_ONLY, model: 'm1' } }), N('n1', '收尾', { dependsOn: ['n0'] })];
  const r = await W.writeWorkflow(root, { goal: '选型', nodes }, { view });
  assert.ok(fs.existsSync(path.join(r.dir, 'index.html'))); assert.ok(r.files.includes(path.join(r.dir, 'index.html')));
  assert.equal(seen.goal, '选型'); assert.equal(typeof seen.generatedAt, 'number'); assert.equal(seen.digest, null);
  assert.deepEqual(seen.nodes.map(n => [n.id, n.status, n.agent, n.model]), [['n0', 'done', '研究员', 'm1'], ['n1', 'todo', '', null]]);
  assert.equal(seen.nodes[0].files.xlsx, 'n0-对比/对比.xlsx'); assert.deepEqual(seen.nodes[0].table.head, ['型号', '功耗']); assert.equal(seen.nodes[1].table, null);
  await W.writeWorkflow(root, { goal: '选型', nodes }, {});                              // 没传 view = 关闭
  assert.ok(!fs.existsSync(path.join(r.dir, 'index.html')));
  await W.writeWorkflow(root, { nodes }, { view: { render: () => 'x', enabled: false } });
  assert.ok(!fs.existsSync(path.join(r.dir, 'index.html')));
});

test('清理：只删本程序写过的文件；用户和模型放进节点文件夹的文件永远不碰；空文件夹顺手删', async () => {
  const root = tmp(), wf = path.join(root, 'workflow'), n0 = path.join(wf, 'n0-A');
  fs.mkdirSync(n0, { recursive: true }); fs.writeFileSync(path.join(n0, '我的笔记.md'), '用户自己的'); fs.writeFileSync(path.join(n0, '图.png'), '模型生成的附件');
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: 'x' } })] });
  assert.deepEqual(nodeFiles(root), ['n0-A/图.png', 'n0-A/我的笔记.md', 'n0-A/结果.md']);
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: '改了' } }), N('n1', 'B', { dependsOn: ['n0'], run: { status: 'done', output: 'y' } })] });
  assert.deepEqual(nodeFiles(root), ['n0-A/图.png', 'n0-A/我的笔记.md', 'n0-A/结果.md', 'n1-B/结果.md']);
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: '改了' } })] });         // n1 没了 → 我们写的 n1-B/结果.md 和空的 n1-B 要清掉
  assert.deepEqual(nodeFiles(root), ['n0-A/图.png', 'n0-A/我的笔记.md', 'n0-A/结果.md']);
  assert.ok(!fs.existsSync(path.join(wf, 'n1-B')));
  await W.writeWorkflow(root, { nodes: [] });                                                                 // 全清：结果删了，用户和模型的文件还在
  assert.deepEqual(nodeFiles(root), ['n0-A/图.png', 'n0-A/我的笔记.md']);
  assert.equal(fs.readFileSync(path.join(n0, '我的笔记.md'), 'utf8'), '用户自己的');
  fs.writeFileSync(path.join(wf, '.written.json'), JSON.stringify(['../../evil.txt', '../evil.txt', 'a/../../evil.txt', '/abs.txt', 'x\\y.md', 5]));   // 被篡改的清单不能把删除带出 workflow/
  fs.writeFileSync(path.join(root, 'evil.txt'), 'keep'); fs.writeFileSync(path.join(wf, '..', 'abs.txt'), 'keep'); await W.writeWorkflow(root, { nodes: [] });
  assert.equal(fs.readFileSync(path.join(root, 'evil.txt'), 'utf8'), 'keep');
});
test('旧版 results/ 布局：升级后旧结果被清掉，用户放在 results/ 里的文件不动', async () => {
  const root = tmp(), results = path.join(root, 'workflow', 'results');
  fs.mkdirSync(results, { recursive: true }); fs.writeFileSync(path.join(results, 'n0-A.md'), '旧布局写的'); fs.writeFileSync(path.join(results, '我的笔记.md'), '用户自己的');
  fs.writeFileSync(path.join(results, '.written.json'), JSON.stringify(['n0-A.md']));
  await W.writeWorkflow(root, { nodes: [N('n0', 'A', { run: { status: 'done', output: 'x' } })] });
  assert.deepEqual(fs.readdirSync(results).sort(), ['我的笔记.md']);
  assert.ok(fs.existsSync(path.join(root, 'workflow', 'n0-A', '结果.md')));
});
test('真实路径检查：符号链接/目录联接不能绕出允许的根；不存在的路径看最近的上级；大小写不敏感', async () => {
  const root = tmp(), outside = tmp(); fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  assert.equal(await W.realInside(path.join(root, 'ok.txt'), [root]), true);                                    // 目标尚不存在
  assert.equal(await W.realInside(path.join(root, 'sub', 'deep', 'new.txt'), [root]), true);
  assert.equal(await W.realInside(path.join(outside, 'secret.txt'), [root]), false);
  let linked = false;
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); linked = true; } catch { /* 无权限创建联接时跳过这一段 */ }
  if (linked) assert.equal(await W.realInside(path.join(root, 'link', 'secret.txt'), [root]), false, '联接指向根之外，必须被拒绝');
  assert.equal(await W.realInside(path.join(root, 'x'), []), false);
});
