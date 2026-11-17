'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {inspectPackage,copyPackage,within}=require('./workbench-package.cjs');
const {copyDependencies}=require('./workbench-dependencies.cjs');

// Publication is a local snapshot, separate from the editable source tree.
function createCatalog(userData){
  const root=path.join(userData,'workbench-library'),file=path.join(root,'catalog.json');
  let writes=Promise.resolve();
  async function list(){try{const data=JSON.parse(await fs.readFile(file,'utf8'));return (data.entries||[]).filter(e=>/^local-[a-f0-9]{16}$/.test(e.id)&&within(root,e.path));}catch(e){if(e.code==='ENOENT')return [];throw new Error('工作台目录读取失败：'+e.message);}}
  const releases=entry=>entry.releases?.length?entry.releases:[{releaseId:'legacy',path:entry.path,version:entry.version,publishedAt:entry.publishedAt,sourcePath:entry.sourcePath}];
  async function commit(entries){await fs.mkdir(root,{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify({schema:2,entries},null,2));await fs.rename(file+'.tmp',file);}
  function publish(source,{recover=false,knowledge}={}){
    const result=writes.then(async()=>{
      source=path.resolve(source);const entries=await list();
      const provenance=await fs.readFile(path.join(source,'.pi-package.json'),'utf8').then(JSON.parse).catch(()=>({}));
      const existing=entries.find(e=>e.id===provenance.source?.catalogId||[e.sourcePath,e.path,...releases(e).map(r=>r.path)].some(p=>p?.toLowerCase()===source.toLowerCase()));
      if(recover&&existing)return existing;
      const inspected=await inspectPackage(source);
      if(!inspected.ok)throw new Error('工作台不能发布：'+inspected.issues.filter(i=>i.level==='error').map(i=>i.text).join('；'));
      if(inspected.summary.uiKind!=='page')throw new Error('自建工作台需要 HTML 界面入口，请检查 manifest.ui.entry');
      const id=existing?.id||'local-'+crypto.createHash('sha256').update(source.toLowerCase()).digest('hex').slice(0,16);
      const releaseId=Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex');
      const dest=path.join(root,id+'-releases',releaseId),pending=path.join(root,id+'-pending-'+crypto.randomUUID()),backup=path.join(root,id+'-backup-'+crypto.randomUUID());
      await fs.mkdir(root,{recursive:true});
      await fs.mkdir(path.dirname(dest),{recursive:true});
      let moved=false,installed=false;
      async function cleanup(target){if(path.dirname(target)!==root||!path.basename(target).startsWith(id+'-'))throw new Error('工作台临时目录越界');await fs.rm(target,{recursive:true,force:true});}
      try{
        await copyPackage(source,pending,{...inspected,source:{path:source,catalogId:id,releaseId}});
        const dependencies=await copyDependencies(source,pending);
        if(await fs.stat(dest).catch(()=>null)){await fs.rename(dest,backup);moved=true;}
        await fs.rename(pending,dest);installed=true;
        const boundKnowledge=knowledge===undefined?existing?.knowledge:knowledge;
        const release={releaseId,path:dest,sourcePath:source,name:inspected.manifest.name,version:inspected.manifest.version,publishedAt:Date.now(),dependencies,knowledge:boundKnowledge||null};
        const entry={id,...release,disabled:false,removed:false,releases:[...(existing?releases(existing):[]),release],warnings:inspected.issues.filter(i=>i.level==='warn').map(i=>i.text)};
        const next=entries.filter(e=>e.id!==id);next.push(entry);
        await commit(next);
        if(moved)await cleanup(backup).catch(()=>{});
        return entry;
      }catch(error){
        if(moved){if(installed){await fs.rename(dest,pending);await cleanup(pending);}await fs.rename(backup,dest);}
        else if(installed){await fs.rename(dest,pending);await cleanup(pending);}
        await cleanup(pending).catch(()=>{});throw error;
      }
    });writes=result.catch(()=>{});return result;
  }
  async function fork(id){const entry=(await list()).find(e=>e.id===id);if(!entry)throw new Error('找不到已发布的工作台');const dest=path.join(userData,'workbench-projects','workbench-'+crypto.randomBytes(6).toString('hex'));const inspected=await inspectPackage(entry.path);if(!inspected.ok)throw new Error('工作台文件不完整，无法创建设计副本');await copyPackage(entry.path,dest,{...inspected,source:{path:entry.path,catalogId:id,releaseId:entry.releaseId||'legacy'}});await copyDependencies(entry.path,dest);return {path:dest,name:entry.name,catalogId:id,knowledge:entry.knowledge||null};}
  function manage(id,operation,releaseId){const result=writes.then(async()=>{
    const entries=await list(),entry=entries.find(e=>e.id===id);if(!entry)throw new Error('工作台不存在');
    if(operation==='rollback'){const version=releases(entry).find(r=>r.releaseId===releaseId);if(!version)throw new Error('版本不存在');await fs.access(path.join(version.path,'manifest.json'));Object.assign(entry,version);}
    else if(operation==='disable')entry.disabled=true;
    else if(operation==='enable'){entry.disabled=false;entry.removed=false;}
    else if(operation==='uninstall'){entry.removed=true;entry.disabled=true;}
    else throw new Error('未知工作台管理操作');
    await commit(entries);return entry;
  });writes=result.catch(()=>{});return result;}
  return {list,publish,fork,manage};
}
module.exports={createCatalog};
