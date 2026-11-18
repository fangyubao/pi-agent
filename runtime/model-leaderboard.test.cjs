'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LB = require('./model-leaderboard.js');

test('模型归一化匹配：准确识别真实中转/CLI 模型名，且严格区分 flash/mini 与 pro/r1', () => {
  const snap = LB.defaultSnapshot();
  assert.equal(LB.matchModel('deepseek-v4.1-flash-sg', snap).id, 'deepseek-flash');
  assert.equal(LB.matchModel('deepseek-v4-pro-0813', snap).id, 'deepseek-v4-pro');
  assert.equal(LB.matchModel('deepseek-r1-0528', snap).id, 'deepseek-r1');
  assert.equal(LB.matchModel('opencode/glm-5.3-flash-free', snap).id, 'glm-flash');
  assert.equal(LB.matchModel('gpt-6.1-sol', snap).id, 'gpt-5-pro');
  assert.equal(LB.matchModel('grok-4.7', snap).id, 'grok-4');
  assert.equal(LB.matchModel('gemini-3.8-flash-tiered', snap).id, 'gemini-2.5-flash');
  assert.equal(LB.matchModel('main', snap), null);
  assert.equal(LB.matchModel('relay-main', snap), null);
});

test('全球排名与本地拥有模型相对排名：实时计算 6 大领域在当前拥有模型中的名次', () => {
  const owned = ['deepseek-v4.1-flash-sg', 'gpt-6.1-sol', 'deepseek-r1', 'opencode/glm-5.3-flash-free'];
  const r1 = LB.describeModel('deepseek-r1', owned);
  const flash = LB.describeModel('deepseek-v4.1-flash-sg', owned);
  const gpt = LB.describeModel('gpt-6.1-sol', owned);

  assert.ok(r1 && flash && gpt);
  assert.equal(r1.domains.math.localTotal, 4);
  // DeepSeek R1 在这 4 个自有模型里数学推理排第 1
  assert.equal(r1.domains.math.localRank, 1);
  assert.equal(r1.domains.math.isLocalTop, true);
  // GPT-6.1-sol 在这 4 个自有模型里综合与编程排第 1
  assert.equal(gpt.domains.overall.localRank, 1);
  assert.equal(gpt.domains.coding.localRank, 1);
  // DeepSeek Flash 比 GLM Flash 强，但排在 GPT 与 R1 之后（第 3 / 4 名）
  assert.equal(flash.domains.overall.localRank, 3);
  assert.ok(flash.domains.overall.globalRank > gpt.domains.overall.globalRank);
});

test('任务领域自动识别与 5 档智能推荐：按领域关键词归类，按综合实力由轻到强推荐 5 档', () => {
  assert.equal(LB.inferCategory({ title: 'API契约与数据库实现', prompt: '编写 SQL 与后端接口代码' }), 'coding');
  assert.equal(LB.inferCategory({ title: '量子模拟器边界计算', prompt: '推导矩阵概率与复杂度公式' }), 'math');
  assert.equal(LB.inferCategory({ title: '宣传文案润色', prompt: '改写品牌故事与修辞' }), 'writing');

  const vendors = [
    { profileId: 'p1', vendor: 'A', models: ['opencode/glm-5.3-flash-free', 'deepseek-v4.1-flash-sg'] },
    { profileId: 'p2', vendor: 'B', models: ['deepseek-v3', 'gpt-6.1-sol'] }
  ];
  const tiers = LB.recommendTiers(vendors);
  assert.equal(tiers.length, 5);
  assert.equal(tiers[0].model, 'opencode/glm-5.3-flash-free');
  assert.equal(tiers[4].model, 'gpt-6.1-sol');
});
