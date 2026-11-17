'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./workflow-run.js');
const N = (id, dependsOn = [], status) => ({ id, title: '节点' + id, role: '分析师', prompt: '做' + id, dependsOn, run: status ? { status, output: '结果' + id } : null });
const sleep = ms => new Promise(x => setTimeout(x, ms));

test('单独运行：没有上游依赖的节点可以直接运行', () => assert.equal(R.checkRunnable([N('n1')], 'n1').ok, true));
test('单独运行：上游没结果时报错，并明确指出缺哪些', () => {
  const r = R.checkRunnable([N('n1'), N('n2', ['n1']), N('n3', ['n1', 'n2'])], 'n3');
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['n1', 'n2']); assert.match(r.reason, /先运行/); assert.match(r.reason, /n1 节点n1/);
});
test('单独运行：上游已完成就能运行；上游失败不算完成；正在运行的节点不能重复运行；节点不存在报错', () => {
  assert.equal(R.checkRunnable([N('n1', [], 'done'), N('n2', ['n1'])], 'n2').ok, true);
  assert.equal(R.checkRunnable([N('n1', [], 'error'), N('n2', ['n1'])], 'n2').ok, false);
  assert.equal(R.checkRunnable([N('n1', [], 'running')], 'n1').ok, false);
  assert.equal(R.checkRunnable([N('n1')], 'zz').ok, false);
});
test('拆层：并行的在同一层；有环返回 null', () => {
  assert.deepEqual(R.layers([N('n1'), N('n2', ['n1']), N('n3', ['n1']), N('n4', ['n2', 'n3'])]), [['n1'], ['n2', 'n3'], ['n4']]);
  assert.equal(R.layers([N('n1', ['n2']), N('n2', ['n1'])]), null);
});
test('请求：只含本节点指令与直接上游结论；上游结论被截断；有 DATA 围栏；无上游时不带围栏', () => {
  const nodes = [N('n1', [], 'done'), N('n2', ['n1'])]; nodes[0].run.output = 'x'.repeat(5000);
  const req = R.buildRequest(nodes[1], R.upstreamOf(nodes, nodes[1]));
  assert.match(req.system, /分析师/); assert.match(req.user, /DATA_BEGIN/); assert.match(req.user, /已截断/); assert.ok(req.user.length < 1800);
  assert.equal(R.buildRequest(nodes[0], []).user, '做n1');
});
test('运行全部：按依赖顺序执行，同层并行；已完成的跳过', async () => {
  const nodes = [N('n1', [], 'done'), N('n2', ['n1']), N('n3', ['n1']), N('n4', ['n2', 'n3'])], order = []; let live = 0, peak = 0;
  const r = await R.runAll(nodes, { runNode: async id => { live++; peak = Math.max(peak, live); order.push(id); await sleep(10); live--; } });
  assert.deepEqual(r, { done: 3, failed: [], skipped: [], cancelled: false }); assert.equal(order[order.length - 1], 'n4'); assert.ok(!order.includes('n1')); assert.equal(peak, 2);
});
test('运行全部：失败的节点只让依赖它的节点被跳过，其他分支继续', async () => {
  const nodes = [N('n1'), N('n2', ['n1']), N('n3'), N('n4', ['n2', 'n3'])], events = [];
  const r = await R.runAll(nodes, { runNode: async id => { if (id === 'n1') throw new Error('炸了'); }, onEvent: e => events.push(e.id + ':' + e.status) });
  assert.deepEqual(r.failed, [{ id: 'n1', error: '炸了' }]); assert.deepEqual(r.skipped.sort(), ['n2', 'n4']); assert.equal(r.done, 1);
  assert.ok(events.includes('n3:done') && events.includes('n2:skipped'));
});
test('运行全部：并发上限 3；取消后不再启动新节点；有环直接报错', async () => {
  const wide = Array.from({ length: 7 }, (_, i) => N('n' + (i + 1))); let live = 0, peak = 0;
  await R.runAll(wide, { runNode: async () => { live++; peak = Math.max(peak, live); await sleep(5); live--; } });
  assert.equal(peak, 3);
  const ctl = new AbortController(), ran = [];
  const r = await R.runAll(wide, { signal: ctl.signal, runNode: async id => { ran.push(id); ctl.abort(); } });
  assert.equal(r.cancelled, true); assert.ok(ran.length <= 3);
  await assert.rejects(R.runAll([N('n1', ['n2']), N('n2', ['n1'])], { runNode: async () => {} }), /有环/);
});

