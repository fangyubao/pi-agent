'use strict';
const defaultMatrix = () => [[-1, 1, 0, 0], [1, -1, 1, 0], [0, 1, -1, 1], [0, 0, 1, -1]];

function normalize(state = {}) {
  const matrix = Array.isArray(state.matrix) && state.matrix.length === 4
    ? state.matrix.map(row => Array.isArray(row) && row.length === 4 ? row.map(value => Number(value) || 0) : [0, 0, 0, 0])
    : defaultMatrix();
  return { matrix, result: state.result || null, revision: Number(state.revision || 0) };
}

module.exports={normalize};
