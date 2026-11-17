'use strict';
window.PiWorkbenchPlugins.context={
  name:'任务上下文',
  prompt:'只读取当前任务名称、项目名称与对话数量，不读取其他任务或磁盘文件。',
  read(current){return current?'项目：'+current.project.name+'\n任务：'+current.task.name+'\n消息数量：'+current.task.messages.length+'\n数据来自当前任务模型。':'尚未选择任务。';}
};
