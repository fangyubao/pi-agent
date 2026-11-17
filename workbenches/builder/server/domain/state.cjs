'use strict';
function normalize(state = {}) {
  return {
    name: String(state.name || '未命名工作台'),
    workspacePath: String(state.workspacePath||''),
    principles: String(state.principles || ''),
    knowledgePaths: Array.isArray(state.knowledgePaths) ? state.knowledgePaths.map(String).slice(0, 64) : [],
    knowledge: state.knowledge && typeof state.knowledge === 'object' ? structuredClone(state.knowledge) : null,
    stage: Math.max(0, Math.min(6, Number(state.stage || 0))),
    revision: Number(state.revision || 0),
    promptDraft: String(state.promptDraft || '').slice(0, 12000),
    appliedPrompt: String(state.appliedPrompt || '').slice(0, 12000),
    promptMethod: String(state.promptMethod || ''),
    promptVersion: Number(state.promptVersion || 0)
  };
}

module.exports={normalize};
