'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'..');test.use({video:'off'});
async function launch(){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-publication-')),exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const page=await app.firstWindow();await page.waitForLoadState('load');if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,960));
  return {app,page,profile,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}
const UI='<!doctype html><html><head><meta charset="utf-8"><script>const transport=window.__wbTransport;</script></head><body><h1>计数工作台</h1><button id="run">运行后端</button><pre id="out"></pre><script>document.querySelector("#run").onclick=async()=>{try{const r=await transport("updateState",{patch:{ran:true},baseRevision:window.__wbState?.revision||0});document.querySelector("#out").textContent=JSON.stringify(r)}catch(e){document.querySelector("#out").textContent="ERROR:"+e.message}};</script></body></html>';
async function design(fx){const {page}=fx;const dir=await page.evaluate(async()=>{const r=await window.piDesktop.workbench.scaffold({name:'计数工作台'});return r.result.path;});fs.writeFileSync(path.join(dir,'ui','index.html'),UI);
  require('./fixtures/workbench-ui.cjs').restoreOutput(dir);require('./fixtures/workbench-ui.cjs').scenario(dir);
  const file=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(file));m.server.entry='transport/stdio.cjs';fs.writeFileSync(file,JSON.stringify(m));
  await page.locator('[data-route="workbenches"]').click();await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
  await page.evaluate(async dir=>{await window.PiPersistence.flush();const key='pi-workbench-design-v2',s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workspacePath=dir;localStorage.setItem(key,JSON.stringify(s));},dir);await page.reload();await expect(page.locator('[data-action="toggle-trial"]')).toBeEnabled();return dir;
}
test('预览入口只跟随已开启的设计工作台，关闭、重载、切换任务后不残留，重开可试运行',async({},info)=>{
  const fx=await launch(),navigation=[];
  fx.page.on('framenavigated',frame=>navigation.push({type:'navigation',url:frame.url()}));
  fx.page.on('requestfailed',request=>navigation.push({type:'requestfailed',url:request.url(),failure:request.failure()}));
  try{
    const {page}=fx,errors=[];page.on('pageerror',e=>errors.push(e.message));
    await design(fx);
    const taskId=await page.evaluate(async()=>{await window.PiPersistence.flush();return (await window.piDesktop.storage.load()).result.state.activeTask;});
    const previewButton=page.locator('[data-action="open-preview-tab"]');
    const previewTab=page.locator('[data-action="select-side-tab"][data-tab="preview"]');
    const trialButton=page.locator('[data-action="toggle-trial"]');
    const toggle=page.locator('[data-action="toggle-task-workbench"]');
    const expectClosed=async()=>{
      await expect(toggle).toContainText('继续设计');
      await expect(previewButton).toHaveCount(0);await expect(previewTab).toHaveCount(0);await expect(trialButton).toHaveCount(0);
      await expect(page.locator('#workbench-panel')).toBeHidden();
      expect(await page.locator('#preview-frame').getAttribute('src')).toBeNull();
    };
    await expect(previewButton).toBeVisible();await expect(trialButton).toBeEnabled();
    await toggle.click();await expectClosed();
    await page.reload();await expectClosed();
    await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await expect(previewButton).toHaveCount(0);await expect(previewTab).toHaveCount(0);
    await page.locator('[data-action="select-task"][data-id="'+taskId+'"]').click();await expectClosed();
    await toggle.click();await expect(previewButton).toBeVisible();await expect(previewTab).toHaveAttribute('aria-selected','true');
    const frame=page.frameLocator('#preview-frame');await expect(frame.locator('.design-mode-switch')).toBeVisible();
    await trialButton.click();await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);
    await frame.locator('#run').click();await expect(frame.locator('#out')).toContainText('"revision":1');
    await page.locator('[data-action="close-side-tab"][data-tab="preview"]').click();
    await expectClosed();await toggle.click();await expect(frame.locator('.design-mode-switch')).toBeVisible();
    await expect(trialButton).toHaveText('试运行');
    await toggle.click();await expectClosed();
    expect(errors).toEqual([]);
  }finally{
    if(info.status!==info.expectedStatus){
      const preview=await fx.page.locator('#preview-frame').evaluate(frame=>({src:frame.getAttribute('src'),hidden:frame.hidden,ready:frame.contentDocument?.readyState,body:frame.contentDocument?.body?.innerText}));
      await info.attach('preview-navigation.json',{body:JSON.stringify({navigation,preview},null,2),contentType:'application/json'});
    }
    await fx.close();
  }
});

