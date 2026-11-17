'use strict';
(() => {
  const MAX_HISTORY = 30;
  const DEFAULTS = {
    goal: '',
    notes: '',
    blockEdits: {},
    summary: '',
    historyCutoff: '',
    excluded: [],
    pinned: [],
    includeMemory: true,
    includeAttachments: true,
    includeToolResults: true,
    settings: { autoCompact: 'ask', threshold: 0.8, reserveTokens: 4096 }
  };
  const clone = value => {
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value ?? null)); }
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'ctx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const textOf = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  };
  const clipText = (value, limit) => {
    const text = String(value ?? ''), max = Math.max(80, Number(limit) || 1000);
    if (text.length <= max) return { text, truncated: false };
    const head = Math.max(40, Math.floor(max * .62)), tail = Math.max(20, max - head - 80);
    return { text: text.slice(0, head) + '\n… [为本轮 Agent 请求裁剪，原始记录仍保留在任务历史] …\n' + text.slice(-tail), truncated: true };
  };
  function compactValue(value, options = {}, depth = 0) {
    const maxString = Number(options.maxString) || 1600, maxArray = Number(options.maxArray) || 24, maxDepth = Number(options.maxDepth) || 6;
    if (typeof value === 'string') return clipText(value, maxString).text;
    if (value == null || typeof value !== 'object' || depth >= maxDepth) return value;
    if (Array.isArray(value)) return value.slice(0, maxArray).map(item => compactValue(item, options, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, options, depth + 1)]));
  }
  function estimate(value) {
    const text = textOf(value);
    if (!text) return { chars: 0, tokens: 0 };
    // A conservative local estimate. Pi's exact tokenizer is provider/model specific
    // and is intentionally not fabricated in the UI.
    const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) || []).length;
    const latin = Math.max(0, text.length - cjk);
    return { chars: text.length, tokens: Math.max(1, Math.ceil(cjk / 1.7 + latin / 4)) };
  }
  function defaults() { return clone(DEFAULTS); }
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const mutableId = id => typeof id === 'string' && (
    ['task:goal', 'request:current', 'conversation:recent', 'conversation:summary', 'tools:file-io', 'tools:workbench-state', 'attachments:pending'].includes(id) ||
    /^(task|request|conversation|memory|user|tools|attachments):.+$/.test(id)
  );
  const protectedBlock = block => [block.source, block.trust, block.type].some(value =>
    /^(system|capability|permissions?|polic(?:y|ies)|tool[-_:]?schemas?|schemas?)$/i.test(value || ''));
  const canToggle = block => mutableId(block.id) && !protectedBlock(block);
  const canEdit = block => canToggle(block) && block.editable === true && block.type !== 'empty';

  // Pure integration boundary: accepts task.context, an envelope, or overrides.
  // blockEdits is a complete replacement map; omitted keys remove prior edits.
  function materialize(context = {}) {
    const source = object(context?.overrides ?? context?.contextOverrides ?? context);
    const result = defaults();
    for (const key of ['goal', 'notes', 'summary', 'historyCutoff']) if (typeof source[key] === 'string') result[key] = source[key];
    for (const key of ['includeMemory', 'includeAttachments', 'includeToolResults']) result[key] = source[key] !== false;
    for (const key of ['excluded', 'pinned']) result[key] = Array.isArray(source[key]) ? [...new Set(source[key].filter(mutableId))] : [];
    for (const [id, value] of Object.entries(object(source.blockEdits))) {
      if (mutableId(id) && id !== 'memory:none' && id !== 'conversation:summary' && typeof value === 'string') result.blockEdits[id] = value;
    }
    const settings = object(source.settings);
    if (typeof settings.autoCompact === 'string' && ['ask', 'auto', 'off'].includes(settings.autoCompact)) result.settings.autoCompact = settings.autoCompact;
    const threshold = Number(settings.threshold);
    if (Number.isFinite(threshold) && threshold > 0 && threshold <= 1) result.settings.threshold = threshold;
    const reserveTokens = Number(settings.reserveTokens);
    if (Number.isFinite(reserveTokens) && reserveTokens > 0) result.settings.reserveTokens = Math.min(65536, Math.max(256, Math.round(reserveTokens)));
    // Preserve the existing optional memory selection without accepting arbitrary state.
    if (Array.isArray(source.memoryIds)) result.memoryIds = [...new Set(source.memoryIds.filter(id => typeof id === 'string'))];
    return result;
  }

  function applyOverrides(blocks, context) {
    const over = materialize(context);
    return (blocks || []).map(block => {
      const editable = canEdit(block), toggleable = canToggle(block);
      const originalContent = textOf(block.originalContent ?? block.content);
      const overridden = editable && (block.id === 'conversation:summary' ? over.summary !== originalContent : own(over.blockEdits, block.id));
      const content = editable && block.id === 'conversation:summary' ? over.summary : overridden ? over.blockEdits[block.id] : originalContent;
      const included = !(block.source === 'memory' && !over.includeMemory || block.source === 'tools' && !over.includeToolResults || block.source === 'attachments' && !over.includeAttachments);
      const enabled = block.enabled !== false && (!toggleable || included && !over.excluded.includes(block.id));
      return { ...block, editable, toggleable, originalContent, content, overridden, enabled, pinned: over.pinned.includes(block.id), ...estimate(content) };
    });
  }

  function ensure(task) {
    if (!task) return null;
    const current = object(task.context);
    // Keep context identity stable: history operations must not write into an
    // object detached by a nested ensure()/snapshot call.
    Object.assign(current, {
      schema: 1,
      revision: Number(current.revision) || 0,
      cleanStart: Boolean(current.cleanStart),
      overrides: materialize(current.overrides),
      history: Array.isArray(current.history) ? current.history.filter(item => item && typeof item === 'object').slice(0, MAX_HISTORY) : [],
      lastSnapshot: current.lastSnapshot && typeof current.lastSnapshot === 'object' ? current.lastSnapshot : null
    });
    task.context = current;
    return current;
  }
  function overrides(task) { return ensure(task).overrides; }
  function snapshotOverrides(task) { return clone(overrides(task)); }
  function commit(task, next, label, detail = '', meta = {}) {
    const context = ensure(task), before = snapshotOverrides(task), after = materialize(next);
    const cleanStart = own(meta, 'cleanStart') ? Boolean(meta.cleanStart) : context.cleanStart;
    const entry = { id: uid(), label, detail, time: Date.now(), before, after: clone(after), beforeCleanStart: context.cleanStart, afterCleanStart: cleanStart, kind: meta.kind || 'edit' };
    if (meta.undoOf) entry.undoOf = meta.undoOf;
    // Prepare everything first, then publish the complete revision together.
    Object.assign(context, { overrides: after, cleanStart, revision: context.revision + 1, history: [entry, ...context.history].slice(0, MAX_HISTORY) });
    return after;
  }
  function update(task, patch = {}, label = '更新上下文设置', detail = '') {
    const before = snapshotOverrides(task), changes = object(patch);
    const next = materialize({ ...before, ...changes, settings: { ...before.settings, ...object(changes.settings) } });
    if (JSON.stringify(before) === JSON.stringify(next)) return overrides(task);
    return commit(task, next, label, detail);
  }
  function restore(task, id) {
    const context = ensure(task);
    const item = context.history.find(x => x.id === id);
    if (!item) return false;
    if (!item.before || typeof item.before !== 'object' || Array.isArray(item.before)) return false;
    const meta = { kind: 'restore' };
    if (own(item, 'beforeCleanStart')) meta.cleanStart = item.beforeCleanStart;
    commit(task, item.before, '恢复上下文版本', item.label || '历史版本', meta);
    return true;
  }
  function reset(task, label = '重置当前上下文') {
    return commit(task, defaults(), label, '清除本任务的上下文覆盖项；保留原始资料和聊天记录', { kind: 'reset' });
  }
  function checkpoint(task, label, detail = '') {
    const current = snapshotOverrides(task);
    commit(task, current, label, detail, { kind: 'checkpoint' });
    return ensure(task).revision;
  }
  function undoTarget(task) {
    const stack = [];
    for (const entry of [...(task?.context?.history || [])].reverse()) {
      if (entry.kind === 'undo') {
        const index = stack.findIndex(item => item.id === entry.undoOf);
        if (index >= 0) stack.splice(index, 1);
      } else if (entry.kind !== 'checkpoint' && entry.before && entry.after &&
        (JSON.stringify(entry.before) !== JSON.stringify(entry.after) || entry.beforeCleanStart !== entry.afterCleanStart)) stack.push(entry);
    }
    return stack.at(-1);
  }
  function undo(task) {
    const entry = undoTarget(task);
    if (!entry) return false;
    const meta = { kind: 'undo', undoOf: entry.id };
    if (own(entry, 'beforeCleanStart')) meta.cleanStart = entry.beforeCleanStart;
    commit(task, entry.before, '撤销上下文修改', entry.label, meta);
    return true;
  }
  function diff(before, after) {
    const a = materialize(before), b = materialize(after), rows = [];
    for (const key of Object.keys({ ...a, ...b })) {
      if (key === 'blockEdits') {
        for (const id of new Set([...Object.keys(a.blockEdits), ...Object.keys(b.blockEdits)])) {
          if (a.blockEdits[id] !== b.blockEdits[id]) rows.push({ key: 'blockEdits.' + id, before: a.blockEdits[id] ?? null, after: b.blockEdits[id] ?? null });
        }
      } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) rows.push({ key, before: a[key] ?? null, after: b[key] ?? null });
    }
    return rows;
  }
  function buildSnapshot(options = {}) {
    const task = options.task || {};
    const project = options.project || {};
    const over = materialize(task.context?.overrides || {});
    const envelope = options.context || {};
    const contextMode = String(options.contextMode || envelope.mode || 'base');
    const designMode = contextMode === 'design' || contextMode === 'builder' || contextMode === 'edit';
    const limits = designMode ? { messages: 8, messageChars: 1800, dialogueChars: 9000, io: 12, ioOutput: 700, ioChars: 9000, attachmentChars: 5000, stateString: 1800, stateArray: 24 } : { messages: 12, messageChars: 3000, dialogueChars: 16000, io: 20, ioOutput: 1000, ioChars: 14000, attachmentChars: 12000, stateString: 2400, stateArray: 40 };
    const blocks = [];
    const add = (block) => {
      const originalContent = textOf(block.originalContent ?? block.content);
      const size = estimate(originalContent);
      blocks.push({ editable: false, enabled: true, ...block, originalContent, content: originalContent, ...size });
    };
    add({ id: 'system:core', source: 'system', type: 'core', label: 'Pi 核心规则', scope: '全局', trust: 'system', version: envelope.core?.version || 1, reason: '始终保持 Agent 轻量并遵守交互协议', content: envelope.core?.prompt || 'Pi Agent 核心规则由运行时注入。' });
    const taskText = [
      '项目：' + (project.name || envelope.task?.project || ''),
      '任务：' + (task.name || envelope.task?.name || ''),
      over.goal ? '用户定义目标：' + over.goal : '',
      over.notes ? '本任务工作备注：' + over.notes : ''
    ].filter(Boolean).join('\n');
    add({ id: 'task:goal', source: 'task', type: 'goal', label: '任务目标与约束', scope: '当前任务', trust: 'user', version: task.context?.revision || 0, reason: '用户可修改的任务级上下文', content: taskText, editable: true });
    (envelope.contexts || []).filter(x => x.id !== envelope.core?.id).forEach(item => {
      const content = [item.prompt, item.architecture ? '工程分层：' + textOf(item.architecture) : '', item.state ? '状态：' + textOf(item.state) : '', item.actions ? '动作：' + textOf(item.actions) : '', item.events ? '事件：' + textOf(item.events) : ''].filter(Boolean).join('\n');
      add({ id: 'module:' + item.id, source: item.kind === 'plugin' ? 'plugin' : 'workbench', type: item.kind || 'module', label: item.id, scope: '按需激活', trust: 'capability', version: item.version || 1, reason: '仅在当前工作台/插件激活时载入', content: content || '该模块未提供文字提示词，但仍可通过结构化状态交互。' });
    });
    const memoryItems = Array.isArray(options.memory?.items) ? options.memory.items : [];
    if (memoryItems.length) memoryItems.forEach(item => {
      const id = 'memory:' + String(item.id || uid());
      add({ id, source: 'memory', type: item.kind || item.lifespan || 'memory', label: item.title || '已确认记忆', scope: item.scope || '当前任务', trust: 'confirmed-memory', version: item.version || 1, reason: item.reason || '本轮按需检索', content: item.content || '', editable: true, enabled: over.includeMemory && !over.excluded.includes(id) });
    });
    if (!memoryItems.length) add({ id: 'memory:none', source: 'memory', type: 'empty', label: '记忆胶囊', scope: '当前任务', trust: 'confirmed-memory', version: 0, reason: '本轮没有检索到已确认记忆', content: '本轮未载入记忆。', enabled: over.includeMemory && !over.excluded.includes('memory:none') });
    const allMessages=options.historyMessages||task.messages||[],cutoff=allMessages.findIndex(m=>m.id===over.historyCutoff);
    const messages = options.cleanStart ? [] : allMessages.slice(cutoff+1).filter(x=>x&&(x.text||x.role)).slice(-limits.messages);
    const dialogue = messages.map(x => {
      const item = clipText(String(x.text || '(无文字内容)'), limits.messageChars);
      return { text: (x.role === 'assistant' ? 'Agent' : '用户') + '：' + item.text, truncated: item.truncated };
    });
    const dialogueText = clipText(dialogue.map(x => x.text).join('\n\n') || (options.cleanStart ? '已按干净上下文策略排除旧对话。' : '暂无历史对话。'), limits.dialogueChars);
    add({ id: 'conversation:recent', source: 'conversation', type: 'dialogue', label: options.cleanStart ? '旧对话（已重建时排除）' : '最近对话', scope: options.cleanStart ? '当前任务 · 干净上下文' : `当前任务 · 最近 ${limits.messages} 条`, trust: 'user', version: messages.length, reason: options.cleanStart ? '重建/重置后不把历史对话带入新会话；任务历史仍保留在聊天记录中' : '保持当前任务的连续性', content: dialogueText.text, truncated: dialogueText.truncated || dialogue.some(x => x.truncated), editable: true, enabled: !options.cleanStart && !over.excluded.includes('conversation:recent') });
    const ioSteps=[];
    if(!options.cleanStart)for(let i=allMessages.length-1;i>cutoff&&ioSteps.length<limits.io;i--){const m=allMessages[i],steps=m.run?.steps||[];for(let j=steps.length-1;j>=0&&ioSteps.length<limits.io;j--)if(steps[j].kind==='tool')ioSteps.unshift({...steps[j],time:m.time});}
    if (ioSteps.length) {
      const io = clipText(ioSteps.map(step => {
        const output = step.output ? clipText(String(step.output), limits.ioOutput).text : '';
        return `${step.status || 'unknown'} · ${step.tool || '工具'} · ${clipText(step.target || '', 500).text}${output ? '\n' + output : ''}`;
      }).join('\n\n'), limits.ioChars);
      add({ id: 'tools:file-io', source: 'tools', type: 'file-io', label: '文件 / 工具 I/O', scope: `当前任务 · 最近 ${limits.io} 项`, trust: 'runtime', version: ioSteps.length, reason: '来自 Agent 已记录的文件操作和工具事件；过长输出只保留摘要，原始结果仍在操作记录中', content: io.text, truncated: io.truncated, editable: true, enabled: over.includeToolResults && !over.excluded.includes('tools:file-io') });
    }
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    if (attachments.length) {
      const attachmentText = clipText(attachments.map(x => { const head=`${x.name || '附件'} · ${x.kind || 'file'} · ${Math.max(1, Math.ceil((x.size || 0) / 1024))} KB`; return x.kind === 'text' && x.data ? head + '\n' + String(x.data) : head + (x.kind === 'image' ? '\n[图片内容在本轮以图像输入发送]' : ''); }).join('\n\n'), limits.attachmentChars);
      add({ id: 'attachments:pending', source: 'attachments', type: 'files', label: '本轮附件', scope: '当前输入', trust: 'untrusted', version: attachments.length, reason: '用户明确附加；仅发送当前轮；预览过长时只保留摘要', content: attachmentText.text, truncated: attachmentText.truncated, editable: true, enabled: over.includeAttachments && !over.excluded.includes('attachments:pending') });
    }
    const workbenchState = options.workbenchState;
    if (workbenchState && over.includeToolResults) {
      // A workbench state is a live application model, not disposable tool
      // output. Never slice arrays or nested fields here: dropping one node,
      // wire, constraint, or revision makes recovery act on false state.
      const stateText = textOf(workbenchState);
      add({ id: 'tools:workbench-state', source: 'tools', type: 'structured-state', label: '工作台结构化状态', scope: '当前工作台', trust: 'state', version: workbenchState.revision || 0, reason: '由本地工作台同步的完整结构化状态，不是自然语言猜测', content: stateText, truncated: false, editable: true, enabled: !over.excluded.includes('tools:workbench-state') });
    }
    if (options.input) add({ id: 'request:current', source: 'request', type: 'current-turn', label: '当前请求', scope: '本轮', trust: 'user', version: 1, reason: '本轮用户输入', content: String(options.input), editable: true });
    add({ id: 'conversation:summary', source: 'conversation', type: 'summary', label: '压缩摘要', scope: '当前任务', trust: 'user', version: task.context?.revision || 0, reason: '只在本地上下文覆盖项中保存；不改写原始聊天', content: over.summary, editable: true });
    const reserve = Number(over.settings.reserveTokens) || DEFAULTS.settings.reserveTokens;
    add({ id: 'runtime:reserve', source: 'runtime', type: 'reserve', label: '输出与运行时预留', scope: '运行时', trust: 'system', version: 1, reason: '避免上下文占满后无法输出', content: '为模型输出、工具事件和交互响应预留约 ' + reserve + ' tokens。' });
    blocks.forEach(block => {
      if (over.excluded.includes(block.id)) block.enabled = false;
      if (block.source === 'memory' && !over.includeMemory) block.enabled = false;
      if (block.source === 'attachments' && !over.includeAttachments) block.enabled = false;
      if (block.source === 'tools' && !over.includeToolResults) block.enabled = false;
      block.pinned = over.pinned.includes(block.id);
    });
    const materializedBlocks = applyOverrides(blocks, over);
    blocks.splice(0, blocks.length, ...materializedBlocks);
    const enabled = blocks.filter(x => x.enabled);
    const usedTokens = enabled.reduce((sum, x) => sum + x.tokens, 0);
    const windowTokens = Number(options.contextWindow) > 0 ? Number(options.contextWindow) : null;
    const reserveTokens = Number(over.settings.reserveTokens) || DEFAULTS.settings.reserveTokens;
    const total = usedTokens + reserveTokens;
    const percent = windowTokens ? Math.min(100, Math.round(total / windowTokens * 1000) / 10) : null;
    const issues = [];
    if (!options.context) issues.push({ level: 'warning', label: '运行时上下文尚未建立', detail: '当前显示的是本地预览；发送第一轮 Agent 请求后会得到实际激活模块。' });
    if (options.memory?.truncated) issues.push({ level: 'warning', label: '记忆胶囊已截断', detail: '本轮只载入了相关记忆，不代表其他记忆丢失。' });
    const trimmed = blocks.filter(x => x.truncated).map(x => x.label);
    if (trimmed.length) issues.push({ level: 'info', label: '本轮上下文已做安全裁剪', detail: trimmed.join('、') + ' 只发送了紧凑摘要；完整内容仍保留在任务历史或工作台状态中，可通过工具继续读取。' });
    if (options.agentState?.isCompacting) issues.push({ level: 'info', label: 'Pi 正在压缩', detail: '等待 Agent 完成后再编辑上下文。' });
    if (blocks.some(x => x.enabled&&!protectedBlock(x)&&/ignore previous|忽略之前|system prompt|系统提示词|api[_ -]?key/i.test(x.content || ''))) issues.push({ level: 'warning', label: '发现需审阅的指令型文本', detail: '不可信来源包含类似提示词控制语句，已标记供人工检查。' });
    const thresholdPercent = (Number(over.settings.threshold) || .8) * 100;
    if (windowTokens && percent >= 90) issues.push({ level: 'danger', label: '上下文接近容量上限', detail: '建议先预览压缩或重建干净上下文。' });
    else if (windowTokens && percent >= thresholdPercent) issues.push({ level: 'warning', label: '上下文使用量偏高', detail: '建议排除不必要的附件、工具结果或旧对话。' });
    const auditStatus = issues.some(x => x.level === 'danger') ? 'contaminated' : issues.length ? 'warning' : 'clean';
    const snapshot = {
      schema: 1, revision: task.context?.revision || 0, cleanStart: Boolean(options.cleanStart), taskId: task.id, projectId: project.id,
      generatedAt: Date.now(), blocks, enabledBlocks: enabled.map(x => x.id), usedTokens, reserveTokens, windowTokens, percent,
      estimate: true,capacitySource:options.contextWindowSource||'unknown', audit: { status: auditStatus, issues }, agent: options.agentState || null,
      model: options.model || '', activeWorkbench: options.active?.id || null, overrides: clone(over)
    };
    return snapshot;
  }
  function formatTokens(value) {
    if (value == null || !Number.isFinite(Number(value))) return '未知';
    const n = Number(value) || 0;
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  }
  function previewObject(snapshot) {
    return {
      kind: 'local-context-preview',
      exact: false,
      note: '这是本地序列化上下文预览；上游 provider payload 不可用时，不等同于 provider 的精确请求体。',
      taskId: snapshot?.taskId || null,
      revision: snapshot?.revision || 0,
      blocks: (snapshot?.blocks || []).filter(block => block.enabled).map(block => ({
        id: block.id, source: block.source, type: block.type, content: textOf(block.content)
      }))
    };
  }
  function help(key) {
    try {
      const value = globalThis.window?.PiHelp?.button?.(key);
      return typeof value === 'string' ? value : '';
    } catch { return ''; }
  }
  function mount(container, options = {}) {
    if (!container) return;
    const taskId = String(options.task?.id || '__context-inspector__');
    const states = container.__contextInspectorStates || new Map();
    const state = states.get(taskId) || { view: 'overview', editing: false, editingBlock: null, focusBlock: null, preview: null, snapshot: null };
    states.set(taskId, state);
    container.__contextInspectorStates = states;
    container.__contextInspectorState = state;
    // The surface is reused when the user switches tasks. Keep one delegated
    // listener, but always resolve callbacks and task data from the latest mount.
    container.__contextInspectorOptions = options;
    const currentOptions = () => container.__contextInspectorOptions || {};
    const currentState = () => {
      const id = String(container.__contextInspectorOptions?.task?.id || '__context-inspector__');
      return container.__contextInspectorStates?.get(id) || state;
    };
    const getSnapshot = () => { const current = currentOptions(); return current.getSnapshot ? current.getSnapshot() : current.snapshot; };
    const render = () => {
      const current = currentOptions();
      state.snapshot = getSnapshot() || { blocks: [], audit: { status: 'warning', issues: [] }, usedTokens: 0, windowTokens: null, percent: null, overrides: defaults(), revision: 0 };
      const s = state.snapshot, audit = s.audit || { status: 'clean', issues: [] }, over = materialize(s.overrides || defaults());
      const levelLabel = audit.status === 'clean' ? '干净' : audit.status === 'contaminated' ? '需立即处理' : '需审阅';
      const tabs = [['overview', '概览'], ['content', '内容区块'], ['audit', '污染审计'], ['history', '历史版本'], ['settings', '设置']];
      const tabHtml = tabs.map(([id, label]) => `<button type="button" class="context-tab ${state.view === id ? 'active' : ''}" data-context-view="${id}" role="tab" aria-selected="${state.view === id}">${label}</button>`).join('');
      const blocks = s.blocks || [];
      const knownCapacity = Number(s.windowTokens) > 0;
      const threshold = Number(over.settings?.threshold || .8) * 100;
      const capacityDetail = knownCapacity
        ? `约 ${s.percent ?? 0}% · 提醒阈值 ${threshold}% · 预留 ${formatTokens(s.reserveTokens)} tokens · 不等同于计费 token`
        : `窗口未知，请在设置里填写 · 预留 ${formatTokens(s.reserveTokens)} tokens · 不等同于计费 token`;
      const preview = state.preview ? `<section class="context-preview"><header><strong>发送预览</strong><button type="button" class="button" data-context-action="close-preview">关闭</button></header><p>这是本地序列化上下文预览；上游 provider payload 不可用时，不等同于 provider 的精确请求体。</p><pre>${esc(JSON.stringify(state.preview, null, 2))}</pre></section>` : '';
      let body = '';
      if (state.view === 'overview') {
        const bars = blocks.map(b => `<button type="button" class="context-source-row ${state.focusBlock === b.id ? 'focused' : ''}" data-context-source="${esc(b.id)}"><span><i class="context-source-dot ${esc(b.source)}"></i>${esc(b.label)}</span><strong>${formatTokens(b.tokens)}</strong></button>`).join('');
        body = `<section class="context-overview"><div class="context-capacity-card"><div class="context-capacity-head"><span>估算上下文容量 ${help('context-capacity')}</span><strong>${knownCapacity ? formatTokens(s.usedTokens) + ' / ' + formatTokens(s.windowTokens) : '窗口未知，请在设置里填写'}</strong></div><div class="context-capacity-bar"><i style="width:${knownCapacity ? Math.min(100, s.percent || 0) : 0}%" class="${knownCapacity && s.percent >= 90 ? 'danger' : knownCapacity && s.percent >= threshold ? 'warning' : ''}"></i></div><p>${capacityDetail}</p></div><div class="context-summary-grid"><div><small>启用区块</small><strong>${(s.enabledBlocks || []).length}</strong></div><div><small>上下文修订</small><strong>r${s.revision || 0}</strong></div><div><small>模型</small><strong>${esc(s.model || '未选择')}</strong></div><div><small>审计</small><strong class="audit-${audit.status}">${levelLabel}</strong></div></div><div class="context-section-card"><header><strong>来源占用</strong><span>点击查看完整内容</span></header>${bars || '<p class="context-empty">暂无可显示区块</p>'}</div></section>`;
      } else if (state.view === 'content') {
        const goal = state.editing === true ? `<form class="context-edit-form" data-context-form><label>任务目标<textarea name="goal" maxlength="4000">${esc(over.goal || '')}</textarea></label><label>当前任务备注<textarea name="notes" maxlength="4000">${esc(over.notes || '')}</textarea></label><div class="context-form-actions"><button type="button" class="button" data-context-action="cancel-edit">取消</button><button type="submit" class="button primary">保存并重建会话</button></div></form>` : `<div class="context-goal-preview"><div><strong>任务目标与约束 ${help('context-edit')}</strong><p>${esc(over.goal || '尚未填写任务级目标。')}</p>${over.notes ? `<small>${esc(over.notes)}</small>` : ''}</div><button type="button" class="button" data-context-action="edit-goal">编辑</button></div>`;
        const rows = blocks.filter(x => x.id !== 'task:goal').map(b => {
          const editing = state.editingBlock === b.id;
          const editControl = canEdit(b) ? (editing
            ? `<form class="context-block-edit" data-context-block-form data-context-block-id="${esc(b.id)}"><textarea name="content">${esc(b.content || '')}</textarea><div class="context-form-actions"><button type="button" class="button" data-context-action="cancel-block-edit">取消</button><button type="submit" class="button primary">保存覆盖项</button></div></form>`
            : `<button type="button" class="button context-edit-block" data-context-action="edit-block" data-context-block="${esc(b.id)}">编辑</button>`) : '';
          return `<article class="context-block-card ${b.enabled ? '' : 'disabled'} ${state.focusBlock === b.id ? 'focused' : ''}" data-context-block-card="${esc(b.id)}"><div class="context-block-head"><div><i class="context-source-dot ${esc(b.source)}"></i><strong>${esc(b.label)}</strong><span class="context-trust">${esc(b.trust)}</span></div><label class="context-check"><input type="checkbox" data-context-toggle="${esc(b.id)}" ${b.enabled ? 'checked' : ''} ${b.toggleable ? '' : 'disabled'} aria-label="${b.toggleable ? '控制是否载入' : '只读上下文区块'}"><span>${b.toggleable ? (b.enabled ? '载入' : '排除') : '只读'}</span></label></div><div class="context-block-meta"><span>${esc(b.scope || '')}</span><span>v${esc(b.version || 0)}</span><span>${formatTokens(b.tokens)} tokens</span>${b.overridden ? '<span class="context-overridden">本地覆盖</span>' : ''}</div>${editing ? editControl : `<pre class="context-block-content">${esc(String(b.content || ''))}</pre>${editControl}`}<small>${esc(b.reason || '')}</small></article>`;
        }).join('');
        body = `<section class="context-content"><div class="context-notice">这里编辑的是本地类型化覆盖项，不直接改写系统规则、能力、权限、工具协议或原始会话。${help('context-edit')} 停用区块会在下一次 Agent 会话中生效。</div>${goal}<div class="context-block-list">${rows}</div></section>`;
      } else if (state.view === 'audit') {
        const issueHtml = (audit.issues || []).map(x => `<li class="audit-item ${esc(x.level)}"><i></i><div><strong>${esc(x.label)}</strong><p>${esc(x.detail)}</p></div></li>`).join('');
        body = `<section class="context-audit"><div class="audit-banner ${audit.status}"><strong>${levelLabel}</strong><span>${audit.issues?.length || 0} 个审计提示</span></div><p class="context-notice">审计只检查来源、范围、容量和疑似污染信号，不会把用户资料当成系统指令。发现问题后可排除区块、编辑任务覆盖项，或重建干净上下文。</p><ul class="audit-list">${issueHtml || '<li class="audit-empty">当前没有发现需要处理的污染信号。</li>'}</ul></section>`;
      } else if (state.view === 'history') {
        const history = current.task?.context?.history || [];
        const items = history.map(x => { const changes = diff(x.before, x.after).map(change => `<li><code>${esc(change.key)}</code><del>${esc(textOf(change.before))}</del><ins>${esc(textOf(change.after))}</ins></li>`).join(''); return `<li class="context-history-item"><div><strong>${esc(x.label)}</strong><time>${new Date(x.time).toLocaleString()}</time></div><p>${esc(x.detail || '上下文覆盖项已保存为一个可恢复版本。')}</p><details><summary>查看差异（${diff(x.before, x.after).length}）</summary><ul class="context-diff">${changes || '<li>无覆盖项差异</li>'}</ul></details><button type="button" class="button" data-context-restore="${esc(x.id)}">恢复此版本</button></li>`; }).join('');
        body = `<section class="context-history"><p class="context-notice">历史只保存结构化覆盖项和审计元数据，不复制完整附件或工具输出，避免额外占用空间。</p><ol>${items || '<li class="context-empty">还没有上下文版本记录。</li>'}</ol></section>`;
      } else {
        const settings = over.settings || DEFAULTS.settings;
        body = `<section class="context-settings"><div class="context-setting-row"><div><strong>自动压缩策略</strong><p>达到已知容量阈值时的行为；默认先询问。</p></div><select data-context-setting="autoCompact"><option value="ask" ${settings.autoCompact === 'ask' ? 'selected' : ''}>请求确认</option><option value="auto" ${settings.autoCompact === 'auto' ? 'selected' : ''}>自动压缩</option><option value="off" ${settings.autoCompact === 'off' ? 'selected' : ''}>关闭</option></select></div><div class="context-setting-row"><div><strong>容量提醒阈值</strong><p>仅在 provider 提供容量时提醒。</p></div><select data-context-setting="threshold"><option value="0.7" ${Number(settings.threshold) === .7 ? 'selected' : ''}>70%</option><option value="0.8" ${Number(settings.threshold) === .8 ? 'selected' : ''}>80%</option><option value="0.9" ${Number(settings.threshold) === .9 ? 'selected' : ''}>90%</option></select></div><div class="context-setting-row"><div><strong>输出预留 tokens</strong><p>计入容量估算，为模型输出和工具事件留出空间；范围 256 到 65536，默认 4096。</p></div><input type="number" min="256" max="65536" step="256" data-context-setting="reserveTokens" value="${Number(settings.reserveTokens)||4096}" aria-label="输出预留 tokens"></div><div class="context-setting-row"><div><strong>工具结果</strong><p>是否把当前工作台的结构化结果放入下一轮上下文。</p></div><label class="context-switch"><input type="checkbox" data-context-setting="includeToolResults" ${over.includeToolResults !== false ? 'checked' : ''}><span></span></label></div><div class="context-setting-row"><div><strong>附件</strong><p>是否把本轮附件作为 Agent 输入。</p></div><label class="context-switch"><input type="checkbox" data-context-setting="includeAttachments" ${over.includeAttachments !== false ? 'checked' : ''}><span></span></label></div></section>`;
      }
      container.innerHTML = `<div class="context-page"><header class="context-page-head"><div><span class="context-kicker">CONTEXT CONTROL</span><h2>上下文查看</h2><p>按来源、范围和信任级别查看当前 Agent 实际可见的信息。</p></div><div class="context-revision">r${s.revision || 0}<small>${levelLabel}</small></div></header><div class="context-toolbar"><button type="button" class="button" data-context-action="refresh">刷新</button><button type="button" class="button" data-context-action="preview">发送预览</button>${help('context-preview')}<button type="button" class="button" data-context-action="compact">压缩</button>${help('context-compress')}<button type="button" class="button" data-context-action="undo">撤销</button><button type="button" class="button" data-context-action="rebuild">重建干净上下文</button><button type="button" class="button danger" data-context-action="reset">重置当前上下文</button></div><nav class="context-tabs" role="tablist">${tabHtml}</nav>${preview}${body}</div>`;
    };
    if (!container.__contextInspectorBound) {
      container.__contextInspectorBound = true;
      container.addEventListener('click', event => {
        const current = currentOptions();
        const ui = currentState();
        const redraw = () => container.__contextInspectorRender?.();
        const view = event.target.closest('[data-context-view]');
        if (view) { ui.view = view.dataset.contextView; ui.editing = false; redraw(); return; }
        const source = event.target.closest('[data-context-source]');
        if (source) { ui.focusBlock = source.dataset.contextSource; ui.view = 'content'; redraw(); return; }
        const action = event.target.closest('[data-context-action]');
        if (action) {
          const name = action.dataset.contextAction;
          if (name === 'edit-goal') { ui.editing = true; redraw(); return; }
          if (name === 'cancel-edit') { ui.editing = false; redraw(); return; }
          if (name === 'edit-block') { ui.editingBlock = action.dataset.contextBlock || null; redraw(); return; }
          if (name === 'cancel-block-edit') { ui.editingBlock = null; redraw(); return; }
          if (name === 'close-preview') { ui.preview = null; redraw(); return; }
          if (name === 'preview') {
            const result = current.getPreview ? current.getPreview(ui.snapshot) : current.preview;
            if (result && typeof result.then === 'function') result.then(value => { ui.preview = value || previewObject(ui.snapshot); redraw(); }).catch(() => { ui.preview = previewObject(ui.snapshot); redraw(); });
            else { ui.preview = result || previewObject(ui.snapshot); redraw(); }
            return;
          }
          current.onAction?.(name, ui); return;
        }
        const restoreButton = event.target.closest('[data-context-restore]');
        if (restoreButton) { if (current.onRestore) current.onRestore(restoreButton.dataset.contextRestore); else current.onAction?.('restore', ui, restoreButton.dataset.contextRestore); return; }
      });
      container.addEventListener('change', event => {
        const current = currentOptions();
        const toggle = event.target.closest('[data-context-toggle]');
        if (toggle) { current.onToggle?.(toggle.dataset.contextToggle, toggle.checked); return; }
        const setting = event.target.closest('[data-context-setting]');
        if (setting) { current.onSetting?.(setting.dataset.contextSetting, setting.type === 'checkbox' ? setting.checked : setting.value); }
      });
      container.addEventListener('submit', event => {
        const current = currentOptions();
        const ui = currentState();
        const redraw = () => container.__contextInspectorRender?.();
        const form = event.target.closest('[data-context-form]');
        const blockForm = event.target.closest('[data-context-block-form]');
        if (!form && !blockForm) return;
        event.preventDefault();
        const data = new FormData(form || blockForm);
        if (blockForm) {
          const id = blockForm.dataset.contextBlockId;
          const value = String(data.get('content') || '');
          current.onEdit?.(id === 'conversation:summary' ? { summary: value } : { blockEdits: { [id]: value } });
          ui.editingBlock = null;
        } else {
          current.onEdit?.({ goal: String(data.get('goal') || ''), notes: String(data.get('notes') || '') });
          ui.editing = false;
        }
        redraw();
      });
    }
    container.__contextInspectorRender = render;
    render();
  }
  window.PiContextInspector = Object.freeze({ ensure, defaults, materialize, applyOverrides, overrides, update, restore, reset, checkpoint, undo, diff, estimate, buildSnapshot, previewObject, mount, formatTokens });
})();
