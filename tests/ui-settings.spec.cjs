'use strict';

const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

async function launch(){
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-ui-'));
  const packaged=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:packaged||path.join(ROOT,'node_modules','electron','dist','electron.exe'),args:[...(packaged?[]:[ROOT]),'--user-data-dir='+profile],cwd:packaged?path.dirname(packaged):ROOT});
  const page=await app.firstWindow();
  await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('#first-launch [data-action="dismiss-first-launch"]').click();
  await page.evaluate(()=>{localStorage.clear();location.reload();});
  await expect(page.locator('#message-input')).toBeVisible();
  return {app,page,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('pi-workbench-design-v2')||'{}').settings||{});

test('设置分为 LLM 与界面两个子菜单，原有控件各归其位',async()=>{
  const {page,close}=await launch();
  try{
    await page.locator('[data-route="settings"]').click();
    await expect(page.locator('#settings-tab-llm')).toHaveAttribute('aria-selected','true');
    await expect(page.locator('#provider-name')).toBeVisible();
    await expect(page.locator('#agent-environment-setting')).toBeHidden();
    await page.locator('#settings-tab-ui').click();
    await expect(page.locator('#provider-name')).toBeHidden();
    for(const id of ['#approval-setting','#interactive-toggle','#agent-environment-setting','#send-key-setting'])await expect(page.locator(id).first()).toBeAttached();
    await expect(page.locator('#approval-setting')).toBeVisible();
    await expect(page.locator('[data-record]')).toHaveCount(9);
  }finally{await close();}
});

test('字体大小立即生效并在重启渲染后保留',async()=>{
  const {page,close}=await launch();
  try{
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-ui').click();
    const base=await page.evaluate(()=>window.innerWidth);
    await page.locator('[data-font-scale="130"]').click();
    await expect(page.locator('[data-font-scale="130"]')).toHaveAttribute('aria-pressed','true');
    expect((await stored(page)).fontScale).toBe(130);
    await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBeLessThan(base);
    await page.reload();
    await expect(page.locator('#message-input')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBeLessThan(base);
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-ui').click();
    await page.locator('[data-font-scale="100"]').click();
    await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBe(base);
  }finally{await close();}
});

test('快捷键可改、冲突与无效组合被拒绝、可恢复默认，且真正触发动作',async()=>{
  const {page,close}=await launch();
  try{
    await page.keyboard.press('Control+,');
    await expect(page.locator('#settings-tab-llm')).toBeVisible();
    await page.locator('#settings-tab-ui').click();
    // 无效：没有 Ctrl/Alt
    await page.locator('[data-record="search"]').click();
    await page.keyboard.press('KeyJ');
    expect((await stored(page)).shortcuts||{}).toEqual({});
    // 冲突：Ctrl+, 已被「打开设置」使用
    await page.keyboard.press('Control+,');
    expect((await stored(page)).shortcuts||{}).toEqual({});
    // 有效：Ctrl+J
    await page.keyboard.press('Control+J');
    expect((await stored(page)).shortcuts).toEqual({search:'Ctrl+J'});
    await expect(page.locator('[data-route="search"] kbd')).toHaveText('Ctrl J');
    await page.locator('[data-action="select-task"]').first().click();
    await page.keyboard.press('Control+K');
    await expect(page.locator('#search-query')).toBeHidden();
    await page.keyboard.press('Control+J');
    await expect(page.locator('#search-query')).toBeVisible();
    // 恢复默认
    await page.keyboard.press('Control+,');
    await page.locator('#settings-tab-ui').click();
    await page.locator('[data-reset="search"]').click();
    expect((await stored(page)).shortcuts).toEqual({});
    await page.keyboard.press('Control+K');
    await expect(page.locator('#search-query')).toBeVisible();
  }finally{await close();}
});

test('发送键可切换为 Ctrl+Enter',async()=>{
  const {page,close}=await launch();
  try{
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-ui').click();
    await page.locator('#send-key-setting').selectOption('ctrl-enter');
    expect((await stored(page)).sendKey).toBe('ctrl-enter');
    await page.locator('[data-action="select-task"]').first().click();
    const input=page.locator('#message-input');
    await expect(input).toBeVisible();
    const count=()=>page.evaluate(()=>{const st=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));return st.projects.flatMap(p=>p.tasks).find(t=>t.id===st.activeTask).messages.length;});
    const before=await count();
    await input.fill('第一行');
    await input.press('Enter');
    await page.waitForTimeout(600);
    await expect(input).toHaveValue(/第一行/);
    expect(await count()).toBe(before);
    await input.press('Control+Enter');
    await expect.poll(count).toBeGreaterThan(before);
  }finally{await close();}
});

