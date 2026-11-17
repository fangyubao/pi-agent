'use strict';
window.PiContextRegistry['workbench:editor'] = {
  id: 'workbench:editor', kind: 'builder', version: 1,
  prompt: '你正在修改已有本地工作台的设计。先读取 readDesign 获取目标工作台、当前提示词、知识库路径和 revision；只有用户明确要求时调用 updateDesign。更新必须携带最新 baseRevision，并说明哪些设计字段发生了变化。不要声称修改了工作台运行代码，除非工具结果明确返回。',
  state: ['target', 'name', 'description', 'prompt', 'knowledgePaths', 'revision'],
  actions: ['readDesign', 'updateDesign'],
  events: ['design.updated']
};