test('设计工程尚未创建时禁用试运行，创建完成后预览中的控件自动启用',async()=>{
  const fx=await launch();try{
    const {page}=fx;
    await expect(page.locator('[data-action="open-preview-tab"]')).toHaveCount(0);
    await page.locator('[data-route="workbenches"]').click();
    await page.locator('[data-action="open-workbench"][data-key="builder"]').click();
    await expect(page.locator('[data-action="open-preview-tab"]')).toBeVisible();
    await expect(page.locator('[data-action="select-side-tab"][data-tab="preview"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-trial"]')).toBeDisabled();
    await expect(page.locator('#preview-empty')).toContainText('还没有设计工程');
    await fx.app.evaluate(({ipcMain})=>{
      const handler=ipcMain._invokeHandlers.get('workbench:scaffold');
      globalThis.__previewScaffoldPending=false;
      ipcMain._invokeHandlers.set('workbench:scaffold',async(...args)=>{
        globalThis.__previewScaffoldPending=true;
        await new Promise(resolve=>{globalThis.__releasePreviewScaffold=resolve;});
        return handler(...args);
      });
    });
    await page.locator('[data-action="select-side-tab"][data-tab="workbench"]').click();
    await page.frameLocator('#module-frame').locator('#create-project').click();
    await expect.poll(()=>fx.app.evaluate(()=>globalThis.__previewScaffoldPending)).toBe(true);
    await page.locator('[data-action="open-preview-tab"]').click();
    await expect(page.locator('[data-action="toggle-trial"]')).toBeDisabled();
    await fx.app.evaluate(()=>globalThis.__releasePreviewScaffold());
    await expect(page.locator('[data-action="toggle-trial"]')).toBeEnabled();
    const frame=page.frameLocator('#preview-frame');await expect(frame.locator('.design-mode-switch')).toBeVisible();
    await page.locator('[data-action="toggle-trial"]').click();await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);
    await expect(page.locator('[data-action="toggle-trial"]')).toHaveText('停止试运行');
  }finally{await fx.close();}
});

