'use strict';
// Runs only in the isolated verification Electron process, never in the shell.
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createDriver } = require('./workbench-ui-driver.cjs');
const { runtimePage } = require('./workbench-runtime-page.cjs');
const workers = require('./workbench-worker-host.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'pi-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.disableHardwareAcceleration();
const profile = process.argv.find(a => a.startsWith('--user-data-dir='));
if (profile) app.setPath('userData', profile.slice('--user-data-dir='.length));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const field = (value, key) => key === '$' ? value : key.split('.').reduce((v, k) => v?.[k], value);
function fail(message, details) { throw Object.assign(new Error(message), { details }); }
function checkFields(actual, expected, label) { for (const [key, value] of Object.entries(expected || {})) assert.deepEqual(field(actual, key), value, label + '.' + key); }
function checkUi(actual, expected) {
  const keys = ['text', 'value', 'visible', 'checked', 'disabled', 'exists'];
  if (!keys.some(k => k in expected) && !('contains' in expected)) fail('页面断言必须包含具体文本、值或控件状态', expected);
  for (const key of keys) if (key in expected) assert.deepEqual(actual[key], expected[key], expected.selector + '.' + key);
  if ('contains' in expected) assert.ok(actual.text?.includes(String(expected.contains)), expected.selector + ' 应包含 ' + expected.contains + '，实际为 ' + actual.text);
}
async function run(input) {
  const root = path.resolve(input.root), uiRoot = path.join(root, 'ui');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const spec = JSON.parse(await fs.readFile(path.join(root, 'tests/ui-scenarios.json'), 'utf8'));
  const report = { ok: false, scope: 'workbench-frontend', cases: [], controls: [], errors: [], evidencePath: input.evidencePath, method: 'Chromium input + production runtime bridge + real backend worker', realDevicesVerified: false };
  if (spec.schema !== 1 || !Array.isArray(spec.cases) || !spec.cases.length || spec.cases.length > 50) fail('tests/ui-scenarios.json 必须提供 schema:1 和 1–50 条真实页面交互用例');
  const read = manifest.actions.find(a => a.access === 'read')?.name;
  if (!read) fail('工作台缺少读取状态动作');
  let win, driver, sessionId, state, pending = 0, journal = [], activeCase, stepIndex = -1;
  const controls = new Set(), operated = new Set();
  function send(data) { if (win && !win.isDestroyed()) win.webContents.send('verification:reply', data); }
  async function dispatch(action, payload, source = 'ui') {
    const response = await workers.executePath(root, { sessionId, taskId: sessionId, state, action, payload, source, mode: 'use' }, event => {
      if (event.type === 'job.updated' && event.payload?.response?.ok && event.payload.response.state !== undefined) { state = event.payload.response.state; send({ type: 'runtime-state', state }); }
      send({ type: 'runtime-event', event });
    });
    if (response.ok && response.state !== undefined) { state = response.state; send({ type: 'runtime-state', state }); }
    for (const event of response.events || []) send({ type: 'runtime-event', event });
    if (source === 'ui') journal.push({ action, payload, ok: response.ok, state: response.state, result: response.result, error: response.error, code: response.failure?.code, events: response.events });
    return response;
  }
  const onMessage = (event, m) => {
    if (!win || event.sender !== win.webContents) return;
    if (m.type === 'ready') { send({ type: 'runtime-state', state }); return; }
    if (m.type === 'runtime-error') { report.errors.push(String(m.message)); return; }
    if (!['server-request', 'host-request'].includes(m.type)) return;
    pending++;
    const action = m.type === 'host-request' && m.operation === 'jobs' ? '__jobs.' + m.payload?.operation : m.action;
    const work = m.type === 'host-request' && m.operation !== 'jobs' ? Promise.reject(new Error('前端验收尚不支持此宿主能力：' + m.operation)) : dispatch(action, m.payload || {});
    work.then(r => send(r.ok ? { type: 'server-response', requestId: m.requestId, result: r } : { type: 'server-response', requestId: m.requestId, error: r.error, code: r.failure?.code, details: r.failure?.details }))
      .catch(e => { report.errors.push(e.message); send({ type: 'server-response', requestId: m.requestId, error: e.message }); }).finally(() => pending--);
  };
  async function until(fn, timeout = 5000) { const end = Date.now() + timeout; let error; while (Date.now() < end) { try { return await fn(); } catch (e) { error = e; await delay(60); } } throw error || new Error('页面等待超时'); }
  async function inspect() {
    const page = await driver.inspect({ limit: 100 });
    if (!page.ready) fail('页面尚未完成运行态初始化');
    if (page.errors.length || report.errors.length) fail('工作台前端出现错误', { errors: [...page.errors, ...report.errors] });
    if (page.total > 500) fail('页面控件超过一次验收的 500 个上限，请拆分页面用例');
    const all = [...page.controls]; let next = page.next;
    while (next !== null) { const more = await driver.inspect({ offset: next, limit: 100 }); all.push(...more.controls); next = more.next; }
    for (const c of all) if (!c.disabled) controls.add(c.selector);
    return { ...page, controls: all };
  }
  async function open(restored) {
    state = structuredClone(restored || spec.initialState || { revision: 0, data: {} }); sessionId = 'verify-' + require('node:crypto').randomUUID();
    const r = await dispatch(read, {}, 'host-verifier'); if (!r.ok) fail('打开工作台后读取状态失败', r);
    const w = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { preload: path.join(__dirname, 'workbench-test-preload.cjs'), contextIsolation: false, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win = w;
    w.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    w.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
      if(/^https?:|^wss?:/i.test(details.url)){report.errors.push('离线验收阻止外部网络请求：'+details.url);callback({cancel:true});}else callback({});
    });
    w.webContents.setWindowOpenHandler(() => { report.errors.push('验收中页面尝试打开外部窗口'); return { action: 'deny' }; });
    w.webContents.on('will-navigate', event => { event.preventDefault(); report.errors.push('验收中页面尝试离开工作台'); });
    w.webContents.on('render-process-gone', (_event, details) => report.errors.push('页面进程退出：' + details.reason));
    await w.loadFile(path.join(__dirname, 'workbench-test-host.html'));
    w.webContents.send('verification:mount', 'pi-preview://verification/' + (/\.html?$/i.test(manifest.ui.entry) ? manifest.ui.entry : '__pi_runtime__.html'));
    driver = createDriver({ contents: w.webContents, frame: async () => { const f = w.webContents.mainFrame.frames.find(f => f.url.startsWith('pi-preview://verification/')); if (!f) throw new Error('运行页面尚未加载'); return f; } });
    await until(async () => { const page = await inspect(); if (!page.text.trim() && !page.controls.some(c => c.tag === 'canvas')) fail('工作台页面为空白，不能完成验收'); return page; }, 10000);
  }
  async function close() { const old = win; win = null; old?.destroy(); if (sessionId) await workers.closeSession(root, sessionId); }
  async function expectResult(expectation, from, before, timeoutMs) {
    if (!Array.isArray(expectation?.ui) || !expectation.ui.length) fail('每个交互步骤必须有 expect.ui 页面结果断言');
    await until(async () => {
      if (pending) fail('等待前端请求完成');
      for (const expected of expectation.ui) checkUi(await driver.read(expected.selector), expected);
      const called = journal.slice(from);
      for (const action of expectation.actions || []) if (!called.some(c => c.action === action)) fail('页面没有调用预期后端动作：' + action, { called });
      if (expectation.errorCode && !called.some(c => !c.ok && c.code === expectation.errorCode)) fail('没有出现预期错误：' + expectation.errorCode, { called });
      const unexpected = called.find(c => !c.ok && c.code !== expectation.errorCode); if (unexpected) fail('前端调用后端失败', unexpected);
      if (!(expectation.actions || []).length && !expectation.errorCode) {
        let changed = false;
        for (let i=0;i<expectation.ui.length;i++) {
          const e=expectation.ui[i],after=await driver.read(e.selector),old=before[i];
          for(const key of ['text','value','visible','checked','disabled','exists'])if((key in e||key==='text'&&'contains' in e)&&!require('node:util').isDeepStrictEqual(old[key],after[key]))changed=true;
        }
        if(!changed)fail('交互没有可验证的效果：请断言实际页面变化，或声明 expect.actions 核对真实后端调用');
      }
      if (expectation.state) { const r = await dispatch(read, {}, 'host-verifier'); if (!r.ok) fail('核对后端状态失败', r); checkFields(state, expectation.state, 'state'); }
      const writes = called.filter(c => c.ok && manifest.actions.some(a => a.name === c.action && a.access !== 'read'));
      if (writes.length && !Object.keys(expectation.state || {}).some(k => k !== 'revision')) fail('页面触发写操作，但没有断言实际业务状态', { actions: writes.map(c => c.action) });
      await inspect();
    },Math.min(60000,Math.max(1000,Number(timeoutMs)||5000)));
  }
  try {
    protocol.handle('pi-preview', async request => {
      try {
        const url = new URL(request.url), file = path.resolve(uiRoot, '.' + decodeURIComponent(url.pathname));
        if (url.hostname !== 'verification' || !file.startsWith(uiRoot + path.sep)) return new Response('Forbidden', { status: 403 });
        if (file === path.join(uiRoot, manifest.ui.entry) || file === path.join(uiRoot, '__pi_runtime__.html')) return new Response(await runtimePage(uiRoot, manifest), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        return net.fetch(pathToFileURL(file).href);
      } catch { return new Response('Not found', { status: 404 }); }
    });
    ipcMain.on('verification:message', onMessage);
    for (const c of spec.cases) {
      activeCase = { name: c.name, steps: [], passed: false }; report.cases.push(activeCase);
      if (!c.name || !Array.isArray(c.steps) || !c.steps.length || c.steps.length > 100 || !Array.isArray(c.afterReopen) || !c.afterReopen.length) fail('每条前端用例需要 name、steps 和 afterReopen 页面断言');
      journal = []; await open(c.initialState);
      for (stepIndex = 0; stepIndex < c.steps.length; stepIndex++) {
        const step = c.steps[stepIndex], from = journal.length;
        const before=[];for(const e of step.expect?.ui||[])before.push(await driver.read(e.selector));
        const action = await driver.act(step);
        operated.add(step.selector);
        await expectResult(step.expect, from, before, step.timeoutMs);
        activeCase.steps.push({ operation: step.operation, selector: step.selector, passed: true, inputMethod: action.inputMethod, backend: journal.slice(from) });
      }
      const saved = structuredClone(state); await close(); await open(saved);
      assert.deepEqual(state, saved, '关闭重开后后端状态丢失');
      await until(async () => { for (const e of c.afterReopen) checkUi(await driver.read(e.selector), e); await inspect(); });
      activeCase.lifecycle = { closed: true, reopened: true, stateRestored: true, uiRestored: true };
      activeCase.screenshot = await driver.screenshot(input.evidencePath);
      activeCase.passed = true; await close();
    }
    const missing = [...controls].filter(c => !operated.has(c));
    report.controls = [...controls].map(selector => ({ selector, exercised: operated.has(selector) }));
    if (!controls.size || !operated.size || missing.length) fail('前端交互覆盖不完整：' + (missing.join('、') || '没有可验证的控件'), { missing });
    report.ok = true; report.passed = report.cases.length;
  } catch (error) {
    report.reason = 'WORKBENCH_UI_FAILED'; report.message = error.message;
    const failedStep=spec.cases.find(c=>c.name===activeCase?.name)?.steps?.[stepIndex];
    report.failure = { case: activeCase?.name, step: stepIndex + 1, operation:failedStep?.operation,selector:failedStep?.selector, details: error.details, expected: error.expected, actual: error.actual, backend: journal.slice(-10) };
    if (win && !win.isDestroyed()) { report.failure.page = await driver.inspect().catch(e => ({ error: e.message })); report.failure.screenshot = await driver.screenshot(input.evidencePath).catch(() => null); }
  } finally { await close(); await workers.dispose(); ipcMain.removeListener('verification:message', onMessage); }
  await fs.mkdir(input.evidencePath, { recursive: true }); await fs.writeFile(path.join(input.evidencePath, 'frontend.json'), JSON.stringify(report, null, 2));
  return report;
}
process.once('message', async input => {
  let result;
  try { await app.whenReady(); result = await run(input); }
  catch (error) { result = { ok: false, reason: 'WORKBENCH_UI_CONTRACT', message: error.message, details: error.details }; }
  process.send(result, () => app.exit(result.ok ? 0 : 1));
});
app.on('window-all-closed', () => {});
