'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiExecutionGraph = api;
})(typeof window === 'object' ? window : globalThis, function (root) {
  // All state is JSON-serializable and belongs to the message. No provider calls.
  // execution_node: {node:{id,kind,label,status,parentId,dependencies,attempt,
  //   retryOf,stepId,tool,file,startedAt,finishedAt}, timestamp?, eventId?}.
  // subagent/task_{start,update,end,error,stopped} accept the same node fields.
  // IDs are stable within a run; reuse requires an explicit incremented attempt.
  const terminal = new Set(['done', 'error', 'stopped', 'interrupted', 'skipped']);
  const statuses = new Set(['running', 'waiting', 'queued', 'done', 'error', 'stopped', 'interrupted', 'skipped']);
  const statusLabels = { running: '进行中', waiting: '等待中', queued: '排队中', done: '完成', error: '失败', stopped: '已停止', interrupted: '中断', skipped: '已跳过' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const stamp = value => number(value) ?? (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
  const timeOf = (event, now) => stamp(event?.timestamp) ?? stamp(event?.at) ?? stamp(event?.message?.timestamp) ?? stamp(event?.assistantMessageEvent?.timestamp) ?? now;
  const normalizeStatus = value => ({ complete: 'done', completed: 'done', success: 'done', failed: 'error', aborted: 'stopped', cancelled: 'stopped', canceled: 'stopped', paused: 'waiting', pending: 'queued' }[value] || (statuses.has(value) ? value : null));
  const identity = value => value?.id != null ? 'id:' + value.id : value?.responseId != null ? 'response:' + value.responseId : value?.timestamp != null ? 'timestamp:' + value.timestamp : null;
  const textOf = value => typeof value?.content === 'string' ? value.content : (value?.content || []).filter(x => x.type === 'text').map(x => x.text || '').join('');
  const duration = ms => ms == null ? '未记录' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' 秒';

  function ensure(message) {
    const run = message.run;
    if (!run) return null;
    run.graph ||= { version: 1, nodes: [], eventIds: [], sequence: 0 };
    run.metrics ||= { version: 1, generations: [], waits: [], sequence: 0 };
    return run;
  }
  function start(message, now = Date.now()) {
    message.run ||= { status: 'running', startedAt: now, steps: [], changedFiles: [] };
    ensure(message);
    return message.run.graph;
  }
  function eventSeen(graph, event) {
    const id = event.eventId ?? event.sequence ?? event.seq;
    if (id == null) return false;
    const key = JSON.stringify([event.type, String(id)]);
    if (graph.eventIds.includes(key)) return true;
    graph.eventIds.push(key);
    return false;
  }
  function attemptId(id, attempt) { return attempt > 1 ? id + '::attempt:' + attempt : id; }

  // Temporal edges express observed order, not tool-call order in an LLM turn.
  // A join depends on every maximal completed interval before its start.
  function inferDependencies(graph) {
    const groups=new Map();
    for(const node of graph.nodes){if(!groups.has(node.parentId))groups.set(node.parentId,[]);groups.get(node.parentId).push(node);}
    for (const node of graph.nodes) {
      if (node.explicitDependencies || node.startedAt == null) continue;
      const before = groups.get(node.parentId).filter(other => other !== node && other.finishedAt != null && other.startedAt != null &&
        (other.finishedAt < node.startedAt || other.finishedAt === node.startedAt && other.finishOrder < node.startOrder));
      // A predecessor is maximal exactly when it does not finish before the
      // latest start among candidates. This replaces a nested scan per pair.
      let latestTime=-Infinity,latestOrder=-Infinity;
      for(const b of before)if(b.startedAt>latestTime||b.startedAt===latestTime&&b.startOrder>latestOrder){latestTime=b.startedAt;latestOrder=b.startOrder;}
      node.dependencies = before.filter(a => !(a.finishedAt<latestTime||a.finishedAt===latestTime&&a.finishOrder<latestOrder)).map(x=>x.id);
      if (node.retryOf && !node.dependencies.includes(node.retryOf)) node.dependencies.push(node.retryOf);
    }
  }
  function structured(event) {
    if (event.type === 'execution_node') return { ...(event.params || {}), ...(event.node || {}) };
    const match = /^(subagent|task)_(start|update|end|error|stopped)$/.exec(event.type);
    if (!match) return null;
    const value = { ...event, ...(event.params || {}), ...(event.node || {}), kind: match[1] };
    value.id ??= event.nodeId ?? event.subagentId ?? event.taskId;
    value.status ??= { start: 'running', end: event.isError ? 'error' : 'done', error: 'error', stopped: 'stopped' }[match[2]];
    return value;
  }
  function nodeEvent(run, event, at) {
    const graph = run.graph;
    const isTool = /^tool_execution_(start|update|end)$/.test(event.type);
    let value = structured(event);
    if (isTool) {
      const args = event.args || event.input || {};
      const existing = event.toolCallId == null ? graph.nodes.findLast(x => x.kind === 'tool' && !terminal.has(x.status)) : null;
      if (!event.toolCallId && event.type !== 'tool_execution_start' && !existing) return {};
      value = { ...event, id: event.toolCallId ?? existing?.sourceId ?? 'tool-' + (++graph.sequence), kind: 'tool',
        tool: event.toolName, label: event.toolName, file: args.path || args.file_path || args.filePath || args.filename,
        target: args.path || args.file_path || args.filePath || args.filename || args.command,
        status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'done') : 'running' };
    }
    if (!value || value.id == null || String(value.id) === '') return {};
    const sourceId = String(value.id);
    const attempt = Math.max(1, Math.floor(number(value.attempt ?? value.retryAttempt) ?? 1));
    const id = attemptId(sourceId, attempt);
    let node = graph.nodes.find(x => x.id === id);
    const status = normalizeStatus(value.status) || node?.status || 'running';
    const eventAt = stamp(value.updatedAt) ?? at;
    if (node && (eventAt < node.updatedAt || terminal.has(node.status))) return { node, duplicate: true };
    if (node && isTool && event.type === 'tool_execution_start' && node.startedAt != null) return { node, duplicate: true };
    const order = ++graph.sequence;
    if (!node) {
      const previous = graph.nodes.findLast(x => x.sourceId === sourceId && x.attempt < attempt);
      node = { id, sourceId, attempt, kind: ['tool', 'task', 'subagent'].includes(value.kind) ? value.kind : 'task',
        label: '', parentId: null, dependencies: [], status, createdAt: eventAt,
        startedAt: null, finishedAt: null, stepId: String(value.stepId ?? id), updatedAt: eventAt };
      if (previous) node.retryOf = previous.id;
      graph.nodes.push(node);
    }
    for (const key of ['label', 'tool', 'file', 'target', 'stepId', 'retryOf']) if (value[key] != null) node[key] = String(value[key]);
    node.label ||= node.tool || (node.kind === 'subagent' ? '子任务' : node.kind === 'tool' ? '工具' : '任务');
    if (Object.hasOwn(value, 'parentId') || Object.hasOwn(value, 'parent')) node.parentId = value.parentId ?? value.parent ?? null;
    if (node.parentId != null) node.parentId = String(node.parentId);
    const dependencies = value.dependencies ?? value.dependsOn;
    if (Array.isArray(dependencies)) {
      node.dependencies = [...new Set(dependencies.filter(x => x != null).map(String))].filter(x => x !== id);
      node.explicitDependencies = true;
    }
    const startedAt = stamp(value.startedAt ?? value.startTime);
    if (startedAt != null || node.startedAt == null && status === 'running') {
      // A terminal event without a start does not invent an execution duration.
      node.startedAt = startedAt ?? eventAt;
      node.startOrder ||= order;
    }
    node.status = status;
    node.updatedAt = eventAt;
    if (terminal.has(status)) {
      node.finishedAt = Math.max(node.startedAt ?? 0, stamp(value.finishedAt ?? value.endTime) ?? eventAt);
      node.finishOrder = order;
    }
    if(event.type!=='tool_execution_update')inferDependencies(graph);
    return { node };
  }

  function normalizeUsage(value) {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) result[key] = number(value[key]);
    result.totalTokens = number(value.totalTokens ?? value.total);
    if (Object.values(result).every(x => x == null)) return null;
    if (result.totalTokens == null && result.input != null && result.output != null) {
      result.totalTokens = result.input + result.output + (result.cacheRead || 0) + (result.cacheWrite || 0);
    }
    return result;
  }
  function updateUsage(run) {
    const records = run.metrics.generations.filter(x => x.usage);
    if (!records.length) return;
    run.usage = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      const values = records.map(x => x.usage[key]).filter(x => x != null);
      run.usage[key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
    }
  }
  function generation(run, event, at, create = true) {
    const data = run.metrics;
    const key = identity(event.message ?? event.assistantMessageEvent?.partial);
    const parentId = event.parentId == null ? null : String(event.parentId);
    let item = key ? data.generations.find(x => x.messageKey === key) : null;
    if (!item) item = data.generations.findLast(x => !x.completed && x.parentId === parentId && (!key || !x.messageKey));
    if (!item && create) {
      item = { id: 'generation-' + (++data.sequence), messageKey: key, parentId, startedAt: event.type === 'message_start' ? at : null,
        firstTokenAt: null, finishedAt: null, chars: 0, completed: false };
      data.generations.push(item);
    }
    if (item && key) item.messageKey ||= key;
    return item;
  }
  function closeWaits(run, at, parentId = null) {
    for (const wait of run.metrics.waits) if (wait.finishedAt == null && wait.parentId === parentId) wait.finishedAt = Math.max(wait.startedAt, at);
  }
  function observeGeneration(run, event, at) {
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      const item = generation(run, event, at);
      if (item.completed || item.startSeen) return { duplicate: true };
      item.startSeen = true;
      item.startedAt ??= at;
      closeWaits(run, at, item.parentId);
    }
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (!delta) return {};
      const item = generation(run, event, at);
      if (item.completed) return { duplicate: true };
      if (/_delta$/.test(delta.type) && typeof delta.delta === 'string' && delta.delta.length) {
        item.firstTokenAt ??= at;
        // Count characters only; never persist or render private reasoning text.
        item.chars += delta.delta.length;
        closeWaits(run, at, item.parentId);
      }
      const usage = normalizeUsage(event.message?.usage || event.usage || delta.partial?.usage);
      if (usage && Object.values(usage).some(x => x > 0)) { item.usage = usage; item.usageFinal = false; updateUsage(run); }
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      // Message IDs/timestamps are preferred. Identity-free end replays can only
      // be recognized between starts; two newly started identical replies count.
      const signature = JSON.stringify([textOf(event.message), (event.message.content || []).filter?.(x => x.type === 'toolCall').map(x => x.id), event.message.stopReason]);
      let item = generation(run, event, at, false);
      if (!item && !identity(event.message)) item = run.metrics.generations.findLast(x => x.endSignature === signature);
      item ||= generation(run, event, at);
      const duplicate = item.completed;
      item.finishedAt ??= at;
      item.completed = true;
      item.endSignature = signature;
      item.chars = Math.max(item.chars, textOf(event.message).length);
      const usage = normalizeUsage(event.message.usage);
      if (usage) { item.usage = usage; item.usageFinal = true; updateUsage(run); }
      return { duplicate };
    }
    return {};
  }
  function apply(message, event, now = Date.now()) {
    const run = ensure(message);
    if (!run || run.status !== 'running' || !event || event.runId != null && String(event.runId) !== String(message.id)) return { duplicate: true };
    if (eventSeen(run.graph, event)) return { duplicate: true };
    const at = timeOf(event, now);
    const result = nodeEvent(run, event, at);
    if (result.duplicate) return result;
    const generationResult = observeGeneration(run, event, at);
    if (event.type === 'extension_ui_request' || event.type === 'auto_retry_start') {
      const parentId = event.parentId == null ? null : String(event.parentId);
      if (!run.metrics.waits.some(x => x.finishedAt == null && x.parentId === parentId)) run.metrics.waits.push({ startedAt: at, finishedAt: null, parentId, kind: event.type });
      const active = run.graph.nodes.filter(x => x.kind === 'tool' && x.status === 'running' && x.parentId === parentId && (!event.toolCallId || x.sourceId === event.toolCallId));
      if (active.length === 1) { active[0].status = 'waiting'; result.node = active[0]; }
    }
    if (['extension_ui_response', 'auto_retry_end', 'tool_execution_end'].includes(event.type)) closeWaits(run, at, event.parentId == null ? null : String(event.parentId));
    if (event.type === 'agent_end') {
      // Final usage is sometimes delivered only here. Reuse identity-bearing
      // records without replaying transcript text or charging the entire history.
      const last = (event.messages || []).findLast(x => x.role === 'assistant');
      if (last && (!run.metrics.generations.length || identity(last) && run.metrics.generations.some(x => x.messageKey === identity(last)))) observeGeneration(run, { type: 'message_end', message: last }, at);
    }
    return { ...result, ...generationResult, at };
  }
  function finish(message, status, now = Date.now()) {
    const run = ensure(message);
    if (!run) return;
    const at = stamp(run.finishedAt) ?? now;
    for (const node of run.graph.nodes) if (!terminal.has(node.status)) {
      node.status = 'stopped';
      node.interrupted = true;
      node.settledBy = status || run.status;
      node.finishedAt = Math.max(node.startedAt ?? 0, at);
      node.updatedAt = node.finishedAt;
      node.finishOrder = ++run.graph.sequence;
    }
    for (const item of run.metrics.generations) if (!item.completed) { item.finishedAt ??= at; item.completed = true; item.interrupted = true; }
    for (const wait of run.metrics.waits) if (wait.finishedAt == null) wait.finishedAt = Math.max(wait.startedAt, at);
    inferDependencies(run.graph);
  }

  function unionLength(intervals) {
    let end = -Infinity, total = 0;
    for (const [a, b] of intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    return total;
  }
  function metrics(message, now = Date.now()) {
    const run = message?.run;
    if (!run) return null;
    const data = run.metrics || { generations: [], waits: [] };
    const end = stamp(run.finishedAt) ?? now;
    let generationMs = 0, timedOutput = 0, estimate = 0, timingEstimated = false, missingTiming = false;
    const firstTokens = [];
    for (const item of data.generations) {
      if (item.firstTokenAt != null) firstTokens.push(item.firstTokenAt);
      const output = item.usage?.output ?? Math.ceil(item.chars / 4);
      if (item.usage?.output == null) estimate += Math.ceil(item.chars / 4);
      const a = item.firstTokenAt ?? item.startedAt, b = item.finishedAt ?? end;
      if (a == null || b <= a) { if (output > 0) missingTiming = true; continue; }
      const waits = [...data.waits, ...(run.graph?.nodes || []).filter(x => x.kind === 'tool')].filter(x => x.parentId === item.parentId && x.startedAt != null);
      const excluded = unionLength(waits.map(x => [Math.max(a, x.startedAt), Math.min(b, x.finishedAt ?? end)]));
      const ms = Math.max(0, b - a - excluded);
      if (!ms && output > 0) missingTiming = true;
      generationMs += ms;
      timedOutput += output;
      timingEstimated ||= item.firstTokenAt == null || item.usage?.output == null;
    }
    const usage = normalizeUsage(run.usage);
    const partial = data.generations.some(x => !x.usageFinal || !x.usage);
    const elapsedMs = stamp(run.startedAt) == null ? null : Math.max(0, end - run.startedAt);
    return { usage, estimatedOutput: estimate, hasEstimate: data.generations.some(x => x.chars > 0 && x.usage?.output == null), partial,
      elapsedMs, generationMs, firstTokenLatencyMs: firstTokens.length && stamp(run.startedAt) != null ? Math.max(0, Math.min(...firstTokens) - run.startedAt) : null,
      tokensPerSecond: !missingTiming && generationMs > 0 ? timedOutput * 1000 / generationMs : null,
      speedEstimated: timingEstimated || partial, timingEstimated };
  }
  function help(id) { return typeof root.PiHelp?.button === 'function' ? root.PiHelp.button(id) || '' : ''; }
  function metricsMarkup(message, options = {}) {
    const value = metrics(message, options.now ?? Date.now());
    if (!value) return '';
    const count = n => n == null ? '未报告' : n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    const speed = value.tokensPerSecond == null ? '未记录' : (value.speedEstimated ? '约 ' : '') + value.tokensPerSecond.toFixed(1) + ' tokens/s';
    if (options.compact) return '<span class="run-metrics-compact" data-message="' + escape(message.id) + '">输出 ' + (value.hasEstimate ? '约 ' + count(value.estimatedOutput) + '（估算）' : count(value.usage?.output)) + ' · ' + speed + ' · ' + duration(value.elapsedMs) + '</span>';
    const rows = [['输入 token', count(value.usage?.input)], ['输出 token', count(value.usage?.output)], ['缓存读取', count(value.usage?.cacheRead)], ['缓存写入', count(value.usage?.cacheWrite)], ['总 token', count(value.usage?.totalTokens)], ['输出速度' + (value.speedEstimated ? '（估算）' : ''), speed], ['首 token 延迟', duration(value.firstTokenLatencyMs)], ['生成用时' + (value.timingEstimated ? '（估算）' : ''), value.generationMs > 0 ? duration(value.generationMs) : '未记录'], ['总用时', duration(value.elapsedMs)]];
    return '<section class="run-metrics" aria-label="运行摘要" data-message="' + escape(message.id) + '"><header><span class="summary-heading">运行摘要</span>' + help('token-rate') + '</header><dl>' + rows.map(([label, text]) => '<div><dt>' + label + '</dt><dd>' + text + '</dd></div>').join('') + '</dl>' +
      (value.hasEstimate ? '<p class="run-metrics-estimate">未报告部分：流式输出约 ' + count(value.estimatedOutput) + ' token（字符估算，非计费数据）。</p>' : '') +
      '<p class="review-note">' + (value.usage ? 'Token 来自模型 usage' + (value.partial ? '（部分消息尚未报告）' : '') : '模型尚未报告 usage') + '；速度按输出 token / 生成用时计算，排除工具和确认等待。首 token 延迟从本轮开始计时；未收到流式 token 时不推测。</p></section>';
  }

  // Interval lanes only overlap if execution timestamps actually overlap.
  // Parent/dependency edges are independent of lanes and may branch or join.
  function layout(message, now = Date.now()) {
    const nodes = [...(message?.run?.graph?.nodes || [])].sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt) || (a.startOrder || 0) - (b.startOrder || 0));
    const lanes = [];
    return nodes.map((node, index) => {
      const start = node.startedAt ?? node.createdAt;
      const end = node.finishedAt ?? message.run.finishedAt ?? now;
      let lane = node.startedAt == null ? 0 : lanes.findIndex(x => x <= start);
      if (lane < 0) lane = lanes.length;
      if (node.startedAt != null) lanes[lane] = end;
      return { ...node, lane, row: index };
    });
  }
  function graphMarkup(message, options = {}) {
    const now = options.now ?? Date.now();
    const nodes = layout(message, now);
    const header = '<header><span class="summary-heading">执行图</span>' + help('execution-graph') + '</header>';
    if (!nodes.length) return '<section class="execution-graph" aria-label="执行图">' + header + '<p class="review-empty">尚无执行事件。工具实际执行或明确的任务 / 子代理事件会显示在这里。</p></section>';
    const height = nodes.length * 54 + 12;
    const width = Math.max(24, ...nodes.map(x => 16 + x.lane * 16));
    const positions = new Map(nodes.map(x => [x.id, x]));
    const edges = [];
    for (const node of nodes) for (const id of new Set([node.parentId, ...(node.dependencies || [])].filter(Boolean))) {
      const from = positions.get(id);
      if (!from || from === node) continue;
      const x1 = 10 + from.lane * 16, x2 = 10 + node.lane * 16, y1 = 27 + from.row * 54, y2 = 27 + node.row * 54;
      edges.push('<path class="' + (id === node.parentId ? 'graph-parent-edge' : 'graph-order-edge') + '" d="M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + 27) + ' ' + x2 + ' ' + (y2 - 27) + ' ' + x2 + ' ' + y2 + '"/>');
    }
    const svg = '<svg class="graph-lines" width="' + width + '" height="' + height + '" aria-hidden="true">' + edges.join('') + nodes.map(x => '<circle class="graph-dot ' + escape(x.status) + '" cx="' + (10 + x.lane * 16) + '" cy="' + (27 + x.row * 54) + '" r="3"/>').join('') + '</svg>';
    const clock = time => time == null ? '未记录' : new Date(time).toISOString();
    const rows = nodes.map(node => '<li class="graph-row" data-node="' + escape(node.id) + '"><button type="button" class="graph-node" data-action="focus-run-step" data-message="' + escape(message.id) + '" data-step="' + escape(node.stepId || node.id) + '" title="跳到操作记录"><span class="graph-node-label">' + escape(node.label) + '</span><span class="graph-status ' + escape(node.status) + '">' + escape(statusLabels[node.status] || node.status) + '</span><small>' + escape(node.file || node.target || node.kind) + '</small></button><details class="graph-node-details" data-graph-details="' + escape(node.id) + '"><summary aria-label="展开节点详情">详情</summary><dl>' +
      [['节点', node.id], ['用时', node.startedAt == null ? '未记录' : duration(Math.max(0, (node.finishedAt ?? message.run.finishedAt ?? now) - node.startedAt))], ['开始', clock(node.startedAt)], ['结束', clock(node.finishedAt)], ['工具', node.tool], ['文件', node.file], ['父节点', node.parentId], ['依赖', node.dependencies?.join(', ')], ['重试', node.retryOf], ['状态说明', node.interrupted ? '运行结束时未收到该节点的完成事件' : null]].filter(([, value]) => value != null && value !== '').map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + escape(value) + '</dd></div>').join('') + '</dl></details></li>').join('');
    return '<section class="execution-graph" aria-label="执行图" data-message="' + escape(message.id) + '">' + header + '<p class="review-note">实线表示执行先后，虚线表示父子关系；分支只来自明确事件或实际时间重叠。节点可跳转，详情可展开。</p><div class="execution-graph-scroll" tabindex="0" aria-label="执行节点"><div class="execution-graph-tree" style="--graph-gutter:' + width + 'px">' + svg + '<ol>' + rows + '</ol></div></div></section>';
  }
  return { start, apply, finish, graphMarkup, metricsMarkup, metrics, layout, normalizeUsage };
});
