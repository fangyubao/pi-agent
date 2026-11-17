'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, fork, execFile } = require('node:child_process');
const assert = require('node:assert/strict');
const os = require('node:os');
const runtime = require('./workbench-runtime.cjs');

const LIMITS = Object.freeze({ files: 800, bytes: 32 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, depth: 10, output: 512 * 1024 });
const IGNORED = new Set(['node_modules', '.git', 'results', 'workflow', '.pi-design', 'coverage', '.cache']);

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function fail(code, message, extra = {}) { const error = new Error(message); error.code = code; Object.assign(error, extra); return error; }
function within(root, candidate) { const base = path.resolve(root), target = path.resolve(candidate); return target === base || target.startsWith(base + path.sep); }
function validRoot(root) {
  const resolved = path.resolve(String(root || ''));
  if (!resolved || resolved === path.parse(resolved).root) throw fail('WORKBENCH_ROOT_INVALID', '工作台工程路径无效');
  return resolved;
}

async function collectFiles(root) {
  const files = [], seen = new Set(); let total = 0;
  async function walk(dir, depth) {
    if (depth > LIMITS.depth) throw fail('WORKBENCH_TOO_DEEP', '工作台工程目录层级超过限制');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const target = path.join(dir, entry.name), stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw fail('WORKBENCH_UNSAFE_FILE', '工作台工程包含不支持的文件：' + entry.name);
      if (stat.isDirectory()) { await walk(target, depth + 1); continue; }
      if (files.length >= LIMITS.files) throw fail('WORKBENCH_TOO_MANY_FILES', '工作台工程文件数量超过限制');
      if (stat.size > LIMITS.fileBytes || total + stat.size > LIMITS.bytes) throw fail('WORKBENCH_TOO_LARGE', '工作台工程文件超过验证大小限制');
      const rel = path.relative(root, target).split(path.sep).join('/');
      const before = await fs.lstat(target);
      const data = await fs.readFile(target);
      const after = await fs.lstat(target);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || !before.isFile() || !after.isFile()) throw fail('WORKBENCH_UNSTABLE_FILE', '验证期间文件发生变化：' + rel);
      const key = rel + '\0' + data.length + '\0' + before.mtimeMs + '\0' + before.ctimeMs;
      if (seen.has(rel)) throw fail('WORKBENCH_DUPLICATE_FILE', '工作台工程出现重复文件：' + rel);
      seen.add(rel); files.push({ rel, data, key }); total += data.length;
    }
  }
  await walk(root, 0);
  return files;
}

async function fingerprint(root) {
  const files = await collectFiles(root);
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file.rel).update('\0').update(file.data).update('\0').update(file.key).update('\n');
  return { value: hash.digest('hex'), files: files.length, bytes: files.reduce((n, file) => n + file.data.length, 0) };
}

function testFiles(files) { return files.filter(file => /^tests\/.*\.test\.(?:cjs|js|mjs)$/i.test(file.rel)).map(file => file.rel).sort(); }
function contractCheck(files, manifest) {
  const names = (manifest.actions || []).map(action => typeof action === 'string' ? action : action.name).filter(Boolean);
  if(!(manifest.actions||[]).some(action=>action.access==='read'))throw fail('WORKBENCH_LIFECYCLE_CONTRACT','工作台必须提供读取当前状态的动作，供用户界面与 Agent 核对结果');
  let scenarios;
  try { scenarios = JSON.parse(files.find(file => file.rel === 'tests/host-scenarios.json')?.data.toString('utf8') || 'null'); } catch {}
  if (!Array.isArray(scenarios?.cases) || !scenarios.cases.length || scenarios.cases.length > 200)
    throw fail('WORKBENCH_LIFECYCLE_CONTRACT', '缺少 tests/host-scenarios.json：为每个动作提供真实输入和具体 state/result 期望值；说明文字不能替代行为验证。');
  const missingActions = names.filter(name => !scenarios.cases.some(c => c.action === name && !c.errorCode && ['state','result'].some(key => c.expect?.[key] && Object.keys(c.expect[key]).length)));
  if (!names.length || missingActions.length) throw fail('WORKBENCH_LIFECYCLE_CONTRACT', '宿主行为用例缺少动作：' + missingActions.join('、'));
  for (const item of scenarios.cases) {
    if (!names.includes(item.action)) throw fail('WORKBENCH_LIFECYCLE_CONTRACT', '行为用例包含未声明动作：' + item.action);
    const declared = manifest.actions.find(a => (a.name || a) === item.action);
    if (!item.errorCode && declared.access === 'write' && !Object.keys(item.expect?.state || {}).some(key=>key!=='revision'))
      throw fail('WORKBENCH_LIFECYCLE_CONTRACT', '写动作必须验证实际 state 内容：' + item.action);
  }
  for(const action of manifest.actions.filter(a=>a.access==='write'))if(!scenarios.cases.some(c=>c.action===action.name&&c.errorCode==='REVISION_CONFLICT'))throw fail('WORKBENCH_LIFECYCLE_CONTRACT','缺少旧版本写入被拒的实际用例：'+action.name);
  return { actionCount: names.length, actions: names, scenarios, checks: { declaredScenarios: true }, note: '覆盖结论来自下面实际执行的行为用例，不来自关键词。' };
}

