'use strict';
// 端到端：交互选项卡（编号/推荐/数字键/超时自动选）、工作流发送不阻塞聊天、路径右键菜单。
// 假模型同时扮演：拆解器、聊天模型（可按关键词调用 interaction_request / read 工具）。
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

const node = (id, extra = {}) => ({ id, title: '任务' + id, role: '分析师', brief: '做' + id, prompt: '指令 ' + id, tier: 3, dependsOn: [], ...extra });
const PLAN = JSON.stringify({ decision: 'split', goal: '选型', nodes: [node('n1', { title: '调研' }), node('n2', { dependsOn: ['n1'] }), node('n3', { dependsOn: ['n2'] })] });
const chunk = (id, delta, finish = null) => ({ id, object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta, finish_reason: finish }] });
function sse(res, chunks) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.end('data: [DONE]\n\n'); }
const text = (id, t) => [chunk(id, { role: 'assistant', content: t }), chunk(id, {}, 'stop')];
const tool = (id, name, args) => [chunk(id, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk(id, {}, 'tool_calls')];

async function launch({ plannerDelay = 0 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw || '{}');
    const sys = String(body.messages?.[0]?.content || '');
    const last = body.messages?.[body.messages.length - 1] || {};
    const users = body.messages.filter(m => m.role === 'user'), lastUser = users[users.length - 1];
    const rawUser = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content || []).map(c => c.text || '').join('')) : '';
    const userText = rawUser.split('\n\n当前桌面状态快照')[0];      // 只取用户自己写的话：每条消息后面都会附带含历史对话的桌面快照，不能拿它匹配关键词
    const isPlanner = sys.includes('任务拆解器');
    requests.push({ kind: isPlanner ? 'planner' : 'chat', body, at: Date.now() });
    if (isPlanner) {
      if (plannerDelay) await new Promise(r => setTimeout(r, plannerDelay));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: PLAN } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); return;
    }
    const id = 'r' + requests.length;
    if (last.role === 'tool') {
      if(userText.startsWith('PW_SEQUENCE')&&body.messages.filter(m=>m.role==='tool').length===1){sse(res,tool(id,'interaction_request',{method:'select',title:'第二个问题',message:'选择布局',options:['保留原布局','重新布局']}));return;}
      const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content); sse(res, text(id, 'GOT_TOOL_RESULT ' + out.slice(0, 200))); return;
    }
    if(userText.startsWith('PW_SEQUENCE')){sse(res,tool(id,'interaction_request',{method:'select',title:'第一个问题',message:'选择范围',options:['继续','取消']}));return;}
    if(userText.startsWith('PW_INPUT')){sse(res,tool(id,'interaction_request',{method:'input',title:'修改需求',message:'填写需求'}));return;}
    if(userText.startsWith('PW_CUSTOM')){sse(res,tool(id,'interaction_request',{method:'select',title:'说明你的需求',message:'可以直接填写',options:['保持现状','其他（请说明）']}));return;}
    if (userText.startsWith('PW_SELECT')) { sse(res, tool(id, 'interaction_request', { method: 'select', title: '选方案', message: userText.startsWith('PW_SELECT_LONG') ? '先确认本轮工作台修改范围。'.repeat(60) : '你想要哪种？', options: ['快速版', '标准版', '完整版'], recommended: 1 })); return; }
    if (userText.startsWith('PW_CONFIRM_NOREC')) { sse(res, tool(id, 'interaction_request', { method: 'confirm', title: '继续吗', message: '是否继续？' })); return; }
    if (userText.startsWith('PW_READ')) { sse(res, tool(id, 'read', { path: 'notes.txt' })); return; }
    sse(res, text(id, 'CHAT_DONE'));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(ROOT, '.ix-')); const workspace = path.join(profile, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'hello\n');
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app = await electron.launch({ executablePath: exe||path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [...(exe?[]:[ROOT]), '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_WORKBENCH_WORKSPACE: workspace } });
  await require('./helpers/clipboard.cjs').useClipboardMemory(app);
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
  await page.evaluate(async port => {
    await window.PiProviderManager.saveConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'local-test-only', model: 'x-local', models: ['x-local'] });
    window.__events = []; window.piDesktop.agent.onEvent(e => window.__events.push(e));
  }, server.address().port);
  return { app, page, requests, profile, workspace, close: async () => { try { await app.close(); } finally { server.close(); fs.rmSync(profile, { recursive: true, force: true }); } } };
}
const clip = app => app.evaluate(({ clipboard }) => clipboard.readText());
const clipBecomes = async (app, predicate, ms = 8000) => { const end = Date.now() + ms; let v = ''; while (Date.now() < end) { v = await clip(app); if (predicate(v)) return v; await new Promise(r => setTimeout(r, 50)); } return v; };
const send = async (page, t) => { await page.locator('#message-input').fill(t); await page.locator('#composer').evaluate(f => f.requestSubmit()); };
const settled = page => page.waitForFunction(() => window.__events.some(e => e.type === 'agent_settled'), null, { timeout: 60000 });
const built = page => page.waitForFunction(() => /已搭好/.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 60000 });
const setAuto = (page, seconds) => page.evaluate(s => { const st = JSON.parse(localStorage.getItem('pi-workbench-design-v2') || '{}'); return s; }, seconds);

