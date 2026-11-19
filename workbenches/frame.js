'use strict';
const host=document.querySelector('#host');
const key=new URLSearchParams(location.search).get('key');
const mode=new URLSearchParams(location.search).get('mode')||'workbench';
if(mode==='edit'||mode==='design'){const banner=document.createElement('div');banner.id='frame-design-banner';banner.className='frame-design-banner';banner.textContent=mode==='design'?'设计模式 · 空白工作台，可与 Agent 一起搭建':'设计模式 · 当前工作台与已保存状态已载入，可继续让 Agent 修改';host.before(banner);}
const paths={play:'M5 3l14 9-14 9Z',layout:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z'};
const icon=n=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[n]||paths.layout)+'"/></svg>';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const registry=Object.create(null);
let controller=null, layoutController=null, initial=null, pendingWorkflow=null;
const pendingInvokes=[];
const requests=new Map();
let moduleReady=false;
function runInvoke(msg){
  try {
    const layoutCommands=['readLayout','setLayout'];
    if(msg.command==='setDraftHTML')layoutController?.freeze();
    const invoker=layoutController&&layoutCommands.includes(msg.command)?layoutController:controller;
    Promise.resolve(invoker.invoke(msg.command,msg.payload||{})).then(result=>send({type:'invoke-result',requestId:msg.requestId,result}),error=>send({type:'invoke-result',requestId:msg.requestId,error:error.message}));
  } catch(error) {
    send({type:'invoke-result',requestId:msg.requestId,error:error.message});
  }
}
function request(operation,payload={}) {
  const requestId=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{requests.delete(requestId);reject(new Error('请求超时，请重试'));},60000);
    requests.set(requestId,{resolve,reject,timer});
    send({type:'knowledge-request',requestId,operation,payload});
  });
}
function server(action,payload={}) {
  return request('server',{action,payload}).then(envelope=>envelope?.result===undefined?envelope:envelope.result);
}
function send(message){parent.postMessage({source:'pi-workbench',key,...message},'*');}
function mount(){
  const factory=registry[key];
  if(!factory||initial===null||controller)return;
  const persist=()=>send({type:'save',data:initial});
  controller=factory.mount(host,{data:initial,mode,target:new URLSearchParams(location.search).get('target')||null,icon,esc,request,server,save(next){initial={...next,_layout:initial?._layout};request('server',{action:'saveUIState',payload:{state:initial}}).catch(error=>send({type:'notify',message:error.message}));},notify(message){send({type:'notify',message});}});
  layoutController=key==='builder'?null:window.PiWorkbenchLayout?.({host,key,mode,data:initial,persist(next){initial={...initial,_layout:next._layout};persist();},notify(message){send({type:'notify',message});}})||null;
  if(pendingWorkflow)controller?.syncWorkflow?.(pendingWorkflow);
  while(pendingInvokes.length)runInvoke(pendingInvokes.shift());
  send({type:'mounted',prompt:factory.prompt||''});
}
window.PiWorkbenchModules=registry;
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.source!=='pi-workbench-shell'||event.data.key!==key)return;
  if(event.data.type==='knowledge-response') {
    const pending=requests.get(event.data.requestId);
    if(pending){clearTimeout(pending.timer);requests.delete(event.data.requestId);event.data.error?pending.reject(new Error(event.data.error)):pending.resolve(event.data.result);}
    return;
  }
  if(event.data.type==='init'){initial=event.data.data||{};mount();}
  if(event.data.type==='server-state'){
    initial=structuredClone(event.data.data||{});
    if(event.data.skipRender)return;
    if(controller?.sync) controller.sync(initial);
    else { controller?.dispose?.(); layoutController?.dispose?.(); host.replaceChildren(); controller=null; layoutController=null; mount(); }
    return;
  }
  if(event.data.type==='design-workflow'){
    pendingWorkflow=event.data.workflow||null;
    controller?.syncWorkflow?.(pendingWorkflow);
    return;
  }
  if(event.data.type==='invoke'){
    if(controller)runInvoke(event.data);
    else pendingInvokes.push(event.data);
  }
  if(event.data.type==='freeze')layoutController?.freeze();
});
const script=document.createElement('script');
script.src='./'+key+'/ui/index.js';
const moduleLoaded=()=>{if(moduleReady)return;moduleReady=true;send({type:'ready'});mount();};
window.addEventListener('pi-workbench-module-loaded',moduleLoaded,{once:true});
script.onload=()=>{if(registry[key])moduleLoaded();};
script.onerror=()=>{host.textContent='工作台文件读取失败';send({type:'error',message:'本地工作台 UI 文件未能载入'});};
document.head.append(script);
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='o'){
    event.preventDefault();
    send({type:'open-source'});
  }
},true);