test('窗口栏：折叠侧栏、前进后退、logo 在右下角，且状态可保留',async()=>{
  const {page,close}=await launch();
  try{
    // 标题栏里不再有 logo，logo 在底部状态栏右侧
    await expect(page.locator('.titlebar .brand')).toHaveCount(0);
    await expect(page.locator('.app-status .brand')).toBeVisible();
    const box=await page.locator('.app-status .brand').boundingBox(),win=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
    expect(box.x).toBeGreaterThan(win.w/2);expect(box.y).toBeGreaterThan(win.h-60);
    // 标题栏与页面同底色（一体化）
    const colors=await page.evaluate(()=>({t:getComputedStyle(document.querySelector('.titlebar')).backgroundColor,p:getComputedStyle(document.querySelector('.main')).backgroundColor}));
    expect(colors.t).toBe(colors.p);

    // 初始没有历史：后退/前进不可用
    await expect(page.locator('#nav-back')).toBeDisabled();await expect(page.locator('#nav-forward')).toBeDisabled();
    await page.locator('[data-route="settings"]').click();
    await expect(page.locator('#settings-tab-llm')).toBeVisible();
    await expect(page.locator('#nav-back')).toBeEnabled();
    await page.locator('[data-route="plugins"]').click();
    await page.locator('#nav-back').click();                       // 回到设置
    await expect(page.locator('#settings-tab-llm')).toBeVisible();
    await expect(page.locator('#nav-forward')).toBeEnabled();
    await page.keyboard.press('Alt+ArrowRight');                    // 前进到插件
    await expect(page.locator('.plugin-row').first()).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');await page.keyboard.press('Alt+ArrowLeft');  // 回到聊天
    await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#nav-back')).toBeDisabled();
    // 后退后再走新页面，前进栈被丢弃
    await page.locator('[data-route="search"]').click();
    await expect(page.locator('#nav-forward')).toBeDisabled();

    // 折叠侧栏
    const sidebar=page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    await page.locator('#nav-sidebar').click();
    await expect(page.locator('#shell')).toHaveClass(/sidebar-collapsed/);
    await expect(sidebar).toBeHidden();
    expect((await stored(page)).sidebarCollapsed).toBe(true);
    await page.reload();await expect(page.locator('#shell')).toHaveClass(/sidebar-collapsed/);   // 重启后保留
    await page.keyboard.press('Control+B');
    await expect(page.locator('#shell')).not.toHaveClass(/sidebar-collapsed/);
    await expect(sidebar).toBeVisible();
    await expect(page.locator('#nav-sidebar')).toHaveAttribute('aria-pressed','false');
  }finally{await close();}
});

test('后退会跳过已被删除的任务，不会落到空白页',async()=>{
  const {page,close}=await launch();
  try{
    const names=await page.locator('.task-select').allInnerTexts();
    expect(names.length).toBeGreaterThan(1);
    const target=page.locator('.task-row').nth(1);
    const targetName=(await target.locator('.task-select').innerText()).trim();
    await target.locator('.task-select').click();                    // 历史：聊天(任务1) → 聊天(任务2)
    await page.locator('[data-route="settings"]').click();           // 历史：→ 设置(任务2)
    await page.locator('[data-action="select-task"]').first().click().catch(()=>{});
    await page.locator('.task-row').first().locator('.task-select').click(); // 切回任务1，让任务2可以被删除
    await page.locator('.task-row').nth(1).locator('[data-action="task-menu"]').click();
    await page.locator('#menu [data-action="delete-task"]').click();
    await page.locator('#dialog-form').evaluate(form=>form.requestSubmit());
    await expect(page.locator('.task-select',{hasText:targetName})).toHaveCount(0);
    // 连续后退：不应落到已删除的任务/空白页，页面始终可用
    for(let i=0;i<4;i++){if(await page.locator('#nav-back').isDisabled())break;await page.locator('#nav-back').click();await expect(page.locator('#page')).not.toBeEmpty();}
    await expect(page.locator('#page')).not.toContainText('从左侧选择一个任务');
  }finally{await close();}
});

