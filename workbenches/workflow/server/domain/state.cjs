'use strict';
const graph = require('../../../../runtime/workflow-graph.js');

// 状态只存“计划本身”：节点（含用户拖动后的位置）。视口是个人浏览习惯，存在画布自己的本地存储里，不在这里。运行结果等执行期数据等接入执行引擎时再加。
const num = v => (Number.isFinite(Number(v)) && Math.abs(Number(v)) < 1e6 ? Number(v) : 0);
const pos = p => (p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? { x: num(p.x), y: num(p.y) } : null);

function normalize(state = {}) {
  const source = (Array.isArray(state.nodes) ? state.nodes : []).slice(0, graph.LIMITS.nodesEdited);
  const seen = new Set();
  const nodes = source.map(raw => { const n = { ...graph.normalizeNode(raw), pos: pos(raw && raw.pos) }; while (!n.uid || seen.has(n.uid)) n.uid = graph.newUid(); seen.add(n.uid); return n; });   // 每个节点都有唯一 uid（旧数据在这里补上）
  // 子智能体：只保存“它用哪个模型”。名字来自节点；没有节点使用的子智能体会被清掉，不留垃圾。
  const names = new Set(graph.agentsOf(nodes));
  const agents = {};
  for (const [name, a] of Object.entries(state.agents && typeof state.agents === 'object' ? state.agents : {})) {
    if (!names.has(name)) continue;
    const m = a && a.model && typeof a.model === 'object' ? a.model : null;
    agents[name] = { model: m && m.profileId && m.model ? { profileId: String(m.profileId).slice(0, 80), model: String(m.model).slice(0, 120), source: 'user' } : null };
  }
  return {
    agents,
    htmlView: state.htmlView === true,                       // 是否在 workflow/ 顶层生成可交互的 index.html（默认关：只有用户勾选才多花一次摘要调用）
    revision: Math.max(0, Math.floor(Number(state.revision) || 0)),
    goal: String(state.goal || '').slice(0, graph.LIMITS.goal),
    status: nodes.length ? 'planned' : 'empty',
    nodes,
    planRevision: Math.max(0, Math.floor(Number(state.planRevision) || 0))
  };
}

module.exports = { normalize };