for(const surface of ['design','published','base'])test('长对话与长交互卡：鼠标选择不把聊天页滚走，提交后消息和输入框始终可见 '+surface, async ({},info) => {
  const fx=await launch();
  try {
    const {page}=fx,errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    let published=null;
    if(surface==='published'){
      const source=await page.evaluate(async()=>(await window.piDesktop.workbench.scaffold({name:'交互布局测试'})).result.path);
      require('./fixtures/workbench-ui.cjs').counter(source);
      published=await page.evaluate(async path=>{const verified=await window.piDesktop.workbench.verify({path});if(!verified.ok)throw new Error(JSON.stringify(verified));const p=await window.piDesktop.workbench.publish({path});if(!p.ok)throw new Error(p.error);return p.result;},source);
    }
    await page.evaluate(({surface,published})=>{
      const key='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(key)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
      s.settings.autoTranslate=false;s.settings.approval='full';
      t.messages=Array.from({length:45},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',text:'工作台设计历史 '+i+'\n'+'请保留已经确认的布局与功能。'.repeat(35),time:Date.now()}));
      if(surface==='base'){delete t.design;delete t.workbenchSession;}
      if(published){delete t.design;t.use={workbenchId:published.id};t.workbenchSession={key:published.id,mode:'use',sourcePath:published.path,name:published.name,open:true};}
      localStorage.setItem(key,JSON.stringify(s));
    },{surface,published});
    await page.reload();await page.evaluate(()=>{window.__events=[];window.piDesktop.agent.onEvent(e=>window.__events.push(e));});
    await send(page,'PW_SELECT_LONG');const form=page.locator('#agent-ui-form');await expect(form).toBeVisible({timeout:30000});
    await form.locator('.choice').nth(2).click();
    const geometry=await page.evaluate(()=>{
      const p=document.querySelector('#page'),input=document.querySelector('#message-input'),chat=document.querySelector('.chat-page'),m=document.querySelector('#messages');
      return {pageTop:p.scrollTop,pageHeight:p.clientHeight,pageScroll:p.scrollHeight,input:input.getBoundingClientRect().toJSON(),chat:chat.getBoundingClientRect().toJSON(),messages:m.getBoundingClientRect().toJSON(),viewport:innerHeight};
    });
    await page.screenshot({path:info.outputPath('interaction-selected.png')});
    expect(geometry.pageTop,JSON.stringify(geometry)).toBe(0);
    expect(geometry.pageScroll).toBeLessThanOrEqual(geometry.pageHeight+2);
    expect(geometry.input.bottom).toBeLessThan(geometry.viewport);
    await expect(form.locator('input[value="完整版"]')).toBeChecked();
    for(const [w,h,zoom] of [[1280,800,1],[1600,960,1.3]]){
      await fx.app.evaluate(({BrowserWindow},[w,h,z])=>{const win=BrowserWindow.getAllWindows()[0];win.setContentSize(w,h);win.webContents.setZoomFactor(z);},[w,h,zoom]);
      await expect(page.locator('#message-input')).toBeInViewport();
      await form.locator('.choice').first().click();await form.locator('.choice').nth(2).click();
      expect(await page.locator('#page').evaluate(p=>({top:p.scrollTop,overflow:p.scrollHeight-p.clientHeight}))).toEqual({top:0,overflow:0});
    }

    await form.locator('button[type="submit"]').last().click();await settled(page);
    await expect(page.locator('#messages')).toContainText('GOT_TOOL_RESULT');await expect(page.locator('#message-input')).toBeInViewport();
    expect(await page.locator('#page').evaluate(p=>p.scrollTop)).toBe(0);expect(errors).toEqual([]);
  }finally{await fx.close();}
});

test('交互选项卡：编号 + 推荐标记；点选项/按数字键直接提交；Agent 收到所选文字', async () => {
  const fx = await launch();
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await send(fx.page, 'PW_SELECT 帮我选');
    const form = fx.page.locator('#agent-ui-form');
    await expect(form).toBeVisible({ timeout: 30000 });
    await expect(form.locator('.choice')).toHaveCount(4);
    await expect(form.locator('.choice-no').nth(0)).toHaveText('1');
    await expect(form.locator('.choice.recommended')).toContainText('标准版');          // recommended: 1
    await expect(form.locator('.choice.recommended .choice-rec')).toHaveText('推荐');
    await expect(form.locator('.question-message')).toContainText('你想要哪种');
    await expect(fx.page.locator('#auto-choose-status')).toHaveText('Agent 正在等待');   // 默认没开自动选择
    await fx.page.keyboard.press('3');                                                  // 数字键 3 = 完整版
    await settled(fx.page);
    const reply = fx.requests.at(-1).body.messages.at(-1);
    expect(JSON.stringify(reply.content)).toContain('完整版');
    await expect(fx.page.locator('#messages')).toContainText('GOT_TOOL_RESULT');
  } finally { await fx.close(); }
});

