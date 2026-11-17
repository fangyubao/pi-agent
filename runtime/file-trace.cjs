'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const idPart = id => {
  if (!String(id || '').trim()) throw new Error('缺少项目或任务标识');
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
};
function taskPath(task = {}, project = {}) {
  return task.design?.workspacePath || task.workspacePath || task.cwd || task.path ||
    [...(task.messages || [])].reverse().find(m => m.run?.cwd)?.run.cwd || '';
}
async function directory(target) {
  if (!path.isAbsolute(target) || /\.asar(?:[\\/]|$)/i.test(target)) throw new Error('需要可由资源管理器打开的本地目录');
  if (!(await fs.stat(target).catch(() => null))?.isDirectory()) throw new Error('目录不存在：' + target);
  return path.resolve(target);
}
async function entityFolder(base, {kind, project, task}) {
  if (!project?.id || !['project', 'task'].includes(kind) || kind === 'task' && !task?.id) throw new Error('项目或任务无效');
  const explicit = kind === 'project' ? project.path || project.workspacePath || '' : taskPath(task, project);
  if (explicit) return {path: await directory(explicit), managed: false};
  const projectDir = path.join(base, idPart(project.id));
  const target = kind === 'project' ? projectDir : path.join(projectDir, 'tasks', idPart(task.id));
  const records = path.join(target, '.pi-trace');
  await fs.mkdir(records, {recursive: true});
  const info = {kind, project: {id:project.id, name:project.name}, task:task ? {id:task.id, name:task.name} : undefined, updatedAt:new Date().toISOString()};
  if (kind === 'project') {
    info.tasks = [];
    for (const item of project.tasks || []) {
      const known = taskPath(item, project), folder = known || path.join(projectDir, 'tasks', idPart(item.id));
      if (!known) await fs.mkdir(folder, {recursive:true});
      info.tasks.push({id:item.id, name:item.name, path:folder});
    }
  }
  await fs.writeFile(path.join(records, 'location.json'), JSON.stringify(info, null, 2));
  if (task) await fs.writeFile(path.join(records, 'conversation.md'), '# ' + task.name + '\n\n' + (task.messages || []).map(m => '## ' + (m.role === 'user' ? '用户' : 'Agent') + '\n\n' + String(m.text || '')).join('\n\n'));
  return {path:target, managed:true};
}
async function sourceFolder({workbenchRoot, exportRoot, key, sourcePath, taskId, design, state = {}}) {
  if (!/^[a-z0-9_-]+$/i.test(String(key || ''))) throw new Error('工作台标识无效');
  if (sourcePath) return {path:await directory(sourcePath), kind:'project'};
  const original = await directory(path.join(workbenchRoot, key));
  if (!design) return {path:original, kind:'installed'};
  // A design stored in task state is not the installed source. Preserve both,
  // without silently redirecting the running workbench or overwriting edited code.
  const target = path.join(exportRoot, idPart(taskId), key);
  await fs.mkdir(target, {recursive:true});
  await fs.cp(original, target, {recursive:true, force:false, errorOnExist:false});
  const meta = path.join(target, '.pi-design');
  await fs.mkdir(meta, {recursive:true});
  await fs.writeFile(path.join(meta, 'state.json'), JSON.stringify(state, null, 2));
  if (typeof state.html === 'string') await fs.writeFile(path.join(meta, 'draft.html'), state.html);
  await fs.writeFile(path.join(meta, 'README.md'), '# 当前设计状态\n\nui/ 与 server/ 是所选工作台的源码副本，不覆盖你在副本中编辑的代码。state.json 是本次打开时的任务状态，包含 _layout 布局、业务数据和已导入知识；draft.html（如有）是保存的页面草稿。\n\n这些是本机设计材料，不要未经审阅公开其中的个人知识。该副本不是当前桌面加载路径，修改副本不会自动更新右侧预览。UI mount(host, api) 仍需工作台宿主提供状态、save、server、request 等接口；接入独立前端时需实现对应适配。后端入口见 manifest.json。\n');
  return {path:target, kind:'design-copy'};
}
module.exports = {taskPath, entityFolder, sourceFolder, directory};
