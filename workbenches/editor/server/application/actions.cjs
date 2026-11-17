'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/events.cjs');
async function dispatch({ action, payload = {}, state = {} }) {
  const next = normalize(state);
  if (action === 'readDesign') return { state: next, result: next, events: [] };
  if (action === 'updateDesign') {
    if (payload.baseRevision !== undefined && Number(payload.baseRevision) !== next.revision) throw new Error('设计已更新，请先重新读取当前 revision');
    for (const key of ['name', 'description', 'prompt']) if (payload[key] !== undefined) next[key] = String(payload[key]);
    if (payload.knowledgePaths !== undefined) next.knowledgePaths = Array.isArray(payload.knowledgePaths) ? payload.knowledgePaths.map(String).slice(0, 64) : [];
    next.revision++;
    return { state: next, result: { target: next.target, revision: next.revision, saved: true }, events: [event('design.updated', { revision: next.revision })] };
  }
  throw new Error('设计后端不支持动作：' + action);
}
module.exports={dispatch};
