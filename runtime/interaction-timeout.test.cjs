'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./interaction-timeout.js');

test('默认不自动选择：替用户做决定必须是他主动开启的；非法值回落为 0', () => {
  assert.equal(T.DEFAULT_SECONDS, 0);
  assert.deepEqual([undefined, null, 'x', -5, 17, 30, '60'].map(T.normalizeSeconds), [0, 0, 0, 0, 0, 30, 60]);
  assert.equal(T.autoAnswer({ method: 'select', options: ['A', 'B'] }, 0), null);
});
test('选择题：按 recommended（下标或文字）选；没指定就取第一项；下标越界/文字不存在也回落到第一项', () => {
  const opts = ['快速', '标准', '完整'];
  assert.deepEqual(T.autoAnswer({ method: 'select', options: opts }, 30).response, { value: '快速' });
  assert.deepEqual(T.autoAnswer({ method: 'select', options: opts, recommended: 1 }, 30).response, { value: '标准' });
  assert.deepEqual(T.autoAnswer({ method: 'select', options: opts, recommended: '完整' }, 30).response, { value: '完整' });
  assert.deepEqual(T.autoAnswer({ method: 'select', options: opts, recommended: 9 }, 30).response, { value: '快速' });
  assert.deepEqual(T.autoAnswer({ method: 'select', options: opts, recommended: '不存在' }, 30).response, { value: '快速' });
  assert.equal(T.autoAnswer({ method: 'select', options: opts, recommended: 2 }, 60).seconds, 60);
});
test('确认题：只有 Agent 明确给了 recommended 才自动答；没给就不自动（确认/取消没有天然默认）', () => {
  assert.equal(T.autoAnswer({ method: 'confirm', message: '继续？' }, 30), null);
  assert.deepEqual(T.autoAnswer({ method: 'confirm', recommended: true }, 30).response, { confirmed: true });
  assert.deepEqual(T.autoAnswer({ method: 'confirm', recommended: false }, 30).response, { confirmed: false });
});
test('输入题、编辑题、空选项、空请求：永不自动答', () => {
  for (const r of [{ method: 'input' }, { method: 'editor' }, { method: 'select', options: [] }, { method: 'select' }, null, undefined]) assert.equal(T.autoAnswer(r, 30), null);
  assert.equal(T.autoAnswer({ method: 'select', options: ['', 5, null] }, 30), null);
});
test('展示用的推荐项下标', () => {
  assert.equal(T.recommendedOf({ method: 'select', options: ['a', 'b'], recommended: 1 }), 1);
  assert.equal(T.recommendedOf({ method: 'select', options: ['a', 'b'] }), 0);
  assert.equal(T.recommendedOf({ method: 'confirm' }), -1);
  assert.equal(T.recommendedOf(null), -1);
});

test('扩展把推荐项编进标记里：界面取出并去掉标记，坏标记不会让请求出错', () => {
  const M = (j) => '⁣REC:' + j + '⁣';
  const r = T.extract({ method: 'select', title: '选方案', message: '用哪个？' + M('1'), options: ['a', 'b'] });
  assert.equal(r.recommended, 1); assert.equal(r.message, '用哪个？'); assert.ok(!JSON.stringify(r).includes('REC'));
  assert.equal(T.extract({ method: 'confirm', title: 't', message: '继续？' + M('true') }).recommended, true);
  assert.equal(T.extract({ method: 'select', message: 'm' + M('{坏的') , options: ['a'] }).recommended, undefined);
  assert.deepEqual(T.extract({ method: 'input', title: 't' }), { method: 'input', title: 't' });
  assert.equal(T.extract(null), null);
  assert.equal(T.autoAnswer(T.extract({ method: 'select', message: 'm' + M('"b"'), options: ['a', 'b'] }), 30).response.value, 'b');
});
