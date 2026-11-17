'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeProject, decodeProject } = require('./local-vault.cjs');
const { within } = require('./workbench-package.cjs');
const limits = { bytes: 40 * 1024 * 1024, files: 3000, file: 8 * 1024 * 1024 };
const excluded = new Set(['node_modules','.git','.venv','dist','build','.env','provider-config.json','auth.json']);
function pathFields(project) {
  const fields=[];
  function add(object,key){if(typeof object?.[key]==='string'&&path.isAbsolute(object[key]))fields.push({object,key,value:path.resolve(object[key])});}
  add(project,'path');add(project,'workspacePath');
  for(const task of project.tasks||[]){add(task,'workspacePath');for(const key of ['workspacePath','publishedPath'])add(task.design,key);add(task.workbenchSession,'sourcePath');for(const value of Object.values(task.workbenches||{}))add(value,'workspacePath');}
  return fields;
}
async function encodePortable(project,password='') {
  const copy=structuredClone(project),fields=pathFields(copy),roots=[];
  for(const field of [...fields].sort((a,b)=>a.value.length-b.value.length))if(!roots.some(root=>within(root,field.value)))roots.push(field.value);
  let bytes=0,count=0;const bundles=[],warnings=[];
  for(const root of roots){
    if(root===path.parse(root).root)throw new Error('不能导出整个磁盘，请为项目设置独立工作目录');
    const bundle={id:crypto.randomUUID(),original:root,files:[]};
    async function walk(dir){
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(excluded.has(entry.name)||entry.name.startsWith('.env.')||/\.(?:pem|key|pfx)$/i.test(entry.name)){warnings.push('未打包：'+path.relative(root,path.join(dir,entry.name)));continue;}
        const file=path.join(dir,entry.name),stat=await fs.lstat(file);
        if(stat.isSymbolicLink()){warnings.push('未打包链接：'+path.relative(root,file));continue;}
        if(stat.isDirectory()){await walk(file);continue;}
        if(!stat.isFile())continue;
        if(stat.size>limits.file||bytes+stat.size>limits.bytes||++count>limits.files)throw new Error('工程导出超过容量限制；请将大型数据另行备份。未生成不完整备份。');
        const data=await fs.readFile(file);bytes+=data.length;
        bundle.files.push({path:path.relative(root,file).split(path.sep).join('/'),data:data.toString('base64'),sha256:crypto.createHash('sha256').update(data).digest('hex')});
      }
    }
    try{await walk(root);}catch(error){if(error.code==='ENOENT')throw new Error('工程目录不存在，无法完整导出：'+root);throw error;}
    bundles.push(bundle);
  }
  for(const field of fields){const bundle=bundles.find(b=>within(b.original,field.value));field.object[field.key]='pi-package://'+bundle.id+'/'+path.relative(bundle.original,field.value).split(path.sep).join('/');}
  copy._portable={schema:1,bundles,warnings,bytes,createdAt:Date.now(),dependencies:'保留 package.json 与锁文件；运行依赖需在目标电脑安装。知识库外部路径不自动复制。'};
  return {text:await encodeProject(copy,password),warnings,bytes};
}
async function decodePortable(text,password,destination) {
  const project=await decodeProject(text,password),portable=project._portable;
  if(!portable)return {project,warnings:['此旧版备份只含对话和状态，源码路径可能需要重新指定。']};
  if(portable.schema!==1||!Array.isArray(portable.bundles))throw new Error('工程包格式无效');
  const root=path.resolve(destination,'import-'+crypto.randomUUID()),map=new Map();let bytes=0,count=0;
  // Validate the entire archive before writing any files.
  for(const bundle of portable.bundles){
    if(!/^[a-f0-9-]{36}$/.test(bundle.id)||map.has(bundle.id)||!Array.isArray(bundle.files))throw new Error('工程包目录标识无效');
    const base=path.join(root,bundle.id),seen=new Set();map.set(bundle.id,base);
    for(const file of bundle.files){
      if(typeof file.path!=='string'||file.path.includes(':')||file.path.includes('\\')||file.path.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('工程包文件路径越界');
      const target=path.resolve(base,file.path),data=Buffer.from(file.data,'base64');
      if(!within(base,target)||seen.has(target.toLowerCase()))throw new Error('工程包文件路径重复或越界');seen.add(target.toLowerCase());
      bytes+=data.length;if(data.length>limits.file||bytes>limits.bytes||++count>limits.files)throw new Error('工程包超过容量限制');
      if(crypto.createHash('sha256').update(data).digest('hex')!==file.sha256)throw new Error('工程包文件校验失败：'+file.path);
    }
  }
  const remap=value=>{
    if(typeof value==='string'&&value.startsWith('pi-package://')){const match=/^pi-package:\/\/([a-f0-9-]{36})\/(.*)$/.exec(value);if(!match||!map.has(match[1]))throw new Error('工程路径引用无效');const base=map.get(match[1]),target=path.resolve(base,match[2]);if(!within(base,target))throw new Error('工程路径引用越界');return target;}
    if(Array.isArray(value))return value.map(remap);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)]));return value;
  };
  delete project._portable;const imported=remap(project);
  for(const task of imported.tasks||[])for(const wb of Object.values(task.workbenches||{}))if(wb.knowledge?.indexId){delete wb.knowledge.indexId;wb.knowledge.warnings ||= [];wb.knowledge.warnings.push('此知识库索引来自另一台电脑，请重新选择来源并导入。');}
  await fs.mkdir(root,{recursive:true});
  try{for(const bundle of portable.bundles)for(const file of bundle.files){const target=path.join(map.get(bundle.id),file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,Buffer.from(file.data,'base64'),{flag:'wx'});}}
  catch(error){if(path.dirname(root)!==path.resolve(destination))throw error;await fs.rm(root,{recursive:true,force:true});throw error;}
  return {project:imported,warnings:portable.warnings||[],root};
}
module.exports={encodePortable,decodePortable};
