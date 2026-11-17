'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('./design-workflow.js');

function design() { return { stage: 4, history: [] }; }
test('length recovery preserves the stage attempt and report until a successful settlement',()=>{
  const item=design();workflow.begin(item,{revision:0,requestId:'a'});workflow.attach(item,'a','r');
  workflow.report(item,{stage:0,attemptId:'a',summary:'已写入',evidence:['ui/index.html']},'r');
  assert.equal(workflow.view(item).status,'running');
  // A supervisor recovery has no terminal settle event until its budget ends.
  assert.equal(workflow.view(item).attempt.id,'a');
  workflow.settle(item,'r','complete');
  assert.equal(workflow.view(item).status,'review');assert.equal(workflow.view(item).stage,0);
  assert.match(workflow.explainError('单次模型输出被截断 stopReason=length'),/小批次/);
  assert.match(workflow.explainError('context_length_exceeded'),/输入上下文/);
  const failed=design();workflow.begin(failed,{revision:0,requestId:'old'});workflow.attach(failed,'old','r2');
  workflow.report(failed,{stage:0,attemptId:'old',summary:'已写文件',evidence:['ui/index.html']},'r2');
  workflow.settle(failed,'r2','error','单次模型输出被截断');
  workflow.begin(failed,{revision:workflow.view(failed).revision,requestId:'new'});
  assert.equal(workflow.view(failed).attemptHistory[0].report.summary,'已写文件');
  assert.equal(workflow.view(failed).attemptHistory[0].attempt.id,'old');
  assert.equal(workflow.view(failed).stage,0);
});

test('设计流程把旧阶段计数迁移为待开始，而不是伪造已确认进度', () => {
  const item = design();
  const view = workflow.view(item);
  assert.equal(view.stage, 0);
  assert.equal(view.status, 'idle');
  assert.equal(item.stage, 0);
  assert.equal(item.completed, false);
});

test('确认设计阶段会创建执行批次，报告后才进入待确认', () => {
  const item = design();
  const started = workflow.begin(item, { revision: 0, requestId: 'request-1' });
  assert.equal(started.stage, 0);
  assert.equal(workflow.view(item).status, 'running');
  assert.throws(() => workflow.begin(item, { revision: 1, requestId: 'request-duplicate' }), /正在执行/);
  workflow.attach(item, 'request-1', 'run-1');
  assert.throws(() => workflow.report(item, { stage: 0, attemptId: 'request-1', summary: '缺少证据', evidence: [] }, 'run-1'), /summary 和.*evidence/);
  workflow.report(item, { stage: 0, attemptId: 'request-1', summary: '需求边界已整理', evidence: ['task/design.md'] }, 'run-1');
  assert.equal(workflow.view(item).status, 'running');
  assert.equal(workflow.settle(item, 'run-1', 'complete'), true);
  assert.equal(workflow.view(item).status, 'review');
  assert.equal(workflow.view(item).report.summary, '需求边界已整理');
});

test('用户确认待审阅结果后才进入下一阶段，继续修改不会跳阶段', () => {
  const item = design();
  workflow.begin(item, { revision: 0, requestId: 'request-1' });
  workflow.attach(item, 'request-1', 'run-1');
  workflow.report(item, { stage: 0, attemptId: 'request-1', summary: '需求已完成', evidence: ['requirements.md'] }, 'run-1');
  workflow.settle(item, 'run-1', 'complete');
  const reviewRevision = workflow.view(item).revision;
  const revised = workflow.begin(item, { revision: reviewRevision, requestId: 'request-2', revise: true });
  assert.equal(revised.stage, 0);
  assert.equal(workflow.view(item).status, 'running');
  workflow.attach(item, 'request-2', 'run-2');
  workflow.report(item, { stage: 0, attemptId: 'request-2', summary: '需求已按反馈修订', evidence: ['requirements-v2.md'] }, 'run-2');
  workflow.settle(item, 'run-2', 'complete');
  const next = workflow.begin(item, { revision: workflow.view(item).revision, requestId: 'request-3' });
  assert.equal(next.stage, 1);
  assert.equal(workflow.view(item).status, 'running');
  assert.equal(workflow.view(item).accepted.length, 1);
});

test('执行失败或停止不会推进设计阶段', () => {
  const item = design();
  workflow.begin(item, { revision: 0, requestId: 'request-1' });
  workflow.attach(item, 'request-1', 'run-1');
  assert.equal(workflow.settle(item, 'run-1', 'error', '工具失败'), true);
  assert.equal(workflow.view(item).status, 'error');
  assert.equal(workflow.view(item).stage, 0);
  const retry = workflow.begin(item, { revision: workflow.view(item).revision, requestId: 'request-2' });
  assert.equal(retry.stage, 0);
  workflow.interrupt(item);
  assert.equal(workflow.view(item).status, 'interrupted');
  assert.equal(workflow.view(item).stage, 0);
});

test('失败阶段保留原始错误，并给出可执行的超时原因', () => {
  const item = design();
  workflow.begin(item, { revision: 0, requestId: 'request-timeout' });
  workflow.attach(item, 'request-timeout', 'run-timeout');
  workflow.settle(item, 'run-timeout', 'error', 'Request timed out.');
  const view = workflow.view(item);
  assert.equal(view.rawError, 'Request timed out.');
  assert.match(view.error, /模型请求超时/);
  assert.match(view.error, /API 地址|网络|更换模型/);
});