test('模型选择优先级：节点手选 > 所属子智能体 > 难度档位 > 主模型', () => {
  const agents = { 研究员: { model: { profileId: 'p', model: 'agent-m' } }, 撰稿: { model: null } };
  const auto = { profileId: 'p', model: 'tier-m', source: 'auto' }, user = { profileId: 'p', model: 'mine', source: 'user' };
  assert.deepEqual(R.modelFor({ agent: '研究员', model: user }, agents), { model: { profileId: 'p', model: 'mine' }, by: 'node' });
  assert.deepEqual(R.modelFor({ agent: '研究员', model: auto }, agents), { model: { profileId: 'p', model: 'agent-m' }, by: 'agent' });
  assert.deepEqual(R.modelFor({ agent: '撰稿', model: auto }, agents), { model: { profileId: 'p', model: 'tier-m' }, by: 'tier' });   // 子智能体没指定 → 回到档位
  assert.deepEqual(R.modelFor({ agent: '', model: auto }, agents).by, 'tier');
  assert.deepEqual(R.modelFor({ agent: '研究员', model: null }, agents).by, 'agent');
  assert.deepEqual(R.modelFor({ model: null }, undefined), { model: null, by: 'main' });
  assert.deepEqual(R.modelFor(null, null), { model: null, by: 'main' });
});
test('并行兄弟节点互相看不到对方的结论：请求里只有自己的指令和直接上游；同一子智能体名下的并行节点同样不共享', () => {
  const base = { ...N('n0', [], 'done'), agent: '研究员' };
  const a = { ...N('n10', ['n0']), agent: '研究员' }, b = { ...N('n11', ['n0']), agent: '研究员' };
  a.run = { status: 'done', output: '甲的秘密结论' }; b.run = null;
  const nodes = [base, a, b];
  const req = R.buildRequest(b, R.upstreamOf(nodes, b));
  assert.ok(!req.user.includes('甲的秘密结论'), '并行兄弟的结果不能进入请求');
  assert.ok(req.user.includes('结果n0'), '直接上游的结论要在');
  assert.equal(R.upstreamOf(nodes, b).length, 1);
});

test('runAll 滑动窗口：同一层不整批等待，上游完成就补位；fresh 重跑已完成节点，默认跳过', async () => {
  const mk = (id, dependsOn = [], done = false) => ({ id, dependsOn, run: done ? { status: 'done', output: 'x' } : null });
  // 并发 2，四个互不依赖的节点：耗时 [40, 40, 40, 40]ms。整批等待 = 两批 ≈ 80ms；滑动窗口：一个结束立刻补位，同样 ≈ 80ms，
  // 所以用“一快一慢”区分：[10, 100, 10, 10] —— 整批等待要 100(第一批) + 10(第二批) = 110ms；滑动窗口：慢的占一个位，另一个位连跑三个快的 ≈ 100ms。
  // 更明显的区分：[100, 10, 10, 10, 10] 并发 2 → 整批：100 + 10 + 10 = 120；滑动：100。差 20ms 在 CI 上不稳，所以改看“开始顺序”：
  // 第二批的第一个节点必须在“第一批里较快的那个”结束后立刻开始，而不是等较慢的那个。
  const nodes = [mk('a'), mk('b'), mk('c')];
  const delay = { a: 150, b: 10, c: 10 }, ev = [], running = new Set(); let peak = 0;
  const runNode = async id => { running.add(id); peak = Math.max(peak, running.size); ev.push('start:' + id); await new Promise(r => setTimeout(r, delay[id])); running.delete(id); ev.push('end:' + id); };
  const r = await R.runAll(nodes, { runNode, concurrency: 2 });
  assert.equal(r.done, 3); assert.ok(peak <= 2, '并发不超过上限');
  assert.ok(ev.indexOf('start:c') < ev.indexOf('end:a'), 'b 结束后 c 立刻补位，不等慢的 a：' + ev.join(','));
  const skipped = await R.runAll([mk('a', [], true), mk('b', ['a'])], { runNode: async () => {} });
  assert.equal(skipped.done, 1);
  const fresh = await R.runAll([mk('a', [], true), mk('b', ['a'], true)], { runNode: async () => {}, fresh: true });
  assert.equal(fresh.done, 2);
  const failed = await R.runAll([mk('a'), mk('b', ['a']), mk('c')], { runNode: async id => { if (id === 'a') throw new Error('boom'); } });
  assert.deepEqual(failed.skipped, ['b']); assert.equal(failed.failed.length, 1); assert.equal(failed.done, 1);
  const ctl = new AbortController();
  const stopped = await R.runAll([mk('a'), mk('b', ['a'])], { runNode: async () => { ctl.abort(); }, signal: ctl.signal });
  assert.equal(stopped.cancelled, true);
});
