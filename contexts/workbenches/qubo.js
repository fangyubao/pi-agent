'use strict';
window.PiContextRegistry['workbench:qubo'] = {
  id: 'workbench:qubo', kind: 'workbench', version: 1,
  prompt: '你正在协作 QUBO 求解器。理解矩阵、变量和约束；本地运行时负责计算，你负责读取状态、检查参数和解释结果。不要伪造求解结果。',
  state: ['matrix', 'variables', 'solver', 'result', 'revision'],
  actions: ['readState', 'setMatrix', 'symmetrize', 'solve'],
  events: ['matrix.updated', 'solver.started', 'solver.finished', 'result.read']
};
