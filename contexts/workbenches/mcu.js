'use strict';
window.PiContextRegistry['workbench:mcu'] = {
  id: 'workbench:mcu', kind: 'builder', version: 1,
  prompt: '这是 MCU 控制台的本地设计草稿。初始 HTML 为空就是空白画布，不代表正在加载。readDraft 读取当前 HTML 与 revision，setDraftHTML({html,baseRevision}) 更新静态预览。预览不执行脚本，也没有设备连接或硬件控制能力。仅按用户的设计要求更新，不要声称硬件功能已经存在。',
  state: ['html', 'status', 'revision'],
  actions: ['readDraft', 'setDraftHTML'],
  events: ['draft.updated']
};
