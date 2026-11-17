'use strict';
// Run a workbench's own backend tests in a disposable copy, without touching its
// saved sessions, credentials or editable source. All SSH fixtures use loopback.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {copyDependencies}=require('../runtime/workbench-dependencies.cjs');
async function main(){
  const source=path.resolve(process.argv[2]||'');
  if(!process.argv[2])throw new Error('Provide the workbench source directory');
  const base=path.resolve(os.tmpdir()),scratch=await fs.mkdtemp(path.join(base,'pi-workbench-verification-'));
  try{
    for(const name of ['ui','server','tests','manifest.json','package.json'])await fs.cp(path.join(source,name),path.join(scratch,name),{recursive:true});
    await copyDependencies(source,scratch);
    // The original connection-failure test uses a documentation-only IP; avoid
    // accessing any external address and use an unused loopback port instead.
    const failureFile=path.join(scratch,'tests','backend.test.cjs');
    const original=await fs.readFile(failureFile,'utf8').catch(()=>null);
    if(original){const net=require('node:net'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
      await fs.writeFile(failureFile,original.replace("host: '203.0.113.9', port: 22",`host: '127.0.0.1', port: ${port}`));
    }
    const files=(await fs.readdir(path.join(scratch,'tests'))).filter(x=>x.endsWith('.test.cjs')).map(x=>'tests/'+x);
    const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--test',...files],{cwd:scratch,stdio:'inherit',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});p.once('error',reject);p.once('exit',resolve);});
    process.exitCode=code??1;
  }finally{
    if(path.dirname(scratch)!==base||!path.basename(scratch).startsWith('pi-workbench-verification-'))throw new Error('Unexpected cleanup path');
    await fs.rm(scratch,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
