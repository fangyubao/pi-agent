'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('./execution-graph.js');
const transcript = require('./transcript.js');

function message(id = 'run-1') {
  const value = { id, role: 'assistant', text: '' };
  value.run = { status: 'running', steps: [], changedFiles: [], startedAt: 1000 };
  graph.start(value);
  return value;
}

test('tool timeline records observed order and does not invent overlap dependencies', () => {
  const value = message();
  graph.apply(value, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'a.txt' }, timestamp: 1100 });
  graph.apply(value, { type: 'tool_execution_start', toolCallId: 'overlap', toolName: 'grep', args: {}, timestamp: 1150 });
  graph.apply(value, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', timestamp: 1300 });
  graph.apply(value, { type: 'tool_execution_end', toolCallId: 'overlap', toolName: 'grep', timestamp: 1250 });
  graph.apply(value, { type: 'tool_execution_start', toolCallId: 'b', toolName: 'write', args: { path: 'b.txt' }, timestamp: 1400 });
  graph.apply(value, { type: 'tool_execution_end', toolCallId: 'b', toolName: 'write', timestamp: 1500 });
  const nodes = value.run.graph.nodes;
  assert.deepEqual(nodes.find(node => node.id === 'b').dependencies, ['a', 'overlap']);
  assert.deepEqual(nodes.find(node => node.id === 'overlap').dependencies, []);
  assert.equal(nodes.find(node => node.id === 'a').file, 'a.txt');
  assert.equal(nodes.find(node => node.id === 'b').status, 'done');
});

test('optimized temporal edges match the maximal predecessor definition with parallel, equal-time, nested and out-of-order events',()=>{
  const value=message();let seed=83;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const nodes=Array.from({length:90},(_,i)=>{const at=1000+Math.floor(random()*30)*10;return {id:'node-'+i,kind:'tool',parentId:i%4?'root':'child',status:'done',startedAt:at,finishedAt:at+Math.floor(random()*8)*10};});
  for(const node of nodes)graph.apply(value,{type:'execution_node',node,timestamp:node.finishedAt});
  for(const node of value.run.graph.nodes){
    const before=value.run.graph.nodes.filter(other=>other!==node&&other.parentId===node.parentId&&other.finishedAt!=null&&other.startedAt!=null&&(other.finishedAt<node.startedAt||other.finishedAt===node.startedAt&&other.finishOrder<node.startOrder));
    const expected=before.filter(a=>!before.some(b=>a!==b&&(a.finishedAt<b.startedAt||a.finishedAt===b.startedAt&&a.finishOrder<b.startOrder))).map(n=>n.id);
    assert.deepEqual(node.dependencies,expected,node.id);
  }
});

test('explicit execution nodes support branch, join, retry, and idempotent replay', () => {
  const value = message();
  const emit = node => graph.apply(value, { type: 'execution_node', node, timestamp: node.startedAt ?? node.finishedAt });
  emit({ id: 'root', kind: 'task', label: '主任务', status: 'running', startedAt: 1100 });
  emit({ id: 'left', kind: 'subagent', parentId: 'root', label: '左分支', status: 'done', startedAt: 1200, finishedAt: 1300 });
  emit({ id: 'right', kind: 'subagent', parentId: 'root', label: '右分支', status: 'done', startedAt: 1200, finishedAt: 1300 });
  emit({ id: 'join', kind: 'task', parentId: 'root', dependencies: ['left', 'right'], label: '汇合', status: 'done', startedAt: 1400, finishedAt: 1500 });
  emit({ id: 'retryable', kind: 'tool', label: '第一次', status: 'error', startedAt: 1600, finishedAt: 1650 });
  emit({ id: 'retryable', kind: 'tool', attempt: 2, label: '重试', status: 'done', startedAt: 1700, finishedAt: 1800 });
  const retry = value.run.graph.nodes.find(node => node.id === 'retryable::attempt:2');
  assert.equal(retry.retryOf, 'retryable');
  assert.deepEqual(value.run.graph.nodes.find(node => node.id === 'join').dependencies, ['left', 'right']);
  const before = value.run.graph.nodes.length;
  const replay = graph.apply(value, { type: 'execution_node', eventId: 'same', node: { id: 'new', status: 'done' }, timestamp: 1900 });
  const replayAgain = graph.apply(value, { type: 'execution_node', eventId: 'same', node: { id: 'new', status: 'done' }, timestamp: 1900 });
  assert.equal(replay.duplicate, undefined);
  assert.equal(replayAgain.duplicate, true);
  assert.equal(value.run.graph.nodes.length, before + 1);
});

