'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
module.exports=async function checkRuntime(context){
  const resources=path.join(context.appOutDir,'resources'),runtime=path.join(resources,'pi-runtime/node_modules/@earendil-works/pi-coding-agent'),node=path.join(resources,'runtime/node.exe');
  for(const file of [node,path.join(runtime,'package.json'),path.join(runtime,'dist/cli.js'),path.join(runtime,'dist/modes/rpc/rpc-client.js')])await fs.access(file);
  const result=await promisify(execFile)(node,[path.join(runtime,'dist/cli.js'),'--version'],{windowsHide:true,timeout:60000,env:{...process.env,NODE_OPTIONS:''}});
  const expected=JSON.parse(await fs.readFile(path.join(resources,'runtime/runtime.json'),'utf8'));if(result.stdout.trim()!==expected.pi)throw new Error('安装包 Pi 运行时版本不匹配');
  console.log('Packaged runtime verified: Node '+expected.node+', Pi '+expected.pi);
};
