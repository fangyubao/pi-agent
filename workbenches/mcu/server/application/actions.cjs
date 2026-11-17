'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/events.cjs');
async function dispatch({ action, payload = {}, state = {} }) {
  const next = normalize(state);
  if (action === 'readDraft') return { state: next, result: next, events: [] };
  if (action === 'setDraftHTML') {
    if (typeof payload.html !== 'string' || payload.html.length > 200000) throw new Error('HTML 草稿必须是不超过 200000 字符的文本');
    if (payload.baseRevision !== undefined && Number(payload.baseRevision) !== next.revision) throw new Error('草稿版本已更新，请先读取当前 revision');
    next.html = payload.html;
    next.revision++;
    return { state: next, result: { revision: next.revision, status: next.status }, events: [event('draft.updated', { revision: next.revision }), event('draft.previewed', { revision: next.revision })] };
  }
  throw new Error('MCU 后端不支持动作：' + action);
}
module.exports={dispatch};
