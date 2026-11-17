'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TOKENS } = require('./design-tokens.cjs');
const { filesFor } = require('./workbench-scaffold.cjs');
const workflow = require('./design-workflow.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const lower = text => text.toLowerCase();

test('宿主主题、脚手架与两份提示词使用同一套底色，不会漂移', () => {
  const theme = lower(read('runtime/theme-warm.css'));
  const scaffold = lower(filesFor({ id: 'x', name: 't' })['ui/styles.css']);
  const context = lower(read('contexts/workbench-design.js'));
  const rules = lower(workflow.stages.map(s => s.work).join('\n') + workflow.prompt({ workflow: { schema: 1, stage: 2, status: 'idle', revision: 0, attempt: null, report: null, accepted: [] } }));
  for (const key of ['bg', 'surface', 'text', 'muted', 'line', 'accent', 'ok', 'warn', 'error']) {
    const value = TOKENS[key];
    assert.ok(scaffold.includes(value), 'scaffold styles.css 缺少 ' + key + ' ' + value);
    assert.ok(context.includes(value), 'workbench-design 提示词缺少 ' + key + ' ' + value);
  }
  for (const key of ['bg', 'surface', 'text', 'muted', 'line', 'accent']) assert.ok(theme.includes(TOKENS[key]), '宿主 theme-warm.css 缺少 ' + key + ' ' + TOKENS[key]);
  for (const key of ['bg', 'surface', 'text', 'accent']) assert.ok(rules.includes(TOKENS[key]), '阶段提示词缺少 ' + key + ' ' + TOKENS[key]);
});

test('提示词里不再出现旧的蓝色强调、让用户选主题或“浅色底、蓝色强调”的说法', () => {
  const all = lower(read('contexts/workbench-design.js') + read('runtime/design-workflow.js'));
  for (const stale of ['#4268d5', '蓝色强调', '明或暗主题', '浅色底、蓝色']) assert.ok(!all.includes(stale), '残留旧说法：' + stale);
});

test('脚手架的新工作台只用令牌变量，不含旧的冷灰蓝底色', () => {
  const styles = lower(filesFor({ id: 'x', name: 't' })['ui/styles.css']);
  for (const old of ['#fafbfc', '#f6f7f9', '#f3f5f8', '#4268d5', '#eef2fe']) assert.ok(!styles.includes(old), '脚手架残留旧色 ' + old);
  assert.match(styles, /background:var\(--bg\)/);
});
