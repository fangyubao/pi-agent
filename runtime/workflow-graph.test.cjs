'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('./workflow-graph.js');

const N = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', prompt: '做 ' + id, ...extra });

test('合法的串行 + 并行计划通过，并分层：并行的节点在同一层', () => {
  const r = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n1'] }), N('n4', { dependsOn: ['n2', 'n3'] })]);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.plan.layers, [['n1'], ['n2', 'n3'], ['n4']]);
});

test('布局：层从左到右，同一层上下排，较短的一列垂直居中，坐标互不重叠', () => {
  const { plan } = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n1'] }), N('n4', { dependsOn: ['n2', 'n3'] })]);
  const L = g.layout(plan.nodes);
  assert.equal(L.positions.n1.x, 0); assert.equal(L.positions.n2.x, L.positions.n3.x); assert.ok(L.positions.n4.x > L.positions.n2.x);
  assert.ok(L.positions.n3.y > L.positions.n2.y);                                  // 同一列上下排
  assert.equal(L.positions.n1.y, (L.positions.n2.y + L.positions.n3.y) / 2);       // 单节点列相对并行列居中
  assert.equal(L.parallel, 1);
  const seen = new Set(Object.values(L.positions).map(p => p.x + ',' + p.y)); assert.equal(seen.size, 4);
});

test('层号取最长依赖链，而不是最短：n4 同时依赖 n1 和 n3，必须排在 n3 之后', () => {
  const r = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n2'] }), N('n4', { dependsOn: ['n1', 'n3'] })]);
  assert.deepEqual(r.plan.layers, [['n1'], ['n2'], ['n3'], ['n4']]);
});

test('环检测：给出具体的环，而不只是“有环”', () => {
  const r = g.validate([N('n1', { dependsOn: ['n3'] }), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n2'] })]);
  assert.equal(r.ok, false); assert.match(r.errors.join(), /循环依赖：.*n1.*n3.*n2|循环依赖：.*n[123] → n[123]/);
  const self = g.validate([N('n1', { dependsOn: ['n1'] })]); assert.match(self.errors.join(), /依赖了自己/);
});

test('环不会拖垮无关节点的检测，也不会死循环', () => {
  const r = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n4'] }), N('n4', { dependsOn: ['n3'] })]);
  assert.equal(r.ok, false); assert.match(r.errors.join(), /n3 → n4 → n3|n4 → n3 → n4/);
});

test('引用不存在的节点、id 重复、id 格式错误都会报错', () => {
  assert.match(g.validate([N('n1', { dependsOn: ['n9'] })]).errors.join(), /不存在的节点 n9/);
  assert.match(g.validate([N('n1'), N('n1')]).errors.join(), /id 重复/);
  assert.match(g.validate([N('x1')]).errors.join(), /id 不合法/);
});

test('必填项：标题和提示词缺一不可；角色缺失时给默认值，不因此丢掉整份计划', () => {
  const e = g.validate([{ id: 'n1', title: '', role: '', prompt: '' }]).errors.join();
  assert.match(e, /缺少标题/); assert.match(e, /缺少提示词/); assert.doesNotMatch(e, /角色/);
  const ok = g.validate([{ id: 'n1', title: 'a', prompt: 'p' }, { id: 'n2', title: 'b', prompt: 'p', dependsOn: ['n1'] }]);
  assert.equal(ok.ok, true); assert.equal(ok.plan.nodes[0].role, '执行者');
});

test('节点数上限：拆解器 36 个（与 0-9A-Z 编号一致），用户手动编辑后 72 个', () => {
  const many = n => Array.from({ length: n }, (_, i) => N('n' + (i + 1)));
  assert.match(g.validate(many(37)).errors.join(), /最多 36/);
  assert.equal(g.validate(many(36)).ok, true);
  assert.equal(g.validate(many(72), { edited: true }).ok, true);
  assert.match(g.validate(many(73), { edited: true }).errors.join(), /最多 72/);
  assert.equal(g.validate([]).ok, false);
});

test('字段被规范化：超长截断、去重、控制字符被清除、非法难度回落为 3；旧的 light/standard/strong 兼容', () => {
  const n = g.normalizeNode({ id: 'n1', title: 'x'.repeat(100), role: 'r\u0000ole', prompt: 'p'.repeat(5000), tier: 'ultra', skills: ['a', 'a', 'b', 'c', 'd', 'e'], tools: ['t1', 't1'], dependsOn: ['n2', 'n2'] });
  assert.equal(n.title.length, 24); assert.equal(n.role, 'role'); assert.equal(n.prompt.length, 1500); assert.equal(n.tier, 3); assert.equal(g.normalizeNode({ tier: 'light' }).tier, 1); assert.equal(g.normalizeNode({ tier: 'strong' }).tier, 5); assert.equal(g.normalizeNode({ tier: 4 }).tier, 4); assert.equal(g.normalizeNode({ effort: 'high' }).effort, 'high'); assert.equal(g.normalizeNode({ effort: 'x' }).effort, null);
  assert.deepEqual(n.skills, ['a', 'b', 'c', 'd']); assert.deepEqual(n.tools, ['t1']); assert.deepEqual(n.dependsOn, ['n2']);
});

test('任务介绍缺省取提示词开头；用户锁定的模型被保留且 source=user', () => {
  assert.equal(g.normalizeNode({ id: 'n1', prompt: '调研三种 MCU 的功耗' }).brief, '调研三种 MCU 的功耗');
  const n = g.normalizeNode({ id: 'n1', model: { profileId: 'p', model: 'm', source: 'user' } });
  assert.deepEqual(n.model, { profileId: 'p', model: 'm', source: 'user' });
  assert.equal(g.normalizeNode({ id: 'n1', model: { profileId: 'p', model: 'm', source: 'weird' } }).model.source, 'auto');
});

test('修改某节点后，列出所有下游（含间接），用于标出结果过期', () => {
  const { plan } = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n2'] }), N('n4'), N('n5', { dependsOn: ['n4'] })]);
  assert.deepEqual(g.downstreamOf(plan.nodes, 'n1'), ['n2', 'n3']);
  assert.deepEqual(g.downstreamOf(plan.nodes, 'n4'), ['n5']);
  assert.deepEqual(g.downstreamOf(plan.nodes, 'n3'), []);
});

test('边由依赖派生；恶意/畸形输入不会抛异常', () => {
  const { plan } = g.validate([N('n1'), N('n2', { dependsOn: ['n1'] })]);
  assert.deepEqual(g.edges(plan.nodes), [{ from: 'n1', to: 'n2' }]);
  for (const bad of [null, undefined, 'x', 5, [null], [undefined], [{}], [[]], [{ id: {} , title: [], dependsOn: 'n1' }]]) assert.doesNotThrow(() => g.validate(bad));
});

test('大图性能：12 个节点的布局与校验在毫秒级完成', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => N('n' + (i + 1), { dependsOn: i ? ['n' + i] : [] }));
  const t = Date.now(); for (let i = 0; i < 500; i++) g.validate(nodes, { edited: true }); assert.ok(Date.now() - t < 1500);
});
