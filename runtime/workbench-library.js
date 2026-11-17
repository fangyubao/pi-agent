'use strict';
// 「工作台」一级栏目：与「项目」并列，专门存放 使用 / 创建 / 修改 工作台的任务。
// 不搬动任何数据：任务仍保存在原来的项目里，只靠 task.use / task.design 标记区分，所以旧数据零迁移、零丢失。
// 这里是纯函数（无 DOM），便于单测。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiWorkbenchLibrary = api; })(typeof window === 'object' ? window : globalThis, () => {
  const isWorkbenchTask = task => Boolean(task && (task.use || task.design));

  const workflowEnabled = task => Boolean(task && !isWorkbenchTask(task) && task.workflowOn === true);

  // Task purpose owns the session. Publication is metadata on a draft, never a
  // reason to restore that task as a production runtime.
  function sessionFor(task) {
    if (!task) return null;
    const saved = task.workbenchSession;
    if (task.design) {
      const d = task.design;
      return { key: d.workbenchId || 'builder', mode: d.kind === 'modify' ? 'edit' : 'design',
        target: d.target || d.workbenchId || 'builder', name: d.name || '设计工作台',
        open: saved?.open !== false, updatedAt: saved?.updatedAt };
    }
    if (saved?.asMode && !workflowEnabled(task)) return null;
    if (saved?.key) return { ...saved };
    return task.use?.workbenchId ? { key: task.use.workbenchId, mode: 'use', target: task.use.workbenchId, open: false } : null;
  }

  function canUse(task, key) {
    return Boolean(task && !task.archived && !task.design && !workflowEnabled(task) &&
      (!task.use || task.use.workbenchId === key));
  }

  // Retain a conflicting old binding for audit/recovery. Business state, chat,
  // publication and source paths remain untouched; running this twice is inert.
  function normalizeDesignSession(task) {
    if (!task?.design) return false;
    const saved = task.workbenchSession, next = sessionFor(task);
    if (saved?.key === next.key && saved.mode === next.mode && saved.target === next.target && !saved.sourcePath && !saved.asMode) return false;
    if (saved) {
      task.workbenchSessionHistory ||= [];
      task.workbenchSessionHistory.push({ reason: 'design-purpose-restored', session: { ...saved } });
    }
    task.workbenchSession = next;
    return true;
  }

  // 把一个普通聊天任务“转成”工作台任务（就地打标，不新建、不搬数据、不丢任何历史）。
  // 已经是工作台任务（有 use 或 design）则不动；返回是否发生了转换。
  function adoptAsWorkbenchTask(task, { key, mode = 'use', now = Date.now() } = {}) {
    if (!task || !key || isWorkbenchTask(task)) return false;
    if (mode === 'use') task.use = { workbenchId: String(key), createdAt: now, converted: true };
    else return false;                                   // 创建/修改本来就走 createDesignTask 新建任务，这里不处理
    return true;
  }

  // 旧数据迁移：以前“打开使用”只写 workbenchSession（或残留 workbenches 状态），任务没有 use/design 标记，
  // 所以会一直留在项目里。这里补上标记；返回迁移了多少个。幂等：已有标记的任务不动。
  function migrate(projects, validKey = () => true) {
    let changed = 0;
    for (const project of projects || []) for (const task of (project && project.tasks) || []) {
      if (!task) continue;
      if (task.design) { if (normalizeDesignSession(task)) changed++; continue; }
      if (isWorkbenchTask(task)) continue;
      const session = task.workbenchSession, key = session && session.key;
      // 工作流模式（task.workflowOn / session.asMode）是聊天自己的模式，画布只是它的右侧面板，不是“使用工作台”，不能迁移。
      if (task.workflowOn || (session && session.asMode)) continue;
      if (key && key !== 'builder' && key !== 'workflow' && (session.sourcePath || validKey(key))) { task.use = { workbenchId: String(key), createdAt: task.workbenchSession.updatedAt || Date.now(), converted: true }; changed++; }
    }
    return changed;
  }
  // 一个任务属于哪个工作台条目：同一个工作台的 使用/创建/修改 都归到同一组。
  function entryKey(task) {
    if (task.design) return task.design.kind === 'modify' ? (task.design.sourceWorkbenchId || task.design.target || task.design.workbenchId) : ('new:' + (task.design.workspacePath || task.id));
    if (task.use) return task.use.workbenchId;
    return null;
  }
  function entryKind(task) {
    if (task.design) return task.design.kind === 'modify' ? 'modify' : 'create';
    return 'use';
  }
  const KIND_LABEL = { use: '使用', create: '创建', modify: '修改' };
  const KIND_ORDER = { create: 0, modify: 1, use: 2 };

  // 把所有项目里的工作台类任务收集成「工作台条目 → 任务」。labelOf(key) 由调用方提供（内置工作台名称）。
  function collect(projects, labelOf = key => key, options = {}) {
    const groups = new Map();
    for (const project of projects || []) for (const task of (project && project.tasks) || []) {
      if (!isWorkbenchTask(task) || (task.archived && !options.includeArchived)) continue;
      const key = entryKey(task); if (!key) continue;
      let group = groups.get(key);
      if (!group) { group = { key, name: key.startsWith('new:') ? (task.design?.name || task.workbenches?.builder?.name || '新工作台') : labelOf(key), created: !key.indexOf('new:'), tasks: [] }; groups.set(key, group); }
      group.tasks.push({ task, project, kind: entryKind(task) });
    }
    for (const group of groups.values()) {
      group.tasks.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.task.updated || 0) - (a.task.updated || 0));
      group.updated = Math.max(...group.tasks.map(item => item.task.updated || 0));
      // 同一个新建工作台的名字以最新的 builder 名称为准。
      const named = group.tasks.map(item => item.task.workbenches?.builder?.name).find(Boolean);
      if (named && group.key.startsWith('new:')) group.name = named;
    }
    return [...groups.values()].sort((a, b) => b.updated - a.updated);
  }

  // 项目栏里是否还显示这些任务：用户选择「在项目里也显示」时才显示，默认只在「工作台」栏目里。
  const visibleInProject = (task, showInProject) => showInProject || !isWorkbenchTask(task);
  return { isWorkbenchTask, workflowEnabled, sessionFor, canUse, normalizeDesignSession, adoptAsWorkbenchTask, migrate, entryKey, entryKind, collect, visibleInProject, KIND_LABEL };
});
