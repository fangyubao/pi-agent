'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('./agent-recovery.cjs');
const { buildModel } = require('./pi-model.cjs');

test('classifies process failures as bounded rebuilds and refuses auth failures', () => {
  const processFailure = recovery.diagnose({ attemptError: 'Agent process stdin error: write EPIPE', tools: [] });
  assert.equal(processFailure.code, 'PROCESS');
  assert.equal(processFailure.retryable, true);
  assert.equal(processFailure.action, 'rebuild');
  const authFailure = recovery.diagnose({ attemptError: 'HTTP 401 invalid api key', tools: [] });
  assert.equal(authFailure.code, 'AUTH');
  assert.equal(authFailure.retryable, false);
});

test('classifies a failed tool with its concrete target instead of generic failure', () => {
  const run = { tools: [{ tool: 'read', target: 'src/missing.ts', status: 'error', output: 'ENOENT: no such file or directory' }] };
  const failure = recovery.diagnose(run);
  assert.equal(failure.code, 'DEPENDENCY');
  assert.equal(failure.tool.target, 'src/missing.ts');
  assert.match(failure.reason, /ENOENT/);
});

test('successful final response wins over an earlier recoverable tool error', () => {
  const result = recovery.diagnose({
    tools: [{ tool: 'read', target: 'src/optional.ts', status: 'error', output: 'not found' }],
    lastAssistant: { role: 'assistant', content: [{ type: 'text', text: '已使用现有文件完成并验证。' }], stopReason: 'stop' }
  });
  assert.equal(result, null);
});

test('retry budget stops after two attempts and recovery prompt preserves evidence', () => {
  const failure = { code: 'PROCESS', title: '进程失效', reason: 'write EPIPE', retryable: true, action: 'rebuild' };
  assert.equal(recovery.decide({ recoveryAttempts: 0 }, failure).retry, true);
  assert.equal(recovery.decide({ recoveryAttempts: 1 }, failure).retry, true);
  const exhausted = recovery.decide({ recoveryAttempts: 2 }, failure);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.failure.exhausted, true);
  const prompt = recovery.resumePrompt({ message: '修复当前工作台' }, { tools: [{ tool: 'read', target: 'workbench.json', status: 'error', output: 'ENOENT' }] }, failure, { workbenchState: { revision: 4 } });
  assert.match(prompt, /agent_diagnostics/);
  assert.match(prompt, /workbench\.json/);
  assert.match(prompt, /修复当前工作台/);
});

test('length output is separate from context overflow and earlier tool errors', () => {
  const failure = recovery.diagnose({ tools: [{ tool: 'workbench_action', target: 'readTaskContext', status: 'error', output: '当前工作台未声明该动作' }], lastAssistant: { role: 'assistant', content: [], stopReason: 'length', usage: { input: 265, output: 8192 } } });
  assert.equal(failure.code, 'OUTPUT_LIMIT');
  assert.equal(failure.action, 'continue');
  assert.equal(failure.tool.target, 'readTaskContext');
  assert.match(failure.reason, /8192/);
  assert.equal(recovery.diagnose({ attemptError: 'context_length_exceeded: maximum context length exceeded', tools: [] }).code, 'CONTEXT_LIMIT');
  assert.equal(recovery.diagnose({ lastAssistant: { content: 'partial', rawStopReason: 'length' }, tools: [] }).code, 'OUTPUT_LIMIT');
  const prompt = recovery.resumePrompt({ message: '设计当前阶段' }, { tools: [] }, failure, { marker: 'SNAPSHOT_NOT_DUPLICATED' });
  assert.match(prompt, /小型参数/);
  assert.doesNotMatch(prompt, /SNAPSHOT_NOT_DUPLICATED/);
});

test('unavailable actions retain concrete evidence, permissions and cancellation stop recovery', () => {
  assert.equal(recovery.diagnose({ tools: [{ status: 'error', output: '当前工作台未声明该动作：readTaskContext' }] }).code, 'ACTION_UNAVAILABLE');
  for (const error of ['用户未批准此操作', 'HTTP 401 unauthorized', 'HTTP 402 insufficient balance']) {
    assert.equal(recovery.decide({}, recovery.diagnose({ attemptError: error })).retry, false);
  }
  assert.equal(recovery.decide({ cancelled: true }, { retryable: true }).retry, false);
  for(const error of ['用户未批准此操作','HTTP 401 unauthorized','HTTP 402 insufficient balance']) {
    const f=recovery.diagnose({lastAssistant:{content:[],stopReason:'length'},tools:[{status:'error',output:error}]});
    assert.equal(f.retryable,false);
  }
  assert.equal(recovery.diagnose({attemptError:'输入上下文未超限，本次为网络超时'}).code,'TRANSIENT');
});

test('explicit output limit respects declared context and does not guess provider capabilities', () => {
  assert.equal(buildModel({ contextWindow: 65536, maxOutputTokens: 16384 }).maxTokens, 16384);
  assert.equal(buildModel({ contextWindow: 8192, maxOutputTokens: 16384 }).maxTokens, 7168);
  assert.equal(buildModel({}).maxTokens, 32768);
  // A 34k-token prompt must not squeeze the default output budget (Pi clamps to window - input - 4096).
  assert.ok(buildModel({}).contextWindow - 34001 - 4096 >= buildModel({}).maxTokens);
});

test('DeepSeek capability stays enabled while selected effort off sends an explicit disabled-thinking model', () => {
  const model = buildModel({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', effort: 'off' });
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.thinkingFormat, 'deepseek');
  assert.equal(model.contextWindow, 200000);
});
