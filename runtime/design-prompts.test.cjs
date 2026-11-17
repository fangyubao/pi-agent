'use strict';
// 工作台设计 Agent 的提示词检查：要点齐全、没有废弃说法、字符串可被正确解析，脚手架自带测试真的能跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const workflow = require('./design-workflow.js');
const { scaffold, filesFor } = require('./workbench-scaffold.cjs');

function loadContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contexts', 'workbench-design.js'), 'utf8');
  const sandbox = { window: { PiContextRegistry: {} } };
  vm.runInNewContext(source, sandbox);
  return { source, context: sandbox.window.PiContextRegistry['workbench-design'] };
}
const flow = stage => ({ workflow: { schema: 1, stage, status: 'running', revision: 0, attempt: { id: 'req-' + stage }, report: null, accepted: [] } });
const stageWork = name => workflow.stages.find(s => s.name === name).work;

test('设计上下文提示词能被解析，是单行转义字符串，其它字段保持不变', () => {
  const { source, context } = loadContext();
  assert.equal(typeof context.prompt, 'string');
  const promptLine = source.split('\n').find(line => line.startsWith('  prompt:'));
  assert.ok(promptLine && promptLine.endsWith("',"), 'prompt 必须在一行内，用 \\n 转义换行');
  assert.ok(context.prompt.includes('\n'), '分段应解析为真实换行');
  assert.deepEqual([...context.actions], ['readLayout', 'setLayout', 'readDesignWorkflow', 'reportDesignStage', 'verifyWorkbench']);
  assert.deepEqual([...context.state], ['_layout']);
  assert.ok(context.architecture.rules.length > 0);
});

test('六个阶段名称与顺序不变，每阶段指令都包含共同约束', () => {
  assert.deepEqual(workflow.stages.map(s => s.name), ['需求确认', '结构设计', '布局调整', '交互验证', '预览', '发布准备']);
  for (let i = 0; i < workflow.stages.length; i++) {
    const text = workflow.prompt(flow(i));
    for (const must of ['readDesignWorkflow', 'reportDesignStage', 'interaction_request', '最多 3 个问题', '小批次', '截断', '先检查已写入文件', '不能自行假设已经确认', '不要调用 advanceStage', '仅由用户确认', '普通人能懂', '没运行的测试不得说通过', 'attemptId:"req-' + i + '"', 'stage:' + i])
      assert.ok(text.includes(must), `第 ${i + 1} 阶段提示词缺少：${must}`);
  }
});

test('完全批准与连续自动推进模式下阶段提示词要求自主完成且不请求许可', () => {
  for (let i = 0; i < workflow.stages.length; i++) {
    const fullText = workflow.prompt(flow(i), { approval: 'full' });
    assert.ok(fullText.includes('scaffoldWorkbench'));
    assert.ok(fullText.includes('不要调用 interaction_request 请求执行许可'));
    assert.ok(!fullText.includes('仅由用户确认'));
    const autoText = workflow.prompt(flow(i), { approval: 'full', autoAdvance: true });
    assert.ok(autoText.includes('连续自动推进模式'));
    assert.ok(autoText.includes('不要调用 interaction_request 或用文字征求用户同意'));
  }
});

test('交互验证阶段包含完整的后端测试规范', () => {
  const work = stageWork('交互验证');
  for (const must of ['manifest', '正常路径', '参数校验错误', 'revision 冲突', '未知 action', '持久化', '恢复', 'child_process.spawn', 'server/transport/stdio.cjs', 'JSONL', '不得 mock', '变异检查', '变红', 'DOM', 'Electron', '真实的通过/失败/跳过数量', '没运行就不得声称通过'])
    assert.ok(work.includes(must), '测试规范缺少：' + must);
  assert.ok(stageWork('预览').includes('重新运行全部测试'));
  assert.ok(stageWork('发布准备').includes('通过/失败/跳过数量'));
});

test('提示词反映新的预览架构，且不再出现废弃说法', () => {
  const { context } = loadContext();
  const layout = stageWork('布局调整');
  const all = context.prompt + workflow.stages.map(s => s.work).join('\n') + workflow.prompt(flow(2));
  for (const must of ['设计画布', 'ui/layout.json', 'ui/layout.css', 'window.__wbTransport', '自动刷新', '没有布局工具'])
    assert.ok(layout.includes(must) && context.prompt.includes(must), '缺少预览架构说明：' + must);
  for (const stale of ['setDraftHTML', 'readDraft/setDraftHTML', '可同步预览；不能热预览', '保证无误。'])
    assert.ok(!all.includes(stale), '残留废弃说法：' + stale);
  assert.ok(stageWork('需求确认').includes('空白'), '需求阶段应说明预览可能为空白');
  assert.ok(stageWork('交互验证').includes('可用的完整页面'));
});

test('脚手架带有按规范编写的后端测试，含真实子进程端到端用例', () => {
  const files = filesFor({ id: 'x', name: 't' });
  const spec = files['tests/state.test.cjs'];
  for (const must of ["spawn(process.execPath", 'stdio.cjs', 'REVISION_CONFLICT', 'VALIDATION', 'UNKNOWN_ACTION', 'manifest', 'JSON.parse(JSON.stringify'])
    assert.ok(spec.includes(must), '范例测试缺少：' + must);
  assert.doesNotMatch(spec, /\bmock\(|test\.skip|\{\s*skip\s*:/);
  const manifest = JSON.parse(files['manifest.json']);
  assert.deepEqual(manifest.actions.map(a => a.name), ['readState', 'updateState']);
  assert.match(files['README.md'], /测试规范/);
});

test('脚手架生成的工程能独立通过自带测试（真实运行 node --test）', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-scaffold-spec-'));
  try {
    const project = await scaffold(dir, { name: '规范范例' });
    // 去掉外层测试运行器的上下文变量，否则子进程的 node --test 会跳过执行。
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'tests/state.test.cjs'], { cwd: project.path, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 0, output);
    assert.match(output, /ℹ fail 0/);
    assert.match(output, /ℹ skipped 0/);
    assert.match(output, /stdio 端到端/);
    const passed = Number((output.match(/ℹ pass (\d+)/) || [])[1]);
    assert.ok(passed >= 9, '自带测试数量不足：' + passed);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
