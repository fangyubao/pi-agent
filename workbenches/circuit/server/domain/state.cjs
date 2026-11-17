'use strict';
function normalize(state = {}) {
  const qubits = Math.max(1, Math.min(32, Number(state.qubits || 3)));
  const gates = Array.isArray(state.gates) ? state.gates.map(gate => ({ gate: String(gate.gate || 'H'), q: Number(gate.q || 0), col: Number(gate.col || 1), ...(gate.t === undefined ? {} : { t: Number(gate.t) }) })) : [];
  return { qubits, gates, simulation: state.simulation || null, probabilities:state.probabilities||[],selected: String(state.selected || 'H'), revision: Number(state.revision || 0) };
}

module.exports={normalize};
