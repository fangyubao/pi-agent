'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/events.cjs');
const {solve}=require('../processing/solve.cjs');

async function dispatch({ action, payload = {}, state = {} }) {
  const next = normalize(state);
  if(action==='setCell'){
    const {row,column,value}=payload;
    if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||row>3||column<0||column>3||typeof value!=='number'||!Number.isFinite(value))throw new Error('矩阵坐标或数值无效');
    next.matrix[row][column]=value;next.result=null;next.revision++;
    return {state:next,result:{revision:next.revision},events:[event('matrix.updated',{row,column,value})]};
  }
  if (action === 'readState') return { state: next, result: next, events: [event('result.read', { revision: next.revision })] };
  if (action === 'setMatrix') {
    if (!Array.isArray(payload.matrix)||payload.matrix.length!==4||payload.matrix.some(row=>!Array.isArray(row)||row.length!==4||row.some(value=>typeof value!=='number'||!Number.isFinite(value)))) throw new Error('matrix 必须是 4×4 的有限数值矩阵');
    next.matrix = normalize({ matrix: payload.matrix }).matrix;
    next.result = null;
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('matrix.updated', { revision: next.revision })] };
  }
  if (action === 'symmetrize') {
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const value = (next.matrix[i][j] + next.matrix[j][i]) / 2;
      next.matrix[i][j] = next.matrix[j][i] = value;
    }
    next.result = null;
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('matrix.updated', { revision: next.revision })] };
  }
  if (action === 'clear') {
    next.result = null;
    next.revision++;
    return { state: next, result: { revision: next.revision }, events: [event('state.cleared', { revision: next.revision })] };
  }
  if (action === 'solve' || action === 'run') {
    const result = solve(next.matrix);
    next.result = result;
    next.revision++;
    return { state: next, result, events: [event('solver.started', { revision: next.revision }), event('solver.finished', result)] };
  }
  throw new Error('QUBO 后端不支持动作：' + action);
}
module.exports={dispatch};
