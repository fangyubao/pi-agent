'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function atomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.pending';
  const handle = await fs.open(temp, 'w');
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}
function createStateStore(root) {
  let queue = Promise.resolve();
  let recovered=false, writes=0;
  const known = new Set();
  async function loadManifest(name) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    async function read(key) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('本地存储索引损坏');
      const data = await fs.readFile(path.join(root, 'objects', key + '.json'), 'utf8');
      if (hash(data) !== key) throw new Error('本地存储内容校验失败');
      known.add(key); return JSON.parse(data);
    }
    const state = await read(manifest.state);
    state.projects = await Promise.all(manifest.projects.map(async project => ({ ...await read(project.meta), tasks: await Promise.all(project.tasks.map(read)) })));
    return { state, mirrorHash: manifest.mirrorHash, revision: manifest.revision };
  }
  async function load() {
    await queue;
    try { return { ...await loadManifest('current.json'), recovered: false }; }
    catch (error) {
      try { const value=await loadManifest('previous.json');recovered=true;return { ...value, recovered: true, warning: '最近一次保存不完整，已恢复上一个完整版本。' }; }
      catch (previousError) {
        if (error.code === 'ENOENT'&&previousError.code==='ENOENT') {
          const manifests=await Promise.all(['current.json','previous.json'].map(name=>fs.stat(path.join(root,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;})));
          if(manifests.every(value=>!value))return {state:null};
        }
        throw new Error('聊天存储无法恢复；原文件已保留：' + error.message);
      }
    }
  }
  function save(state, mirrorHash = '') {
    const operation = queue.catch(() => {}).then(async () => {
      if (state?.schema !== 2 || !Array.isArray(state.projects)) throw new Error('聊天数据格式无效');
      let changed = 0;
      const writing=new Map();
      async function put(value) {
        const text = JSON.stringify(value), key = hash(text);
        if (!known.has(key)) {if(!writing.has(key))writing.set(key,atomic(path.join(root, 'objects', key + '.json'), text).then(()=>{known.add(key);changed++;}));await writing.get(key);}
        return key;
      }
      const { projects, ...meta } = state;
      const manifest = { schema: 1, revision: Date.now(), mirrorHash, state: await put(meta), projects: [] };
      for (const project of projects) {
        const { tasks, ...projectMeta } = project;
        manifest.projects.push({ meta: await put(projectMeta), tasks: await Promise.all(tasks.map(put)) });
      }
      let previous;
      try { previous = await fs.readFile(path.join(root, 'current.json'), 'utf8'); JSON.parse(previous); } catch {}
      if (previous&&!recovered) await atomic(path.join(root, 'previous.json'), previous);
      await atomic(path.join(root, 'current.json'), JSON.stringify(manifest));
      recovered=false;
      if(++writes%40===0){
        const keep=new Set([manifest.state,...manifest.projects.flatMap(p=>[p.meta,...p.tasks])]);
        try{const older=JSON.parse(await fs.readFile(path.join(root,'previous.json'),'utf8'));keep.add(older.state);for(const p of older.projects)for(const k of [p.meta,...p.tasks])keep.add(k);}catch{}
        const objects=path.resolve(root,'objects');
        for(const entry of await fs.readdir(objects)){if(!/^[a-f0-9]{64}\.json$/.test(entry)||keep.has(entry.slice(0,-5)))continue;const target=path.resolve(objects,entry);if(path.dirname(target)!==objects)throw new Error('存储清理路径越界');await fs.unlink(target);known.delete(entry.slice(0,-5));}
      }
      return { revision: manifest.revision, changed };
    });
    queue = operation; return operation;
  }
  return { load, save, flush: () => queue };
}
module.exports = { createStateStore, hash };
