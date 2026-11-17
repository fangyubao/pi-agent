'use strict';
window.PiContextRegistry['workbench:circuit'] = {
  id: 'workbench:circuit', kind: 'workbench', version: 1,
  prompt: '你正在协作量子门电路工作台。读取量子比特、电路门、连接和模拟状态；用户和 Agent 使用同一套电路动作。',
  state: ['qubits', 'gates', 'simulation', 'selected', 'revision'],
  actions: ['readCircuit', 'addGate', 'removeGate', 'clearCircuit', 'runSimulation', 'applyPreset'],
  events: ['gate.placed', 'gate.removed', 'circuit.cleared', 'simulation.finished']
};
