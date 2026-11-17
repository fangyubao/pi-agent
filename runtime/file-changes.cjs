'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ignored = new Set(['node_modules','.git','dist','.venv','.venv-eval','test-results','playwright-report']);
async function snapshot(cwd) {
  const files = new Map();
  let bytes = 0, limited = false;
  async function walk(dir, depth) {
    if (depth > 12 || files.size >= 1500) { limited = true; return; }
    for (const entry of await fs.readdir(dir, { withFileTypes:true }).catch(()=>[])) {
      if (entry.name.startsWith('.playwright-') || entry.name.startsWith('.agent-') || ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute, depth+1); continue; }
      if (!entry.isFile()) continue;
      if (files.size >= 1500) { limited = true; break; }
      const stat = await fs.stat(absolute).catch(()=>null);
      if (!stat) continue;
      if (stat.size > 256*1024 || bytes + stat.size > 12*1024*1024) { limited = true; files.set(path.relative(cwd,absolute), { size:stat.size, stamp:stat.mtimeMs, text:null }); continue; }
      const buffer = await fs.readFile(absolute).catch(()=>null);
      if (!buffer) continue;
      bytes += buffer.length;
      files.set(path.relative(cwd,absolute), { size:stat.size, hash:crypto.createHash('sha256').update(buffer).digest('hex'), text:buffer.includes(0)?null:buffer.toString('utf8') });
    }
  }
  await walk(cwd,0);
  return { cwd,files,limited };
}
function compare(before,after) {
  const changes=[];
  for (const name of new Set([...before.files.keys(),...after.files.keys()])) {
    const a=before.files.get(name),b=after.files.get(name);
    if (a&&b&&(a.hash&&b.hash?a.hash===b.hash:a.size===b.size&&a.stamp===b.stamp)) continue;
    changes.push({path:name,cwd:before.cwd,operation:!a?'新增':!b?'删除':'修改',before:a?.text??(a?null:''),after:b?.text??(b?null:''),binary:Boolean(a&&a.text===null||b&&b.text===null)});
  }
  return { files:changes.slice(0,40).map(x=>({...x,before:x.before?.slice(0,64000)??null,after:x.after?.slice(0,64000)??null,truncated:(x.before?.length||0)>64000||(x.after?.length||0)>64000})),limited:before.limited||after.limited||changes.length>40,total:changes.length };
}
async function persist(directory,report) {
  await fs.mkdir(directory,{recursive:true});
  const id=crypto.randomUUID(),file=path.join(directory,id+'.json');
  await fs.writeFile(file,JSON.stringify(report),'utf8');
  const records=await Promise.all((await fs.readdir(directory)).filter(x=>/^[\da-f-]{36}\.json$/.test(x)).map(async name=>({name,...await fs.stat(path.join(directory,name))})));
  records.sort((a,b)=>b.mtimeMs-a.mtimeMs);
  let bytes=0;
  for(let i=0;i<records.length;i++){bytes+=records[i].size;if((i>=100||bytes>64*1024*1024)&&records[i].name!==id+'.json')await fs.unlink(path.join(directory,records[i].name));}
  return {...report,files:report.files.map(({before,after,...meta},index)=>({...meta,reviewId:id,index}))};
}
async function readFileReview(directory,id,index) {
  if(!/^[\da-f-]{36}$/.test(String(id))||!Number.isInteger(index)||index<0||index>=40)throw new Error('无效的变更记录');
  let report;try{report=JSON.parse(await fs.readFile(path.join(directory,id+'.json'),'utf8'));}catch{throw new Error('此变更快照已过期或不存在（最多保留 100 轮 / 64 MB）');}
  if(!report.files[index])throw new Error('文件变更不存在');
  return report.files[index];
}
module.exports={snapshot,compare,persist,readFileReview};
