'use strict';
function normalize(state = {}) {
  const html = typeof state.html === 'string' ? state.html.slice(0, 200000) : '';
  return { html, revision: Number(state.revision || 0), status: 'draft' };
}

module.exports={normalize};
