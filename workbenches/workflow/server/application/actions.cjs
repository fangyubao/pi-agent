'use strict';
const graph = require('../../../../runtime/workflow-graph.js');
const { normalize } = require('../domain/state.cjs');
const { event } = require('../contracts/events.cjs');

class ActionError extends Error { constructor(message, code) { super(message); this.code = code; } }
const fail = (message, code) => { throw new ActionError(message, code); };

// 给 Agent 看的摘要：不含完整提示词，只给标题、角色、任务介绍、模型、依赖。这是“聊天里使用工作台时省 token”的关键。
const summarize = state => ({
  revision: state.revision, goal: state.goal, planRevision: state.planRevision, count: state.nodes.length,
  agents: Object.fromEntries(Object.entries(state.agents || {}).map(([k, v]) => [k, v.model ? v.model.model : null])),
  nodes: state.nodes.map(n => ({ id: n.id, deliver: n.deliver && n.deliver.length ? n.deliver : undefined, inputs: n.inputs && n.inputs.length ? n.inputs.map(i => i.name) : undefined, agent: n.agent || undefined, title: n.title, role: n.role, brief: n.brief, tier: n.tier, effort: n.effort, model: n.model ? n.model.model : null, dependsOn: n.dependsOn, skills: n.skills, tools: n.tools }))
});

function requireRevision(payload, state) {
  if (!Number.isInteger(payload.baseRevision)) fail('缺少 baseRevision，请先 readPlan', 'BAD_REQUEST');
  if (payload.baseRevision !== state.revision) fail('工作流已被修改（当前版本 ' + state.revision + '），请重新读取后再改', 'REVISION_CONFLICT');
}
// 结构变化（增删节点、改依赖、整体替换）后统一重新编号：id 反映阶段与并行序号。返回 旧id→新id 的映射。
function tidyIds(state) {
  const { nodes, map } = graph.renumber(state.nodes);
  state.nodes = nodes;
  return map;
}
const bump = (state, planChanged = false) => { state.revision++; if (planChanged) state.planRevision++; };
const findNode = (state, id) => state.nodes.find(n => n.id === String(id || '')) || fail('找不到节点：' + id, 'NOT_FOUND');
const keepPositions = (nodes, state) => { const keep = new Map(state.nodes.map(n => [n.id, n.pos])); return nodes.map(n => ({ ...n, pos: keep.get(n.id) || null })); };
function checked(nodes, state) {
  const r = graph.validate(nodes, { edited: true });
  if (!r.ok) fail(r.errors.slice(0, 4).join('；'), 'INVALID_PLAN');
  return keepPositions(r.plan.nodes, state);
}

// 某节点内容变了：它的下游结果已不再对应新的输入，标记为“过期”（内容保留，供查看，但不能当作上游使用）。
const markStale = (nodes, id) => { const down = new Set(graph.downstreamOf(nodes, id)); return nodes.map(n => (down.has(n.id) && n.run && n.run.status === 'done' ? { ...n, run: { ...n.run, status: 'stale' } } : n)); };

async function dispatch(input) {
  const out = await run(input);
  // uid：每个节点一个不随编号变化的内部标识。动作内部会重建节点（校验、重新编号），所以在出口统一保证：
  // 旧节点沿用原 uid（按 id 对应，重新编号映射由各动作自己维护，这里只补缺），新节点分配新 uid，且互不重复。
  const seen = new Set();
  out.state.nodes = out.state.nodes.map(n => { let uid = n.uid; while (!uid || seen.has(uid)) uid = graph.newUid(); seen.add(uid); return uid === n.uid ? n : { ...n, uid }; });
  // status 是由节点数量推导出的，统一在返回前重算，避免某个动作忘记更新。
  out.state.status = out.state.nodes.length ? 'planned' : 'empty';
  // 子智能体表只留还有节点在用的，避免删光节点后残留设置。
  const names = new Set(graph.agentsOf(out.state.nodes));
  out.state.agents = Object.fromEntries(Object.entries(out.state.agents || {}).filter(([k]) => names.has(k)));
  return out;
}

