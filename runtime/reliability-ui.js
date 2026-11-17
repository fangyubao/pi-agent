'use strict';
window.PiReliability=(()=>{
  let api,backupTimer,backupBusy=false,backupAgain=false;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function checked(promise){const result=await promise;if(!result?.ok)throw new Error(result?.error||'操作失败');return result.result;}
  function scheduleBackup(){
    if(!api||!window.piDesktop?.vault)return;
    if(api.running()){clearTimeout(backupTimer);backupTimer=null;return;}
    if(backupBusy){backupAgain=true;return;}
    if(backupTimer)return;backupTimer=setTimeout(async()=>{backupTimer=null;if(api.running())return;backupBusy=true;backupAgain=false;
      try{
        // Back up the committed state in the storage worker. No complete
        // project serialization or compression runs on either UI thread.
        await window.PiPersistence.flush();
        if(!api.running())await checked(window.piDesktop.vault.backupSaved());
      }catch(error){api.notify('自动备份未完成：'+error.message);}
      finally{backupBusy=false;if(backupAgain)scheduleBackup();}
    },2500);
  }
  function refresh(){
    if(!api)return;
    const composer=document.querySelector('.composer-wrap');
    document.querySelector('.run-controls')?.remove();
    const c=api.current(),running=api.runningHere?api.runningHere():api.running(),last=c?.task.messages.findLast(m=>m.run);
    if(composer&&(running||['error','stopped','paused','interrupted','incomplete'].includes(last?.run?.status))){
      const box=document.createElement('div');box.className='run-controls';
      box.innerHTML=running?'<span>Agent 运行中</span><button type="button" data-action="pause-agent">暂停</button><button type="button" data-action="force-stop-agent">强制终止</button>':'<span>'+esc(last.run.label||'可以继续任务')+'</span><button type="button" data-action="resume-agent">从当前状态继续</button>';
      composer.prepend(box);
    }
    const settings=document.querySelector('.provider-block');
    if(settings&&!document.querySelector('#data-protection')){
      settings.insertAdjacentHTML('afterend','<section class="settings-block" id="data-protection"><div class="setting-row"><div><h3>本地数据保护</h3><p>项目更改后自动备份，保留最近五个完整版本。备份包含对话、记忆和工作台状态。</p></div><button class="button" data-action="storage-info">查看存储</button></div><div class="setting-row"><div><h3>导入项目备份</h3><p>导入为新项目，保留原项目。</p></div><button class="button" data-action="import-project-package">导入</button></div><div class="setting-row"><div><h3>归档任务</h3><p>归档隐藏项目列表中的任务，保留全部数据。</p></div><button class="button" data-action="view-archives">查看归档</button></div></section>');
    }
  }
  function project(id){return api.state.projects.find(p=>p.id===id);}
  async function backup(id){const p=project(id);if(!p)return;await checked(window.piDesktop.vault.backup({project:p}));api.notify('项目完整备份已保存');}
  async function restore(id){
    const p=project(id),list=await checked(window.piDesktop.vault.backups({projectId:id}));
    if(!list.length){api.notify('暂无备份');return;}
    api.dialog('恢复项目备份','<p class="dialog-copy">恢复为新的项目副本，便于对比原项目。</p><select class="dialog-input" name="version">'+list.map(x=>'<option value="'+esc(x.id)+'">'+new Date(x.time).toLocaleString()+'</option>').join('')+'</select>',async form=>{
      const value=await checked(window.piDesktop.vault.restore({projectId:id,id:form.get('version')}));
      importCopy(value,' · 恢复');api.notify('已恢复为新的项目副本');
    },'恢复副本');
  }
  function importCopy(value,suffix=' · 导入'){
    const copy=structuredClone(value);copy.id=api.uid();copy.name=String(copy.name)+suffix;copy.expanded=true;
    copy.tasks=(copy.tasks||[]).map(task=>({...task,id:api.uid(),pending:null,workbenchHistory:[],workbenchAudit:[],workbenchSession:task.workbenchSession?{...task.workbenchSession,open:false}:undefined}));
    api.state.projects.push(copy);api.save();api.render();
  }
  function exportPackage(id){
    const p=project(id);if(!p)return;
    api.dialog('导出完整项目','<p class="dialog-copy">包含对话、记忆、工作台状态，以及关联工程的源码和资源。排除依赖目录、密钥文件和外部知识库原文件；目标电脑需要安装工程依赖。可填写密码加密备份。</p><input class="dialog-input" type="password" name="password" autocomplete="new-password" placeholder="备份密码（可选）">',async form=>{
      const result=await window.piDesktop.vault.exportProject({project:p,password:String(form.get('password')||'')});
      if(!result.ok&&!result.canceled)throw new Error(result.error);if(result.ok)api.notify('已导出项目备份'+(result.warnings?.length?'；'+result.warnings.length+' 项已排除':''));
    },'选择保存位置');
  }
  function importPackage(){
    api.dialog('导入完整项目','<p class="dialog-copy">如备份已加密，请先填写密码。</p><input class="dialog-input" type="password" name="password" autocomplete="off" placeholder="备份密码（可选）">',async form=>{
      const result=await window.piDesktop.vault.importProject({password:String(form.get('password')||'')});
      if(result.ok)importCopy(result.project);else if(!result.canceled)throw new Error(result.error);
    },'选择备份文件');
  }
  function archives(){
    const rows=api.state.projects.flatMap(p=>p.tasks.filter(t=>t.archived).map(t=>({p,t})));
    api.dialog('归档任务',rows.length?'<select class="dialog-input" name="task">'+rows.map(({p,t})=>'<option value="'+esc(t.id)+'">'+esc(p.name+' / '+t.name)+'</option>').join('')+'</select>':'<p class="dialog-copy">暂无归档任务。</p>',form=>{const c=api.located(form.get('task'));if(c){c.task.archived=false;api.save();api.render();}},'取消归档');
  }
  function merge(id){
    const c=api.located(id);if(!c)return;
    const targets=c.project.tasks.filter(t=>t.id!==id);
    if(!targets.length){api.notify('同项目中没有可合并的其他任务');return;}
    api.dialog('合并任务分支','<p class="dialog-copy">对话按消息标识去重合并。工作台状态冲突时按下方选择处理；合并前会备份目标项目。</p><label class="dialog-label">目标任务</label><select class="dialog-input" name="target">'+targets.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join('')+'</select><label class="dialog-label">工作台状态冲突处理</label><select class="dialog-input" name="conflict"><option value="target">保留目标任务状态</option><option value="source">采用当前分支状态</option></select>',async form=>{
      if(api.running())throw new Error('请先暂停 Agent');
      await backup(c.project.id);const target=api.located(form.get('target'))?.task;if(!target)throw new Error('目标任务不存在');
      const ids=new Set(target.messages.map(m=>m.id));target.messages.push(...structuredClone(c.task.messages.filter(m=>!ids.has(m.id))));
      for(const [key,value] of Object.entries(c.task.workbenches||{}))if(!target.workbenches[key]||form.get('conflict')==='source')target.workbenches[key]=structuredClone(value);
      target.updated=Date.now();api.save();api.render();api.notify('任务分支已合并，目标项目备份可恢复');
    },'合并');
  }
  function augment(items){
    const task=items.find(x=>x.action==='rename-task'),proj=items.find(x=>x.action==='rename-project');
    if(task){if(!items.some(x=>x.action==='task-branch-menu'))items.splice(items.length-1,0,{label:'分支',action:'task-branch-menu',id:task.id,icon:'chat'});items.splice(items.length-1,0,{label:'归档任务',action:'archive-task',id:task.id,icon:'folder'});}
    if(proj)items.splice(items.length-1,0,{label:'立即备份项目',action:'backup-project',id:proj.id,icon:'file'},{label:'恢复项目备份',action:'restore-project-backup',id:proj.id,icon:'file'},{label:'导出完整项目',action:'export-project-package',id:proj.id,icon:'file'});
    return items;
  }
  function bind(options){
    api=options;
    const act={
      'pause-agent':()=>api.pause(),
      'force-stop-agent':()=>api.forceStop(),
      'resume-agent':()=>api.resume(),
      'backup-project':e=>backup(e.dataset.id),
      'restore-project-backup':e=>restore(e.dataset.id),
      'export-project-package':e=>exportPackage(e.dataset.id),
      'import-project-package':importPackage,
      'storage-info':async()=>{const info=await checked(window.piDesktop.vault.usage());api.dialog('存储占用','<p class="dialog-copy">快照和备份：'+(info.bytes/1024/1024).toFixed(2)+' MB · '+info.files+' 个存储文件</p><p class="file-preview-path">'+esc(info.root)+'</p><p class="dialog-copy">每个任务最多保留 40 个完整工作台快照，每个项目保留 5 个完整备份，旧记录自动轮换。</p>',()=>{},'关闭');},
      'archive-task':e=>{if(api.running())throw new Error('请先暂停 Agent');const c=api.located(e.dataset.id);if(c){c.task.archived=true;api.save();api.render();}},
      'view-archives':archives,
      'fork-task':e=>api.fork(e.dataset.id),
      'merge-task':e=>merge(e.dataset.id)
    };
    for(const [key,fn] of Object.entries(act))api.actions[key]=e=>Promise.resolve().then(()=>fn(e)).catch(error=>api.notify(error.message));
    scheduleBackup();return {refresh,augment};
  }
  return {bind,refresh,augment,scheduleBackup};
})();