function parseTap(output) {
  const number = name => Number((output.match(new RegExp('^# ' + name + '\\s+(\\d+)', 'm')) || [])[1] || 0);
  const counts = { tests: number('tests'), pass: number('pass'), fail: number('fail'), skipped: number('skipped'), todo: number('todo'), cancelled: number('cancelled') };
  counts.actualPass = counts.pass - counts.todo - counts.skipped;
  return counts;
}

function runTests(root, files, timeoutMs = 90000) {
  return new Promise(resolve => {
    const args = ['--test', '--test-reporter=tap', ...files];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined };
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', truncated = false, timer;
    const append = (key, chunk) => { if (Buffer.byteLength(key === 'stdout' ? stdout : stderr, 'utf8') >= LIMITS.output) { truncated = true; return; } const next = (key === 'stdout' ? stdout : stderr) + chunk.toString(); if (key === 'stdout') stdout = next.slice(0, LIMITS.output); else stderr = next.slice(0, LIMITS.output); };
    child.stdout.on('data', chunk => append('stdout', chunk)); child.stderr.on('data', chunk => append('stderr', chunk));
    timer = setTimeout(() => { truncated = true; child.kill(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, counts: parseTap(stdout), stdout, stderr: stderr + '\n' + error.message, truncated, exitCode: null, signal: null }); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); const counts = parseTap(stdout); resolve({ ok: exitCode === 0 && !truncated && counts.tests > 0 && counts.fail === 0 && counts.skipped === 0 && counts.todo === 0 && counts.cancelled === 0 && counts.actualPass === counts.tests, counts, stdout, stderr, truncated, exitCode, signal, command: [process.execPath, ...args] }); });
  });
}

async function sessionLifecycle(root, manifest, contract) {
  const read = (manifest.actions || []).find(action => (typeof action === 'string' ? 'write' : action.access) === 'read');
  const action = typeof read === 'string' ? read : read.name;
  const events = [];
  const state = contract?.scenarios?.initialState || { revision: 0, data: {} };
  const first = await runtime.createSessionAt(root, { state, taskId: 'host-lifecycle-1' }, event => events.push(event));
  let firstResult, secondResult;
  try {
    firstResult = await first.dispatch({ action, payload: {}, state, taskId: 'host-lifecycle-1', source: 'host-verifier' });
    if (!firstResult?.ok) throw fail('WORKBENCH_LIFECYCLE_READ', '生命周期读取动作失败：' + (firstResult.error || action));
    let current = firstResult.state;
    for (const item of contract?.scenarios?.cases || []) {
      const payload = clone(item.payload || {});
      if (payload.baseRevision === '$revision') payload.baseRevision = current?.revision || 0;
      const result = await first.dispatch({ action: item.action, payload, state: current, source: 'host-verifier' });
      if (item.errorCode) { assert.equal(result.ok, false, item.action + ' 应拒绝错误输入'); assert.equal(result.failure?.code, item.errorCode);const back=await first.dispatch({action,payload:{},state:current});assert.equal(back.ok,true);assert.deepEqual(back.state,current,'失败动作改变了状态：'+item.action); continue; }
      assert.equal(result.ok, true, item.action + ': ' + result.error);
      for (const group of ['state', 'result']) for (const [field, value] of Object.entries(item.expect?.[group] || {})) {
        const actual = field === '$' ? result[group] : field.split('.').reduce((v, k) => v?.[k], result[group]);
        assert.deepEqual(actual, value, item.action + ' 的 ' + group + '.' + field + ' 不符合预期');
      }
      const declared = manifest.actions.find(a => (a.name || a) === item.action);
      if (declared.access === 'read') assert.equal(result.state?.revision, current?.revision, '读取动作不应改变 revision');
      if (declared.access === 'write') assert.ok(result.state?.revision > (current?.revision || 0), '写动作必须增加 revision');
      current = result.state || current;
    }
    const unknown = await first.dispatch({ action: '__host_unknown__', payload: {}, state: current });
    assert.equal(unknown.ok, false, '未知动作必须被拒绝');
    firstResult = await first.dispatch({ action, payload: {}, state: current });
    assert.equal(firstResult.ok,true,'动作后读取状态失败');
  } finally { await first.close(); }
  const second = await runtime.createSessionAt(root, { state: firstResult.state || state, taskId: 'host-lifecycle-2' }, event => events.push(event));
  try {
    secondResult = await second.dispatch({ action, payload: {}, state: firstResult.state || state, taskId: 'host-lifecycle-2', source: 'host-verifier' });
    if (!secondResult?.ok) throw fail('WORKBENCH_LIFECYCLE_REOPEN', '生命周期重开后读取失败：' + (secondResult.error || action));
    assert.deepEqual(secondResult.state, firstResult.state, '关闭重开后状态不一致');
  } finally { await second.close(); }
  return { opened: true, readAction: action, firstRead: true, closed: true, reopened: true, secondRead: true, eventCount: events.length };
}