test('设计可试运行真实后端，返回布局；发布登记、目录打开、重启恢复和设计副本',async({},info)=>{
  const fx=await launch();try{const {page}=fx,errors=[];page.on('pageerror',e=>errors.push(e.message));const dir=await design(fx);
    await expect(page.locator('[data-action="toggle-trial"]')).toHaveText('试运行');await page.locator('[data-action="toggle-trial"]').click();
    await expect(page.locator('[data-action="toggle-trial"]')).toHaveText('停止试运行');const frame=page.frameLocator('#preview-frame');await frame.locator('#run').click();await expect(frame.locator('#out')).toContainText('"revision":1');
    await expect(frame.locator('.design-mode-switch')).toHaveCount(0);await page.screenshot({path:info.outputPath('trial-run.png')});
    await page.locator('[data-action="toggle-trial"]').click();await expect(frame.locator('.design-mode-switch')).toBeVisible();
    const verified=await page.evaluate(path=>window.piDesktop.workbench.verify({path}),dir);expect(verified.ok,JSON.stringify(verified)).toBe(true);const pub=await page.evaluate(dir=>window.piDesktop.workbench.publish({path:dir}),dir);expect(pub.ok,pub.error).toBe(true);expect(pub.result.path).not.toBe(dir);
    expect(JSON.parse(fs.readFileSync(path.join(pub.result.path,'manifest.json'))).server.entry).toBe('index.cjs');expect(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))).server.entry).toBe('transport/stdio.cjs');
    await page.reload();await page.locator('[data-route="workbenches"]').click();const card=page.locator('.workbench-card').filter({has:page.locator('h2',{hasText:'计数工作台'})});await expect(card).toHaveCount(1);
    await card.locator('[data-action="open-use-workbench"]').click();await page.locator('#use-project').selectOption('embedded');await page.locator('#use-task').selectOption('__new__');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());
    const run=page.frameLocator('#module-frame');await expect(run.locator('#run')).toBeVisible();await run.locator('#run').click();await expect(run.locator('#out')).toContainText('"revision":1');
    await run.locator('#run').click();await expect(run.locator('#out')).toContainText('"revision":2');await page.reload();await expect(run.locator('#run')).toBeVisible();await run.locator('#run').click();await expect(run.locator('#out')).toContainText('"revision":3');
    await page.locator('[data-route="workbenches"]').click();await card.locator('[data-action="open-workbench"]').click();await page.waitForFunction(()=>document.querySelector('#breadcrumb').textContent.includes('修改设计')||document.querySelector('#toast').textContent.includes('无法打开设计副本'));await expect(page.locator('#breadcrumb'),await page.locator('#toast').textContent()).toContainText('修改设计 · 计数工作台');
    await expect(page.frameLocator('#preview-frame').locator('.design-mode-switch')).toBeVisible();expect(errors).toEqual([]);
  }finally{await fx.close();}
});
test('兼容恢复已完成但未登记的设计，按源码名称进入工作台目录',async()=>{
  const fx=await launch();try{const {page}=fx;await design(fx);await page.evaluate(async()=>{await window.PiPersistence.flush();const key='pi-workbench-design-v2',s=(await window.piDesktop.storage.load()).result.state,t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.design.workflow.status='complete';t.design.workflow.stage=5;t.design.completed=true;t.workbenches.builder={name:'未命名工作台'};localStorage.setItem(key,JSON.stringify(s));});await page.reload();
    await expect(page.locator('[data-action="run-published-workbench"]')).toBeVisible({timeout:60000});await page.locator('[data-action="run-published-workbench"]').click();await page.locator('#use-task').selectOption('__new__');await page.locator('#dialog-form').evaluate(f=>f.requestSubmit());await page.frameLocator('#module-frame').locator('#run').click();await expect(page.frameLocator('#module-frame').locator('#out')).toContainText('"revision":1');
    await expect(page.locator('[data-action="open-preview-tab"]')).toHaveCount(0);
    await expect(page.locator('[data-action="select-side-tab"][data-tab="preview"]')).toHaveCount(0);
    await expect(page.locator('[data-action="toggle-trial"]')).toHaveCount(0);
    await page.locator('[data-route="workbenches"]').click();await expect(page.locator('.workbench-card h2',{hasText:'计数工作台'})).toHaveCount(1);
    expect((await page.evaluate(()=>window.piDesktop.workbench.list())).entries).toHaveLength(1);
  }finally{await fx.close();}
});
test('注册式工作台在试运行中自动挂载，收到完整状态与事件信封',async()=>{
  const fx=await launch();try{const {page}=fx,dir=await design(fx),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    fs.writeFileSync(path.join(dir,'ui','index.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app"></main><script>window.PiWorkbenchModules={"'+manifest.id+'":{mount(root,ctx){root.innerHTML=\'<button id="save">保存</button><pre id="state"></pre>\';document.querySelector("#save").onclick=async()=>{const read=await ctx.server("readState",{});const r=await ctx.server("updateState",{baseRevision:read.state.revision,patch:{saved:true}});document.querySelector("#state").textContent=JSON.stringify({state:r.state,event:r.events[0].type});};return {sync(){}};}}};window.dispatchEvent(new Event("pi-workbench-module-loaded"));</script></body></html>');
    await page.locator('[data-action="toggle-trial"]').click();const frame=page.frameLocator('#preview-frame');await frame.locator('#save').click();await expect(frame.locator('#state')).toContainText('"saved":true');await expect(frame.locator('#state')).toContainText('state.updated');
    expect(await frame.locator('#save').evaluate(()=>typeof window.piDesktop)).toBe('undefined');
  }finally{await fx.close();}
});


test('JS 模块运行入口：异步挂载拿到恢复状态，结构化错误在界面可见',async({},info)=>{
  const fx=await launch();try{
    const {page}=fx,dir=await design(fx),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    const diagnostics=[];page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text());});page.on('pageerror',e=>diagnostics.push(e.message));
    manifest.ui.entry='module.js';manifest.ui.style='module.css';fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir,'ui','module.css'),'#app { background: rgb(240, 230, 220); }');
    fs.writeFileSync(path.join(dir,'ui','module.js'),`window.PiWorkbenchModules[${JSON.stringify(manifest.id)}]={async mount(root,ctx){
      await new Promise(r=>setTimeout(r,80));root.innerHTML='<h1>'+ctx.esc('模块工作台')+'</h1><button id="fail">测试失败</button><pre id="out"></pre><pre id="state"></pre>';
      document.querySelector('#fail').onclick=async()=>{try{await ctx.server('readState',{})}catch(e){document.querySelector('#out').textContent=e.code+':'+e.message;}};
      return {sync(s){document.querySelector('#state').textContent=JSON.stringify(s);}};
    }};`);
    fs.writeFileSync(path.join(dir,'server','index.cjs'),`module.exports={dispatch:async()=>({ok:false,error:{code:'TEST_FAILURE',message:'测试设备连接失败'}})};`);
    await page.locator('[data-action="toggle-trial"]').click();const frame=page.frameLocator('#preview-frame');
    try{await expect(frame.locator('h1')).toHaveText('模块工作台');}catch(error){
      const detail={diagnostics,src:await page.locator('#preview-frame').getAttribute('src'),frames:await Promise.all(page.frames().map(async f=>({url:f.url(),html:await f.locator('body').innerHTML().catch(()=>''),runtime:await f.evaluate(()=>({config:window.__piRuntime,modules:Object.keys(window.PiWorkbenchModules||{})})).catch(()=>null)})))};
      await info.attach('runtime-diagnostics',{body:JSON.stringify(detail,null,2),contentType:'application/json'});throw error;
    }await expect(frame.locator('#app')).toHaveCSS('background-color','rgb(240, 230, 220)');
    await frame.locator('#fail').click();await expect(frame.locator('#out')).toHaveText('TEST_FAILURE:测试设备连接失败');
    const pub={result:{id:'module-fixture',path:dir,name:'模块工作台'}};
    await page.evaluate(entry=>{
      const key='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(key)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
      delete t.design;t.use={workbenchId:entry.id};t.workbenchSession={key:entry.id,mode:'use',sourcePath:entry.path,name:entry.name,open:true};t.workbenches[entry.id]={revision:8,kept:true};localStorage.setItem(key,JSON.stringify(s));
    },pub.result);await page.reload();
    const run=page.frameLocator('#module-frame');await expect(run.locator('#state')).toContainText('"kept":true');await run.locator('#fail').click();await expect(run.locator('#out')).toContainText('TEST_FAILURE');
    expect(await run.locator('body').evaluate(()=>typeof window.piDesktop)).toBe('undefined');
  }finally{await fx.close();}
});

