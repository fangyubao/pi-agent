'use strict';
// Node workers load unpacked files directly; Electron's virtual ASAR resolution
// cannot rescue a missing relative dependency. Verify the physical install tree.
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
  const resources=path.resolve(process.argv[2]||'dist/win-unpacked/resources');
  const root=path.join(resources,'app.asar.unpacked');
  const runtime=require(path.join(root,'runtime','workbench-runtime.cjs'));
  const entries=await fs.readdir(path.join(root,'workbenches'),{withFileTypes:true});
  let checked=0;
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const dir=path.join(root,'workbenches',entry.name);
    if(!await fs.stat(path.join(dir,'manifest.json')).catch(()=>null))continue;
    const result=await runtime.inspectPath(dir);
    if(result.health.status==='error')throw new Error(entry.name+': '+result.health.issues.join('; '));
    checked++;console.log('PASS packaged backend: '+entry.name);
  }
  if(!checked)throw new Error('No packaged workbenches found');
  console.log('Verified '+checked+' packaged workbench backends and their actual dependencies');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