test('settling a run interrupts unfinished children and keeps explicit status', () => {
  const value = message();
  graph.apply(value, { type: 'subagent_start', subagentId: 'child', parentId: 'root', timestamp: 1200 });
  graph.finish(value, 'stopped', 1600);
  assert.equal(value.run.graph.nodes[0].status, 'stopped');
  assert.equal(value.run.graph.nodes[0].interrupted, true);
  assert.equal(value.run.graph.nodes[0].finishedAt, 1600);
});

test('usage is accumulated from actual messages once and speed excludes tool time', () => {
  const value = message();
  graph.apply(value, { type: 'tool_execution_start', toolCallId: 'wait', toolName: 'bash', timestamp: 1200 });
  graph.apply(value, { type: 'tool_execution_end', toolCallId: 'wait', toolName: 'bash', timestamp: 1800 });
  graph.apply(value, { type: 'message_start', message: { role: 'assistant', responseId: 'response-1' }, timestamp: 2000 });
  graph.apply(value, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' }, timestamp: 2100 });
  const end = { type: 'message_end', message: { role: 'assistant', responseId: 'response-1', content: [{ type: 'text', text: 'answer' }], usage: { input: 10, output: 100, cacheRead: 3, cacheWrite: 1, totalTokens: 114 } }, timestamp: 3100 };
  graph.apply(value, end);
  graph.apply(value, end);
  graph.finish(value, 'done', 3100);
  const metrics = graph.metrics(value, 3100);
  assert.deepEqual(value.run.usage, { input: 10, output: 100, cacheRead: 3, cacheWrite: 1, totalTokens: 114 });
  assert.equal(metrics.firstTokenLatencyMs, 1100);
  assert.equal(metrics.generationMs, 1000);
  assert.equal(metrics.tokensPerSecond, 100);
  assert.equal(metrics.speedEstimated, false);
  assert.match(graph.metricsMarkup(value), /Token 来自模型 usage/);
});

test('transcript keeps existing rendering and exposes summary contracts', () => {
  const value = { id: 'summary', text: '', run: { status: 'running', startedAt: 1000, steps: [], changedFiles: [] } };
  graph.start(value);
  transcript.apply(value, { type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: 'README.md' }, timestamp: 1100 });
  transcript.apply(value, { type: 'tool_execution_end', toolCallId: 'tool', toolName: 'read', timestamp: 1200 });
  transcript.finish(value, 'done');
  const html = transcript.progressMarkup(value, true, text => text);
  assert.match(html, /Files/);
  assert.match(html, /Execution graph/);
  assert.match(html, /Run summary/);
  assert.match(html, /data-action="focus-run-step"/);
  assert.equal(typeof transcript.graphMarkup, 'function');
  assert.equal(typeof transcript.metricsMarkup, 'function');
});

test('transcript exposes failed tool, target and error instead of only saying no final answer', () => {
  const value = message('failed-run');
  transcript.apply(value, { type: 'tool_execution_start', toolCallId: 'tool', toolName: 'powershell', args: { command: 'npm install missing-package' }, timestamp: 1100 });
  transcript.apply(value, { type: 'tool_execution_end', toolCallId: 'tool', toolName: 'powershell', isError: true, result: { content: [{ type: 'text', text: 'Request timed out.' }] }, timestamp: 1200 });
  transcript.apply(value, { type: 'agent_settled', timestamp: 1300 });
  const html = transcript.progressMarkup(value, true, text => text);
  assert.equal(value.run.status, 'error');
  assert.match(value.run.error, /Request timed out/);
  assert.match(html, /1 项操作失败/);
  assert.match(html, /执行命令/);
  assert.match(html, /npm install missing-package/);
  assert.match(html, /Request timed out/);
});

test('transcript exposes provider length stop reason and usage instead of a generic missing-final message', () => {
  const value = message('length-run');
  transcript.apply(value, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '模型正在整理，但没有产生最终答复。' }],
      stopReason: 'length',
      rawStopReason: 'length',
      usage: { input: 34001, output: 1572, reasoning: 1572, totalTokens: 35573 }
    },
    timestamp: 1200
  });
  transcript.apply(value, { type: 'agent_settled', timestamp: 1300 });
  assert.equal(value.run.status, 'error');
  assert.equal(value.run.stopReason, 'length');
  assert.match(value.run.error, /单次模型输出被截断/);
  assert.match(value.run.error, /34,001/);
  assert.match(value.text, /小批次续接/);
});
