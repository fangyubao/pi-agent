'use strict';
function solve(matrix) {
  let best = null;
  for (let mask = 0; mask < 16; mask++) {
    const bits = [0, 1, 2, 3].map(i => (mask >> i) & 1);
    let energy = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) energy += bits[i] * matrix[i][j] * bits[j];
    if (!best || energy < best.energy) best = { bits: bits.join(''), energy };
  }
  return best;
}

module.exports={solve};
