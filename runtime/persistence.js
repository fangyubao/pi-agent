'use strict';
window.PiPersistence = (() => {
  const key = 'pi-workbench-design-v2';
  let pending, timer, busy = null, draining=false, warning = '', mirrorDisabled=false, lastMirrorHash='', importedState=null,closing=false,canPatch=false,fullDirty=true;
  let dirtyTasks=new Set(),fullTasks=new Set(),dirtyMessages=new Map(),dirtyTaskMeta=new Set(),dirtyTaskFields=new Map();
  const hash = text => { let value = 2166136261; for (let i=0;i<text.length;i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); return String(value >>> 0); };
  function taskPatch(task,includeMeta,changes,fieldNames){const {messages=[],...meta}=includeMeta?task:{messages:task.messages};const fields=Object.fromEntries([...(fieldNames||[])].filter(name=>name!=='messages'&&Object.hasOwn(task,name)).map(name=>[name,task[name]]));return {id:task.id,meta:includeMeta?meta:null,fields,messageIds:messages.map(m=>m.id),messages:messages.filter(m=>changes?.has(m.id))};}
  function status(text) { const element = document.querySelector('#persistence-status'); if (element) element.textContent = text; }
  async function load() {
    let legacyText, legacy;
    try { legacyText = localStorage.getItem(key); legacy = legacyText && JSON.parse(legacyText); } catch { warning = '旧版本地记录损坏，正在检查文件备份'; }
    if (!window.piDesktop?.storage) return legacy;
    const loaded = await window.piDesktop.storage.load();
    if (!loaded.ok) throw new Error(loaded.error);
    // Startup now waits for the file worker. An importer may update the legacy
    // mirror during that wait; use the latest value, not the pre-await snapshot.
    try {legacyText=localStorage.getItem(key);legacy=legacyText&&JSON.parse(legacyText);}catch{}
    warning = loaded.result.warning || warning;
    const disk = loaded.result;
    canPatch=Boolean(disk.state);
    lastMirrorHash=disk.mirrorHash||(legacyText?hash(legacyText):'');
    // Keep small legacy records readable during migration. A legacy application
    // may have changed this recovery copy after the last file-store commit.
    if (legacy && (!disk.state || (disk.mirrorHash && hash(legacyText) !== disk.mirrorHash))) {lastMirrorHash=hash(legacyText);return legacy;}
    return disk.state || legacy;
  }
  function flush(drain=true) {
    clearTimeout(timer); timer = null;
    if(drain)draining=true;
    if(busy)return busy;
    if (!pending||closing){draining=false;return Promise.resolve();}
    // One in-flight snapshot and one latest pending state, never a queue of
    // obsolete whole-conversation snapshots when the disk worker is busy.
    let failed=false;
    busy = Promise.resolve().then(async () => {
      do{
        if(!pending||closing)break;
        const queued=pending;pending=null;
        const taskIds=[...dirtyTasks],completeTasks=fullTasks,messageChanges=dirtyMessages,taskMetadata=dirtyTaskMeta,taskFields=dirtyTaskFields,full=fullDirty||!canPatch;
        dirtyTasks=new Set();fullTasks=new Set();dirtyMessages=new Map();dirtyTaskMeta=new Set();dirtyTaskFields=new Map();fullDirty=false;
        try{
        // Stream and task-local changes avoid serializing the entire recovery
        // mirror on the renderer thread; durable snapshots are written by worker.
        const input=queued.deferred?(full?prepare(queued.state):{state:queued.state,mirrorHash:lastMirrorHash}):{...queued};
        if(!full&&!importedState&&window.piDesktop?.storage){
          const {projects,...meta}=input.state;
          const changed=projects.flatMap(p=>p.tasks.filter(t=>taskIds.includes(t.id)));
          input.patch={meta,projects:projects.map(({tasks,...project})=>({...project,taskIds:tasks.map(t=>t.id)})),tasks:changed.filter(t=>completeTasks.has(t.id)),taskPatches:changed.filter(t=>!completeTasks.has(t.id)).map(task=>taskPatch(task,taskMetadata.has(task.id),messageChanges.get(task.id),taskFields.get(task.id)))};
          delete input.state;
        }
        const result=window.piDesktop?.storage?await window.piDesktop.storage.save(input):{ok:true};
        if(!result.ok)throw new Error(result.error);
        canPatch=Boolean(window.piDesktop?.storage);
        }catch(error){
          // A failed patch must be retried from the complete latest state. Keep
          // the queued envelope intact, including when the IPC itself rejects.
          fullDirty=true;if(!pending)pending=queued;status('保存失败：'+error.message);throw error;
        }
      }while(pending&&draining);
      if(!closing&&!pending)status('已保存到本地');
    }).catch(error=>{failed=true;throw error;}).finally(()=>{busy=null;draining=false;if(pending&&!closing&&!failed)schedule();});
    busy.catch(() => {}); return busy;
  }
  function prepare(state) {
    // A legacy import can land while an asynchronous startup callback is still
    // saving the old renderer state. Preserve that import until the reload.
    try { const text=localStorage.getItem(key);if(text&&hash(text)!==lastMirrorHash){const value=JSON.parse(text);if(value.schema===2&&Array.isArray(value.projects))importedState=value;} } catch {}
    if(importedState)state=importedState;
    // The recovery mirror is bounded; large conversations use the file store
    // exclusively and cannot hit browser storage quota or stringify per token.
    let mirrorHash = lastMirrorHash;
    if (!mirrorDisabled) {
      try {
        const text = JSON.stringify(state);
        if (text.length <= 512 * 1024) { localStorage.setItem(key, text); mirrorHash = hash(text);lastMirrorHash=mirrorHash; }
        else {localStorage.removeItem(key);mirrorDisabled=true;mirrorHash='';lastMirrorHash='';}
      } catch {}
    }
    return {state,mirrorHash};
  }
  function save(state,{defer=false,taskId=null,metaOnly=false,messageId=null,messageIds=null,taskMetaOnly=false,taskFields=[]}={}) {
    if(closing)return;
    if(taskId){dirtyTasks.add(taskId);if(!messageId&&!messageIds&&!taskMetaOnly&&!taskFields.length)fullTasks.add(taskId);if(taskMetaOnly)dirtyTaskMeta.add(taskId);for(const id of [messageId,...(messageIds||[])].filter(Boolean)){if(!dirtyMessages.has(taskId))dirtyMessages.set(taskId,new Set());dirtyMessages.get(taskId).add(id);}}else if(!metaOnly)fullDirty=true;
    if(taskId&&taskFields.length){if(!dirtyTaskFields.has(taskId))dirtyTaskFields.set(taskId,new Set());for(const field of taskFields)dirtyTaskFields.get(taskId).add(field);}
    // High-frequency text and typing events only mark the latest state dirty.
    // Explicit user actions retain the immediate legacy recovery mirror.
    pending=defer?{state,deferred:true}:prepare(state);status('正在保存…');
    schedule();
  }
  function schedule(){if(!timer&&!busy)timer=setTimeout(()=>{void flush(false).catch(()=>{});},500);}
  function close(state){clearTimeout(timer);pending=null;closing=true;if(importedState)state=importedState;
    // Preserve an explicit update from an older version/import tool during a
    // reload instead of overwriting it with the renderer's previous snapshot.
    try{const text=localStorage.getItem(key);if(text&&hash(text)!==lastMirrorHash){const changed=JSON.parse(text);if(changed.schema===2&&Array.isArray(changed.projects)){state=changed;lastMirrorHash=hash(text);}}}catch{}
    const result=window.piDesktop?.storage?.saveSync({state,mirrorHash:lastMirrorHash});if(result&&!result.ok){closing=false;throw new Error(result.error);}
  }
  let closePromise=null;
  function closeAsync(state){
    if(closePromise)return closePromise;
    closePromise=(async()=>{
      // Respect explicit legacy imports, but do not resend every conversation
      // on exit. Drain the same latest-state patch queue used during editing.
      try{const text=localStorage.getItem(key);if(text&&hash(text)!==lastMirrorHash){const value=JSON.parse(text);if(value.schema===2&&Array.isArray(value.projects)){importedState=value;fullDirty=true;pending={state:value,deferred:true};}}}catch{}
      if(!canPatch&&!pending)save(state,{defer:true});
      await flush();
      const result=await window.piDesktop?.storage?.flush?.();if(result&&!result.ok)throw new Error(result.error);
      // Updates arriving while the worker acknowledged its flush are included.
      if(pending)await flush();
      closing=true;clearTimeout(timer);
    })().catch(error=>{closing=false;closePromise=null;throw error;});
    return closePromise;
  }
  return { load, save, flush, close, closeAsync, warning: () => warning };
})();
