'use strict';
// 导出的工作台没有编辑器：layout.css 里的 [data-pi-node-id] 规则必须能选中与编辑器相同的元素。
// 这里在真实 Chromium（Electron）里把同一份页面分别用「编辑器路径」和「运行时路径」打标，比较每个节点的 id。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="pi-preview-host"><header><h1 id="t">标题</h1><nav><a>一</a><a>二</a></nav></header><main id="app"><section><button id="go">开始</button><span>说明</span></section><div data-design-id="card"><p>x</p></div></main></div></body></html>';

test('运行时打标与布局编辑器扫描得到完全相同的节点 id', { skip: process.platform !== 'win32' || !fs.existsSync(electron) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-layout-rt-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'main.cjs' }));
    fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs');
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false});
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(HTML)}));
  const editor=${JSON.stringify(fs.readFileSync(path.join(__dirname, '..', 'workbenches', 'layout-editor.js'), 'utf8'))};
  const runtime=${JSON.stringify(fs.readFileSync(path.join(__dirname, 'layout-runtime.js'), 'utf8'))};
  const ids=async script=>w.webContents.executeJavaScript(script+';[...document.querySelectorAll("[data-pi-node-id]")].map(e=>e.dataset.piNodeId)');
  // 路径 A：运行时脚本（先在一份干净页面上执行）
  const a=await ids(runtime+';window.PiLayoutRuntime.tag(document.getElementById("pi-preview-host"),"preview")');
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(HTML)}));
  // 路径 B：布局编辑器（编辑模式，根节点）
  const b=await ids(editor+';window.__ctl=window.PiWorkbenchLayout({host:document.getElementById("pi-preview-host"),key:"preview",mode:"design",rootNode:true,data:{_layout:{}},persist(){},notify(){}})');
  fs.writeFileSync(process.argv[2]+'/out.json',JSON.stringify({a,b}));app.quit();
});`);
    const result = spawnSync(electron, [dir, dir], { timeout: 60000, encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(dir, 'out.json')), '未产生结果：' + (result.stderr || '').slice(0, 300));
    const { a, b } = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    assert.ok(a.length >= 8, '运行时打标的节点太少：' + a.length);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.ok(b.includes('preview/page') && a.some(id => id.endsWith('button#go')) && a.some(id => id.endsWith('div#card')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('导出的 layout.css 在没有编辑器时真的生效（平移与根容器外边距）', { skip: process.platform !== 'win32' || !fs.existsSync(electron) }, () => {
  const { cssFor } = require('./preview-layout.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-layout-css-'));
  try {
    const css = cssFor({ nodes: { 'preview/page': { x: 40, y: 24, width: 700 }, 'preview/main#app/section[0]/button#go': { x: 48, y: 30 } } });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', main: 'main.cjs' }));
    fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs');
app.whenReady().then(async()=>{
  const page=${JSON.stringify(HTML)}.replace('</head>','<style>'+${JSON.stringify(css)}+'</style></head>');
  const w=new BrowserWindow({show:false});
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
  const out=await w.webContents.executeJavaScript(${JSON.stringify(fs.readFileSync(path.join(__dirname, 'layout-runtime.js'), 'utf8'))}+';window.PiLayoutRuntime.tag(document.getElementById("pi-preview-host"),"preview");({root:{ml:getComputedStyle(document.getElementById("pi-preview-host")).marginLeft,w:getComputedStyle(document.getElementById("pi-preview-host")).width},btn:getComputedStyle(document.getElementById("go")).translate})');
  fs.writeFileSync(process.argv[2]+'/out.json',JSON.stringify(out));app.quit();
});`);
    spawnSync(electron, [dir, dir], { timeout: 60000, encoding: 'utf8' });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    assert.equal(out.btn, '48px 30px');
    assert.equal(out.root.ml, '40px');
    assert.equal(out.root.w, '700px');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
