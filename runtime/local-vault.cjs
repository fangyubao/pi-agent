'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const {gzip,gunzip}=require('node:zlib');
const compress=promisify(gzip),expand=promisify(gunzip);
const queues=new Map();
function serial(key,fn){const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(key,next);return next.finally(()=>{if(queues.get(key)===next)queues.delete(key);});}
function key(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
async function read(file,fallback){try{return JSON.parse((await expand(await fs.readFile(file),{maxOutputLength:64*1024*1024})).toString('utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('本地记录无法读取：'+e.message);}}
async function atomic(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,await compress(Buffer.from(JSON.stringify(data))));await fs.rename(temp,file);}
function metadata(item){const {state,...meta}=item;return meta;}
function createVault(root){
  const journalFile=taskId=>path.join(root,'workbench-history',key(taskId)+'.json.gz');
  async function record(input){
    const file=journalFile(input.taskId);
    return serial(file,async()=>{
      const history=await read(file,[]);
      const previous=history.find(x=>x.workbenchId===input.key);
      if(previous&&JSON.stringify(previous.state)===JSON.stringify(input.state))return history.map(metadata);
      if(!previous&&input.before&&Object.keys(input.before).length)history.unshift({id:crypto.randomUUID(),workbenchId:input.key,label:'首次记录前的状态',source:'baseline',time:Date.now(),revision:input.before.revision||0,state:input.before});
      const changed=[...new Set([...Object.keys(input.before||{}),...Object.keys(input.state||{})])].filter(k=>JSON.stringify(input.before?.[k])!==JSON.stringify(input.state?.[k]));
      history.unshift({id:crypto.randomUUID(),workbenchId:input.key,label:String(input.label||'状态更新'),source:input.source||'ui',time:Date.now(),revision:input.state?.revision||0,changed,events:input.events||[],state:input.state});
      history.splice(40);
      // Retain complete states only. Never truncate a recoverable snapshot.
      while(history.length>2&&Buffer.byteLength(JSON.stringify(history))>16*1024*1024)history.pop();
      await atomic(file,history);
      return history.map(metadata);
    });
  }
  async function list(taskId){await queues.get(journalFile(taskId));return (await read(journalFile(taskId),[])).map(metadata);}
  async function get(taskId,id){await queues.get(journalFile(taskId));const found=(await read(journalFile(taskId),[])).find(x=>x.id===id);if(!found)throw new Error('快照已过期或不存在');return found;}
  async function backup(project,{ifChanged=false,fingerprint=''}={}){
    if(!project?.id||!Array.isArray(project.tasks))throw new Error('项目备份格式无效');
    const file=path.join(root,'project-backups',key(project.id)+'.json.gz');
    return serial(file,async()=>{const history=await read(file,[]);if(ifChanged&&history[0]?.fingerprint===fingerprint)return {id:history[0].id,time:history[0].time,unchanged:true};history.unshift({id:crypto.randomUUID(),time:Date.now(),name:project.name,project,fingerprint});history.splice(5);await atomic(file,history);return {id:history[0].id,time:history[0].time,unchanged:false};});
  }
  async function backups(projectId){const file=path.join(root,'project-backups',key(projectId)+'.json.gz');await queues.get(file);return (await read(file,[])).map(({project,...meta})=>meta);}
  async function restore(projectId,id){const file=path.join(root,'project-backups',key(projectId)+'.json.gz');await queues.get(file);const item=(await read(file,[])).find(x=>x.id===id);if(!item)throw new Error('备份不存在');return item.project;}
  async function usage(){let bytes=0,files=0;for(const folder of ['workbench-history','project-backups']){for(const entry of await fs.readdir(path.join(root,folder),{withFileTypes:true}).catch(()=>[])){if(entry.isFile()){bytes+=(await fs.stat(path.join(root,folder,entry.name))).size;files++;}}}return {bytes,files,root};}
  return {record,list,get,backup,backups,restore,usage};
}
async function encodeProject(project,password=''){
  const payload=await compress(Buffer.from(JSON.stringify({format:'pi-project',version:1,project})));
  if(!password)return JSON.stringify({format:'pi-project-package',encrypted:false,data:payload.toString('base64')});
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),secret=await promisify(crypto.scrypt)(password,salt,32);
  const cipher=crypto.createCipheriv('aes-256-gcm',secret,iv),data=Buffer.concat([cipher.update(payload),cipher.final()]);
  return JSON.stringify({format:'pi-project-package',encrypted:true,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
}
async function decodeProject(text,password=''){
  const envelope=JSON.parse(text);if(envelope.format!=='pi-project-package')throw new Error('不是 Pi 项目备份包');
  let payload=Buffer.from(envelope.data,'base64');
  if(envelope.encrypted){if(!password)throw new Error('此备份需要密码');const secret=await promisify(crypto.scrypt)(password,Buffer.from(envelope.salt,'base64'),32);const decipher=crypto.createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));payload=Buffer.concat([decipher.update(payload),decipher.final()]);}
  const doc=JSON.parse((await expand(payload,{maxOutputLength:64*1024*1024})).toString('utf8'));
  if(doc.format!=='pi-project'||doc.version!==1||!doc.project?.name||!Array.isArray(doc.project.tasks))throw new Error('项目备份结构无效');
  return doc.project;
}
module.exports={createVault,encodeProject,decodeProject};