test('提问后超时自动选推荐项：设置里选等待时间；倒计时可见；聊天里写明“已自动选了推荐项”；没有推荐的确认题不会自动答', async () => {
  const fx = await launch();
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    // 设置 → 界面：选 30 秒太慢，这里直接写成设置值 30，并确认设置控件存在且生效
    await fx.page.locator('[data-route="settings"]').click();
    await fx.page.locator('#settings-tab-ui').first().click();
    await expect(fx.page.locator('#auto-choose-setting')).toBeVisible();
    await expect(fx.page.locator('#auto-choose-setting')).toHaveValue('0');
    await fx.page.locator('#auto-choose-setting').selectOption('30');
    expect(await fx.page.evaluate(() => JSON.parse(localStorage.getItem('pi-workbench-design-v2')).settings.autoChooseSeconds)).toBe(30);
    // 为了测试速度，把倒计时缩到 2 秒（逻辑一致，只是秒数）
    await fx.page.evaluate(() => { const orig = window.PiInteractionTimeout.autoAnswer; window.PiInteractionTimeout.autoAnswer = (r, s) => { const a = orig(r, s); return a ? { ...a, seconds: 2 } : a; }; });
    await fx.page.locator('[data-route="chat"], [data-action="select-task"]').first().click().catch(() => {});
    await fx.page.locator('.task-row').first().click();
    await send(fx.page, 'PW_SELECT 帮我选');
    await expect(fx.page.locator('#agent-ui-form')).toBeVisible({ timeout: 30000 });
    await expect(fx.page.locator('#auto-choose-status')).toContainText('秒后自动选「标准版」');
    await settled(fx.page);                                                              // 没人点，2 秒后自动继续
    const reply = fx.requests.at(-1).body.messages.at(-1);
    expect(JSON.stringify(reply.content)).toContain('标准版');
    await expect(fx.page.locator('#messages')).toContainText('已自动选了推荐项：标准版');
    // 确认题没有推荐 → 不自动，一直等
    await fx.page.evaluate(() => { window.__events = []; });
    await send(fx.page, 'PW_CONFIRM_NOREC');
    await expect(fx.page.locator('#agent-ui-form')).toBeVisible({ timeout: 30000 });
    await expect(fx.page.locator('#auto-choose-status')).toHaveText('Agent 正在等待');
    await fx.page.waitForTimeout(3500);
    await expect(fx.page.locator('#agent-ui-form')).toBeVisible();                       // 仍在等用户
  } finally { await fx.close(); }
});

