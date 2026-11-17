'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { planWorkflow } = require('./workflow-plan-run.cjs');
const { callModel } = require('./provider-call.cjs');

const MULTI = '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。';
const node = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', brief: '做' + id, prompt: '指令 ' + id, tier: 'standard', dependsOn: [], ...extra });
const GOOD = JSON.stringify({ decision: 'split', goal: '选型汇报', nodes: [node('n1'), node('n2', { dependsOn: ['n1'] }), node('n3', { dependsOn: ['n2'] })] });
const fake = replies => { const seen = []; const call = async req => { seen.push(req); const r = replies.shift(); if (r instanceof Error) throw r; return { text: r, usage: { input: 100, output: 50 } }; }; call.seen = seen; return call; };

test('纯寒暄本地放行：不调用模型，零 token', async () => {
  const call = fake([GOOD]); const r = await planWorkflow({ message: '你好', call });
  assert.equal(r.kind, 'single'); assert.equal(r.calls, 0); assert.equal(call.seen.length, 0); assert.deepEqual(r.usage, { input: 0, output: 0 });
});

test('多步骤请求：调用一次模型，返回拆分结果与真实 token 用量', async () => {
  const call = fake([GOOD]); const r = await planWorkflow({ message: MULTI, call });
  assert.equal(r.kind, 'split'); assert.equal(r.plan.nodes.length, 3); assert.equal(r.calls, 1); assert.deepEqual(r.usage, { input: 100, output: 50, known: true });
  assert.match(call.seen[0].user, /^DATA_BEGIN/);
});

test('第一次格式错误：带错误列表修复重试一次，成功则返回拆分；用量累加两次', async () => {
  const call = fake(['不是 JSON', GOOD]); const r = await planWorkflow({ message: MULTI, call });
  assert.equal(r.kind, 'split'); assert.equal(r.calls, 2); assert.equal(r.usage.input, 200);
  assert.match(call.seen[1].user, /上次输出有问题/);
});

test('两次都失败：降级为“不拆”并说明原因，用户的问题不会丢', async () => {
  const call = fake(['坏的', '{"decision":"split","nodes":[{"id":"n1"}]}']); const r = await planWorkflow({ message: MULTI, call });
  assert.equal(r.kind, 'single'); assert.equal(r.fallback, true); assert.match(r.reason, /没能拆分/); assert.equal(r.calls, 2);
});

test('网络/超时错误：降级而不是抛出；但用户主动取消会向上抛出', async () => {
  const r = await planWorkflow({ message: MULTI, call: fake([new Error('HTTP 500')]) });
  assert.equal(r.kind, 'single'); assert.equal(r.fallback, true); assert.match(r.reason, /HTTP 500/);
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(() => planWorkflow({ message: MULTI, signal: ctl.signal, call: async () => { throw new Error('aborted'); } }));
});

test('服务商不返回用量时 known=false，不编造数字', async () => {
  const call = async () => ({ text: GOOD, usage: null }); const r = await planWorkflow({ message: MULTI, call });
  assert.equal(r.usage.known, false);
});

test('模型判断“不拆”时直接返回，不重试', async () => {
  const call = fake(['{"decision":"single","reason":"一句话能答"}']); const r = await planWorkflow({ message: MULTI, call });
  assert.equal(r.kind, 'single'); assert.equal(r.calls, 1); assert.notEqual(r.fallback, true);
});

test('与真实 HTTP 通道联调：拆解请求体经 callModel 发出，回复被解析成计划', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; seen.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 321, completion_tokens: 123 } })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const cfg = { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'k', model: 'planner-m' };
    const r = await planWorkflow({ message: MULTI, call: (req, opt) => callModel(cfg, { ...req, json: true }, opt) });
    assert.equal(r.kind, 'split'); assert.deepEqual(r.usage, { input: 321, output: 123, known: true });
    assert.equal(seen[0].model, 'planner-m'); assert.equal(seen[0].max_tokens, 1800); assert.equal(seen[0].messages[0].role, 'system');
  } finally { server.close(); }
});

test('画布已有工作流：追问/修改按模型判断返回；没有画布时模型误给 followup/edit 一律当普通对话（不信任模型）', async () => {
  const existing = [{ id: 'n0', title: '调研', status: 'done' }];
  for (const [reply, kind] of [['{"decision":"followup"}', 'followup'], ['{"decision":"edit","reason":"加节点"}', 'edit']]) {
    const call = fake([reply]); const r = await planWorkflow({ message: '第二点再解释一下', existing, call });
    assert.equal(r.kind, kind); assert.equal(r.calls, 1); assert.match(call.seen[0].user, /\[当前工作流\]/);
    const none = await planWorkflow({ message: '第二点再解释一下', existing: [], call: fake([reply]) });
    assert.equal(none.kind, 'single'); assert.match(none.reason, /还没有工作流/);
  }
});
