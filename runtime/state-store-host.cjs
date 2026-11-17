'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
function createStorage(root, vaultRoot) {
  const worker = new Worker(path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'state-store-worker.cjs'), { workerData: { root, vaultRoot } });
  let sequence = 0, dead = false;
  const pending = new Map();
  worker.on('message', result => { const item = pending.get(result.id); if (!item) return; pending.delete(result.id); clearTimeout(item.timer);item.resolve(result); });
  const fail = error => { dead = true; for (const item of pending.values()){clearTimeout(item.timer);item.resolve({ ok: false, error: String(error) });} pending.clear(); };
  worker.on('error', fail); worker.on('exit', () => fail('本地保存进程已退出'));
  function request(operation, input = {}) {
    if (dead) return Promise.resolve({ ok: false, error: '本地保存进程不可用' });
    return new Promise(resolve => { const id = ++sequence;const timer=setTimeout(()=>{fail('本地保存超时，原记录仍保留，请检查磁盘空间与访问权限');void worker.terminate();},30000);pending.set(id,{resolve,timer});worker.postMessage({ id, operation, ...input }); });
  }
  return { request, async close() { await request('flush'); await worker.terminate(); } };
}
module.exports = { createStorage };
