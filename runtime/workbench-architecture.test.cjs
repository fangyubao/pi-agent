'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = require('./workbench-runtime.cjs');

const root = path.join(__dirname, '..', 'workbenches');

test('内置工作台都遵守 ui/server manifest 分层', async () => {
  for (const key of ['qubo', 'circuit', 'mcu', 'editor', 'builder']) {
    const inspected = await runtime.inspect(root, key);
    assert.equal(inspected.manifest.id, key);
    assert.ok(inspected.manifest.ui.entry);
    assert.ok(inspected.manifest.server.entry);
    assert.ok(['healthy', 'warning', 'error'].includes(inspected.health.status));
  }
});

test('QUBO 后端通过统一动作协议返回结构化状态和语义事件', async () => {
  const result = await runtime.dispatch(root, { key: 'qubo', action: 'solve', state: { matrix: [[-1, 1, 0, 0], [1, -1, 1, 0], [0, 1, -1, 1], [0, 0, 1, -1]], revision: 1 }, source: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.state.result.bits, '1010');
  assert.ok(result.events.some(item => item.type === 'solver.finished'));
});

test('未声明动作不能进入工作台后端', async () => {
  const result = await runtime.dispatch(root, { key: 'qubo', action: 'readFiles', state: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /未声明/);
});

test('已发布工程可以直接按工程路径运行后端，而不是只能预览 UI', async () => {
  const result = await runtime.dispatchPath(path.join(root, 'qubo'), {
    action: 'readState',
    state: { matrix: [], revision: 0 },
    source: 'ui'
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.revision, 0);
});