test('左侧「工作台」栏目：使用/创建的工作台任务放在这里，默认不出现在项目里，可开关',async()=>{
  const {page,close}=await launch();
  try{
    await expect(page.locator('#workbench-section')).toBeVisible();
    await expect(page.locator('#workbench-section h2')).toHaveText('工作台');
    await expect(page.locator('#workbench-section .wb-empty')).toBeVisible();   // 一开始是空的
    const before=await page.locator('#projects .task-row').count();

    // 在当前任务里“打开使用” QUBO：会新建一个「使用」任务
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();
    await page.locator('#use-task').selectOption('__new__');
    await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    await expect(page.locator('#workbench-panel')).toBeVisible();

    // 在「工作台」栏目里出现，分组名是工作台名；项目里不出现
    await expect(page.locator('#workbench-section .wb-group')).toHaveCount(1);
    await expect(page.locator('#workbench-section .wb-group')).toContainText('QUBO 求解器');
    await expect(page.locator('#workbench-section .task-row')).toContainText('使用');
    expect(await page.locator('#projects .task-row').count()).toBe(before);

    // 再“创建工作台”：另起一组
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('#workbench-section .wb-group')).toHaveCount(2);
    expect(await page.locator('#projects .task-row').count()).toBe(before);

    // 选中工作台里的任务会切到它；该条目高亮
    await page.locator('#workbench-section .task-select').first().click();
    await expect(page.locator('#workbench-section .task-row.selected')).toHaveCount(1);

    // 折叠分组与整个栏目
    await page.locator('#workbench-section [data-action="toggle-wb-group"]').first().click();
    await page.locator('#workbench-section [data-action="toggle-workbench-section"]').click();
    await expect(page.locator('#workbench-section .wb-group')).toHaveCount(0);
    await page.locator('#workbench-section [data-action="toggle-workbench-section"]').click();
    await expect(page.locator('#workbench-section .wb-group')).toHaveCount(2);

    // 设置：开启“在项目里也显示”，项目里就能看到这些任务
    await page.locator('[data-route="settings"]').click();
    await page.locator('#settings-tab-toggles').click();
    await page.locator('[data-wb-in-projects]').evaluate(el=>el.click());
    expect((await stored(page)).workbenchInProjects).toBe(true);
    expect(await page.locator('#projects .task-row').count()).toBeGreaterThan(before);
    await page.locator('[data-wb-in-projects]').evaluate(el=>el.click());
    expect(await page.locator('#projects .task-row').count()).toBe(before);
  }finally{await close();}
});

test('B 方案：在项目聊天里打开工作台，聊天就地转入「工作台」栏目，历史保留；项目页头没有任何工作台字眼',async()=>{
  const {page,close}=await launch();
  try{
    const read=()=>page.evaluate(async()=>{await window.PiPersistence.flush();const s=(await window.piDesktop.storage.load()).result.state;if(!s)return null;const t=s.projects.flatMap(p=>p.tasks).find(x=>x.id===s.activeTask);return {id:t.id,name:t.name,use:t.use||null,messages:t.messages.length}});
    // 先让项目里的聊天有一条历史，再打开工作台
    await page.locator('#message-input').fill('这是转换前的一条消息');await page.locator('#message-input').press('Enter');
    await expect.poll(async()=>(await read())?.messages).toBeGreaterThan(0);
    const before=await read();

    // 项目普通聊天：页头没有任何“工作台/工作流/开启/关闭”字样（侧栏一级菜单本身除外）
    const wording=()=>page.evaluate(()=>[...document.querySelectorAll('.main-header *, #page *')].filter(e=>!e.children.length&&!e.closest('.composer')).map(e=>(e.innerText||'').trim()+' '+(e.title||'')).filter(t=>/工作台|工作流|开启|关闭/.test(t)));
    expect(await wording()).toEqual([]);
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toHaveCount(0);
    await expect(page.locator('#workbench-section .task-row')).toHaveCount(0);

    // 打开使用 QUBO：当前聊天被转换（同一个任务，不新建），历史保留
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="qubo"]').click();
    await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    await expect(page.locator('#workbench-panel')).toBeVisible();
    // Opening paints immediately; verify the committed file state separately.
    await expect.poll(async()=>(await read())?.use?.workbenchId).toBe('qubo');
    const after=await read();
    expect(after.id).toBe(before.id);                                    // 同一个任务，没有新建
    expect(after.use?.workbenchId).toBe('qubo'); expect(after.use?.converted).toBe(true);
    expect(after.messages).toBeGreaterThanOrEqual(before.messages);      // 历史完整保留
    // 它离开项目、进入「工作台」栏目
    await expect(page.locator('#projects [data-action="select-task"][data-id="'+before.id+'"]')).toHaveCount(0);
    await expect(page.locator('#workbench-section [data-action="select-task"][data-id="'+before.id+'"]')).toHaveCount(1);
    // 工作台任务里才有面板开关
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toHaveCount(1);

    // 回到项目里其他普通聊天：依旧没有工作台字眼
    await page.locator('#projects [data-action="select-task"]').first().click();
    expect(await wording()).toEqual([]);
    await expect(page.locator('[data-action="toggle-task-workbench"]')).toHaveCount(0);
  }finally{await close();}
});

