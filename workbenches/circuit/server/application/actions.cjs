'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/events.cjs');
const {simulate}=require('../processing/simulate.cjs');
function preset(state, kind) {
  const next = normalize(state);
  const isBell = String(kind).toLowerCase() === 'bell';
  next.qubits = isBell ? 2 : 3;
  next.gates = isBell
    ? [{ gate: 'H', q: 0, col: 2 }, { gate: 'CNOT', q: 0, col: 3, t: 1 }]
    : [{ gate: 'H', q: 0, col: 2 }, { gate: 'CNOT', q: 0, col: 3, t: 1 }, { gate: 'CNOT', q: 1, col: 4, t: 2 }];
  next.simulation = null;
  next.probabilities = [];
  next.revision++;
  return next;
}

async function dispatch({ action, payload = {}, state = {} }) {
  let next = normalize(state);
  if (action === 'selectGate') {
    if(!['H','X','CNOT','M'].includes(payload.gate))throw new Error('量子门类型无效');
    next.selected=payload.gate;next.revision++;
    return {state:next,result:{selected:next.selected,revision:next.revision},events:[event('gate.selected',{gate:next.selected})]};
  }
  if (action === 'readCircuit') return { state: next, result: next, events: [event('result.read', { revision: next.revision })] };
  if (action === 'applyPreset' || action === 'preset') {
    next = preset(next, payload.kind || 'bell');
    return { state: next, result: { kind: payload.kind || 'bell', revision: next.revision }, events: [event('preset.applied', { kind: payload.kind || 'bell' })] };
  }
  if (action === 'clearCircuit') {
    next.gates = [];
    next.simulation = null;
    next.probabilities = [];
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('circuit.cleared', { revision: next.revision })] };
  }
  if (action === 'addGate') {
    const q = Number(payload.qubit || 0), col = Number(payload.column || 1);
    if (!Number.isInteger(q)||!Number.isInteger(col)||q < 0 || q >= next.qubits || col < 1) throw new Error('量子门位置无效');
    if(!['H','X','CNOT','M'].includes(payload.gate||next.selected))throw new Error('量子门类型无效');
    next.gates = next.gates.filter(gate => !(gate.q === q && gate.col === col));
    const target=payload.target===undefined?(q+1)%next.qubits:Number(payload.target);
    if(String(payload.gate||next.selected)==='CNOT'&&(!Number.isInteger(target)||target<0||target>=next.qubits||target===q))throw new Error('CNOT 需要有效且不同的目标量子比特');
    next.simulation=null;next.probabilities=[];
    next.gates.push({ gate: String(payload.gate || next.selected || 'H'), q, col, ...(String(payload.gate || next.selected) === 'CNOT' ? { t: target } : {}) });
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('gate.placed', { q, col })] };
  }
  if (action === 'removeGate') {
    next.simulation=null;next.probabilities=[];
    const q = Number(payload.qubit), col = Number(payload.column);
    next.gates = next.gates.filter(gate => !(gate.q === q && gate.col === col));
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('gate.removed', { q, col })] };
  }
  if (action === 'runSimulation') {
    next.probabilities=simulate(next);
    next.simulation = '模拟完成 · '+next.probabilities.map(x=>x.bits+' '+(x.probability*100).toFixed(1)+'%').join(' / ');
    next.revision++;
    return { state: next, result: { status: next.simulation }, events: [event('simulation.finished', { gates: next.gates.length })] };
  }
  throw new Error('电路后端不支持动作：' + action);
}
module.exports={dispatch};
