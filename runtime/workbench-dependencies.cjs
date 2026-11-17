'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createRequire}=require('node:module');
const {within}=require('./workbench-package.cjs');
// Copy only the installed production dependency graph. Resolution reads package
// metadata; publication never runs install scripts or downloads packages.
async function copyDependencies(source,destination){
  let root;try{root=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return {packages:0,bytes:0};throw error;}
  const modules=path.join(source,'node_modules'),seen=new Set();let bytes=0,files=0;
  async function visit(owner,pkg){
    const optional=pkg.optionalDependencies||{},dependencies={...(pkg.dependencies||{}),...optional};
    for(const name of Object.keys(dependencies)){
      if(!/^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(name))throw new Error('依赖名称无效：'+name);
      let dir;
      try{const req=createRequire(path.join(owner,'package.json'));let resolved;try{resolved=req.resolve(name+'/package.json');}catch{resolved=req.resolve(name);}
        dir=path.dirname(resolved);
        while(within(modules,dir)){
          const data=await fs.readFile(path.join(dir,'package.json'),'utf8').then(JSON.parse).catch(()=>null);if(data?.name===name)break;dir=path.dirname(dir);
        }
        if(!within(modules,dir)||dir===modules)throw new Error('依赖指向工程目录之外');
      }catch(error){if(Object.hasOwn(optional,name))continue;throw new Error('缺少运行依赖 '+name+'；请在设计工程中安装依赖后重新试运行或发布。');}
      const real=await fs.realpath(dir);if(!within(modules,real))throw new Error('依赖路径越界：'+name);
      if(seen.has(dir.toLowerCase()))continue;seen.add(dir.toLowerCase());
      const metadata=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
      await fs.cp(dir,path.join(destination,path.relative(source,dir)),{recursive:true,filter:async file=>{
        if(file!==dir&&['node_modules','.git','.bin'].includes(path.basename(file)))return false;
        const stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new Error('依赖包含链接，请先在工程中安装实体依赖：'+name);
        if(stat.isFile()){bytes+=stat.size;if(++files>20000||bytes>256*1024*1024)throw new Error('运行依赖过大，发布上限为 256 MB');}return true;
      }});
      await visit(dir,metadata);
    }
  }
  await visit(source,root);return {packages:seen.size,bytes};
}
module.exports={copyDependencies};
