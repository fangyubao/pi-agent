'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./model-tiers.js');

const M = (profileId, model) => ({ profileId, model });
const levels = ['light', 'standard', 'strong'];
const pickAll = tiers => [1, 2, 3, 4, 5].map(d => T.pickTier(tiers, d));

test('一个都没配：自动分配返回 null（调用方用主模型），拆解模型也是 null', () => {
  assert.equal(T.assign([], 'strong'), null); assert.equal(T.assign(undefined, 'light'), null); assert.equal(T.plannerModel([null, null, null, null, null]), null);
  assert.deepEqual(T.assignAll([{ id: 'n1', tier: 'strong' }], []).map(n => n.model), [null]);
});

test('只配了 1 个档位（不管是第几档）：所有难度都用它', () => {
  for (const slot of [0, 2, 4]) { const tiers = Array(5).fill(null); tiers[slot] = M('a', 'm'); assert.deepEqual(pickAll(tiers), Array(5).fill(slot)); }
});

test('配了 2 个档位：难度分成两段，轻的一半用低档、重的一半用高档', () => {
  const tiers = [M('a', 'small'), null, null, null, M('b', 'big')];
  const picks = pickAll(tiers);
  assert.deepEqual(picks, [0, 0, 0, 4, 4].map((_, i) => picks[i]));      // 先确认只会取到这两个档位
  assert.ok(picks.every(p => p === 0 || p === 4));
  assert.equal(picks[0], 0); assert.equal(picks[4], 4);                   // 最轻 → 低档，最重 → 高档
  assert.ok(picks[0] <= picks[1] && picks[1] <= picks[2] && picks[2] <= picks[3] && picks[3] <= picks[4]);   // 单调不降
});

test('配了 3、4、5 个档位：每个已配置档位都会被用到，且难度越高档位不会更低', () => {
  for (const slots of [[0, 2, 4], [0, 1, 3, 4], [0, 1, 2, 3, 4]]) {
    const tiers = Array(5).fill(null); slots.forEach((s, i) => { tiers[s] = M('p' + i, 'm' + i); });
    const picks = pickAll(tiers);
    assert.deepEqual([...new Set(picks)].sort(), [...slots].sort(), '每个已配置档位都应被用到：' + slots);
    for (let i = 1; i < picks.length; i++) assert.ok(picks[i] >= picks[i - 1], '单调不降：' + picks);
  }
});

test('五档全配时，难度 1-5 与档位一一对应', () => {
  const tiers = [0, 1, 2, 3, 4].map(i => M('p', 'm' + i));
  assert.deepEqual(pickAll(tiers), [0, 1, 2, 3, 4]);
  assert.equal(T.assign(tiers, 'light').model, 'm0'); assert.equal(T.assign(tiers, 'standard').model, 'm2'); assert.equal(T.assign(tiers, 'strong').model, 'm4');
});

test('难度同时接受 light/standard/strong 与 1-5；未知值按标准处理，不抛错', () => {
  assert.deepEqual(['light', 'standard', 'strong', 1, 3, 5, 'weird', undefined, null, 99].map(T.difficultyOf), [1, 3, 5, 1, 3, 5, 3, 3, 3, 3]);
});

test('档位可以跨厂商：每档独立指向 {厂商, 模型}', () => {
  const tiers = [M('deepseek', 'chat'), null, M('openai', 'mini'), null, M('anthropic', 'big')];
  assert.deepEqual(T.assign(tiers, 'light'), { profileId: 'deepseek', model: 'chat', tier: 0, reason: '难度「轻」→ 档位 1 · 最轻' });
  assert.equal(T.assign(tiers, 'strong').profileId, 'anthropic');
});

test('拆解模型用最便宜的已配置档位', () => {
  assert.deepEqual(T.plannerModel([null, null, M('a', 'x'), null, M('b', 'y')]), { profileId: 'a', model: 'x', tier: 2 });
});

test('assignAll：用户手动锁定的节点永远不被覆盖；自动分配的会随档位变化重新分配', () => {
  const nodes = [{ id: 'n1', tier: 'light', model: { profileId: 'u', model: 'mine', source: 'user' } }, { id: 'n2', tier: 'strong' }, { id: 'n3', tier: 'light', model: { profileId: 'old', model: 'old', source: 'auto' } }];
  const tiers = [M('a', 'small'), null, null, null, M('b', 'big')];
  const out = T.assignAll(nodes, tiers);
  assert.deepEqual(out[0].model, { profileId: 'u', model: 'mine', source: 'user' });            // 锁定的不变
  assert.equal(out[1].model.model, 'big'); assert.equal(out[1].model.source, 'auto');
  assert.equal(out[2].model.model, 'small');                                                    // 旧的自动分配被更新
  assert.equal(nodes[1].model, undefined);                                                      // 入参未被修改
  const cleared = T.assignAll(out, []);                                                         // 档位被清空：自动的回到 null，锁定的仍在
  assert.equal(cleared[0].model.model, 'mine'); assert.equal(cleared[1].model, null);
});

test('规范化：长度恒为 5；缺字段、非对象、超长、控制字符都按“未配置”处理', () => {
  assert.equal(T.normalize(null).length, 5); assert.equal(T.normalize([1, 2, 3, 4, 5, 6, 7]).length, 5);
  assert.deepEqual(T.normalize([{ profileId: 'a' }, { model: 'm' }, 'x', null, { profileId: 'a\u0000b', model: 'm'.repeat(500) }]).map(x => x && x.profileId), [null, null, null, null, 'ab']);
  assert.equal(T.normalize([{ profileId: 'a', model: 'm'.repeat(500) }])[0].model.length, 120);
});

test('清理失效档位：厂商被删或模型被移出列表后，对应档位变回未配置，并告诉调用方清了哪几档', () => {
  const vendors = [{ profileId: 'a', models: ['x'] }, { profileId: 'b', models: ['y', 'z'] }];
  const { tiers, dropped } = T.prune([M('a', 'x'), M('gone', 'q'), M('b', 'removed'), M('b', 'z'), null], vendors);
  assert.deepEqual(tiers.map(t => t && t.model), ['x', null, null, 'z', null]); assert.deepEqual(dropped, [1, 2]);
  assert.deepEqual(T.prune([M('a', 'x')], []).dropped, [0]);
});

test('手动选择菜单：所有厂商的所有模型，两级（厂商 → 模型），不受五档限制；没有模型的厂商不出现', () => {
  const menu = T.menu([{ profileId: 'a', vendor: '厂商甲', models: ['m1', 'm2', 'm1'] }, { profileId: 'b', vendor: '厂商乙', models: [] }, { profileId: 'c', models: ['z'] }, null]);
  assert.deepEqual(menu, [{ profileId: 'a', vendor: '厂商甲', models: ['m1', 'm2'] }, { profileId: 'c', vendor: 'c', models: ['z'] }]);
});

test('所有 1-5 个已配置档位的组合（31 种）下，分配都不会越界、不会返回未配置的档位', () => {
  for (let mask = 1; mask < 32; mask++) {
    const tiers = Array.from({ length: 5 }, (_, i) => (mask & (1 << i) ? M('p', 'm' + i) : null));
    for (const d of [1, 2, 3, 4, 5, 'light', 'standard', 'strong']) { const a = T.assign(tiers, d); assert.ok(a && tiers[a.tier], '掩码 ' + mask + ' 难度 ' + d + ' 选到了未配置的档位'); }
  }
});
