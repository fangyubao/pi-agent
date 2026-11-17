'use strict';
function normalize(state = {}) {
  return { target: String(state.target || ''), name: String(state.name || ''), description: String(state.description || ''), prompt: String(state.prompt || ''), knowledgePaths: Array.isArray(state.knowledgePaths) ? state.knowledgePaths.map(String).slice(0, 64) : [], revision: Number(state.revision || 0) };
}

module.exports={normalize};