test('工作流模式发送不阻塞：拆解很慢时聊天里立刻出现“正在搭建工作流…”，停止键可用；拆完只搭建，不让主 Agent 回答，也不自动运行', async ({},info) => {
  const fx = await launch({ plannerDelay: 4000 });
  try {
    await fx.app.evaluate(({ipcMain})=>{global.__workbenchDiagnostics=[];for(const channel of ['workbench:server','workbench:manifest']){const original=ipcMain._invokeHandlers.get(channel);ipcMain._invokeHandlers.set(channel,async(...args)=>{const r=await original(...args);global.__workbenchDiagnostics.push({channel,action:args[1]?.action,key:args[1]?.key,ok:r?.ok,error:r?.error});return r;});}});
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.page.locator('#task-mode').selectOption('workflow');
    const t0 = Date.now();
    await send(fx.page, '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。');
    // 拆解还没返回（4 秒），聊天里应该已经有 Agent 消息和进度
    await expect(fx.page.locator('.message.assistant, [data-message-id]').last()).toContainText('正在搭建工作流', { timeout: 2500 });
    expect(Date.now() - t0).toBeLessThan(3500);
    await expect(fx.page.locator('[data-action="stop-agent"]')).toBeVisible();          // 能停止
    // 拆完后：画布出现节点；聊天里写明“已搭好”，提示先检查再运行；仍是同一条消息
    const fr = fx.page.frameLocator('#module-frame');
    try{await expect(fr.locator('.wf-node')).toHaveCount(3, { timeout: 20000 });}catch(error){await info.attach('workbench-diagnostics',{body:JSON.stringify(await fx.app.evaluate(()=>global.__workbenchDiagnostics),null,2),contentType:'application/json'});throw error;}
    await built(fx.page);
    await expect(fx.page.locator('#messages')).toContainText('工作流已搭好：3 步');
    await expect(fx.page.locator('#messages')).toContainText('运行全部');
    expect(await fx.page.locator('#messages .message.assistant').count()).toBe(1);
    await expect(fx.page.locator('[data-action="stop-agent"]')).toHaveCount(0);          // 搭建结束，不再处于运行中
    expect(fx.requests.filter(r => r.kind === 'planner')).toHaveLength(1);
    await fx.page.waitForTimeout(1500);
    expect(fx.requests.filter(r => r.kind === 'chat')).toHaveLength(0);                  // 主 Agent 没有被叫起来回答（省一份 token）
    expect(fx.requests.filter(r => r.kind === 'node')).toHaveLength(0);                  // 也没有自动运行任何节点
  } finally { await fx.close(); }
});

test('工作流拆解中点停止：取消拆解，不再发聊天请求，界面恢复可再次发送', async () => {
  const fx = await launch({ plannerDelay: 6000 });
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.page.locator('#task-mode').selectOption('workflow');
    await send(fx.page, '帮我调研三种国产 MCU 的低功耗特性，对比后给出选型建议，并写一段给老板的 200 字汇报。');
    await expect(fx.page.locator('[data-action="stop-agent"]')).toBeVisible({ timeout: 5000 });
    await fx.page.locator('[data-action="stop-agent"]').click();
    await expect(fx.page.locator('[data-action="stop-agent"]')).toHaveCount(0, { timeout: 5000 });
    await fx.page.waitForTimeout(1500);
    expect(fx.requests.filter(r => r.kind === 'chat')).toHaveLength(0);
    await expect(fx.page.locator('#message-input')).toBeEnabled();
  } finally { await fx.close(); }
});