test('创建/修改任务在「工作台」栏目里有颜色徽标，使用任务没有',async()=>{
  const {page,close}=await launch();
  try{
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('#workbench-section .kind-badge.kind-create')).toHaveText('创建');
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="qubo"][data-mode="edit"]').click();
    await expect(page.locator('#workbench-section .kind-badge.kind-modify')).toHaveText('修改');
    const colors=await page.evaluate(()=>({c:getComputedStyle(document.querySelector('.kind-create')).backgroundColor,m:getComputedStyle(document.querySelector('.kind-modify')).backgroundColor}));
    expect(colors.c).not.toBe(colors.m);                                  // 两种颜色不同
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-use-workbench"][data-key="circuit"]').click();
    await page.locator('#use-task').selectOption('__new__');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    await expect(page.locator('#workbench-section .task-row').filter({hasText:'使用'}).locator('.kind-badge')).toHaveCount(0);
  }finally{await close();}
});

test('旧数据迁移：以前只写了 workbenchSession 的任务，启动后自动进入「工作台」栏目',async()=>{
  const {page,close}=await launch();
  try{
    await page.evaluate(()=>{window.dispatchEvent(new Event('x'));const K='pi-workbench-design-v2';
      // 构造旧版数据：任务只有 workbenchSession，没有 use/design 标记
      const st={schema:2,projects:[{id:'p',name:'旧项目',pinned:false,expanded:true,tasks:[{id:'old1',name:'旧的聊天',messages:[{id:'m',role:'user',text:'hi',time:1}],workbenches:{},workbenchHistory:[],workbenchAudit:[],draft:'',pending:null,updated:1,workbenchSession:{key:'qubo',mode:'use',target:'qubo',name:'QUBO 求解器',open:false,updatedAt:7}}]}],activeTask:'old1',settings:{interactive:true,approval:'ask',automaticRecovery:true,agentEnvironment:'auto',sort:'manual',composer:{}},deleted:[],plugins:[]};
      localStorage.setItem(K,JSON.stringify(st));});
    await page.reload();await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#workbench-section [data-action="select-task"][data-id="old1"]')).toHaveCount(1);
    await expect(page.locator('#projects [data-action="select-task"][data-id="old1"]')).toHaveCount(0);
    const task=await page.evaluate(()=>JSON.parse(localStorage.getItem('pi-workbench-design-v2')).projects[0].tasks[0]);
    expect(task.use.workbenchId).toBe('qubo'); expect(task.messages).toHaveLength(1);   // 内容没丢
  }finally{await close();}
});