test('工作台实时事件经独立后端进入沙箱界面，返回布局后结束会话，重开可再次运行',async({},info)=>{
  const fx=await launch();let dir;try{
    const {page}=fx;dir=await design(fx);
    await page.evaluate(()=>{window.__runtimeEvents=[];window.piDesktop.workbench.onEvent(event=>window.__runtimeEvents.push(event));});
    fs.writeFileSync(path.join(dir,'ui','index.html'),`<!doctype html><html><body><button id="start">运行</button><pre id="events"></pre><script>
      window.__wbOnEvent(ev=>document.querySelector('#events').textContent+=ev.payload.text+'\n');
      document.querySelector('#start').onclick=async()=>{try{await window.__wbTransport('readState');document.querySelector('#start').dataset.result='ok'}catch(error){document.querySelector('#events').textContent=error.message}};
    </script></body></html>`.replace("+'\n'","+'\\n'"));
    fs.writeFileSync(path.join(dir,'server','index.cjs'),`const fs=require('node:fs'),path=require('node:path');const log=value=>fs.appendFileSync(path.join(__dirname,'events.log'),value+'\\n');module.exports={dispatch:()=>{throw new Error('未使用会话')},createSession:()=>{
      log('open');let listener,timer;return {onEvent(fn){listener=fn;return ()=>listener=null},async call(){log('call');timer=setTimeout(()=>{log('event:'+Boolean(listener));listener?.({type:'terminal.data',payload:{text:'后端实时输出'}})},150);return {result:{started:true}}},close(){log('close');clearTimeout(timer);fs.writeFileSync(path.join(__dirname,'closed'),'closed')}};
    }};`);
    await page.locator('[data-action="toggle-trial"]').click();const frame=page.frameLocator('#preview-frame');
    await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);await frame.locator('#start').click();await expect(frame.locator('#events')).toHaveText('后端实时输出\n');
    await page.locator('[data-action="toggle-trial"]').click();await expect.poll(()=>fs.existsSync(path.join(dir,'server','closed'))).toBe(true);
    await page.locator('[data-action="toggle-trial"]').click();await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);await frame.locator('#start').click();await expect(frame.locator('#events')).toHaveText('后端实时输出\n');
    expect(await frame.locator('body').evaluate(()=>typeof window.piDesktop)).toBe('undefined');
  }catch(error){const diagnostic={backend:dir&&fs.existsSync(path.join(dir,'server/events.log'))?fs.readFileSync(path.join(dir,'server/events.log'),'utf8'):'',events:await fx.page.evaluate(()=>window.__runtimeEvents),frame:await fx.page.frameLocator('#preview-frame').locator('body').evaluate(()=>({url:location.href,result:document.querySelector('#start')?.dataset.result,script:typeof window.__wbTransport,html:document.body.innerHTML})).catch(()=>null)};await info.attach('event-diagnostics',{body:JSON.stringify(diagnostic,null,2),contentType:'application/json'});throw error;}finally{await fx.close();}
});

