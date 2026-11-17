'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadInspector() {
  const sandbox = { structuredClone, window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'context-inspector.js'), 'utf8'), sandbox, { filename: 'context-inspector.js' });
  return sandbox.window.PiContextInspector;
}

function snapshot(inspector, task, extra = {}) {
  return inspector.buildSnapshot({
    task,
    project: { id: 'project-1', name: '测试项目' },
    context: { core: { id: 'core', prompt: '只读系统规则' } },
    ...extra
  });
}

test('block edits are local overrides and preserve raw chat', () => {
  const inspector = loadInspector();
  const messages = [{ id: 'm1', role: 'user', text: '原始用户消息' }, { id: 'm2', role: 'assistant', text: '原始 Agent 消息' }];
  const task = { id: 'task-1', name: '任务', messages };
  inspector.ensure(task);
  inspector.update(task, {
    blockEdits: {
      'conversation:recent': '仅发送这段本地会话覆盖',
      'memory:fact-1': '仅发送这段记忆覆盖'
    },
    summary: '用户编辑的压缩摘要'
  }, '编辑区块');

  const result = snapshot(inspector, task, { memory: { items: [{ id: 'fact-1', content: '原始记忆' }] } });
  assert.equal(result.blocks.find(block => block.id === 'conversation:recent').content, '仅发送这段本地会话覆盖');
  assert.equal(result.blocks.find(block => block.id === 'memory:fact-1').content, '仅发送这段记忆覆盖');
  assert.equal(result.blocks.find(block => block.id === 'conversation:summary').content, '用户编辑的压缩摘要');
  assert.deepEqual(task.messages, messages);
  assert.deepEqual(inspector.materialize({ blockEdits: { 'system:core': '不应被接受', 'tools:file-io': '工具覆盖' } }).blockEdits, { 'tools:file-io': '工具覆盖' });
});

test('history restore and undo publish one atomic revision with a diff', () => {
  const inspector = loadInspector();
  const task = { id: 'task-history', name: '历史', messages: [] };
  inspector.ensure(task);
  const first = inspector.update(task, { goal: '第一版' }, '编辑目标');
  const firstHistoryId = task.context.history[0].id;
  inspector.update(task, { blockEdits: { 'tools:file-io': '工具本地版' } }, '编辑工具');
  assert.equal(task.context.overrides.goal, '第一版');
  assert.equal(task.context.overrides.blockEdits['tools:file-io'], '工具本地版');
  assert.ok(inspector.diff(task.context.history[1].before, task.context.history[1].after).some(item => item.key === 'goal'));

  assert.equal(inspector.restore(task, firstHistoryId), true);
  assert.equal(task.context.overrides.goal, '');
  assert.deepEqual(task.context.overrides.blockEdits, {});
  const revisionAfterRestore = task.context.revision;
  assert.equal(inspector.undo(task), true);
  assert.equal(task.context.revision, revisionAfterRestore + 1);
  assert.equal(task.context.overrides.goal, '第一版');
  assert.equal(inspector.undo(task), true);
  assert.equal(task.context.overrides.goal, '第一版');
  assert.equal(inspector.undo(task), true);
  assert.equal(task.context.overrides.goal, '');
  assert.equal(inspector.undo(task), false);
  assert.deepEqual(first.blockEdits, {});
});

test('mount keeps task UI state but refreshes callbacks when the surface is reused', () => {
  const inspector = loadInspector();
  const listeners = {};
  const container = {
    innerHTML: '',
    addEventListener(type, listener) { listeners[type] = listener; }
  };
  const taskA = { id: 'task-a', context: { overrides: {} } };
  const taskB = { id: 'task-b', context: { overrides: {} } };
  const calls = [];
  const makeOptions = task => ({
    task,
    snapshot: { taskId: task.id, blocks: [], enabledBlocks: [], usedTokens: 0, windowTokens: null, percent: null, reserveTokens: 4096, overrides: {}, audit: { status: 'clean', issues: [] } },
    onAction: name => calls.push(`${task.id}:${name}`)
  });
  inspector.mount(container, makeOptions(taskA));
  inspector.mount(container, makeOptions(taskB));
  listeners.click({ target: { closest: selector => selector === '[data-context-action]' ? { dataset: { contextAction: 'refresh' } } : null } });
  assert.deepEqual(calls, ['task-b:refresh']);
  assert.ok(container.innerHTML.includes('窗口未知，请在设置里填写'));
  assert.equal(container.innerHTML.includes('128k'), false);
});

test('unknown context capacity does not create threshold warnings or a fabricated window', () => {
  const inspector = loadInspector();
  const task = { id: 'task-capacity', name: '容量', messages: [] };
  const result = snapshot(inspector, task, { contextWindow: undefined });
  assert.equal(result.windowTokens, null);
  assert.equal(result.percent, null);
  assert.equal(result.audit.issues.some(issue => /容量|使用量/.test(issue.label)), false);
  assert.equal(inspector.formatTokens(result.windowTokens), '未知');
});

test('design context compacts old dialogue and tool output before sending to the provider', () => {
  const inspector = loadInspector();
  const huge = 'README content '.repeat(5000);
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: 'm-' + index,
    role: index % 2 ? 'assistant' : 'user',
    text: huge
  }));
  messages[19].run = { steps: Array.from({ length: 20 }, (_, index) => ({ kind: 'tool', status: 'done', tool: 'read', target: 'file-' + index, output: huge })) };
  const result = snapshot(inspector, { id: 'task-large', name: '设计任务', messages }, {
    contextMode: 'design',
    context: { mode: 'design', core: { id: 'core', prompt: '核心规则' }, contexts: [] },
    workbenchState: { revision: 1, layout: Array.from({ length: 100 }, (_, index) => ({ id: index, html: huge })) }
  });
  const dialogue = result.blocks.find(block => block.id === 'conversation:recent');
  const io = result.blocks.find(block => block.id === 'tools:file-io');
  const state = result.blocks.find(block => block.id === 'tools:workbench-state');
  assert.ok(dialogue.content.length <= 9000);
  assert.ok(io.content.length <= 9000);
  assert.equal(state.content, JSON.stringify({ revision: 1, layout: Array.from({ length: 100 }, (_, index) => ({ id: index, html: huge })) }, null, 2));
  assert.equal(state.truncated, false);
  assert.equal(result.audit.issues.some(issue => /安全裁剪/.test(issue.label)), true);
  assert.match(dialogue.content, /原始记录仍保留/);
});

test('reserveTokens is user adjustable and clamped', () => {
  const inspector = loadInspector();
  const task = { id: 'task-reserve', name: '预留', messages: [], context: { overrides: { settings: { reserveTokens: '8192' } } } };
  assert.equal(snapshot(inspector, task, { contextWindow: 100000 }).reserveTokens, 8192);
  task.context.overrides.settings.reserveTokens = 10;
  assert.equal(snapshot(inspector, task, {}).reserveTokens, 256);
  task.context.overrides.settings.reserveTokens = 9e9;
  assert.equal(snapshot(inspector, task, {}).reserveTokens, 65536);
});
