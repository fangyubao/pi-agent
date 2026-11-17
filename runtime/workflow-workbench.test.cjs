'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = require('./workbench-runtime.cjs');
const { dispatch } = require('../workbenches/workflow/server/index.cjs');

const root = path.join(__dirname, '..', 'workbenches');
const N = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', prompt: '做 ' + id, ...extra });
const LONG = '这是一段很长的完整提示词，只应该出现在 readNode 的结果里。'.repeat(8);
const THREE = [N('n1', { prompt: LONG, brief: '一行介绍' }), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n1'] }), N('n4', { dependsOn: ['n2', 'n3'] })];
const run = async (state, action, payload) => dispatch({ action, payload, state });
async function planned() { return (await run({}, 'setPlan', { goal: '调研', nodes: THREE })).state; }

test('manifest 声明的每个动作都被后端实现，且后端没有未声明的动作（双向对照）', async () => {
  const inspected = await runtime.inspect(root, 'workflow');
  assert.equal(inspected.health.status, 'healthy');
  const declared = inspected.manifest.actions.map(a => a.name);
  for (const name of declared) {
    let err = null; try { await run({}, name, { baseRevision: 0, id: 'n1', patch: {}, node: {}, nodes: THREE, model: null }); } catch (e) { err = e; }
    assert.notEqual(err?.code, 'UNKNOWN_ACTION', '动作 ' + name + ' 已声明但没有实现');
  }
  await assert.rejects(() => run({}, 'notDeclared', {}), e => e.code === 'UNKNOWN_ACTION');
});

test('setPlan：写入计划并递增版本；非法计划（环/缺字段）被拒绝且状态不变', async () => {
  const s = await planned(); assert.equal(s.nodes.length, 4); assert.equal(s.revision, 1); assert.equal(s.planRevision, 1); assert.equal(s.status, 'planned');
  const cyc = [N('n1', { dependsOn: ['n2'] }), N('n2', { dependsOn: ['n1'] }), N('n3')];
  await assert.rejects(() => run(s, 'setPlan', { nodes: cyc }), e => e.code === 'INVALID_PLAN' && /循环依赖/.test(e.message));
  await assert.rejects(() => run(s, 'setPlan', { nodes: [{ id: 'n1' }] }), e => e.code === 'INVALID_PLAN');
  assert.equal((await run(s, 'readPlan')).state.nodes.length, 4);
});

test('readPlan 只给摘要，不含完整提示词（聊天里省 token 的关键）；readNode 才给全文', async () => {
  const s = await planned();
  const { result } = await run(s, 'readPlan');
  assert.equal(result.count, 4); assert.ok(!JSON.stringify(result).includes('完整提示词'), '摘要里不应出现完整提示词');
  assert.ok(JSON.stringify(result).includes('一行介绍'));
  assert.equal((await run(s, 'readNode', { id: 'n0' })).result.prompt.length > 100, true);
  const big = (await run({}, 'setPlan', { nodes: Array.from({ length: 6 }, (_, i) => N('n' + (i + 1), { prompt: LONG, brief: '介绍' + i, dependsOn: i ? ['n' + i] : [] })) })).state;
  const ratio = JSON.stringify((await run(big, 'readPlan')).result).length / JSON.stringify(big).length;
  assert.ok(ratio < 0.4, '6 个长提示词节点：摘要应不足完整状态的 40%，实际 ' + ratio.toFixed(2));
  await assert.rejects(() => run(s, 'readNode', { id: 'n99' }), e => e.code === 'NOT_FOUND');
});

test('updateNode：需要 baseRevision；版本冲突被拒绝并给出当前版本；成功后列出下游过期节点', async () => {
  const s = await planned();
  await assert.rejects(() => run(s, 'updateNode', { id: 'n0', patch: { title: 'x' } }), e => e.code === 'BAD_REQUEST');
  await assert.rejects(() => run(s, 'updateNode', { baseRevision: 0, id: 'n0', patch: { title: 'x' } }), e => e.code === 'REVISION_CONFLICT' && /当前版本 1/.test(e.message));
  const r = await run(s, 'updateNode', { baseRevision: 1, id: 'n0', patch: { prompt: '新的提示词' } });
  assert.equal(r.state.nodes[0].prompt, '新的提示词'); assert.equal(r.state.nodes[0].origin, 'user'); assert.equal(r.state.revision, 2);
  assert.deepEqual([...r.result.stale].sort(), ['n10', 'n11', 'n2']);
});

test('updateNode：不能改 id/model 等未开放字段；改出环或空标题会被拒绝；失败不改变状态', async () => {
  const s = await planned();
  await assert.rejects(() => run(s, 'updateNode', { baseRevision: 1, id: 'n0', patch: { id: 'n9' } }), e => e.code === 'BAD_REQUEST' && /id/.test(e.message));
  await assert.rejects(() => run(s, 'updateNode', { baseRevision: 1, id: 'n0', patch: { dependsOn: ['n2'] } }), e => e.code === 'INVALID_PLAN' && /循环依赖/.test(e.message));
  await assert.rejects(() => run(s, 'updateNode', { baseRevision: 1, id: 'n0', patch: { title: '' } }), e => e.code === 'INVALID_PLAN');
  await assert.rejects(() => run(s, 'updateNode', { baseRevision: 1, id: 'n0', patch: 'bad' }), e => e.code === 'BAD_REQUEST');
  assert.equal(s.revision, 1);
});

test('只挪动节点位置：版本递增（界面能感知），但不算计划内容变化（planRevision 不变），也不产生过期节点', async () => {
  const s = await planned();
  const r = await run(s, 'updateNode', { baseRevision: 1, id: 'n10', patch: { pos: { x: 10, y: 20 } } });
  assert.deepEqual(r.state.nodes[1].pos, { x: 10, y: 20 }); assert.equal(r.state.planRevision, 1); assert.deepEqual(r.result.stale, []);
  const again = await run(r.state, 'updateNode', { baseRevision: 2, id: 'n0', patch: { title: '改标题' } });
  assert.deepEqual(again.state.nodes[1].pos, { x: 10, y: 20 });          // 改内容不会丢掉已拖动的位置
});

test('setNodeModel：用户指定 source=user；传 null 恢复自动；参数不全被拒绝；不算计划变化', async () => {
  const s = await planned();
  const r = await run(s, 'setNodeModel', { baseRevision: 1, id: 'n0', model: { profileId: 'p1', model: 'gpt-x' } });
  assert.deepEqual(r.state.nodes[0].model, { profileId: 'p1', model: 'gpt-x', source: 'user' }); assert.equal(r.state.planRevision, 1);
  assert.equal((await run(r.state, 'setNodeModel', { baseRevision: 2, id: 'n0', model: null })).state.nodes[0].model, null);
  await assert.rejects(() => run(s, 'setNodeModel', { baseRevision: 1, id: 'n0', model: { model: 'x' } }), e => e.code === 'BAD_REQUEST');
});

test('addNode / removeNode：新 id 不与现有冲突；删除节点会清掉别人对它的依赖；上限 72', async () => {
  const s = await planned();
  const added = await run(s, 'addNode', { baseRevision: 1, node: { title: '补充', role: '编辑', prompt: '补充内容', dependsOn: ['n2'] } });
  assert.equal(added.result.id, 'n3');                                   // 接在第 2 阶段之后 → 第 3 阶段、唯一一个 → n3
  const removed = await run(added.state, 'removeNode', { baseRevision: 2, id: 'n10' });
  assert.equal(removed.state.nodes.length, 4);
  assert.deepEqual(removed.state.nodes.map(n => n.id), ['n0', 'n1', 'n2', 'n3']);                  // 并行变成单个后，剩下的重新编号为串行
  assert.deepEqual(removed.state.nodes.find(n => n.id === 'n2').dependsOn, ['n1']);              // 对被删节点的依赖被清掉，并随重新编号改写
  const full = { ...(await planned()), nodes: Array.from({ length: 72 }, (_, i) => N('n' + (i + 1))), revision: 5 };
  await assert.rejects(() => run(full, 'addNode', { baseRevision: 5, node: N('x') }), e => e.code === 'LIMIT');
});

test('clearPlan 清空；saveUIState 只保存视口，不递增版本（否则每次平移都会让 Agent 的 baseRevision 失效）', async () => {
  const s = await planned();
  const moved = await run(s, 'saveUIState', { state: { viewport: { x: 5, y: 6, zoom: 9 } } });
  assert.equal(moved.state.revision, s.revision); assert.equal(moved.state.viewport, undefined);   // 视口不进计划状态
  const cleared = await run(s, 'clearPlan', { baseRevision: 1 });
  assert.equal(cleared.state.nodes.length, 0); assert.equal(cleared.state.status, 'empty');
});

test('畸形状态与畸形载荷不会让后端崩溃', async () => {
  for (const bad of [null, undefined, 'x', 5, { nodes: 'x' }, { nodes: [null, 5, {}] }, { viewport: 'x' }]) await assert.doesNotReject(() => run(bad ?? {}, 'readPlan'));
  await assert.rejects(() => run({}, 'addNode', { baseRevision: 0, node: null }), e => e.code === 'INVALID_PLAN');
});

test('经宿主运行时（与真实应用相同的 dispatch 路径）：读取、写入、版本冲突与未声明动作', async () => {
  const state = {};
  const set = await runtime.dispatch(root, { key: 'workflow', action: 'setPlan', state, payload: { goal: 'g', nodes: THREE }, source: 'agent' });
  assert.equal(set.ok, true, set.error); const s1 = set.state;
  const read = await runtime.dispatch(root, { key: 'workflow', action: 'readPlan', state: s1, payload: {}, source: 'agent' });
  assert.equal(read.ok, true); assert.equal(read.result.count, 4);
  const conflict = await runtime.dispatch(root, { key: 'workflow', action: 'updateNode', state: s1, payload: { baseRevision: 0, id: 'n0', patch: { title: 'x' } }, source: 'agent' });
  assert.equal(conflict.ok, false);
  const unknown = await runtime.dispatch(root, { key: 'workflow', action: 'rm_rf', state: s1, payload: {}, source: 'agent' });
  assert.equal(unknown.ok, false); assert.match(unknown.error, /未声明/);
});

test('节点编号：串行 n0,n1,n2；某阶段有并行时在阶段号后加序号（n10,n11），下一阶段继续 n2；提交时的 id 会被重新编号并改写依赖', async () => {
  const s = await planned();
  assert.deepEqual(s.nodes.map(n => n.id), ['n0', 'n10', 'n11', 'n2']);
  assert.deepEqual(s.nodes.map(n => n.dependsOn), [[], ['n0'], ['n0'], ['n10', 'n11']]);
  const serial = (await run({}, 'setPlan', { nodes: [N('a1'.replace('a1', 'n7')), N('n8', { dependsOn: ['n7'] }), N('n9', { dependsOn: ['n8'] })] })).state;
  assert.deepEqual(serial.nodes.map(n => n.id), ['n0', 'n1', 'n2']);
});
test('节点编号：运行结果、模型随节点走；修改依赖导致阶段变化时 id 跟着变，结果不丢', async () => {
  let s = await planned();
  s = (await run(s, 'setNodeRun', { id: 'n11', run: { status: 'done', output: '结果B' } })).state;
  s = (await run(s, 'setNodeModel', { baseRevision: s.revision, id: 'n11', model: { profileId: 'p', model: 'm' } })).state;
  // n11 改为依赖 n10 → 变成串行：n0 → n10... 重新编号
  const r = await run(s, 'updateNode', { baseRevision: s.revision, id: 'n11', patch: { dependsOn: ['n10'] } });
  assert.deepEqual(r.state.nodes.map(n => n.id), ['n0', 'n1', 'n2', 'n3']);
  assert.equal(r.result.id, 'n2');                                                               // 被修改的节点现在的新 id
  assert.equal(r.state.nodes.find(n => n.id === 'n2').title, '任务n3');
});
test('节点编号：同一阶段超过 10 个并行用字母继续（n1A），并且 id 唯一', async () => {
  const wide = [N('n0'), ...Array.from({ length: 11 }, (_, i) => N('n' + (i < 9 ? i + 1 : 'ABC'[i - 9]) + '', { dependsOn: ['n0'] }))];
  const g = require('./workflow-graph.js');
  const r = g.renumber(wide.map(n => ({ ...n, id: n.id, dependsOn: n.dependsOn || [] })));
  assert.deepEqual(r.nodes.slice(0, 3).map(n => n.id), ['n0', 'n10', 'n11']);
  assert.ok(r.nodes.some(n => n.id === 'n1A')); assert.equal(new Set(r.nodes.map(n => n.id)).size, 12);
  assert.throws(() => g.renumber([N('n0'), ...Array.from({ length: 37 }, (_, i) => N('x' + i, { dependsOn: ['n0'] }))]), /最多 36/);
});

test('子智能体：节点带 agent 名；setAgentModel 给它指定模型，清掉其跟随节点的旧结果并让下游过期；手选模型的节点不受影响', async () => {
  const nodes = [N('n1', { agent: '研究员' }), N('n2', { agent: '研究员', dependsOn: ['n1'] }), N('n3', { agent: '撰稿', dependsOn: ['n2'] }), N('n4', { agent: '撰稿', dependsOn: ['n3'] })];
  let s = (await run({}, 'setPlan', { nodes })).state;
  assert.deepEqual(s.nodes.map(n => n.agent), ['研究员', '研究员', '撰稿', '撰稿']);
  for (const id of ['n0', 'n1', 'n2', 'n3']) s = (await run(s, 'setNodeRun', { id, run: { status: 'done', output: 'x' } })).state;
  s = (await run(s, 'setNodeModel', { baseRevision: s.revision, id: 'n1', model: { profileId: 'p', model: 'mine' } })).state;   // n1 手选
  const r = await run(s, 'setAgentModel', { baseRevision: s.revision, name: '研究员', model: { profileId: 'p', model: 'big' } });
  assert.deepEqual(r.state.agents, { 研究员: { model: { profileId: 'p', model: 'big', source: 'user' } } });
  assert.deepEqual(r.result.nodes, ['n0']);                                      // 只有没手选模型的 n0 跟随
  assert.equal(r.state.nodes.find(n => n.id === 'n0').run, null);                // 它的旧结果被清
  assert.equal(r.state.nodes.find(n => n.id === 'n1').run, null);                // n1 是 n0 的下游 → 已过期（被 markStale 标记，或手选时已清）
  assert.equal(r.state.nodes.find(n => n.id === 'n2').run.status, 'stale');
  const cleared = await run(r.state, 'setAgentModel', { baseRevision: r.state.revision, name: '研究员', model: null });
  assert.equal(cleared.state.agents['研究员'].model, null);
  await assert.rejects(() => run(s, 'setAgentModel', { baseRevision: s.revision, name: '不存在', model: null }), e => e.code === 'NOT_FOUND');
  await assert.rejects(() => run(s, 'setAgentModel', { baseRevision: s.revision, name: '研究员', model: { model: 'x' } }), e => e.code === 'BAD_REQUEST');
});
test('子智能体：没有节点使用的子智能体会被清掉；改节点归属后同步；数量超过 4 个被拒绝', async () => {
  let s = (await run({}, 'setPlan', { nodes: [N('n1', { agent: '甲' }), N('n2', { agent: '乙', dependsOn: ['n1'] }), N('n3', { agent: '乙', dependsOn: ['n2'] })] })).state;
  s = (await run(s, 'setAgentModel', { baseRevision: s.revision, name: '甲', model: { profileId: 'p', model: 'm' } })).state;
  assert.ok(s.agents['甲']);
  s = (await run(s, 'updateNode', { baseRevision: s.revision, id: 'n0', patch: { agent: '乙' } })).state;      // 甲 不再有节点
  assert.equal(s.agents['甲'], undefined);
  const five = ['甲', '乙', '丙', '丁', '戊'].map((a, i) => N('n' + (i + 1), { agent: a, dependsOn: i ? ['n' + i] : [] }));
  await assert.rejects(() => run({}, 'setPlan', { nodes: five }), e => e.code === 'INVALID_PLAN' && /子智能体过多/.test(e.message));
  assert.equal((await run({}, 'setPlan', { nodes: [N('n1'), N('n2', { dependsOn: ['n1'] }), N('n3', { dependsOn: ['n2'] })] })).state.nodes[0].agent, '');   // 没有归属也合法
});
