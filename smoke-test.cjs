'use strict';

const assert = require('node:assert/strict');

const endpoint = process.env.PI_WORKBENCH_CDP || 'http://127.0.0.1:9339';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      } else {
        this.events.push(message);
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      value = await this.eval(expression);
      if (value) return value;
      await pause(100);
    }
    throw new Error(`等待超时：${label}; last=${JSON.stringify(value)}`);
  }

  close() { this.ws?.close(); }
}

async function main() {
  const pages = await fetch(endpoint + '/json').then(response => response.json());
  const page = pages.find(item => item.type === 'page' && (
    item.url.includes('pi-workbench-prototype/index.html') ||
    item.url.includes('/app.asar/index.html') ||
    item.title.startsWith('Pi Workbench')
  ));
  assert(page, '没有找到 Pi Workbench 调试页面');
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  const checks = [];
  const check = (name, detail = '') => checks.push({ name, detail });

  try {
    await cdp.connect();
    await cdp.eval(`localStorage.clear(); location.reload(); true`);
    await cdp.waitFor(`document.readyState === 'complete' && !!document.querySelector('#projects .project-group')`, '主页面初始化');
    // Log.enable may replay entries emitted before this isolated test run. From
    // this point onward, every collected event belongs to the smoke scenario.
    cdp.events.length = 0;

    const initial = await cdp.eval(`({
      title: document.title,
      desktop: window.piDesktop?.isDesktop === true,
      projects: document.querySelectorAll('#projects .project-group').length,
      projectButtons: [...document.querySelectorAll('.project-row .icon-button')].every(x => x.getBoundingClientRect().width > 0 && getComputedStyle(x).opacity === '1'),
      trustedBuiltinFrame: !document.querySelector('#module-frame').hasAttribute('sandbox'),
      context: window.PiContextManager?.snapshot()
    })`);
    assert.equal(initial.desktop, true);
    assert(initial.projects >= 2);
    assert.equal(initial.projectButtons, true);
    assert.equal(initial.trustedBuiltinFrame, true);
    assert.equal(initial.context.workbench, null);
    check('桌面壳与显式项目控件', `${initial.projects} 个初始项目`);

    assert.equal(await cdp.eval(`!!document.querySelector('#composer-model') && document.querySelector('#approval-mode').value==='ask' && document.querySelector('[data-action="toggle-interactive"]').getAttribute('aria-pressed')==='true'`),true);
    await cdp.eval(`{const s=document.querySelector('#approval-mode');s.value='full';s.dispatchEvent(new Event('change'));} document.querySelector('[data-action="toggle-interactive"]').click();true`);
    assert.equal(await cdp.eval(`document.querySelector('#approval-mode').value==='full' && document.querySelector('[data-action="toggle-interactive"]').getAttribute('aria-pressed')==='false'`),true);
    await cdp.eval(`{const s=document.querySelector('#approval-mode');s.value='ask';s.dispatchEvent(new Event('change'));} document.querySelector('[data-action="toggle-interactive"]').click();true`);
    await cdp.eval(`{const dt=new DataTransfer();dt.items.add(new File(['attachment smoke test'],'notes.txt',{type:'text/plain'}));const input=document.querySelector('#attachment-input');input.files=dt.files;input.dispatchEvent(new Event('change'));}true`);
    await cdp.waitFor(`document.querySelector('#composer .attachment-chip')?.textContent.includes('notes.txt')`,'附件读取与显示');
    await cdp.eval(`document.querySelector('[data-action="remove-attachment"]').click();true`);
    assert.equal(await cdp.eval(`document.querySelectorAll('#composer .attachment-chip').length`),0);
    check('输入区控件与附件', '模型入口、批准切换、交互开关、文本附件添加和移除');

    await cdp.eval(`document.querySelector('[data-action="new-project"]').click(); true`);
    await cdp.waitFor(`document.querySelector('#dialog')?.open === true`, '新建项目对话框');
    await cdp.eval(`document.querySelector('#entity-name').value='烟雾测试项目'; document.querySelector('#dialog-form').requestSubmit(); true`);
    await cdp.waitFor(`[...document.querySelectorAll('.project-toggle span')].some(x => x.textContent === '烟雾测试项目')`, '项目创建');
    await cdp.eval(`{ const group=[...document.querySelectorAll('.project-group')].find(x=>x.textContent.includes('烟雾测试项目')); group.querySelector('[data-action="new-task"]').click(); } true`);
    await cdp.waitFor(`document.querySelector('#dialog')?.open === true`, '新建任务对话框');
    await cdp.eval(`document.querySelector('#entity-name').value='桥接测试任务'; document.querySelector('#dialog-form').requestSubmit(); true`);
    await cdp.waitFor(`[...document.querySelectorAll('.task-select span')].some(x => x.textContent === '桥接测试任务')`, '任务创建');
    check('项目与任务创建', '创建成功且关键控件始终可见');

    await cdp.eval(`document.querySelector('[data-route="workbenches"]').click(); true`);
    await cdp.waitFor(`document.querySelectorAll('.workbench-card').length === 4 && !!document.querySelector('[data-key="builder"]')`, '工作台目录与创建入口');
    await cdp.eval(`document.querySelector('[data-action="open-workbench"][data-key="builder"]').click(); true`);
    await cdp.waitFor(`!document.querySelector('#workbench-panel').hidden && document.querySelector('#workbench-title').textContent==='创建工作台'`, '工作台设计页面');
    await cdp.eval(`document.querySelector('[data-action="close-side-tab"][data-tab="workbench"]').click(); true`);
    await cdp.waitFor(`document.querySelector('#workbench-panel').hidden`, '关闭设计工作台');
    await cdp.eval(`document.querySelector('[data-route="workbenches"]').click();document.querySelector('[data-action="open-use-workbench"][data-key="mcu"]').click();{const pick=(sel,label)=>{const o=[...sel.options].find(x=>x.textContent===label);sel.value=o.value;sel.dispatchEvent(new Event('change',{bubbles:true}));};pick(document.querySelector('#use-project'),'烟雾测试项目');pick(document.querySelector('#use-task'),'桥接测试任务');}document.querySelector('#dialog-form').requestSubmit();true`);
    await cdp.waitFor(`(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));return s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask)?.workbenches.mcu?.status==='draft'})()`, 'MCU 空白草稿挂载');
    await cdp.waitFor(`(()=>{const f=document.querySelector('#module-frame');return f?.contentWindow?.document?.readyState==='complete'&&!!f.contentWindow.PiWorkbenchModules?.mcu})()`, 'MCU 工作台模块载入');
    assert.equal(await cdp.eval(`document.querySelector('#module-frame').contentWindow.document.querySelector('#host').innerHTML`), '');
    assert.equal(await cdp.eval(`window.PiContextManager.snapshot().workbench`), 'mcu');
    await cdp.eval(`(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));const t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);const revision=Number(t?.workbenches?.mcu?.revision||0);document.querySelector('#module-frame').contentWindow.postMessage({source:'pi-workbench-shell',key:'mcu',type:'invoke',command:'setDraftHTML',payload:{html:'<h1>当前设计</h1>',baseRevision:revision}},'*');return true})()`);
    await cdp.waitFor(`document.querySelector('#module-frame').contentWindow.document.querySelector('#host iframe')?.srcdoc.includes('当前设计')`, 'MCU 真实草稿预览');
    await cdp.eval(`document.querySelector('[data-action="close-side-tab"][data-tab="workbench"]').click();document.querySelector('[data-route="workbenches"]').click();document.querySelector('[data-action="open-use-workbench"][data-key="mcu"]').click();document.querySelector('#dialog-form').requestSubmit();true`);
    await cdp.waitFor(`document.querySelector('#module-frame').contentWindow.document.querySelector('#host iframe')?.srcdoc.includes('当前设计')`, '重新打开恢复草稿');
    await cdp.eval(`document.querySelector('[data-action="close-side-tab"][data-tab="workbench"]').click();true`);
    await cdp.waitFor(`document.querySelector('#workbench-panel').hidden && window.PiContextManager.snapshot().workbench===null`, '关闭 MCU 卸载上下文');
    check('设计中的工作台', '空白状态不显示加载占位；已有内容直接预览，关闭再打开保留草稿');
    await cdp.eval(`document.querySelector('[data-action="open-use-workbench"][data-key="qubo"]').click();document.querySelector('#dialog-form').requestSubmit(); true`);
    await cdp.waitFor(`!document.querySelector('#workbench-panel').hidden && window.PiContextManager?.snapshot().workbench === 'qubo'`, 'QUBO 工作台与上下文');
    await cdp.waitFor(`document.querySelector('#module-frame').contentWindow && document.querySelector('#module-frame').src.includes('key=qubo')`, 'QUBO iframe');
    await pause(600);
    await cdp.eval(`document.querySelector('#module-frame').contentWindow.postMessage({source:'pi-workbench-shell',key:'qubo',type:'invoke',command:'solve',payload:{},requestId:'smoke-qubo'},'*'); true`);
    const qubo = await cdp.waitFor(`(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2')); const p=s.projects.find(p=>p.tasks.some(t=>t.name==='桥接测试任务')); const t=p?.tasks.find(t=>t.name==='桥接测试任务'); return t?.workbenches?.qubo?.result || null})()`, 'QUBO 本地求解');
    assert.match(qubo.bits, /^[01]{4}$/);
    check('QUBO 本地工作台', `最优解 ${qubo.bits}，能量 ${qubo.energy}`);

    await cdp.eval(`document.querySelector('[data-action="close-side-tab"][data-tab="workbench"]').click(); true`);
    await cdp.waitFor(`document.querySelector('#workbench-panel').hidden && window.PiContextManager?.snapshot().workbench === null`, '关闭工作台卸载上下文');
    await cdp.eval(`document.querySelector('[data-route="workbenches"]').click(); document.querySelector('[data-action="open-use-workbench"][data-key="circuit"]').click();document.querySelector('#dialog-form').requestSubmit(); true`);
    await cdp.waitFor(`window.PiContextManager?.snapshot().workbench === 'circuit'`, '量子电路上下文');
    await pause(600);
    await cdp.eval(`document.querySelector('#module-frame').contentWindow.postMessage({source:'pi-workbench-shell',key:'circuit',type:'invoke',command:'applyPreset',payload:{kind:'bell'},requestId:'smoke-circuit'},'*'); true`);
    const circuit = await cdp.waitFor(`(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2')); const p=s.projects.find(p=>p.tasks.some(t=>t.name==='桥接测试任务')); const t=p?.tasks.find(t=>t.name==='桥接测试任务'); const w=t?.workbenches?.circuit; return w?.gates?.length===2 ? w : null})()`, 'Bell 电路预设');
    assert.equal(circuit.qubits, 2);
    await cdp.eval(`document.querySelector('#module-frame').contentWindow.postMessage({source:'pi-workbench-shell',key:'circuit',type:'invoke',command:'runSimulation',payload:{},requestId:'smoke-run'},'*'); true`);
    await cdp.waitFor(`(()=>{const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2')); const p=s.projects.find(p=>p.tasks.some(t=>t.name==='桥接测试任务')); const t=p?.tasks.find(t=>t.name==='桥接测试任务'); return !!t?.workbenches?.circuit?.simulation})()`, '量子电路本地模拟');
    check('量子电路工作台', 'Bell 预设与本地模拟成功');

    await cdp.eval(`document.querySelector('[data-route="plugins"]').click(); true`);
    await cdp.waitFor(`!!document.querySelector('[data-action="toggle-plugin"]')`, '插件页面');
    assert.equal(await cdp.eval(`document.querySelectorAll('.plugin-row').length>=1 &&!/规划中|未实现|GPU 计算连接|浏览器控制/.test(document.querySelector('#page').innerText) && !document.querySelector('.plugin-row button:disabled')`),true);
    await cdp.eval(`document.querySelector('[data-action="toggle-plugin"]').click(); true`);
    await cdp.waitFor(`window.PiContextManager?.snapshot().plugins.includes('task-context')`, '插件上下文载入');
    check('插件按需载入', 'task-context 已加入当前上下文');

    await cdp.eval(`document.querySelector('[data-route="search"]').click(); true`);
    await cdp.eval(`{const x=document.querySelector('#search-query');x.value='桥接测试任务';x.dispatchEvent(new Event('input',{bubbles:true}));} true`);
    const searchCount = await cdp.waitFor(`document.querySelectorAll('.search-result').length`, '搜索任务');
    assert.equal(searchCount, 1);
    check('搜索对话', '精确命中测试任务');

    await cdp.eval(`document.querySelector('[data-route="settings"]').click(); true`);
    await cdp.waitFor(`!!document.querySelector('#provider-form') && !!document.querySelector('#interactive-toggle')`, '设置页面');
    const settings = await cdp.eval(`({provider:document.querySelector('#provider-kind').value, toggle:document.querySelector('#interactive-toggle').checked, keyType:document.querySelector('#provider-key').type})`);
    assert.equal(settings.keyType, 'password');
    assert.equal(settings.toggle, true);
    check('模型设置与安全输入', `默认服务 ${settings.provider}，Key 为密码框`);

    const errors = cdp.events.filter(event =>
      event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params.entry.level))
    ).map(event => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text || event.params.entry?.text || 'unknown');
    assert.deepEqual(errors, [], `页面控制台存在错误：${errors.join(' | ')}`);
    check('运行时控制台', '无 JavaScript 异常或 CSP 错误');

    process.stdout.write(JSON.stringify({ ok: true, checks }, null, 2) + '\n');
  } catch (error) {
    const diagnostics = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded').map(event => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text || event.params.entry?.text || event.method);
    const frameTree = await cdp.send('Page.getFrameTree').catch(() => null);
    const contexts = cdp.events.filter(event => event.method === 'Runtime.executionContextCreated').map(event => event.params.context);
    const childFrame = frameTree?.frameTree?.childFrames?.[0]?.frame;
    const childContext = [...contexts].reverse().find(context => context.auxData?.isDefault && context.auxData?.frameId === childFrame?.id);
    let frameState = null;
    if (childContext) {
      const result = await cdp.send('Runtime.evaluate', { expression: `({ready:document.readyState,text:document.body?.innerText,modules:Object.keys(window.PiWorkbenchModules||{}),url:location.href})`, contextId: childContext.id, returnByValue: true }).catch(() => null);
      frameState = result?.result?.value || result?.exceptionDetails?.text || null;
    }
    if (!frameState) {
      const targets = await fetch(endpoint + '/json').then(response => response.json()).catch(() => []);
      const iframeTarget = targets.find(target => target.type === 'iframe' && target.url.includes('/workbenches/frame.html'));
      if (iframeTarget) {
        const iframeCdp = new CdpClient(iframeTarget.webSocketDebuggerUrl);
        await iframeCdp.connect();
        frameState = await iframeCdp.eval(`({ready:document.readyState,text:document.body?.innerText,modules:Object.keys(window.PiWorkbenchModules||{}),url:location.href})`).catch(innerError => ({ error: innerError.message }));
        diagnostics.push(...iframeCdp.events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded').map(event => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text || event.params.entry?.text || event.method));
        iframeCdp.close();
      }
    }
    error.message += '\n浏览器诊断：' + JSON.stringify({ diagnostics, childFrame, frameState });
    throw error;
  } finally {
    cdp.close();
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2) + '\n');
  process.exitCode = 1;
});