test('路径右键菜单：文件夹行与聊天里的文件引用都有「打开 ›」子菜单和「复制绝对路径」；复制的是绝对路径；越界路径被拒绝', async () => {
  const fx = await launch();
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    // 1) 让聊天里出现一个文件引用：Agent 用 read 读 notes.txt，回复里引用它
    await fx.page.evaluate(async ws => { /* 给当前任务设置工作文件夹 */ const key = 'pi-workbench-design-v2'; }, fx.workspace);
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, fx.workspace);
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('右键测试');
    await fx.page.locator('#task-path-pick').click();
    await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    // 2) 聊天框下面的路径下拉里的文件夹行：右键
    await fx.page.locator('.path-toggle').click();
    const row = fx.page.locator('#path-menu .path-item').first();
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    const ctx = fx.page.locator('#path-ctx');
    await expect(ctx).toBeVisible();
    await expect(ctx.locator('[data-ctx="submenu"]')).toContainText('打开');
    await ctx.locator('[data-ctx="submenu"]').hover();                                    // 停在「打开」上 → 子菜单展开
    await expect(ctx.locator('.ctx-sub')).toBeVisible();
    await expect(ctx.locator('.ctx-sub [data-ctx="open"]')).toHaveText('打开文件夹');
    await expect(ctx.locator('.ctx-sub [data-ctx="reveal"]')).toHaveText('在文件夹中显示');
    await expect(ctx.locator('.ctx-sub [data-ctx="copy"]')).toHaveText('复制绝对路径');
    // 3) 复制绝对路径：剪贴板里是工作文件夹的绝对路径
    await fx.app.evaluate(({ clipboard }) => clipboard.writeText('PENDING'));
    await ctx.locator('.ctx-sub [data-ctx="copy"]').click();
    const clipText = await clipBecomes(fx.app, v => v !== 'PENDING');
    expect(path.resolve(clipText).toLowerCase()).toBe(path.resolve(fx.workspace).toLowerCase());
    await expect(ctx).toHaveCount(0);
    // 4) Esc 关闭
    if (!(await row.isVisible())) await fx.page.locator('.path-toggle').click();            // 点了菜单项后下拉随之收起，再展开
    await row.click({ button: 'right' }); await expect(fx.page.locator('#path-ctx')).toBeVisible();
    await fx.page.keyboard.press('Escape'); await expect(fx.page.locator('#path-ctx')).toHaveCount(0);
    // 5) 主进程把关：不在允许范围内的路径被拒绝，且不会复制
    await fx.app.evaluate(({ clipboard }) => clipboard.writeText('SENTINEL'));
    const bad = await fx.page.evaluate(ws => window.piDesktop.paths.act({ action: 'copy', target: 'C:\\Windows\\System32\\drivers\\etc\\hosts', workspace: ws, roots: [] }), fx.workspace);
    expect(bad.ok).toBe(false); expect(bad.error).toMatch(/不在当前聊天用到的文件夹/);
    expect(await fx.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('SENTINEL');
    const rel = await fx.page.evaluate(ws => window.piDesktop.paths.act({ action: 'copy', target: '..\\outside.txt', workspace: ws, roots: [] }), fx.workspace);
    expect(rel.ok).toBe(false);
    const good = await fx.page.evaluate(ws => window.piDesktop.paths.act({ action: 'copy', target: 'notes.txt', workspace: ws, roots: [] }), fx.workspace);
    expect(good.ok).toBe(true); expect(path.resolve(good.path).toLowerCase()).toBe(path.join(path.resolve(fx.workspace), 'notes.txt').toLowerCase());
  } finally { await fx.close(); }
});

