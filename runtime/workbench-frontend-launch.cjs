'use strict';
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
function verifyFrontend(input, timeoutMs = 120000) {
  return new Promise(resolve => {
    const appRoot = path.join(__dirname, '..');
    const electron = process.versions.electron ? process.execPath : require('electron');
    const args = [...(appRoot.includes('app.asar') ? [] : [appRoot]), '--pi-workbench-ui-verifier', '--user-data-dir=' + path.join(input.root, '.pi-design', 'browser')];
    const child = spawn(electron, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '', PI_WORKBENCH_TEST_ROOT: input.root } });
    let done = false, stderr = '';
    const finish = result => { if (done) return; done = true; clearTimeout(timer); if(child.pid&&process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve(result));else {child.kill();resolve(result);} };
    const timer = setTimeout(() => finish({ ok: false, reason: 'WORKBENCH_UI_TIMEOUT', message: '前端验收超时，请检查未结束的操作或循环', stderr: stderr.slice(-2000) }), timeoutMs);
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
    child.once('error', e => finish({ ok: false, reason: 'WORKBENCH_UI_PROCESS', message: e.message }));
    child.on('message', result => finish(result));
    child.once('exit', code => finish({ ok: false, reason: 'WORKBENCH_UI_PROCESS', message: '前端验收进程退出：' + code, stderr }));
    child.send(input);
  });
}
module.exports = { verifyFrontend };
