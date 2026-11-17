'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'contexts');

// 在最小的 window 里执行每个上下文文件，收集它注册的 (键, 条目)。
function loadAll(subdir) {
  const out = [];
  for (const file of fs.readdirSync(path.join(dir, subdir)).filter(f => f.endsWith('.js'))) {
    const window = { PiContextRegistry: {}, PiWorkbenchPlugins: {} };
    new Function('window', fs.readFileSync(path.join(dir, subdir, file), 'utf8'))(window);
    for (const [key, item] of Object.entries(window.PiContextRegistry)) out.push({ file, key, item });
  }
  return out;
}

test('每个工作台上下文：注册表的键 = 条目的 id = "workbench:<文件名>"，否则加载后提示词会静默丢失', () => {
  const all = loadAll('workbenches');
  assert.ok(all.length >= 5, '至少应有 5 个内置工作台上下文，实际 ' + all.length);
  for (const { file, key, item } of all) {
    const name = file.replace(/.js$/, '');
    assert.equal(key, 'workbench:' + name, file + '：注册键应为 workbench:' + name);
    assert.equal(item.id, key, file + '：条目的 id（' + item.id + '）必须等于注册键（' + key + '）');
    assert.ok(typeof item.prompt === 'string' && item.prompt.length > 10, file + '：缺少 prompt');
    assert.ok(Array.isArray(item.actions) && item.actions.length, file + '：缺少 actions');
  }
});

test('工作流上下文声明的动作与 manifest 完全一致（双向）', () => {
  const ctx = loadAll('workbenches').find(x => x.file === 'workflow.js').item;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workbenches', 'workflow', 'manifest.json'), 'utf8'));
  assert.deepEqual([...ctx.actions].sort(), manifest.actions.map(a => a.name).sort());
});

test('工作流模式提示词的关键约束都在：直接开始、不读仓库、少提问、简短回复、改计划带版本、失败不重复重试', () => {
  const { prompt } = loadAll('workbenches').find(x => x.file === 'workflow.js').item;
  for (const phrase of ['直接开始做', '不要先去读项目目录', 'interaction_request', '一次最多问 1 个问题', '不要在聊天里复述计划', 'baseRevision', '不要反复重试']) assert.ok(prompt.includes(phrase), '缺少要点：' + phrase);
  const est = t => { let c = 0, o = 0; for (const ch of t) /[㐀-鿿　-〿＀-￯]/.test(ch) ? c++ : o++; return Math.round(c / 1.7 + o / 4); };
  assert.ok(est(prompt) <= 400, '工作流提示词应当精简（≤400 token），实际约 ' + est(prompt));
});
