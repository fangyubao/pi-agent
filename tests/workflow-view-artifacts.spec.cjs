'use strict';
// 真实浏览器（Electron）里打开生成的 index.html：
//   · 节点生成的 SVG 图真的显示出来（naturalWidth > 0）
//   · 节点生成的网页放进沙箱 iframe，脚本能运行，但碰不到外层页面、也发不出网络请求
//   · 恶意文件名不能让页面引用到 workflow/ 之外
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const W = require('../runtime/workspace-files.cjs');
const V = require('../runtime/workflow-view.js');
const A = require('../runtime/workflow-artifacts.js');

const SVG = A.cleanSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect width="200" height="80" fill="#fde"/><text x="10" y="45" font-size="20">框图 VCC</text></svg>');
const SCRIPT = [
  'document.getElementById("b").onclick=function(){document.getElementById("t").textContent="已点击"};',
  'window.__probe={};',
  'try{window.__probe.parent=typeof window.parent.document.title}catch(e){window.__probe.parent="blocked"}',
  'fetch("http://127.0.0.1:1/x").then(function(){window.__probe.net="open"},function(){window.__probe.net="blocked"});',
  'try{window.__probe.ls=typeof localStorage.getItem("a")}catch(e){window.__probe.ls="blocked"}'
].join('');
const PAGE = A.wrapHtml('<html><body><h1 id="t">交互页</h1><button id="b">点我</button><' + 'script>' + SCRIPT + '<' + '/script></body></html>');

test('index.html 引用节点产出：图显示、网页在沙箱 iframe 里可交互且碰不到外层/网络', async () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.wfv-art-'));
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + path.join(root, 'profile')], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: root } });
  try {
    const wf = path.join(root, 'workflow');
    const node = (id, title, uid, extra = {}) => ({ id, title, uid, role: '分析师', brief: '做' + id, tier: 3, dependsOn: [], ...extra });
    const folderA = W.nodeFolder({ id: 'n0', title: '框图' }), folderB = W.nodeFolder({ id: 'n1', title: '演示' });
    fs.mkdirSync(path.join(wf, folderA), { recursive: true }); fs.mkdirSync(path.join(wf, folderB), { recursive: true });
    fs.writeFileSync(path.join(wf, folderA, '电路框图.svg'), SVG);
    fs.writeFileSync(path.join(wf, folderB, '演示.html'), PAGE);
    const state = {
      goal: '带产出', nodes: [
        node('n0', '框图', 'uidaaaaaa1', { deliver: ['image'], run: { status: 'done', output: '结论：见框图', artifacts: [{ name: '电路框图.svg', kind: 'image', bytes: SVG.length }, { name: '../../../etc/passwd', kind: 'file', bytes: 1 }] } }),
        node('n1', '演示', 'uidbbbbbb2', { dependsOn: ['n0'], deliver: ['html'], run: { status: 'done', output: '结论：见网页', artifacts: [{ name: '演示.html', kind: 'html', bytes: PAGE.length }] } })
      ]
    };
    const r = await W.writeWorkflow(root, state, { view: { render: V.renderView, digest: null } });
    expect(r.artifacts.n0.map(a => a.name)).toEqual(['电路框图.svg']);                      // 越界文件名被丢弃，不会引用到 workflow/ 之外
    const html = fs.readFileSync(path.join(wf, 'index.html'), 'utf8');
    expect(html).not.toContain('etc/passwd');
    expect(fs.readFileSync(path.join(wf, 'plan.md'), 'utf8')).toContain('产出文件：[电路框图.svg]');

    const win = await app.evaluate(async ({ BrowserWindow }, file) => { const w = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } }); await w.loadFile(file); return w.id; }, path.join(wf, 'index.html'));
    const page = await app.evaluate(async ({ BrowserWindow }, id) => { const w = BrowserWindow.fromId(id); return w.webContents.getURL(); }, win);
    expect(page).toMatch(/index\.html$/);
    const run = (code) => app.evaluate(async ({ BrowserWindow }, { id, code }) => BrowserWindow.fromId(id).webContents.executeJavaScript(code), { id: win, code });

    // 1) 图真的显示了
    await run('new Promise(r => setTimeout(r, 400))');
    // 图真的加载并画出来了：complete、没有 onerror、占位有尺寸。SVG 经 file:// 画到 canvas 会污染画布（读像素抛错），所以不取像素；
    // 改为读 <img> 的 decode() 是否成功（解码失败会 reject），并确认 currentSrc 指向节点文件夹里的文件。
    const imgInfo = JSON.parse(await run(`(function(){
      var i = document.querySelector(".wfv-art-image img");
      return i.decode().then(function(){ return JSON.stringify({ ok: true, complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, src: decodeURIComponent(i.currentSrc) }); },
        function(e){ return JSON.stringify({ ok: false, error: String(e) }); });
    })()`));
    expect(imgInfo.ok).toBe(true); expect(imgInfo.complete).toBe(true);
    expect(imgInfo.w).toBeGreaterThan(0); expect(imgInfo.h).toBeGreaterThan(0);                 // 解码出真实尺寸（SVG 只有 viewBox 时由浏览器按 viewBox 给出）
    expect(imgInfo.src).toMatch(/workflow\/n0-框图\/电路框图\.svg$/);
    // 2) 网页：默认折叠；展开后在 iframe 里加载并能交互
    expect(await run('document.querySelectorAll("iframe.wfv-frame").length')).toBe(1);
    await run('document.querySelector(".wfv-art-html").open = true; 0');
    await run('new Promise(r => setTimeout(r, 600))');
    const frames = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.mainFrame.frames.map(f => f.url), win);
    expect(frames.length).toBe(1); expect(frames[0]).toMatch(/演示\.html$|%E6%BC%94%E7%A4%BA\.html$/);
    const sub = await app.evaluate(async ({ BrowserWindow }, id) => { const f = BrowserWindow.fromId(id).webContents.mainFrame.frames[0]; await f.executeJavaScript('document.getElementById("b").click()'); await new Promise(r => setTimeout(r, 300)); return f.executeJavaScript('JSON.stringify({t:document.getElementById("t").textContent,probe:window.__probe})'); }, win);
    const got = JSON.parse(sub);
    expect(got.t).toBe('已点击');                           // 脚本在沙箱里能运行
    expect(got.probe.parent).toBe('blocked');               // 碰不到外层页面（沙箱 iframe 是 opaque origin）
    expect(got.probe.ls).toBe('blocked');                   // 读不了外层的 localStorage
    expect(got.probe.net).toBe('blocked');                  // 页面自带的 CSP 禁网络
    // 3) 外层页面没有被网页脚本改动
    expect(await run('document.title')).toContain('带产出');
  } finally {
    await app.close().catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});    // Windows 上进程刚退出时目录可能还被占用：重试，失败也不让测试失败
  }
});
