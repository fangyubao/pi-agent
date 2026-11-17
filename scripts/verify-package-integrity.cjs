'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
async function main(){
  const root=path.resolve(__dirname,'..'),resources=path.resolve(process.argv[2]||path.join(root,'dist/win-unpacked/resources')),archive=path.join(resources,'app.asar');let checked=0;
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  async function visit(relative){
    const file=path.join(root,relative),stat=await fs.stat(file);
    if(stat.isDirectory()){for(const name of await fs.readdir(file))await visit(path.join(relative,name));return;}
    if(relative.endsWith('.test.cjs'))return;
    const packed=asar.extractFile(archive,relative),source=await fs.readFile(file);if(hash(packed)!==hash(source))throw new Error('安装包文件不同于源码：'+relative);checked++;
  }
  for(const entry of ['bootstrap.cjs','app.js','main.cjs','preload.cjs','index.html','styles.css','README.md','DESIGN.md','runtime','contexts','plugins','workbenches'])await visit(entry);
  const metadata=JSON.parse(await fs.readFile(path.join(resources,'runtime/runtime.json'),'utf8')),nodeHash=hash(await fs.readFile(path.join(resources,'runtime/node.exe')));
  if(metadata.sha256!==nodeHash)throw new Error('内置 Node 校验不匹配');
  const pi=JSON.parse(await fs.readFile(path.join(resources,'pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8'));
  if(pi.version!==metadata.pi)throw new Error('内置 Pi 版本不匹配');
  console.log(JSON.stringify({ok:true,files:checked,node:metadata.node,pi:pi.version,nodeSha256:nodeHash},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
