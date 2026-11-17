'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const evidence = process.env.PI_ISOLATION_EVENTS;
function record(type, details = {}) {
  fs.appendFileSync(evidence, JSON.stringify({ time: new Date().toISOString(), type, ...details }) + '\n');
}
function gpu() {
  return { hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(), switches: Object.fromEntries(['disable-gpu', 'disable-gpu-compositing', 'no-sandbox', 'disable-setuid-sandbox'].map(name => [name, app.commandLine.hasSwitch(name)])), featureStatus: app.isReady() ? app.getGPUFeatureStatus() : null };
}
record('entry', { argv: process.argv, versions: process.versions, runAsNodePresent: Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') });
app.on('child-process-gone', (_event, details) => { const { type: processType, ...rest } = details; record('child-process-gone', { processType, ...rest }); });
app.on('render-process-gone', (_event, contents, details) => record('render-process-gone', { webContentsId: contents.id, ...details }));
app.on('gpu-info-update', () => record('gpu-info-update', gpu()));
app.on('web-contents-created', (_event, contents) => {
  record('web-contents-created', { webContentsId: contents.id });
  contents.on('did-finish-load', () => record('did-finish-load', { webContentsId: contents.id, url: contents.getURL(), preferences: contents.getLastWebPreferences() }));
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => record('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }));
  contents.on('preload-error', (_event, preloadPath, error) => record('preload-error', { preloadPath, error: error.message }));
});
app.on('browser-window-created', (_event, win) => record('browser-window-created', { preferences: win.webContents.getLastWebPreferences() }));
app.on('before-quit', () => record('before-quit'));
app.on('will-quit', () => record('will-quit'));
// 入口自身的上界保证调试连接失败时也会结束。
const deadline = setTimeout(() => { record('entry-deadline'); app.exit(124); }, 14000);
deadline.unref();
app.whenReady().then(() => record('ready', gpu()));
if (process.env.PI_ISOLATION_MODE === 'project') {
  require('../main.cjs');
  record('project-main-required', gpu());
} else {
  if (process.env.PI_ISOLATION_GPU === 'software') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
  record('blank-configured', gpu());
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await win.loadURL('data:text/html,<html><title>隔离空白页</title><body></body></html>'); }
    catch (error) { record('load-error', { error: error.message }); }
  });
  app.on('window-all-closed', () => app.quit());
}
