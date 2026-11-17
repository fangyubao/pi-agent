'use strict';
// 工作流图：节点校验、环检测、串行/并行分层布局。纯函数，无 DOM、无 Electron，浏览器与 Node 通用（UMD）。
// 精简原则：P0 只做“拆解 + 展示 + 编辑”，所以节点只保留展示和修改所需的字段；
// 预算、失败策略、状态哈希等执行期字段等接入执行引擎时再加，现在不占 token、不占存储。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiWorkflowGraph = api; })(typeof window === 'object' ? window : globalThis, () => {
  const LIMITS = { agents: 4, agent: 8, nodes: 36, nodesEdited: 72, title: 24, role: 20, brief: 80, prompt: 1500, skills: 4, tools: 4, goal: 60 };
  const LEGACY_TIER = { light: 1, standard: 3, strong: 5 };
  const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high'];
  const tierOf = v => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : (LEGACY_TIER[v] || 3));
  const ID_RE = /^n[0-9A-Z]{1,2}$/;                                 // n<阶段号>[<并行序号>]，符号 0-9A-Z：n0、n1、n10、n11、n1A …
  const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
  const list = (value, max, itemMax) => [...new Set((Array.isArray(value) ? value : []).map(x => clip(x, itemMax)).filter(Boolean))].slice(0, max);

  const RUN_STATUS = ['running', 'done', 'error', 'stale'];
  const DELIVER = ['table', 'html', 'image', 'file'];                // 节点需要哪类文件产出；空 = 只给文字（默认，零额外 token）
  const art = a => (a && typeof a === 'object' && clip(a.name, 80) ? { name: clip(a.name, 80), kind: DELIVER.includes(a.kind) ? a.kind : 'file', bytes: Number.isFinite(a.bytes) ? Math.max(0, Math.floor(a.bytes)) : 0 } : null);
  const inp = a => (a && typeof a === 'object' && clip(a.name, 80) ? { name: clip(a.name, 80), kind: ['text', 'table', 'image', 'binary'].includes(a.kind) ? a.kind : 'binary', bytes: Number.isFinite(a.bytes) ? Math.max(0, Math.floor(a.bytes)) : 0 } : null);
  function runOf(r) {
    if (!r || typeof r !== 'object' || !RUN_STATUS.includes(r.status)) return null;
    return { status: r.status, output: clip(r.output, 6000), error: clip(r.error, 300), model: clip(r.model, 120), artifacts: (Array.isArray(r.artifacts) ? r.artifacts : []).map(art).filter(Boolean).slice(0, 4), warnings: (Array.isArray(r.warnings) ? r.warnings : []).map(w => clip(w, 120)).filter(Boolean).slice(0, 4), usage: r.usage && Number.isFinite(r.usage.input) && Number.isFinite(r.usage.output) ? { input: r.usage.input, output: r.usage.output } : null, at: Number.isFinite(r.at) ? r.at : 0 };
  }

  // 规范化一个节点：只保留已知字段并截断。不抛错，错误统一由 validate 汇总。
  function normalizeNode(input) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const prompt = clip(raw.prompt, LIMITS.prompt);
    return {
      id: clip(raw.id, 8),
      uid: /^[a-z0-9]{6,16}$/.test(String(raw.uid || '')) ? String(raw.uid) : '',   // 不随重新编号变化的内部标识：附件按它存放，所以改编号/改标题都不会让附件和节点对不上
      title: clip(raw.title, LIMITS.title),
      agent: clip(raw.agent, LIMITS.agent),                              // 所属子智能体的简短名字（如“研究员”）；空 = 不分组
      role: clip(raw.role, LIMITS.role) || '执行者',                       // 扮演的角色/岗位；缺省给中性默认值，它只用于展示，不值得因此丢掉整份计划
      brief: clip(raw.brief, LIMITS.brief) || clip(prompt, LIMITS.brief),  // 一行任务介绍；缺省取提示词开头
      prompt,                                                            // 完整提示词，双击才展示
      tier: tierOf(raw.tier),                                            // 难度 1-5（兼容旧的 light/standard/strong），决定默认用哪档模型
      effort: EFFORTS.includes(raw.effort) ? raw.effort : null,          // 思考强度；null = 跟随模型默认
      model: raw.model && typeof raw.model === 'object' ? { profileId: clip(raw.model.profileId, 80), model: clip(raw.model.model, 120), source: raw.model.source === 'user' ? 'user' : 'auto', ...(Number.isInteger(raw.model.tier) ? { tier: raw.model.tier } : {}) } : null,
      run: runOf(raw.run),                                               // 最近一次运行结果；改动节点后会被清空/标记过期
      deliver: [...new Set((Array.isArray(raw.deliver) ? raw.deliver : []).filter(x => DELIVER.includes(x)))].slice(0, 2),   // 要什么文件产出；只有真需要时才有
      inputs: (Array.isArray(raw.inputs) ? raw.inputs : []).map(inp).filter(Boolean).slice(0, 6),                              // 用户给这个节点的附件（元数据；文件本身在节点文件夹的 inputs/ 里）
      dependsOn: list(raw.dependsOn, 36, 8),
      skills: list(raw.skills, LIMITS.skills, 40),                       // 技能库里的技能 id
      tools: list(raw.tools, LIMITS.tools, 60),                          // MCP 服务器名 / 插件名
      origin: raw.origin === 'user' ? 'user' : 'planner'
    };
  }

  // 校验计划。返回 { ok, errors, plan }；errors 是给人看的中文，也可原样喂回模型让它修复。
  function validate(rawNodes, options = {}) {
    const errors = [];
    const max = options.edited ? LIMITS.nodesEdited : LIMITS.nodes;
    const input = Array.isArray(rawNodes) ? rawNodes : [];
    if (!input.length) return { ok: false, errors: ['没有任何节点'], plan: { nodes: [], layers: [] } };
    if (input.length > max) errors.push('节点过多：最多 ' + max + ' 个，收到 ' + input.length + ' 个');
    const nodes = input.slice(0, max).map(normalizeNode);
    const ids = new Set();
    for (const n of nodes) {
      if (!ID_RE.test(n.id)) errors.push('节点 id 不合法：' + JSON.stringify(n.id) + '（应为 n0、n1、n10、n11、n1A …）');
      else if (ids.has(n.id)) errors.push('节点 id 重复：' + n.id);
      ids.add(n.id);
      if (!n.title) errors.push((n.id || '?') + ' 缺少标题');
      if (!n.prompt) errors.push((n.id || '?') + ' 缺少提示词');
    }
    for (const n of nodes) {
      for (const d of n.dependsOn) {
        if (d === n.id) errors.push(n.id + ' 依赖了自己');
        else if (!ids.has(d)) errors.push(n.id + ' 依赖了不存在的节点 ' + d);
      }
    }
    const agentNames = [...new Set(nodes.map(n => n.agent).filter(Boolean))];
    if (agentNames.length > LIMITS.agents) errors.push('子智能体过多：最多 ' + LIMITS.agents + ' 个，收到 ' + agentNames.length + ' 个（' + agentNames.join('、') + '）。请把职责相近的合并');
    const cycle = errors.length ? null : findCycle(nodes);
    if (cycle) errors.push('存在循环依赖：' + cycle.join(' → '));
    const plan = { nodes, layers: errors.length ? [] : layout(nodes).layers };
    return { ok: !errors.length, errors, plan };
  }

  // Kahn 拓扑排序；排不完的节点里必有环，沿依赖回溯找出一个具体的环，错误信息才有用。
  function findCycle(nodes) {
    const indeg = new Map(nodes.map(n => [n.id, n.dependsOn.length]));
    const down = new Map(nodes.map(n => [n.id, []]));
    for (const n of nodes) for (const d of n.dependsOn) down.get(d)?.push(n.id);
    const queue = [...indeg].filter(([, v]) => v === 0).map(([k]) => k), done = new Set();
    while (queue.length) { const id = queue.shift(); done.add(id); for (const next of down.get(id) || []) { indeg.set(next, indeg.get(next) - 1); if (indeg.get(next) === 0) queue.push(next); } }
    const rest = nodes.filter(n => !done.has(n.id));
    if (!rest.length) return null;
    const byId = new Map(rest.map(n => [n.id, n]));
    const seen = new Map(); let cur = rest[0].id; const trail = [];
    while (!seen.has(cur)) { seen.set(cur, trail.length); trail.push(cur); cur = byId.get(cur).dependsOn.find(d => byId.has(d)); if (!cur) return trail; }
    return [...trail.slice(seen.get(cur)), cur];
  }

  // 分层布局：层号 = 最长依赖链长度。同一层的节点互不依赖，即“并行”，画在同一列上下排；层与层之间从左到右是串行。
  // 同层内按“上游的平均行号”排序以减少连线交叉，这是最常用的启发式，不追求最优。
  function layout(nodes, { colWidth = 300, rowHeight = 190, nodeWidth = 240 } = {}) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const level = new Map();
    const depth = id => { if (level.has(id)) return level.get(id); level.set(id, 0); const d = Math.max(-1, ...(byId.get(id)?.dependsOn || []).filter(x => byId.has(x)).map(depth)) + 1; level.set(id, d); return d; };
    nodes.forEach(n => depth(n.id));
    const layers = [];
    for (const n of nodes) (layers[level.get(n.id)] ||= []).push(n.id);
    const row = new Map();
    layers.forEach((ids, col) => {
      if (col > 0) ids.sort((a, b) => avg(byId.get(a).dependsOn, row) - avg(byId.get(b).dependsOn, row) || a.localeCompare(b, 'en', { numeric: true }));
      ids.forEach((id, i) => row.set(id, i));
    });
    const tallest = Math.max(...layers.map(l => l.length));
    const positions = {};
    layers.forEach((ids, col) => {
      const offset = (tallest - ids.length) * rowHeight / 2;           // 让较短的一列在垂直方向居中
      ids.forEach((id, i) => { positions[id] = { x: col * colWidth, y: offset + i * rowHeight }; });
    });
    return { layers, positions, width: layers.length * colWidth - (colWidth - nodeWidth), height: tallest * rowHeight, parallel: layers.filter(l => l.length > 1).length };
  }
  const avg = (ids, row) => { const v = ids.map(id => row.get(id)).filter(x => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

  // 同层“并行”可用于展示；真正能否并行由执行层决定（需要工具的节点排队），所以这里不对执行方式做任何承诺。
  const edges = nodes => nodes.flatMap(n => n.dependsOn.map(from => ({ from, to: n.id })));

  // 修改某个节点后，哪些下游节点的结果会过期（P0 只用于在画布上标出来）。
  function downstreamOf(nodes, id) {
    const down = new Map(nodes.map(n => [n.id, []]));
    for (const n of nodes) for (const d of n.dependsOn) down.get(d)?.push(n.id);
    const out = [], seen = new Set([id]), stack = [...(down.get(id) || [])];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); out.push(x); stack.push(...(down.get(x) || [])); }
    return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  // 重新编号：id 反映“第几阶段、第几个并行”。符号集 0-9A-Z（36 个），阶段号与并行序号各占一位：
  //   串行：n0, n1, n2 …；某一阶段有多个并行节点：阶段号后面加序号，如第 1 阶段有 2 个并行 → n10, n11，下一阶段仍是 n2。
  //   第 1 阶段的第 11 个并行是 n1A。单个节点的阶段只有阶段号（n2），所以 2 位 = 阶段+序号，不会有歧义。
  //   阶段号 = 最长依赖链长度（与画布的列一致）。同一阶段内的先后顺序沿用画布的排序（减少连线交叉）。
  //   返回 { nodes, map }：map 是 旧id → 新id；dependsOn 同步改写。运行结果、模型、位置等随节点走，不丢。
  const SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function renumber(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const { layers } = layout(list);
    const map = {};
    layers.forEach((ids, stage) => {
      if (stage >= SYMBOLS.length) throw new Error('工作流最多 ' + SYMBOLS.length + ' 个阶段');
      if (ids.length > SYMBOLS.length) throw new Error('同一阶段最多 ' + SYMBOLS.length + ' 个并行节点（当前 ' + ids.length + ' 个）');
      ids.forEach((id, i) => { map[id] = ids.length === 1 ? 'n' + SYMBOLS[stage] : 'n' + SYMBOLS[stage] + SYMBOLS[i]; });
    });
    const out = list.map(n => ({ ...n, id: map[n.id] || n.id, dependsOn: (n.dependsOn || []).map(d => map[d] || d) }));
    const seen = new Set();
    for (const n of out) { if (seen.has(n.id)) throw new Error('重新编号后节点 id 冲突：' + n.id); seen.add(n.id); }
    const key = id => [SYMBOLS.indexOf(id[1]), id.length === 2 ? -1 : SYMBOLS.indexOf(id[2])];     // 先按阶段，再按并行序号
    return { nodes: out.sort((p, q) => { const x = key(p.id), y = key(q.id); return x[0] - y[0] || x[1] - y[1]; }), map };
  }

  // 子智能体按“第一次出现的先后”排序，颜色就按这个顺序分配，所以重排节点不会让颜色乱跳。
  const agentsOf = nodes => [...new Set((nodes || []).map(n => n && n.agent).filter(Boolean))];

  const newUid = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 8);
  return { LIMITS, DELIVER, newUid, agentsOf, EFFORTS, tierOf, normalizeNode, validate, findCycle, layout, edges, downstreamOf, renumber };
});