function createVerifier({ timeoutMs = 180000, inProcess = false, isolationPath, evidenceRoot, evidencePath } = {}) {
  const records = new Map();
  const inflight = new Map();
  const children = new Map();
  function cancel(inputRoot) { const key = validRoot(inputRoot).toLowerCase(); records.delete(key); children.get(key)?.cancel(); }
  async function verify(inputRoot) {
    const root = validRoot(inputRoot), key = root.toLowerCase();
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const started = Date.now(); let before, isolated, frontend, evidence;
      try {
        if (!inProcess) {
          isolated=await fs.mkdtemp(path.join(os.tmpdir(),'pi-workbench-verification-'));
          evidence=path.join(evidenceRoot||path.join(os.tmpdir(),'pi-workbench-test-evidence'),crypto.randomUUID());
          const result = await new Promise(resolve => {
            const script = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'workbench-verifier-process.cjs');
            const child = fork(script, [], { windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' } });
            let done = false;
            const stop = () => new Promise(resolve=>{ if (child.pid && process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true,timeout:5000 }, () => resolve()); else {child.kill('SIGKILL');resolve();} });
            const finish = result => { if (done) return; done = true; clearTimeout(timer); children.delete(key); void stop().then(()=>resolve(result)); };
            const failure = (reason,message) => finish({ ok:false,scope:'workbench-full-lifecycle',root,reason,message,durationMs:Date.now()-started });
            const timer = setTimeout(() => failure('WORKBENCH_VERIFICATION_TIMEOUT', '工作台验证超时，验证进程已终止；请检查后端动作和关闭时的资源释放。'), timeoutMs);
            children.set(key, { cancel: () => failure('WORKBENCH_VERIFICATION_CANCELLED', '工作台验证已取消') });
            child.once('error', error => failure('WORKBENCH_VERIFICATION_PROCESS', error.message));
            child.once('exit', code => failure('WORKBENCH_VERIFICATION_PROCESS', '验证进程提前退出：' + code));
            child.once('message', finish);
            child.send({ root, timeoutMs, isolationPath: isolated, evidencePath:evidence });
          });
          if (result.ok) records.set(key, clone(result)); else records.delete(key);
          return result;
        }
        before = await fingerprint(root);
        const files = await collectFiles(root), manifest = JSON.parse((files.find(file => file.rel === 'manifest.json') || {}).data?.toString('utf8') || '{}');
        const tests = testFiles(files);
        if (!tests.length) throw fail('WORKBENCH_TESTS_MISSING', '工作台没有 tests/**/*.test.cjs、.test.js 或 .test.mjs');
        const contract = contractCheck(files, manifest);
        isolated=isolationPath||await fs.mkdtemp(path.join(os.tmpdir(),'pi-workbench-verification-'));
        for(const item of files){const dest=path.resolve(isolated,item.rel);if(!within(isolated,dest))throw fail('WORKBENCH_UNSAFE_FILE','验证文件路径越界');await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,item.data);}
        await require('./workbench-dependencies.cjs').copyDependencies(root,isolated);
        const checkTestSource=async()=>{for(const item of files){const data=await fs.readFile(path.join(isolated,item.rel)).catch(()=>null);if(!data?.equals(item.data))throw fail('WORKBENCH_TEST_CHANGED_SOURCE','测试修改了被测源码，不能用修改后的副本代替发布版本验收：'+item.rel);}};
        const testResult = await runTests(isolated, tests, timeoutMs);
        if (!testResult.ok) {
          const evidence=(testResult.stdout+'\n'+testResult.stderr).split('\n').filter(line=>/^\s*(not ok |error:|message:|expected:|actual:|location:|code:)/.test(line)).slice(0,18).join('\n');
          throw fail('WORKBENCH_TESTS_FAILED', '工作台测试未完整通过：' + JSON.stringify(testResult.counts)+'\n'+(evidence||testResult.stderr.slice(-3000)||'测试未报告完整结果，请检查 tests/ 中的进程退出与输出'), { counts: testResult.counts, testResult });
        }
        const lifecycle = await sessionLifecycle(isolated, manifest, contract);
        await checkTestSource();
        evidence=evidencePath||path.join(evidenceRoot||path.join(os.tmpdir(),'pi-workbench-test-evidence'),crypto.randomUUID());
        frontend=await require('./workbench-frontend-launch.cjs').verifyFrontend({root:isolated,evidencePath:evidence},Math.max(1000,timeoutMs-(Date.now()-started)-5000));
        if(!frontend.ok)throw fail(frontend.reason||'WORKBENCH_UI_FAILED','前端验收未通过：'+frontend.message,{frontend,testResult});
        await checkTestSource();
        contract.checks = { actionCoverage: true, stateRestore: true, closeAndReopen: true, unknownRejected: true };
        contract.executed = contract.scenarios.cases.length;
        delete contract.scenarios;
        const after = await fingerprint(root);
        if (before.value !== after.value) throw fail('WORKBENCH_SOURCE_CHANGED', '测试期间工作台源码发生变化，验证结果已作废', { before, after });
        const result = { ok: true, scope: 'workbench-full-lifecycle', root, frontend, evidencePath:evidence, manifest: { id: manifest.id, name: manifest.name, version: manifest.version }, contract, lifecycle, counts: testResult.counts, testFiles: tests, command: testResult.command, stdout: testResult.stdout, stderr: testResult.stderr, fingerprint: before.value, fingerprintAfter: after.value, files: before.files, bytes: before.bytes, durationMs: Date.now() - started, verifiedAt: Date.now() };
        records.set(key, clone(result));
        return result;
      } catch (error) {
        records.delete(key);
        const result = { ok: false, scope: 'workbench-full-lifecycle', root, frontend:error.frontend||frontend, evidencePath:evidence, reason: error.code || 'WORKBENCH_VERIFICATION_FAILED', message: error.message, counts: error.counts || error.testResult?.counts || { tests: 0, actualPass: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 }, command:error.testResult?.command,stdout:error.testResult?.stdout?.slice(-24000),stderr:error.testResult?.stderr?.slice(-8000),contract: error.contract || null, durationMs: Date.now() - started };
        return result;
      } finally { if(isolated&&path.dirname(isolated)===os.tmpdir()&&path.basename(isolated).startsWith('pi-workbench-verification-'))await fs.rm(isolated,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});inflight.delete(key); }
    })();
    inflight.set(key, run); return run;
  }
  async function requireVerified(inputRoot) {
    const root = validRoot(inputRoot), key = root.toLowerCase(), record = records.get(key);
    if (!record?.frontend?.ok) throw fail('WORKBENCH_VERIFICATION_REQUIRED', '工作台尚未完成前端、后端与关闭重开的完整生命周期验证，请让 Agent 先调用 verifyWorkbench');
    const current = await fingerprint(root);
    if (current.value !== record.fingerprint) { records.delete(key); throw fail('WORKBENCH_VERIFICATION_STALE', '工作台源码已变化，请在最后一次修改后重新调用 verifyWorkbench'); }
    return clone(record);
  }
  function invalidate(inputRoot) { records.delete(validRoot(inputRoot).toLowerCase()); }
  return { verify, requireVerified, invalidate, cancel, dispose: () => { for (const child of children.values()) child.cancel(); } };
}

module.exports = { createVerifier, parseTap, contractCheck, fingerprint, sessionLifecycle };
