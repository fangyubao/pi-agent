'use strict';
// 运行态工作台只通过宿主消息调用后端，不接触 Electron 或桌面文件系统。
(() => {
  const diagnostics = [];
  window.__piRuntimeDiagnostics = diagnostics;
  const diagnostic = entry => { diagnostics.push({ ...entry, time: Date.now() }); if (diagnostics.length > 60) diagnostics.shift(); };
  window.addEventListener('error', event => diagnostic({ type: event.target === window ? 'script' : 'resource', message: event.message || '资源加载失败', file: event.filename || event.target?.src || event.target?.href || '', line: event.lineno || 0 }), true);
  window.addEventListener('unhandledrejection', event => diagnostic({ type: 'promise', message: String(event.reason?.message || event.reason), stack: String(event.reason?.stack || '').slice(0, 3000) }));
  const originalError = console.error;
  console.error = (...args) => { diagnostic({ type: 'console', message: args.map(x => String(x?.message || x)).join(' ').slice(0, 3000) }); originalError.apply(console, args); };
  const pending = new Map();
  let controller=null,mounting=false,pageReady=false;
  // Parsed controls can appear before their handlers or restored state exist.
  // Keep the page non-interactive until both the UI and host state are ready.
  const pageRoot=document.documentElement;
  const originalInert=pageRoot.inert;
  pageRoot.inert=true;pageRoot.setAttribute('aria-busy','true');
  const bufferedEvents=[];
  window.PiWorkbenchHosted=true;
  window.PiWorkbenchModules ||= Object.create(null);
  const eventListeners=new Set(), pendingInvokes=new Map();
  window.__wbOnEvent=callback=>{
    if(typeof callback!=='function')throw new TypeError('事件监听器必须是函数');
    eventListeners.add(callback);return ()=>eventListeners.delete(callback);
  };
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const send = message => parent.postMessage({ source: 'pi-workbench-runtime', ...message }, '*');
  function dispatchEvent(event){
    for(const callback of eventListeners){try{callback(event);}catch(error){console.error('工作台事件处理失败',error);}}
    window.dispatchEvent(new CustomEvent('workbench-event',{detail:event}));
  }
  function uiReady(){pageReady=true;send({type:'ready'});}
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='o'){
      event.preventDefault();send({type:'open-source'});
    }
  });
  const request = (type, action, payload = {}) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); window.__piRuntimePending=pending.size; reject(new Error('工作台后端请求超时')); }, 60000);
    pending.set(requestId, { resolve, reject, timer });
    window.__piRuntimePending=pending.size;
    try{send({ type, requestId, action, operation:action, payload });}catch(error){clearTimeout(timer);pending.delete(requestId);reject(error);}
  });
  window.__wbTransport=(action,payload={})=>request('server-request',action,payload);
  const jobRequest=payload=>request('host-request','jobs',payload).then(envelope=>envelope.result);
  window.__wbJobs=Object.freeze({start:(action,payload={},options={})=>jobRequest({...options,operation:'start',action,payload}),list:()=>jobRequest({operation:'list'}),get:id=>jobRequest({operation:'get',id}),cancel:id=>jobRequest({operation:'cancel',id})});
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.source !== 'pi-workbench-shell') return;
    if(event.data.type==='runtime-invoke'){if(controller)controller.invoke?.(event.data.command,event.data.payload);else pendingInvokes.set(event.data.command,event.data.payload);return;}
    if(event.data.type==='runtime-event'){
      if(!pageReady){if(bufferedEvents.length>=100)bufferedEvents.shift();bufferedEvents.push(event.data.event);return;}
      dispatchEvent(event.data.event);return;
    }
    if (event.data.type === 'runtime-state') {
      window.__wbState = event.data.state || {};
      if(pageReady){controller?.sync?.(window.__wbState);window.PiLayoutRuntime?.tag(document.body,'preview');window.dispatchEvent(new CustomEvent('workbench-state',{detail:window.__wbState}));
        for(const item of bufferedEvents.splice(0))dispatchEvent(item);
        pageRoot.inert=originalInert;pageRoot.removeAttribute('aria-busy');pageRoot.dataset.piRuntimeReady='true';}
    }
    if (event.data.type !== 'server-response') return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(event.data.requestId); window.__piRuntimePending=pending.size;
    if (event.data.error) item.reject(Object.assign(new Error(event.data.error),{code:event.data.code,details:event.data.details}));
    else {
      const envelope=event.data.result;
      // Keep the complete protocol envelope for registered UIs, while retaining
      // direct fields used by older standalone pages (e.g. result.revision).
      item.resolve(envelope?.result&&typeof envelope.result==='object'&&!Array.isArray(envelope.result)?{...envelope.result,...envelope}:envelope);
    }
  });
  function mountRegistered(){
    if(mounting)return true;
    if(document.readyState==='loading')return false;
    const module=window.PiWorkbenchModules?.[window.__piRuntime?.id];
    if(!module?.mount)return false;
    mounting=true;pageReady=false;pageRoot.inert=true;pageRoot.setAttribute('aria-busy','true');delete pageRoot.dataset.piRuntimeReady;
    Promise.resolve().then(()=>module.mount(document.querySelector('#app')||document.body,{
      key:window.__piRuntime.id,mode:'use',data:window.__wbState||{},
      esc,icon:()=>'',
      onEvent:window.__wbOnEvent,
      server:(action,payload)=>window.__wbTransport(action,payload),
      save:state=>window.__wbTransport('saveUIState',{state}),
      notify:message=>send({type:'notify',message:String(message)}),
      request:(operation,payload)=>operation==='server'?window.__wbTransport(payload.action,payload.payload||{}):request('host-request',operation,payload)
    })).then(value=>{controller=value;for(const [command,payload] of pendingInvokes)controller?.invoke?.(command,payload);pendingInvokes.clear();uiReady();}).catch(error=>{
      pageRoot.inert=originalInert;pageRoot.removeAttribute('aria-busy');
      const panel=document.createElement('p');panel.setAttribute('role','alert');panel.textContent='工作台界面启动失败：'+error.message;document.body.prepend(panel);send({type:'runtime-error',message:panel.textContent});
    });
    return true;
  }
  function documentReady(){if(!mountRegistered())uiReady();}
  window.addEventListener('pi-workbench-module-loaded',mountRegistered);
  document.addEventListener('DOMContentLoaded',documentReady,{once:true});
  if(document.readyState!=='loading')documentReady();
  send({ type: 'ready' });
})();
