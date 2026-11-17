'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {inspectPackage,copyPackage}=require('./workbench-package.cjs');

// Built-in modules become ordinary editable ui/server projects. The adapter only
// mounts the existing UI; computation continues through the real server contract.
async function forkBuiltin({root,userData,key,appRoot,state={}}){
  if(!/^[a-z0-9_-]+$/i.test(key)||['builder','editor'].includes(key))throw new Error('这个入口不是可复制的业务工作台');
  const source=path.join(root,key),inspected=await inspectPackage(source);
  if(!inspected.ok)throw new Error('内置工作台源码不完整');
  const dest=path.join(userData,'workbench-projects','workbench-'+crypto.randomBytes(6).toString('hex'));
  await copyPackage(source,dest,{...inspected,source:{path:source}});
  const manifest=JSON.parse(await fs.readFile(path.join(dest,'manifest.json'),'utf8'));
  if(!/\.html?$/i.test(manifest.ui.entry)){
    const originalEntry=manifest.ui.entry,ui=path.join(dest,'ui');
    await fs.copyFile(path.join(appRoot,'runtime/layout-runtime.js'),path.join(ui,'layout-runtime.js'));
    if(key==='workflow'&&!manifest.ui.style)manifest.ui.style='workflow.css';
    await fs.mkdir(path.join(ui,'shell'),{recursive:true});
    for(const [from,to] of [['styles.css','base.css'],['runtime/theme-warm.css','theme.css'],['runtime/workflow-graph.js','workflow-graph.js'],['runtime/workflow-run.js','workflow-run.js']])await fs.copyFile(path.join(appRoot,from),path.join(ui,'shell',to));
    // The workflow backend uses one shared pure module. Bundle it inside server
    // and rewrite only that known dependency, keeping the copy self-contained.
    if(key==='workflow'){
      await fs.mkdir(path.join(dest,'server','shared'),{recursive:true});
      await fs.copyFile(path.join(appRoot,'runtime/workflow-graph.js'),path.join(dest,'server/shared/workflow-graph.js'));
      for(const rel of ['application/actions.cjs','domain/state.cjs']){
        const f=path.join(dest,'server',rel),text=await fs.readFile(f,'utf8');
        await fs.writeFile(f,text.replaceAll('../../../../runtime/workflow-graph.js','../shared/workflow-graph.js'));
      }
    }
    await fs.writeFile(path.join(ui,'design-adapter.js'),`'use strict';
(() => {
  if(window.__piRuntime)return; // Runtime bridge mounts the same module during trial/use.
  const data=window.__piDesignData||{};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notify=message=>parent.postMessage({source:'pi-preview',type:'notify',message},'*');
  const unavailable=async()=>{notify('请点击试运行来执行功能；当前为布局设计');return {};};
  window.PiWorkbenchModules[${JSON.stringify(manifest.id)}].mount(document.querySelector('#app'),{data,mode:'edit',esc,icon:()=>'',save:()=>notify('请在试运行中修改业务数据'),notify,server:unavailable,request:unavailable});
})();`);
    const asset=s=>String(s).split(/[\\/]/).map(encodeURIComponent).join('/');
    await fs.writeFile(path.join(ui,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="shell/base.css"><link rel="stylesheet" href="shell/theme.css"><link rel="stylesheet" href="layout.css">'+(manifest.ui.style?'<link rel="stylesheet" href="'+asset(manifest.ui.style)+'">':'')+'<style>body{min-width:0;margin:0}#app{min-height:100vh}</style><script>window.PiWorkbenchModules ||= {};window.PiWorkbenchHosted=true;</script><script src="shell/workflow-graph.js"></script><script src="shell/workflow-run.js"></script></head><body><main id="app"></main><script src="'+asset(originalEntry)+'"></script><script src="design-adapter.js"></script><script src="layout-runtime.js"></script></body></html>');
    if(state._layout?.nodes){const layout=structuredClone(state._layout),rename=id=>id===key+'/page'?'preview/page':id.startsWith(key+'/')?'preview/main#app/'+id.slice(key.length+1):id;layout.nodes=Object.fromEntries(Object.entries(layout.nodes).map(([id,g])=>[rename(id),g]));layout.order=(layout.order||[]).map(rename);layout.titles=Object.fromEntries(Object.entries(layout.titles||{}).map(([id,t])=>[rename(id),t]));await require('./preview-layout.cjs').writeLayout(ui,layout);}
    manifest.ui.entry='index.html';await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));
  }
  return {path:dest,name:manifest.name};
}
module.exports={forkBuiltin};
