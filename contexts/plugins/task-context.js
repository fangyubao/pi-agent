'use strict';
window.PiContextRegistry['plugin:task-context'] = {
  id: 'plugin:task-context', kind: 'plugin', version: 1,
  prompt: '任务上下文插件已启用。允许读取当前项目、任务名称和对话数量；不允许修改工作台状态。',
  actions: ['readTaskContext'],
  events: []
};
