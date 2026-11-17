'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const NODE = process.env.PI_WORKBENCH_NODE || process.execPath;
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = process.argv[2];
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' 超时')), ms); })]).finally(() => clearTimeout(timer));
}
function environment(kind) {
  const env = {};
  const keep = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
    if (kind === 'inherited' || keep.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}
async function worker() {
  const spec = JSON.parse(process.argv[4]);
  const { _electron } = require('@playwright/test');
  const result = { ...spec, status: 'starting', startedAt: new Date().toISOString(), node: process.execPath, launchTimeoutMs: 8000, operationTimeoutMs: 4000, closeTimeoutMs: 3000, cleanup: {} };
  let app;
  let electronChild;
  // Playwright 的 CDP 回调可能抛出未捕获异常；记录后让 launch 超时及 finally 完成收尾。
  const fatalErrors = [];
  const captureFatal = error => {
    fatalErrors.push({ name: error.name, message: error.message, stack: error.stack });
    fs.writeFileSync(path.join(spec.directory, 'fatal-errors.json'), JSON.stringify(fatalErrors, null, 2));
  };
  process.on('uncaughtException', captureFatal);
  process.on('unhandledRejection', captureFatal);
  try {
    const env = environment(spec.environment);
    env.PI_ISOLATION_MODE = spec.mode;
    env.PI_ISOLATION_GPU = spec.gpu;
    env.PI_ISOLATION_EVENTS = path.join(spec.directory, 'events.jsonl');
    env.PI_WORKBENCH_WORKSPACE = path.join(spec.directory, 'workspace');
    fs.mkdirSync(env.PI_WORKBENCH_WORKSPACE);
    result.environmentKeys = Object.keys(env).sort();
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'electron-isolation-entry.cjs'), '--user-data-dir=' + path.join(spec.directory, 'profile')], cwd: ROOT, env, chromiumSandbox: true, timeout: 8000 });
    const child = electronChild = app.process();
    result.pid = child.pid;
    result.spawnargs = child.spawnargs;
    child.on('exit', (code, signal) => { result.processExit = { code, signal }; });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-24000); });
    const page = await app.firstWindow({ timeout: 4000 });
    await page.waitForLoadState('load', { timeout: 4000 });
    result.renderer = await bounded(page.evaluate(() => ({ url: location.href, title: document.title, readyState: document.readyState, desktopBridge: typeof window.piDesktop })), 4000, '读取渲染页');
    result.main = await bounded(app.evaluate(({ app, BrowserWindow }) => ({ versions: process.versions, hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(), gpuFeatureStatus: app.getGPUFeatureStatus(), switches: Object.fromEntries(['disable-gpu', 'disable-gpu-compositing', 'no-sandbox', 'disable-setuid-sandbox'].map(name => [name, app.commandLine.hasSwitch(name)])), windows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, preferences: win.webContents.getLastWebPreferences() })) })), 4000, '读取主进程');
    await new Promise(resolve => setTimeout(resolve, 1500));
    result.stderr = stderr;
    result.status = 'loaded';
  } catch (error) {
    result.status = 'failed';
    result.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (app) {
      try { await bounded(app.close(), 3000, '关闭 Electron'); result.cleanup.appClose = 'closed'; }
      catch (error) {
        result.cleanup.appClose = error.message;
        const child = electronChild;
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => { result.cleanup.forced = { error: error?.message, stdout, stderr }; resolve(); }));
        }
      }
      result.cleanup.finalExitCode = electronChild?.exitCode ?? null;
      result.cleanup.finalSignal = electronChild?.signalCode ?? null;
    } else result.cleanup.appClose = 'launch 未返回对象；由 Playwright 超时清理及外层进程上界管理';
    result.fatalErrors = fatalErrors;
    if (fatalErrors.length) result.status = 'failed';
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(spec.directory, 'result.json'), JSON.stringify(result, null, 2));
  }
}
async function parent() {
  if (!OUTPUT || !path.isAbsolute(OUTPUT)) throw new Error('必须提供绝对输出路径');
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(NODE).toLowerCase()) throw new Error('必须使用指定 managed node');
  const runDirectory = fs.mkdtempSync(path.join(path.dirname(OUTPUT), 'electron-isolation-'));
  const report = { schema: 1, generatedAt: new Date().toISOString(), project: ROOT, node: process.execPath, electronExecutable: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), runDirectory, constraints: { chromiumSandbox: true, sandbox: true, contextIsolation: true, productionMainModified: false, globalEnvironmentModified: false, caseUpperBoundMs: 22000 }, cases: [] };
  const modes = [{ mode: 'blank', gpu: 'default' }, { mode: 'blank', gpu: 'software' }, { mode: 'project', gpu: 'production-software' }];
  for (const kind of ['inherited', 'clean']) for (const mode of modes) {
    const id = kind + '-' + mode.mode + '-' + mode.gpu;
    const directory = path.join(runDirectory, id);
    fs.mkdirSync(directory);
    const spec = { id, environment: kind, ...mode, directory };
    const child = spawn(NODE, [__filename, OUTPUT, '--worker', JSON.stringify(spec)], { cwd: ROOT, env: environment('inherited'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, spawnError;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-30000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-30000); });
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => {
        timedOut = true;
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true }, () => {});
      }, 22000);
      child.on('error', error => { spawnError = error.message; });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')); }
    catch { result = { ...spec, status: 'worker-failed' }; }
    result.worker = { pid: child.pid, ...exit, timedOut, spawnError, stdout, stderr };
    try { result.events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { result.events = []; result.eventsReadError = error.message; }
    result.goneEvents = result.events.filter(event => ['child-process-gone', 'render-process-gone'].includes(event.type));
    report.cases.push(result);
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id, status: result.status, goneEvents: result.goneEvents, error: result.error?.message, workerExit: exit, timedOut }));
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
}
(process.argv[3] === '--worker' ? worker() : parent()).catch(error => { console.error(error); process.exitCode = 1; });
