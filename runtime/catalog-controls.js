'use strict';
window.PiCatalogControls={bind(api){
  api.actions['restore-workbench']=async()=>{
    try{const result=await window.piDesktop.workbench.list();if(!result.ok)throw new Error(result.error);const removed=(result.entries||[]).filter(e=>e.removed);
      if(!removed.length){api.notify('没有已卸载的工作台');return;}
      api.dialog('恢复工作台','<p class="dialog-copy">恢复目录入口，继续使用保留的源码与版本。</p><label class="dialog-label">工作台<select class="dialog-input" name="id">'+removed.map(e=>'<option value="'+api.esc(e.id)+'">'+api.esc(e.name)+'</option>').join('')+'</select></label>',async form=>{const restored=await window.piDesktop.workbench.manage({id:form.get('id'),operation:'enable'});if(!restored.ok)throw new Error(restored.error);await api.refresh();api.notify('工作台已恢复');},'恢复');
    }catch(error){api.notify(error.message);}
  };
  api.actions['manage-workbench']=e=>{
    const entry=api.entries().find(x=>x.id===e.dataset.key);if(!entry)return;
    const versions=entry.releases||[{releaseId:'legacy',version:entry.version,publishedAt:entry.publishedAt}];
    api.dialog('管理 · '+entry.name,'<p class="dialog-copy">新发布保存为独立版本，现有任务继续使用原版本。停用禁止新打开；卸载从目录移除，保留源码、历史版本和任务数据。</p><label class="dialog-label">操作<select class="dialog-input" name="operation"><option value="rollback">切换目录默认版本</option><option value="'+(entry.disabled?'enable':'disable')+'">'+(entry.disabled?'启用':'停用')+'</option><option value="uninstall">从目录卸载（保留数据）</option></select></label><label class="dialog-label">版本<select class="dialog-input" name="release">'+versions.slice().reverse().map(v=>'<option value="'+api.esc(v.releaseId)+'">'+api.esc(v.version)+' · '+new Date(v.publishedAt).toLocaleString()+'</option>').join('')+'</select></label>',async form=>{
      const result=await window.piDesktop.workbench.manage({id:entry.id,operation:form.get('operation'),releaseId:form.get('release')});if(!result.ok)throw new Error(result.error);await api.refresh();api.notify('工作台目录已更新，现有任务版本保留');
    },'应用');
  };
  const observer=new MutationObserver(()=>{
    const toolbar=document.querySelector('.catalog-toolbar');if(toolbar&&!toolbar.querySelector('[data-action="restore-workbench"]')){const button=document.createElement('button');button.className='button';button.dataset.action='restore-workbench';button.textContent='恢复已卸载';toolbar.append(button);}
    for(const card of document.querySelectorAll('.workbench-card')){
      const open=card.querySelector('[data-action="open-use-workbench"]'),entry=api.entries().find(x=>x.id===open?.dataset.key);if(!entry)continue;
      open.disabled=Boolean(entry.disabled);
      if(!card.querySelector('[data-action="manage-workbench"]')){const button=document.createElement('button');button.className='button';button.textContent='版本与管理';button.dataset.action='manage-workbench';button.dataset.key=entry.id;card.querySelector('.card-actions').append(button);}
    }
  });observer.observe(document.querySelector('#page'),{childList:true,subtree:true});
}};