test('聊天里的文件引用右键：回复里的文件链接、修改过的文件列表都有菜单；「打开文件」「打开所在文件夹」「复制绝对路径」；越界链接被拒绝', async () => {
  const fx = await launch();
  try {
    await fx.page.locator('#approval-mode').selectOption('full');
    await fx.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, fx.workspace);
    await fx.page.locator('[data-action="new-task"]').first().click();
    await fx.page.locator('#entity-name').fill('引用右键');
    await fx.page.locator('#task-path-pick').click();
    await fx.page.locator('#dialog-form').evaluate(f => f.requestSubmit());
    // 直接在聊天里放入两种引用：一个指向工作文件夹内的文件，一个越界；再放一个“修改过的文件”条目
    await fx.page.evaluate(ws => {
      const key = 'pi-workbench-design-v2', st = JSON.parse(localStorage.getItem(key));
      const t = st.projects.flatMap(p => p.tasks).find(x => x.id === st.activeTask);
      t.messages.push({ id: 'm-ref', role: 'assistant', text: '结果在 [notes](notes.txt) 里，另见 [外部](../outside.txt)。', time: Date.now(), run: { status: 'complete', label: '本轮已结束', steps: [], changedFiles: [{ path: 'notes.txt', cwd: ws, operation: '修改' }], hasFinal: true, cwd: ws } });
      localStorage.setItem(key, JSON.stringify(st));
    }, fx.workspace);
    await fx.page.reload(); await fx.page.waitForLoadState('load');
    if (await fx.page.locator('#first-launch').isVisible().catch(() => false)) await fx.page.locator('[data-action="dismiss-first-launch"]').click();
    const link = fx.page.locator('a[data-reference="notes.txt"]');
    await expect(link).toBeVisible();
    await link.click({ button: 'right' });
    const ctx = fx.page.locator('#path-ctx');
    await expect(ctx).toBeVisible();
    await ctx.locator('[data-ctx="submenu"]').hover();
    await expect(ctx.locator('.ctx-sub [data-ctx="open"]')).toHaveText('打开文件');
    await expect(ctx.locator('.ctx-sub [data-ctx="open-parent"]')).toHaveText('打开所在文件夹');
    await expect(ctx.locator('.ctx-sub [data-ctx="reveal"]')).toHaveText('在文件夹中显示');
    await fx.app.evaluate(({ clipboard }) => clipboard.writeText('PENDING'));
    await ctx.locator('.ctx-sub [data-ctx="copy"]').click();
    expect((await clipBecomes(fx.app, v => v !== 'PENDING')).toLowerCase()).toBe(path.join(path.resolve(fx.workspace), 'notes.txt').toLowerCase());   // 相对链接 → 绝对路径
    // 修改过的文件列表里的条目
    const changed = fx.page.locator('.file-review-link', { hasText: 'notes.txt' });
    if (await changed.count()) {
      await fx.app.evaluate(({ clipboard }) => clipboard.writeText('X'));
      await changed.first().click({ button: 'right' });
      await fx.page.locator('#path-ctx > [data-ctx="copy"]').click();
      expect((await clipBecomes(fx.app, v => v !== 'X')).toLowerCase()).toBe(path.join(path.resolve(fx.workspace), 'notes.txt').toLowerCase());
    }
    // 越界链接：菜单能出现，但操作被主进程拒绝，剪贴板不变
    await fx.app.evaluate(({ clipboard }) => clipboard.writeText('SENTINEL'));
    await fx.page.locator('a[data-reference="../outside.txt"]').click({ button: 'right' });
    await fx.page.locator('#path-ctx > [data-ctx="copy"]').click();
    await expect(fx.page.locator('#toast')).toContainText('不在当前聊天用到的文件夹');
    expect(await fx.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('SENTINEL');
  } finally { await fx.close(); }
});


test('连续交互：重复提交只发送一次，旧响应晚到不清掉下一张卡片，失败可重试',async()=>{
  const fx=await launch();try{
    const {app,page}=fx;await page.locator('#approval-mode').selectOption('full');
    await app.evaluate(({ipcMain})=>{
      const original=ipcMain._invokeHandlers.get('agent:respond');globalThis.__responseCalls=0;
      ipcMain.removeHandler('agent:respond');ipcMain.handle('agent:respond',async(event,input)=>{
        const n=++globalThis.__responseCalls;
        if(n===2)return {ok:false,error:'测试：通道暂时不可用'};
        const result=await original(event,input);
        if(n===1)await new Promise(resolve=>{globalThis.__releaseResponse=resolve;});
        return result;
      });
    });
    await send(page,'PW_SEQUENCE');await expect(page.locator('#agent-ui-form')).toContainText('第一个问题',{timeout:30000});
    await page.locator('#agent-ui-form').evaluate(f=>{f.requestSubmit();f.requestSubmit();f.requestSubmit();});
    await expect(page.locator('#agent-ui-form')).toContainText('第二个问题',{timeout:30000});
    expect(await app.evaluate(()=>globalThis.__responseCalls)).toBe(1);
    await app.evaluate(()=>globalThis.__releaseResponse());
    await expect(page.locator('#messages')).toContainText('你的选择：继续');await expect(page.locator('#agent-ui-form')).toContainText('第二个问题');
    await page.locator('#agent-ui-form button[type="submit"]').last().click();await expect(page.locator('#auto-choose-status')).toContainText('提交失败');
    await page.locator('#agent-ui-form button[type="submit"]').last().click();await settled(page);
    expect(await app.evaluate(()=>globalThis.__responseCalls)).toBe(3);await expect(page.locator('#agent-ui-form')).toHaveCount(0);
  }finally{await fx.close();}
});