async function run({ action, payload = {}, state = {} }) {
  const next = normalize(state);
  switch (action) {
    case 'readPlan': return { state: next, result: summarize(next), events: [] };
    case 'readNode': return { state: next, result: findNode(next, payload.id), events: [] };

    case 'setPlan': {
      // 整体替换：来自拆解器，本来就是“从空白生成”，所以不要求 baseRevision；但会递增版本让正在编辑的界面感知到。
      const r = graph.validate(payload.nodes, { edited: false });
      if (!r.ok) fail(r.errors.slice(0, 4).join('；'), 'INVALID_PLAN');
      next.nodes = r.plan.nodes.map(n => ({ ...n, pos: null }));
      tidyIds(next);
      next.goal = String(payload.goal || '').slice(0, graph.LIMITS.goal);
      bump(next, true);
      return { state: next, result: { revision: next.revision, count: next.nodes.length }, events: [event('plan.updated', { revision: next.revision })] };
    }
    case 'updateNode': {
      requireRevision(payload, next);
      const target = findNode(next, payload.id);
      const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : fail('缺少 patch', 'BAD_REQUEST');
      const allowed = ['title', 'agent', 'role', 'brief', 'prompt', 'tier', 'effort', 'deliver', 'skills', 'tools', 'dependsOn', 'pos'];
      const unknown = Object.keys(patch).filter(k => !allowed.includes(k));
      if (unknown.length) fail('不能修改的字段：' + unknown.join('、'), 'BAD_REQUEST');
      const onlyMoved = Object.keys(patch).length === 1 && patch.pos !== undefined;
      if (onlyMoved) {
        next.nodes = next.nodes.map(n => (n.id === target.id ? { ...n, pos: patch.pos && Number.isFinite(Number(patch.pos.x)) && Number.isFinite(Number(patch.pos.y)) ? { x: Number(patch.pos.x), y: Number(patch.pos.y) } : null } : n));
        bump(next, false);                                                   // 只是挪位置：不算计划内容变化
      } else {
        const { pos, ...content } = patch;
        next.nodes = checked(next.nodes.map(n => (n.id === target.id ? { ...n, ...content, id: n.id, origin: 'user', run: null } : n)), next);
        next.nodes = markStale(next.nodes, target.id);
        const idMap = patch.dependsOn !== undefined ? tidyIds(next) : {};           // 只有改了依赖才可能改变阶段
        target.id = idMap[target.id] || target.id;
        bump(next, true);
      }
      return { state: next, result: { revision: next.revision, id: target.id, stale: onlyMoved ? [] : graph.downstreamOf(next.nodes, target.id) }, events: [event('node.updated', { id: target.id })] };
    }
    case 'setNodeModel': {
      requireRevision(payload, next);
      const target = findNode(next, payload.id), m = payload.model;
      if (m !== null && !(m && typeof m.profileId === 'string' && m.profileId && typeof m.model === 'string' && m.model)) fail('model 需要 profileId 与 model，或传 null 恢复自动分配', 'BAD_REQUEST');
      next.nodes = next.nodes.map(n => (n.id === target.id ? { ...n, model: m ? { profileId: m.profileId, model: m.model, source: 'user' } : null, run: null } : n));
      next.nodes = markStale(next.nodes, target.id);
      bump(next, false);
      return { state: next, result: { revision: next.revision }, events: [event('node.updated', { id: target.id })] };
    }
    case 'addNode': {
      requireRevision(payload, next);
      if (next.nodes.length >= graph.LIMITS.nodesEdited) fail('最多 ' + graph.LIMITS.nodesEdited + ' 个节点', 'LIMIT');
      const raw = payload.node && typeof payload.node === 'object' ? payload.node : {};
      const TEMP = 'nZZ';                                                          // 临时 id：36 个节点以内不可能被正式编号用到；加入后立刻重新编号
      next.nodes = checked([...next.nodes, { ...raw, id: TEMP, origin: 'user' }], next);
      const idMap = tidyIds(next);
      bump(next, true);
      return { state: next, result: { revision: next.revision, id: idMap[TEMP] }, events: [event('plan.updated', { revision: next.revision })] };
    }
    case 'removeNode': {
      requireRevision(payload, next);
      const target = findNode(next, payload.id);
      next.nodes = next.nodes.filter(n => n.id !== target.id).map(n => ({ ...n, dependsOn: n.dependsOn.filter(d => d !== target.id) }));
      tidyIds(next);
      bump(next, true);
      return { state: next, result: { revision: next.revision }, events: [event('plan.updated', { revision: next.revision })] };
    }
    case 'clearPlan': {
      requireRevision(payload, next);
      next.nodes = []; next.goal = ''; bump(next, true);
      return { state: next, result: { revision: next.revision }, events: [event('plan.updated', { revision: next.revision })] };
    }
    case 'setAgentModel': {
      // 给一个子智能体指定模型：它名下没有手选模型的节点都用它；传 null 恢复自动（按难度档位）。
      requireRevision(payload, next);
      const name = String(payload.name || '');
      if (!graph.agentsOf(next.nodes).includes(name)) fail('找不到子智能体：' + name, 'NOT_FOUND');
      const m = payload.model;
      if (m !== null && !(m && typeof m.profileId === 'string' && m.profileId && typeof m.model === 'string' && m.model)) fail('model 需要 profileId 与 model，或传 null 恢复自动分配', 'BAD_REQUEST');
      next.agents = { ...next.agents, [name]: { model: m ? { profileId: m.profileId, model: m.model, source: 'user' } : null } };
      // 该子智能体名下“跟随它”的节点，模型变了 → 旧结果不再对应，清掉并让下游过期
      const follows = next.nodes.filter(n => n.agent === name && !(n.model && n.model.source === 'user')).map(n => n.id);
      next.nodes = next.nodes.map(n => (follows.includes(n.id) ? { ...n, run: null } : n));
      for (const id of follows) next.nodes = markStale(next.nodes, id);
      bump(next, false);
      return { state: next, result: { revision: next.revision, nodes: follows }, events: [event('node.updated', { id: follows[0] || name })] };
    }
    case 'setHtmlView': {
      // 勾选“HTML 交互”：是否生成 workflow/index.html。不属于计划内容，不递增 revision，不影响 Agent 的 baseRevision。
      next.htmlView = payload.enabled === true;
      return { state: next, result: { htmlView: next.htmlView }, events: [event('plan.updated', { revision: next.revision })] };
    }
    case 'setNodeInputs': {
      // 登记/更新某个节点的附件元数据（文件本身由桌面壳复制进节点文件夹的 inputs/）。附件变了 → 该节点结果不再对应新输入，清空并让下游过期。
      requireRevision(payload, next);
      const target = findNode(next, payload.id);
      const before = JSON.stringify(target.inputs || []);
      const inputs = graph.normalizeNode({ id: target.id, inputs: payload.inputs }).inputs;
      next.nodes = next.nodes.map(n => (n.id === target.id ? { ...n, inputs, run: JSON.stringify(inputs) === before ? n.run : null } : n));
      if (JSON.stringify(inputs) !== before) next.nodes = markStale(next.nodes, target.id);
      bump(next, false);
      return { state: next, result: { revision: next.revision, count: inputs.length }, events: [event('node.updated', { id: target.id })] };
    }
    case 'setNodeRun': {
      // 运行结果只由桌面壳在执行节点时写入；不改变计划，不递增 revision，所以不会让正在编辑的人或 Agent 的 baseRevision 失效。
      const target = findNode(next, payload.id), r = payload.run;
      next.nodes = next.nodes.map(n => (n.id === target.id ? { ...n, run: r === null ? null : graph.normalizeNode({ id: n.id, run: r }).run } : n));
      return { state: next, result: { ok: true }, events: [event('node.updated', { id: target.id })] };
    }
    case 'saveUIState': {
      // 画布不再用它保存视口（见 ui/index.js）；宿主运行时也会在到达这里之前自行处理该动作。保留只为兼容旧调用，且不改变计划。
      // 界面保存视口，不改变计划内容，所以不递增 revision（否则每次平移都会让 Agent 的 baseRevision 失效）。
      return { state: next, result: { revision: next.revision }, events: [] };
    }
    default: return fail('未知动作：' + action, 'UNKNOWN_ACTION');
  }
}
module.exports = { dispatch, ActionError, summarize };
