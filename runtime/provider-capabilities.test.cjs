'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const caps = require('./provider-capabilities.js');

test('外部 Agent 默认未探测不支持工作流与工作台，普通 API 默认支持', () => {
  const api = { id: 'p1', name: 'OpenAI', provider: 'openai-compatible', models: ['m1'] };
  const ext = { id: 'p2', name: 'OpenClaw', kind: 'external-agent', agentTransport: 'openclaw-gateway', models: ['main'] };
  assert.equal(caps.isExternalAgent(api), false);
  assert.equal(caps.isExternalAgent(ext), true);
  assert.equal(caps.supportsMode(api, 'workbench'), true);
  assert.equal(caps.supportsMode(api, 'workflow'), true);
  assert.equal(caps.supportsMode(ext, 'chat'), true);
  assert.equal(caps.supportsMode(ext, 'workflow'), false);
  assert.equal(caps.supportsMode(ext, 'workbench'), false);
});

test('按模式过滤下拉选项：不支持工作台的 Agent 在工作台模式消失，切回聊天/工作流恢复', () => {
  const api = { id: 'api-1', name: '标准 API', provider: 'openai-compatible', models: ['gpt'] };
  const claw = {
    id: 'ext-1',
    name: 'OpenClaw',
    kind: 'external-agent',
    agentTransport: 'openclaw-gateway',
    models: ['main'],
    capabilities: { chat: true, workflow: true, workbench: false, vision: false, maxConcurrency: 1, mode: 'probed' }
  };
  const cli = {
    id: 'ext-2',
    name: 'LocalCLI',
    kind: 'external-agent',
    agentTransport: 'external-cli',
    models: ['coder'],
    capabilities: { chat: true, workflow: true, workbench: true, vision: false, maxConcurrency: 2, mode: 'probed' }
  };
  const all = [api, claw, cli];
  assert.deepEqual(caps.filterProfilesForMode(all, 'chat').map(x => x.id), ['api-1', 'ext-1', 'ext-2']);
  assert.deepEqual(caps.filterProfilesForMode(all, 'workflow').map(x => x.id), ['api-1', 'ext-1', 'ext-2']);
  assert.deepEqual(caps.filterProfilesForMode(all, 'workbench').map(x => x.id), ['api-1', 'ext-2']);
  assert.equal(caps.pickCompatibleProfile(all, 'workbench', 'ext-1')?.id, 'api-1');
  assert.equal(caps.workflowConcurrencyFor(all, ['ext-1', 'api-1']), 1);
  assert.equal(caps.workflowConcurrencyFor(all, ['ext-2']), 2);
});

test('跨 API/Agent 切换生成带 DATA 边界的交接上下文', () => {
  const prompt = caps.buildHandoffPrompt({
    projectName: '嵌入式',
    taskName: '串口工具',
    goal: '完成协议解析',
    messages: [{ role: 'user', text: '先写帧头校验' }, { role: 'assistant', model: 'm1', text: '已写好 CRC16 校验' }],
    fromModel: 'm1',
    toModel: 'openclaw-main'
  });
  assert.match(prompt, /DATA_BEGIN/);
  assert.match(prompt, /m1 -> openclaw-main/);
  assert.match(prompt, /CRC16 校验/);
  assert.match(prompt, /DATA_END/);
});
