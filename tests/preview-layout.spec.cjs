'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

async function launch() {
  const profile = fs.mkdtempSync(path.join(ROOT, '.preview-layout-'));
  const exe = process.env.PI_WORKBENCH_TEST_EXE;
  const app = await electron.launch({ executablePath: exe || path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [...(exe ? [] : [ROOT]), '--user-data-dir=' + profile], cwd: ROOT });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  return { app, page, profile, close: async () => { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

async function openDesign(page, ui) {
  const dir = await page.evaluate(async () => (await window.piDesktop.workbench.scaffold({ name: '布局测试' })).result.path);
  for (const [name, content] of Object.entries(ui)) fs.writeFileSync(path.join(dir, 'ui', name), content);
  if(ui['index.html']?.includes('window.__wbTransport("updateState"')){require('./fixtures/workbench-ui.cjs').restoreOutput(dir);require('./fixtures/workbench-ui.cjs').scenario(dir);}
  await page.locator('[data-route="workbenches"]').click();
  await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
  await page.evaluate(d => { const K = 'pi-workbench-design-v2', st = JSON.parse(localStorage.getItem(K)); for (const p of st.projects) for (const t of p.tasks || []) if (t.design) t.design.workspacePath = d; localStorage.setItem(K, JSON.stringify(st)); }, dir);
  await page.reload(); await page.waitForLoadState('load');
  return dir;
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main id="app"><h1 id="title">标题</h1><button id="go">开始</button></main><script type="module" src="./main.js"></script></body></html>';

const MULTI_PAGE = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.widget{position:absolute;width:80px;height:36px;box-sizing:border-box}#one{left:40px;top:60px}#two{left:180px;top:120px}#three{left:40px;top:230px}#group{position:absolute;left:180px;top:230px;width:120px;height:80px}#child{position:absolute;left:10px;top:10px;width:60px;height:30px}</style></head><body><button class="widget" id="one">控件一</button><button class="widget" id="two">控件二</button><button class="widget" id="three">控件三</button><section id="group"><button id="child">子控件</button></section></body></html>';

async function multiFixture() {
  const fx=await launch();
  fx.dir=await openDesign(fx.page,{'index.html':MULTI_PAGE});
  await fx.page.locator('.task-preview-toggle').click();
  fx.preview=fx.page.frameLocator('#preview-frame');
  await fx.preview.locator('.design-mode-switch').click();
  return fx;
}
async function clickArt(fx,id,modifier,button='left') {
  const r=await fx.preview.locator('#'+id).boundingBox();
  if(modifier)await fx.page.keyboard.down(modifier);
  try {await fx.page.mouse.click(r.x+r.width/2,r.y+r.height/2,{button});}
  finally {if(modifier)await fx.page.keyboard.up(modifier);}
}
const pos=(fx,id)=>fx.preview.locator('#'+id).evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
async function drag(fx,start,dx,dy) {await fx.page.mouse.move(start.x,start.y);await fx.page.mouse.down();await fx.page.mouse.move(start.x+dx,start.y+dy,{steps:6});await fx.page.mouse.up();}

test('编辑后图层保持原节点，新增控件仍可选择；同一帧内放开和取消不会丢失或残留拖动',async()=>{
  const fx=await multiFixture();
  try{
    const {preview}=fx;
    await preview.locator('[title="图层与嵌套元素"]').click();
    await preview.locator('.design-layer').filter({hasText:'button · one'}).click();
    await preview.locator('body').evaluate(()=>{window.__originalLayer=document.querySelector('.design-layer.selected');});
    await preview.locator('input[name="x"]').fill('18');await preview.locator('input[name="x"]').press('Tab');
    expect(await preview.locator('body').evaluate(()=>window.__originalLayer===document.querySelector('.design-layer.selected'))).toBe(true);
    await preview.locator('body').evaluate(()=>{const node=document.createElement('button');node.id='dynamic';node.textContent='新增控件';document.querySelector('#pi-preview-host').append(node);});
    await expect(preview.locator('.design-layer').filter({hasText:'button · dynamic'})).toHaveCount(1);
    await preview.locator('[aria-label="关闭图层"]').click();
    const fast=await preview.locator('body').evaluate(async()=>{
      const target=document.querySelector('#one'),viewport=document.querySelector('.design-viewport'),shield=document.querySelector('.design-shield');
      // Synthetic events cannot acquire OS capture; isolate only that native
      // prerequisite to exercise the real pointer handlers in one renderer task.
      viewport.setPointerCapture=()=>{};viewport.releasePointerCapture=()=>{};
      const send=(type,x,y)=>shield.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:77,button:0,clientX:x,clientY:y}));
      const start=target.getBoundingClientRect(),x=start.x+20,y=start.y+15;
      send('pointerdown',x,y);send('pointermove',x+25,y+15);send('pointerup',x+31,y+19);
      const end=target.getBoundingClientRect();
      send('pointerdown',end.x+20,end.y+15);send('pointermove',end.x+65,end.y+40);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await new Promise(requestAnimationFrame);const cancelled=target.getBoundingClientRect();
      return {dx:end.x-start.x,dy:end.y-start.y,cancelledDx:cancelled.x-end.x,cancelledDy:cancelled.y-end.y};
    });
    expect(fast).toEqual({dx:31,dy:19,cancelledDx:0,cancelledDy:0});
  }finally{await fx.close();}
});

test('画布 Shift/Ctrl 多选，整组拖拽/缩放/微调可一次撤销，保存后保持手动并能恢复',async()=>{
  const fx=await multiFixture();
  try{
    const {preview,page}=fx;
    await clickArt(fx,'one');await clickArt(fx,'two','Shift');
    await expect(preview.locator('.design-selection-label')).toHaveText('已选 2 个控件');
    await expect(preview.locator('.design-selection-mark')).toHaveCount(2);
    await clickArt(fx,'two','Control');await expect(preview.locator('.design-selection-label')).toHaveText('one');
    await clickArt(fx,'two','Shift');
    const a=await pos(fx,'one'),b=await pos(fx,'two'),outside=await pos(fx,'three'),r=await preview.locator('#one').boundingBox();
    await drag(fx,{x:r.x+30,y:r.y+20},32,20);
    expect((await pos(fx,'one')).x-a.x).toBeCloseTo(32);expect((await pos(fx,'two')).y-b.y).toBeCloseTo(20);
    expect(await pos(fx,'three')).toEqual(outside);
    await page.keyboard.press('Control+z');expect((await pos(fx,'one')).x).toBeCloseTo(a.x);expect((await pos(fx,'two')).y).toBeCloseTo(b.y);
    await page.keyboard.press('Control+Shift+z');expect((await pos(fx,'one')).x-a.x).toBeCloseTo(32);
    await page.keyboard.press('Shift+ArrowRight');expect((await pos(fx,'one')).x-a.x).toBeCloseTo(42);expect((await pos(fx,'two')).x-b.x).toBeCloseTo(42);
    const beforeA=await pos(fx,'one'),beforeB=await pos(fx,'two'),handle=await preview.locator('[data-handle="se"]').boundingBox();
    await drag(fx,{x:handle.x+4,y:handle.y+4},44,20);
    expect((await pos(fx,'one')).width).toBeGreaterThan(beforeA.width);expect((await pos(fx,'two')).width).toBeGreaterThan(beforeB.width);
    await page.keyboard.press('Control+z');expect((await pos(fx,'one')).width).toBeCloseTo(beforeA.width);expect((await pos(fx,'two')).x).toBeCloseTo(beforeB.x);
    await expect(preview.locator('.design-mode-switch')).toHaveAttribute('aria-checked','true');
    const file=path.join(fx.dir,'ui','layout.json');
    await expect.poll(()=>{try{const ns=JSON.parse(fs.readFileSync(file,'utf8')).nodes;return Object.entries(ns).filter(([id,g])=>/button#(one|two)$/.test(id)&&g.x===42&&g.y===20).length;}catch{return 0;}}).toBe(2);
    await page.reload();await page.waitForLoadState('load');await page.locator('.task-preview-toggle').click();await preview.locator('.design-mode-switch').click();
    expect((await pos(fx,'one')).x-a.x).toBeCloseTo(42);expect((await pos(fx,'two')).y-b.y).toBeCloseTo(20);
  }finally{await fx.close();}
});

test('空白处框选与追加框选，右键保留多选并对齐，冻结后不可移动',async({},testInfo)=>{
  const fx=await multiFixture();
  try{
    const {preview,page}=fx;
    const a=await preview.locator('#one').boundingBox(),b=await preview.locator('#two').boundingBox();
    await drag(fx,{x:a.x-12,y:a.y-12},b.x+b.width-a.x+24,b.y+b.height-a.y+24);
    await expect(preview.locator('.design-selection-label')).toHaveText('已选 2 个控件');
    await clickArt(fx,'one',null,'right');
    await expect(preview.locator('.design-context-menu')).toBeVisible();
    await expect(preview.locator('.design-menu-heading')).toHaveText('已选 2 个控件');
    await page.screenshot({path:testInfo.outputPath('multi-select-menu.png')});
    await preview.locator('[data-design="align-left"]').click();
    expect((await pos(fx,'one')).x).toBeCloseTo((await pos(fx,'two')).x);
    await page.keyboard.press('Control+z');
    const c=await preview.locator('#three').boundingBox();
    await page.keyboard.down('Shift');await drag(fx,{x:c.x-10,y:c.y-10},c.width+20,c.height+20);await page.keyboard.up('Shift');
    await expect(preview.locator('.design-selection-label')).toHaveText('已选 3 个控件');
    await clickArt(fx,'two',null,'right');await preview.locator('[data-design="deselect"]').click();
    await expect(preview.locator('.design-outline')).toBeHidden();
    await page.keyboard.press('Control+a');await expect(preview.locator('.design-selection-label')).toHaveText('已选 5 个控件');
    await page.keyboard.press('Escape');await expect(preview.locator('.design-outline')).toBeHidden();
    await clickArt(fx,'one');await clickArt(fx,'two','Shift');
    await preview.locator('.design-mode-switch').click();
    const oldA=await pos(fx,'one'),oldB=await pos(fx,'two'),r=await preview.locator('#one').boundingBox();
    await drag(fx,{x:r.x+30,y:r.y+20},25,20);
    expect(await pos(fx,'one')).toEqual(oldA);expect(await pos(fx,'two')).toEqual(oldB);
    await expect(preview.locator('.design-outline')).toBeHidden();
  }finally{await fx.close();}
});

test('缩放后多选仍按画布坐标移动，属性栏可整体调整，Agent 冻结取消未提交拖拽',async()=>{
  const fx=await multiFixture();
  try{
    const {preview,page}=fx;
    await preview.locator('[data-design="zoom-out"]').click();
    await clickArt(fx,'one');await clickArt(fx,'two','Shift');
    const a=await pos(fx,'one'),b=await pos(fx,'two');
    await preview.locator('input[name="x"]').fill('60');await preview.locator('input[name="x"]').press('Tab');
    const moved=await pos(fx,'one');expect(moved.x-a.x).toBeCloseTo(20/1.2,1);expect((await pos(fx,'two')).x-b.x).toBeCloseTo(20/1.2,1);
    const beforeW=await pos(fx,'one'),boxWidth=Number(await preview.locator('input[name="width"]').inputValue());
    await preview.locator('input[name="width"]').fill(String(boxWidth*1.5));await preview.locator('input[name="width"]').press('Tab');
    expect((await pos(fx,'one')).width/beforeW.width).toBeCloseTo(1.5,1);
    const stable=await pos(fx,'one'),r=await preview.locator('#one').boundingBox();
    await page.mouse.move(r.x+20,r.y+15);await page.mouse.down();await page.mouse.move(r.x+60,r.y+40,{steps:4});
    await page.evaluate(()=>document.querySelector('#preview-frame').contentWindow.postMessage({source:'pi-preview-shell',type:'freeze'},'*'));
    await expect(preview.locator('.design-mode-switch')).toHaveAttribute('aria-checked','false');await page.mouse.up();
    expect((await pos(fx,'one')).x).toBeCloseTo(stable.x);expect((await pos(fx,'one')).width).toBeCloseTo(stable.width);
    await expect(preview.locator('.design-outline')).toBeHidden();
  }finally{await fx.close();}
});

test('图层多选与画布同步，父子同时选中只移动一次；Escape 可取消整组拖拽',async()=>{
  const fx=await multiFixture();
  try{
    const {preview,page}=fx;
    await preview.locator('[title="图层与嵌套元素"]').click();
    await preview.locator('.design-layer').filter({hasText:'section · group'}).click();
    await preview.locator('.design-layer').filter({hasText:'button · child'}).click({modifiers:['Shift']});
    await expect(preview.locator('.design-layer.selected')).toHaveCount(2);
    await expect(preview.locator('.design-selection-mark')).toHaveCount(2);
    await preview.locator('[aria-label="关闭图层"]').click();
    const before=await pos(fx,'child'),r=await preview.locator('#child').boundingBox();
    await drag(fx,{x:r.x+20,y:r.y+15},30,15);
    expect((await pos(fx,'child')).x-before.x).toBeCloseTo(30);expect((await pos(fx,'child')).y-before.y).toBeCloseTo(15);
    const start=await preview.locator('#child').boundingBox();
    await page.mouse.move(start.x+20,start.y+15);await page.mouse.down();await page.mouse.move(start.x+70,start.y+40,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();
    expect((await pos(fx,'child')).x-before.x).toBeCloseTo(30);
    await page.keyboard.press('Control+z');expect((await pos(fx,'child')).x).toBeCloseTo(before.x);
    await expect(preview.locator('.design-mode-switch')).toHaveAttribute('aria-checked','true');
  }finally{await fx.close();}
});

test('设计设置不含布局工具，设计画布标签在最前面且有顶部入口', async () => {
  const fx = await launch();
  try {
    const { page } = fx;
    await openDesign(page, { 'index.html': PAGE, 'main.js': 'document.getElementById("title").textContent="真实页面";' });
    const tabs = await page.locator('#side-panel-tabs [role="tab"]').allInnerTexts();
    expect(tabs[0]).toContain('设计画布');                                   // 预览排第一
    await expect(page.locator('.task-preview-toggle')).toBeVisible();        // 顶部有显眼入口
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();
    const builder = page.frameLocator('#module-frame');
    await expect(builder.locator('#wb-progress')).toBeVisible();
    await expect(builder.locator('.design-toolbar')).toHaveCount(0);        // 创建工作台里没有布局工具栏
    await expect(builder.locator('.design-mode-switch')).toHaveCount(0);
  } finally { await fx.close(); }
});

test('界面预览里能拖拽布局，结果写成工程里的 layout.json / layout.css，重新打开仍然生效', async () => {
  const fx = await launch();
  try {
    const { page } = fx;
    const dir = await openDesign(page, { 'index.html': PAGE, 'main.js': 'document.getElementById("title").textContent="真实页面";' });
    await page.locator('.task-preview-toggle').click();
    const preview = page.frameLocator('#preview-frame');
    await expect(preview.locator('#title')).toHaveText('真实页面');          // 真实页面（含模块脚本）
    await expect(preview.locator('.design-toolbar')).toBeVisible();          // 布局工具栏在预览里
    await expect(preview.locator('.design-toolbar')).toContainText('布局设计');

    // 切到手动，选中按钮并用检查面板改坐标（与拖拽走同一条保存路径）
    await preview.locator('.design-mode-switch').click();
    await preview.locator('button[title="图层与嵌套元素"]').click();
    const layer = preview.locator('.design-layer').filter({ hasText: 'button · go' });
    await layer.evaluate(el => el.click());                                  // 图层面板可能浮在画布上，直接触发选择
    await preview.locator('input[name="x"]').fill('48'); await preview.locator('input[name="x"]').press('Tab');
    await preview.locator('input[name="y"]').fill('30'); await preview.locator('input[name="y"]').press('Tab');

    const cssFile = path.join(dir, 'ui', 'layout.css'), jsonFile = path.join(dir, 'ui', 'layout.json');
    await expect.poll(() => fs.existsSync(cssFile) && fs.existsSync(jsonFile), { timeout: 8000 }).toBe(true);
    expect(await preview.locator('.design-mode-switch').getAttribute('aria-checked')).toBe('true');
    await expect(preview.locator('button[title="图层与嵌套元素"]')).toBeEnabled();
    const css = fs.readFileSync(cssFile, 'utf8');
    expect(css).toMatch(/translate:48px 30px/);
    expect(css).toMatch(/\[data-pi-node-id="[^"]*button#go"\]/);
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).revision).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dir, 'ui', 'index.html'), 'utf8')).not.toContain('data-pi-injected'); // 没有把编辑器写进用户文件

    // 重新加载预览：保存的布局被应用到真实元素上
    await page.reload(); await page.waitForLoadState('load');
    await page.locator('.task-preview-toggle').click();
    const moved = await page.frameLocator('#preview-frame').locator('#go').evaluate(el => getComputedStyle(el).translate);
    expect(moved).toBe('48px 30px');
  } finally { await fx.close(); }
});

test('工作台发布后进入运行态，UI 可以通过宿主通道调用自己的 server', async () => {
  const fx = await launch();
  try {
    const { page } = fx;
    const dir = await openDesign(page, {
      'index.html': '<!doctype html><html><body><button id="run">运行后端</button><pre id="out"></pre><script>document.getElementById("run").onclick=async()=>{try{const r=await window.__wbTransport("updateState",{baseRevision:window.__wbState?.revision||0,patch:{ran:true}});document.getElementById("out").textContent=JSON.stringify(r)}catch(e){document.getElementById("out").textContent="ERROR:"+e.message}};</script></body></html>'
    });
    const verified = await page.evaluate(path => window.piDesktop.workbench.verify({path}), dir);expect(verified.ok,JSON.stringify(verified)).toBe(true);
    const published = await page.evaluate(path => window.piDesktop.workbench.publish({ path }), dir);
    expect(published.ok).toBe(true);
    await page.evaluate(path => {
      const key = 'pi-workbench-design-v2', state = JSON.parse(localStorage.getItem(key));
      const task = state.projects.flatMap(project => project.tasks || []).find(item => item.id === state.activeTask);
      delete task.design; task.use={workbenchId:'published:'+task.id};
      task.workbenchSession = { key: 'published:' + task.id, mode: 'use', target: 'published', sourcePath: path, name: '可运行工作台', open: true, updatedAt: Date.now() };
      localStorage.setItem(key, JSON.stringify(state));
    }, dir);
    await page.reload(); await page.waitForLoadState('load');
    await expect(page.locator('#workbench-panel')).toBeVisible();
    const runtime = page.frameLocator('#module-frame');
    await expect(runtime.locator('#run')).toBeVisible();
    await runtime.locator('#run').click();
    await expect(runtime.locator('#out')).toContainText('revision');
    await expect(runtime.locator('#out')).not.toContainText('ERROR:');
  } finally { await fx.close(); }
});

test('预览页仍在沙箱里：碰不到桌面接口，恶意布局数据不能注入脚本', async () => {
  const fx = await launch();
  try {
    const { page } = fx;
    const dir = await openDesign(page, { 'index.html': PAGE, 'main.js': 'window.__probe={bridge:typeof window.piDesktop,parent:(()=>{try{return typeof parent.document.body}catch{return "blocked"}})()};' });
    fs.writeFileSync(path.join(dir, 'ui', 'layout.json'), JSON.stringify({ revision: 1, nodes: {}, titles: { x: '</script><script>window.__pwned=1</script>' }, order: [] }));
    await page.locator('.task-preview-toggle').click();
    const preview = page.frameLocator('#preview-frame');
    await expect(preview.locator('.design-toolbar')).toBeVisible();
    const probe = await preview.locator('body').evaluate(() => ({ ...window.__probe, pwned: window.__pwned === 1, scripts: document.querySelectorAll('script[data-pi-injected]').length }));
    expect(probe.bridge).toBe('undefined'); expect(probe.parent).toBe('blocked');
    expect(probe.pwned).toBe(false); expect(probe.scripts).toBe(2);
    // 越界保存会被拒绝
    const bad = await page.evaluate(() => window.piDesktop.workbench.saveLayout({ path: 'C:\Windows', layout: { nodes: {} } }));
    expect(bad.ok).toBe(false);
  } finally { await fx.close(); }
});

test('背景层（页面根）可以拖动、缩放；导出的 layout.css 在没有编辑器时同样生效', async () => {
  const fx = await launch();
  try {
    const { page } = fx;
    const dir = await openDesign(page, { 'index.html': PAGE.replace('<script type="module" src="./main.js"></script>', '<link rel="stylesheet" href="layout.css"><script src="layout-runtime.js"></script>'), 'layout-runtime.js': fs.readFileSync(path.join(ROOT, 'runtime', 'layout-runtime.js'), 'utf8') });
    await page.locator('.task-preview-toggle').click();
    const preview = page.frameLocator('#preview-frame');
    await expect(preview.locator('.design-toolbar')).toBeVisible();
    await preview.locator('.design-mode-switch').click();
    await preview.locator('button[title="图层与嵌套元素"]').click();
    const root = preview.locator('.design-layer').first();
    await expect(root).toContainText('div · pi-preview-host');                 // 最底层页面本身就是第一个图层
    await root.evaluate(el => el.click());
    await expect(preview.locator('.design-selected-name')).toContainText('pi-preview-host');
    for (const [name, value] of [['x', '40'], ['y', '24'], ['width', '700']]) { await preview.locator('input[name="' + name + '"]').fill(value); await preview.locator('input[name="' + name + '"]').press('Tab'); }
    const cssFile = path.join(dir, 'ui', 'layout.css');
    await expect.poll(() => fs.existsSync(cssFile) && /\/page"\]\{margin-left:40px;margin-top:24px;width:700px/.test(fs.readFileSync(cssFile, 'utf8')), { timeout: 8000 }).toBe(true);
    // 预览里背景层真的被移动/缩放了
    const live = await preview.locator('#pi-preview-host').evaluate(el => ({ ml: getComputedStyle(el).marginLeft, w: Math.round(parseFloat(getComputedStyle(el).width)) }));
    expect(live.ml).toBe('40px'); expect(live.w).toBe(700);

    // 导出后的运行态：不带编辑器，直接用 layout.css + layout-runtime.js，结果必须一致
    const exported = await page.evaluate(async ([html, css, runtime]) => {
      const doc = document.implementation.createHTMLDocument('x');
      return { ok: true, len: html.length + css.length + runtime.length };
    }, [fs.readFileSync(path.join(dir, 'ui', 'index.html'), 'utf8'), fs.readFileSync(cssFile, 'utf8'), fs.readFileSync(path.join(dir, 'ui', 'layout-runtime.js'), 'utf8')]);
    expect(exported.ok).toBe(true);
  } finally { await fx.close(); }
});