test('运行页面等待交互脚本与初始状态就绪后才接受点击，恢复状态不会漏发',async()=>{
  const fx=await launch();try{
    const {page}=fx,dir=await design(fx);
    const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
    fs.writeFileSync(path.join(dir,'ui/index.html'),`<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app"></main><script>window.PiWorkbenchModules[${JSON.stringify(manifest.id)}]={async mount(root){root.innerHTML='<button id="ready-run">运行</button><pre id="restore"></pre><pre id="answer"></pre>';await new Promise(resolve=>setTimeout(resolve,700));window.addEventListener('workbench-state',e=>document.querySelector('#restore').textContent=JSON.stringify(e.detail));document.querySelector('#ready-run').onclick=async()=>{const r=await window.__wbTransport('readState');document.querySelector('#answer').textContent=JSON.stringify(r.state);};return {sync(){}};}};</script></body></html>`);
    await page.evaluate(()=>{const k='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(k)),t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.workbenches['trial:'+t.id]={revision:7,data:{kept:'恢复标记'}};localStorage.setItem(k,JSON.stringify(s));});await page.reload();
    await expect(page.locator('[data-action="toggle-trial"]')).toBeEnabled();
    await page.locator('[data-action="toggle-trial"]').click();const frame=page.frameLocator('#preview-frame');
    await expect(frame.locator('#ready-run')).toBeVisible();await frame.locator('#ready-run').click();
    await expect(frame.locator('#restore')).toContainText('恢复标记');await expect(frame.locator('#answer')).toContainText('恢复标记');
  }finally{await fx.close();}
});

test('试运行切换期间旧预览不可交互，就绪后显示新页面',async()=>{
  const fx=await launch();try{
    const {page}=fx;await design(fx);await expect(page.frameLocator('#preview-frame').locator('.design-mode-switch')).toBeVisible();
    await fx.app.evaluate(({ipcMain})=>{const handler=ipcMain._invokeHandlers.get('workbench:runtime-url');ipcMain._invokeHandlers.set('workbench:runtime-url',async(...args)=>{await new Promise(resolve=>{globalThis.__releaseRuntimeStart=resolve;});return handler(...args);});});
    await page.locator('[data-action="toggle-trial"]').click();await expect(page.locator('#preview-frame')).toBeHidden();await expect(page.locator('#preview-empty')).toHaveText('正在启动试运行…');
    await fx.app.evaluate(()=>globalThis.__releaseRuntimeStart());const frame=page.frameLocator('#preview-frame');await expect(frame.locator('html')).toHaveAttribute('data-pi-runtime-ready','true');await frame.locator('#run').click();await expect(frame.locator('#out')).toContainText('"revision":1');
  }finally{await fx.close();}
});

test('迟到的布局预览响应不能覆盖已经打开的试运行页面',async()=>{
  const fx=await launch();try{
    const {page}=fx;await design(fx);
    await fx.app.evaluate(({ipcMain})=>{const handler=ipcMain._invokeHandlers.get('workbench:preview');ipcMain._invokeHandlers.set('workbench:preview',async(...args)=>{const result=await handler(...args);await new Promise(r=>setTimeout(r,600));return result;});});
    await page.locator('[data-action="open-preview-tab"]').click();await page.locator('[data-action="toggle-trial"]').click();
    const frame=page.frameLocator('#preview-frame');await expect(frame.locator('script[data-pi-runtime]')).toHaveCount(1);await frame.locator('#run').click();await expect(frame.locator('#out')).toContainText('"revision":1');
    await page.waitForTimeout(800);await expect(frame.locator('.design-mode-switch')).toHaveCount(0);await expect(frame.locator('#out')).toContainText('"revision":1');
  }finally{await fx.close();}
});

test('继续设计不等待已关闭页面的预览请求，迟到的失败不会遮住新画布',async()=>{
  const fx=await launch();try{
    const {page,app}=fx;await design(fx);await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('计数工作台');
    await app.evaluate(({ipcMain})=>{const handler=ipcMain._invokeHandlers.get('workbench:preview');let held=false;globalThis.__previewCalls=0;ipcMain._invokeHandlers.set('workbench:preview',async(...args)=>{globalThis.__previewCalls++;if(!held){held=true;await new Promise(r=>globalThis.__releaseOldPreview=r);return {ok:false,error:'旧页面的迟到错误'};}return handler(...args);});});
    await page.locator('[data-action="open-preview-tab"]').click();
    await expect.poll(()=>app.evaluate(()=>typeof globalThis.__releaseOldPreview)).toBe('function');
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await page.locator('[data-action="toggle-task-workbench"]').click();
    await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('计数工作台');
    expect(await app.evaluate(()=>globalThis.__previewCalls)).toBeGreaterThanOrEqual(2);
    await app.evaluate(()=>globalThis.__releaseOldPreview());await page.waitForTimeout(100);
    await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('计数工作台');await expect(page.locator('#preview-empty')).toBeHidden();
  }finally{await fx.close();}
});