test('交互草稿：切换摘要保持选择和编辑内容，聊天输入可以直接回答，停止后卡片消失',async()=>{
  const fx=await launch();try{
    const {page}=fx;await page.locator('#approval-mode').selectOption('full');await send(page,'PW_SELECT');
    await expect(page.locator('#agent-ui-form')).toBeVisible({timeout:30000});await page.locator('#agent-ui-form .choice').nth(2).click();
    await page.locator('[data-action="toggle-summary"]').first().click();await expect(page.locator('#agent-ui-form input[value="完整版"]')).toBeChecked();
    await send(page,'采用另外一种自定义方案');await settled(page);await expect(page.locator('#messages')).toContainText('你的选择：采用另外一种自定义方案');
    await page.evaluate(()=>window.__events=[]);await send(page,'PW_INPUT');await expect(page.locator('#agent-ui-form .free-input')).toBeVisible({timeout:30000});
    await page.locator('#agent-ui-form .free-input').fill('修改后的需求，保留全部内容');await page.locator('[data-action="toggle-summary"]').first().click();
    await expect(page.locator('#agent-ui-form .free-input')).toHaveValue('修改后的需求，保留全部内容');
    await page.locator('[data-action="stop-agent"]').click();await expect(page.locator('#agent-ui-form')).toHaveCount(0);await expect(page.locator('.send-button')).not.toHaveClass(/stop-button/);
  }finally{await fx.close();}
});


test('自定义答案直接输入：自动选中、暂停自动答案、重绘和失败重试均保留原文',async({},info)=>{
  const fx=await launch();try{
    const {page,app}=fx;
    await page.locator('#approval-mode').selectOption('full');
    await page.locator('[data-route="settings"]').click();await page.locator('#settings-tab-ui').first().click();await page.locator('#auto-choose-setting').selectOption('30');
    await page.locator('.task-row').first().click();
    await page.evaluate(()=>{const orig=window.PiInteractionTimeout.autoAnswer;window.PiInteractionTimeout.autoAnswer=(r,s)=>{const p=orig(r,s);return p?{...p,seconds:2}:p;};});
    await send(page,'PW_CUSTOM');const form=page.locator('#agent-ui-form'),input=form.getByRole('textbox',{name:'自定义答案'});
    await expect(form).toBeVisible({timeout:30000});await expect(form.locator('.choice')).toHaveCount(2);
    await expect(input).toBeVisible();await expect(input).toBeEditable();await expect(form.locator('#agent-custom-choice')).not.toBeChecked();
    const answer='直接读取后端状态，不要让我重复连接。\n保留已有设备与布局，版本 123。';
    await input.fill(answer);await expect(form.locator('#agent-custom-choice')).toBeChecked();
    await expect(page.locator('#auto-choose-status')).toHaveText('Agent 正在等待');
    await page.waitForTimeout(2300);await expect(form).toBeVisible();
    await page.locator('[data-action="toggle-summary"]').first().click();await expect(input).toHaveValue(answer);await expect(form.locator('#agent-custom-choice')).toBeChecked();
    await form.locator('.choice').first().click();await expect(input).toBeEditable();await expect(input).toHaveValue(answer);
    await input.fill('');await expect(form.locator('#agent-custom-choice')).toBeChecked();await form.locator('button[type="submit"]').last().click();await expect(form).toBeVisible();await expect(page.locator('#toast')).toContainText('请填写自定义答案');
    await input.fill(answer);await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('agent:respond');let once=true;ipcMain._invokeHandlers.set('agent:respond',async(...args)=>{if(once){once=false;return {ok:false,error:'临时提交失败'};}return original(...args);});});
    await form.locator('button[type="submit"]').last().click();await expect(page.locator('#auto-choose-status')).toContainText('提交失败');await expect(input).toHaveValue(answer);await expect(input).toBeEditable();
    await page.screenshot({path:info.outputPath('custom-answer.png')});
    await input.press('Control+Enter');await settled(page);
    const message=fx.requests.at(-1).body.messages.at(-1);expect(JSON.parse(message.content).value).toBe(answer);
    await expect(page.locator('#messages')).toContainText('你的选择：直接读取后端状态');expect(await page.locator('#page').evaluate(p=>p.scrollTop)).toBe(0);
  }finally{await fx.close();}
});