test('消息操作：复制和编辑在气泡下方（不在气泡里），悬停才显示；编辑就在气泡里完成，不动底部输入框',async()=>{
  const {page,close}=await launch();
  try{
    const ask=async t=>{await page.locator('#message-input').fill(t);await page.locator('#composer').evaluate(f=>f.requestSubmit());};
    await ask('第一条消息');
    await expect(page.locator('.message.user')).toHaveCount(1);
    const user=page.locator('.message.user').first();
    // 控件在气泡外面、紧贴在下方
    const geo=await page.evaluate(()=>{const m=document.querySelector('.message.user'),b=m.querySelector('.user-bubble').getBoundingClientRect(),c=m.querySelector('.message-controls').getBoundingClientRect();return {inside:m.querySelector('.user-bubble').contains(m.querySelector('.message-controls')),below:c.top>=b.bottom-1&&c.top-b.bottom<24};});
    expect(geo.inside).toBe(false); expect(geo.below).toBe(true);
    // 没有文字标签，只有图标按钮（带无障碍名称）
    await expect(user.locator('[data-action="copy-message"]')).toHaveAttribute('aria-label','复制消息');
    await expect(user.locator('[data-action="edit-message"]')).toHaveAttribute('aria-label','编辑消息');
    expect((await user.locator('.message-controls').innerText()).trim()).toBe('');
    // 默认隐藏，悬停显示，键盘聚焦也显示
    await page.mouse.move(5,5);
    await expect.poll(()=>user.locator('.message-controls').evaluate(e=>getComputedStyle(e).opacity)).toBe('0');
    await user.hover();
    await expect.poll(()=>user.locator('.message-controls').evaluate(e=>getComputedStyle(e).opacity)).toBe('1');
    await page.mouse.move(5,5);await user.locator('[data-action="copy-message"]').focus();
    await expect.poll(()=>user.locator('.message-controls').evaluate(e=>getComputedStyle(e).opacity)).toBe('1');

    // 就地编辑：气泡变成编辑框，底部输入框保持空，没有“正在编辑”横幅
    await user.hover();await user.locator('[data-action="edit-message"]').click();
    await expect(page.locator('.message.user.editing #edit-input')).toBeFocused();
    await expect(page.locator('.message.user.editing #edit-input')).toHaveValue('第一条消息');
    await expect(page.locator('#message-input')).toHaveValue('');
    await expect(page.locator('.editing-banner')).toHaveCount(0);

    // Esc 取消：恢复成普通气泡，原文不变
    await page.keyboard.press('Escape');
    await expect(page.locator('.message.user.editing')).toHaveCount(0);
    await expect(page.locator('.message.user .message-text').first()).toHaveText('第一条消息');

    // 没改动就“发送”：提示无变化，不重发；清空后发送：提示不能为空，仍停留在编辑态
    await page.locator('.message.user').first().hover();await page.locator('[data-action="edit-message"]').click();
    await page.locator('#edit-form button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('没有变化');
    await expect(page.locator('.message.user.editing')).toHaveCount(0);
    await page.locator('.message.user').first().hover();await page.locator('[data-action="edit-message"]').click();
    await page.locator('#edit-input').fill('   ');await page.locator('#edit-form button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('不能为空');
    await expect(page.locator('.message.user.editing')).toHaveCount(1);

    // 改了内容再提交：这条及之后的消息被替换，以新文字重新发送
    await page.locator('#edit-input').fill('改过的第一条');
    await page.locator('#edit-input').press('Control+Enter');
    await expect(page.locator('.message.user.editing')).toHaveCount(0);
    await expect(page.locator('.message.user .message-text').first()).toHaveText('改过的第一条');
    await expect(page.locator('.message.user')).toHaveCount(1);                       // 没有出现重复的旧消息
    expect(await page.locator('.message.user .message-text',{hasText:'第一条消息'}).count()).toBe(0);
  }finally{await close();}
});

test('助手气泡下方也有复制按钮，且不在气泡内部',async()=>{
  const {page,close}=await launch();
  try{
    await page.locator('#message-input').fill('你好');await page.locator('#composer').evaluate(f=>f.requestSubmit());
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    const geo=await page.evaluate(()=>{const m=document.querySelector('.message.assistant'),b=m.querySelector('.assistant-bubble'),c=m.querySelector('.message-controls');return {exists:!!c,inside:!!b&&b.contains(c),below:!!c&&!!b&&c.getBoundingClientRect().top>=b.getBoundingClientRect().bottom-1};});
    expect(geo.exists).toBe(true); expect(geo.inside).toBe(false); expect(geo.below).toBe(true);
    await expect(page.locator('.message.assistant [data-action="edit-message"]')).toHaveCount(0);   // 助手消息不能编辑
  }finally{await close();}
});
