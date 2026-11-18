'use strict';
// 工作路径相关的纯逻辑：默认路径、工作流文件落盘、从对话记录里归纳“用过哪些文件夹”。
// 目标：用户永远知道文件在哪儿——每个任务有明确的工作路径，工作流的文件固定在其下的 workflow/ 文件夹。
const fs = require('node:fs/promises');
const path = require('node:path');
const xlsx = require('./xlsx-lite.cjs');
const extractTable = output => require('./workflow-table.js').extract(output);

const safe = s => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 60) || '未命名';

// 每个节点一个文件夹：workflow/<节点编号>-<标题>/，节点的结果、表格、模型生成的附件、用户给它的附件（inputs/）都放在里面。
const nodeFolder = n => String(n.id) + '-' + safe(n.title);

// 应用管理的默认位置：<文档>/Pi Workbench/<项目名>/<任务名>。用户可以在新建时改选别的文件夹。
function defaultPath(documentsDir, projectName, taskName) {
  return path.join(documentsDir, 'Pi Workbench', safe(projectName), taskName ? safe(taskName) : '');
}

async function ensureDir(dir) {
  if (!path.isAbsolute(dir) || /\.asar(?:[\\/]|$)/i.test(dir)) throw new Error('需要一个本地文件夹的完整路径');
  await fs.mkdir(dir, { recursive: true });
  if (!(await fs.stat(dir)).isDirectory()) throw new Error('不是文件夹：' + dir);
  return path.resolve(dir);
}

// 节点文件夹的“身份”是 uid，名字（编号-标题）只是显示。编号会随增删节点重排、标题会被改，
// 所以用 workflow/.folders.json 记 uid → 上次的文件夹名；名字变了就把整个文件夹（含用户附件 inputs/、模型产出的文件）改名过去。
// 多个节点互换名字（A↔B）时先全部改成临时名再改回，避免互相覆盖。只动清单里登记过的文件夹，用户自己建的文件夹不碰。
const isPlainName = n => typeof n === 'string' && n && !/[\\/]/.test(n) && n !== '.' && n !== '..' && !n.startsWith('.');
async function migrateFolders(dir, nodes) {
  const file = path.join(dir, '.folders.json');
  const before = await fs.readFile(file, 'utf8').then(t => JSON.parse(t), () => ({}));
  const known = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const want = new Map(nodes.filter(n => n.uid).map(n => [n.uid, nodeFolder(n)]));
  const moves = [];
  for (const [uid, name] of want) { const old = known[uid]; if (isPlainName(old) && old !== name) moves.push({ uid, from: old, to: name }); }
  const exists = n => fs.stat(path.join(dir, n)).then(st => st.isDirectory(), () => false);
  const staged = [];
  for (const m of moves) {                                                    // 第一步：搬到临时名
    if (!(await exists(m.from))) continue;
    const tmp = '.moving-' + m.uid;
    await fs.rename(path.join(dir, m.from), path.join(dir, tmp)).catch(() => null);
    if (await exists(tmp)) staged.push({ ...m, tmp });
  }
  for (const m of staged) {                                                   // 第二步：搬到目标名；目标已被别的（未登记的）同名文件夹占用时，合并进去而不覆盖
    if (await exists(m.to)) {
      for (const e of await fs.readdir(path.join(dir, m.tmp))) { const dst = path.join(dir, m.to, e); if (!(await fs.stat(dst).then(() => true, () => false))) await fs.rename(path.join(dir, m.tmp, e), dst).catch(() => null); }
      await fs.rm(path.join(dir, m.tmp), { recursive: true, force: true }).catch(() => null);
    } else await fs.rename(path.join(dir, m.tmp), path.join(dir, m.to)).catch(() => null);
  }
  const next = {}; for (const [uid, name] of want) next[uid] = name;
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 把工作流写到 <root>/workflow/，按结果的真实形态选文件格式（不是一律 .md）：
//   · 结果里有表格（Markdown 表格 / CSV）→ 表格另存 <id>-<标题>/<标题>.xlsx（Excel/WPS 直接打开）；
//     整段几乎就是表格 → 只出 .xlsx，不再留一份难读的 .md；表格只是长文里的一部分 → .xlsx 与 .md 都出
//   · 其他 → <id>-<标题>/结果.md
//   · plan.md（给人看的计划）、plan.json（完整数据）
//   · options.view：可选的 HTML 交互视图。传入 { render(data)->string }，会写到 workflow/index.html（顶层，最先看到）；
//     没传或 enabled=false 时不生成，并且会删掉以前生成过的 index.html，避免留下过期的页面。
// 只写这个子文件夹；返回写出的文件与每个节点实际生成的文件，方便界面提示“已保存到哪里”。
async function writeWorkflow(root, state, options = {}) {
  const dir = path.join(await ensureDir(root), 'workflow');
  await fs.mkdir(dir, { recursive: true });
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const files = [], perNode = {};
  const put = async (rel, data) => { await fs.writeFile(path.join(dir, rel), data, typeof data === 'string' ? 'utf8' : undefined); files.push(path.join(dir, rel)); };
  const lines = ['# ' + (state?.goal || '工作流'), ''];
  const lb = (() => { try { return require('./model-leaderboard.js'); } catch { return null; } })();
  for (const n of nodes) {
    const domInfo = lb && typeof lb.inferDomains === 'function' ? lb.inferDomains(n) : null;
    const basis = (n.model && (n.model.reason || n.model.cardBasis)) || (domInfo ? domInfo.tendency + '（' + domInfo.basisText + '）' : '');
    lines.push('## ' + n.id + ' · ' + n.title, '', '- 角色：' + n.role, '- 模型：' + (n.model ? n.model.model : '主模型') + (basis ? ' ｜ ' + basis : ''), '- 依赖：' + (n.dependsOn.length ? n.dependsOn.join('、') : '无'), '- 状态：' + ({ done: '已运行', error: '失败', stale: '结果已过期', running: '运行中' }[n.run?.status] || '未运行'), '', n.brief, '');
  }
  await put('plan.json', JSON.stringify({ goal: state?.goal || '', revision: state?.revision || 0, nodes: nodes.map(({ run, ...rest }) => rest) }, null, 2));
  await migrateFolders(dir, nodes);
  // 节点自己产出的文件（模型按交付类型生成，run-node 已写进节点文件夹）：只登记磁盘上真实存在的，供 index.html 引用与 plan.md 列出。
  const artsOf = {};
  for (const n of nodes) {
    const list = Array.isArray(n.run?.artifacts) ? n.run.artifacts : [], folder = nodeFolder(n), found = [];
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || a.name !== path.basename(a.name) || a.name.startsWith('.')) continue;
      const st = await fs.stat(path.join(dir, folder, a.name)).catch(() => null);
      if (st && st.isFile()) found.push({ name: a.name, kind: a.kind, path: folder + '/' + a.name, bytes: st.size });
    }
    artsOf[n.id] = found;
  }
  const keep = new Set();
  for (const n of nodes) {
    if (!n.run || !['done', 'stale'].includes(n.run.status) || !n.run.output) continue;
    const folder = nodeFolder(n), table = extractTable(n.run.output), out = { md: null, xlsx: null, table: null };
    await fs.mkdir(path.join(dir, folder), { recursive: true });
    if (table) {
      out.table = { head: table.head, rows: table.rows };
      out.xlsx = folder + '/' + safe(n.title) + '.xlsx'; keep.add(out.xlsx);
      await put(out.xlsx, xlsx.buildXlsx(table, { sheetName: n.title }));
    }
    if (!table || !table.coversMost) {
      out.md = folder + '/结果.md'; keep.add(out.md);
      await put(out.md, '# ' + n.title + '\n\n' + (n.run.status === 'stale' ? '> 上游已修改，这是旧结果。\n\n' : '') + n.run.output + '\n');
    }
    perNode[n.id] = out;
  }
  // 只清理“上次由本程序写出”的文件（清单 workflow/.written.json，路径相对 workflow/）；用户自己放进来的文件、模型生成的附件永远不碰。
  // 兼容旧版：旧清单在 results/.written.json（文件直接放在 results/ 下）。清掉后空文件夹也顺手删掉。
  const manifestPath = path.join(dir, '.written.json'), legacyPath = path.join(dir, 'results', '.written.json');
  const readList = async f => { const v = await fs.readFile(f, 'utf8').then(t => JSON.parse(t), () => null); return Array.isArray(v) ? v : []; };
  const stale = [...(await readList(manifestPath)), ...(await readList(legacyPath)).map(f => 'results/' + f)];
  const okRel = f => typeof f === 'string' && f && !f.startsWith('/') && !f.split('/').some(x => x === '..' || x === '') && !f.includes('\\');
  for (const f of stale) if (okRel(f) && !keep.has(f)) {
    await fs.rm(path.join(dir, ...f.split('/')), { force: true });
    const parent = path.dirname(path.join(dir, ...f.split('/')));
    if (parent !== dir) await fs.rmdir(parent).catch(() => {});                                    // 只删空文件夹（rmdir 遇到非空会失败，正好）
  }
  await fs.rm(legacyPath, { force: true }); await fs.rmdir(path.join(dir, 'results')).catch(() => {});
  await fs.writeFile(manifestPath, JSON.stringify([...keep].sort()), 'utf8');
  for (const n of nodes) {
    const i = lines.findIndex(l => l.startsWith('## ' + n.id + ' · '));
    const extra = [];
    if ((n.inputs || []).length) extra.push('- 输入附件：' + n.inputs.map(x => x.name).join('、'));
    if ((artsOf[n.id] || []).length) extra.push('- 产出文件：' + artsOf[n.id].map(a => '[' + a.name + '](' + encodeURI(a.path) + ')').join('、'));
    if (i >= 0 && extra.length) { let j = i + 1; while (j < lines.length && !lines[j].startsWith('## ')) j++; lines.splice(j, 0, ...extra, ''); }
  }
  await put('plan.md', lines.join('\n'));
  const view = options.view;
  if (view && view.enabled !== false && typeof view.render === 'function') {
    const data = {
      goal: String(state?.goal || ''), generatedAt: Date.now(), digest: view.digest || null,
      nodes: nodes.map(n => ({ id: n.id, title: n.title, agent: n.agent || '', role: n.role, brief: n.brief, tier: n.tier, effort: n.effort || null, dependsOn: n.dependsOn || [],
        status: n.run?.status || 'todo', model: n.run?.model || (n.model ? n.model.model : null), output: n.run?.output || '', error: n.run?.error || '',
        table: perNode[n.id]?.table || null, inputs: n.inputs || [], files: { md: perNode[n.id]?.md || null, xlsx: perNode[n.id]?.xlsx || null, items: artsOf[n.id] || [] } }))
    };
    await put('index.html', view.render(data));
  } else await fs.rm(path.join(dir, 'index.html'), { force: true });
  return { dir, files, perNode, artifacts: artsOf };
}

// 一次聊天“用到了哪些文件夹”：工作路径 + 对话里工具读写过的文件所在的文件夹（相对路径按工作路径解析）。去重，工作路径排第一。
function foldersUsed(workspace, messages) {
  const out = new Map();
  const add = (dir, why) => { if (!dir) return; const key = path.resolve(dir).toLowerCase(); if (!out.has(key)) out.set(key, { path: path.resolve(dir), why: new Set() }); out.get(key).why.add(why); };
  if (workspace) add(workspace, '工作路径');
  for (const m of messages || []) for (const s of m.run?.steps || []) {
    if (s.kind !== 'tool' || !s.target) continue;
    if (!/[\\/]/.test(s.target) && /\s/.test(s.target)) continue;                                  // 命令行文本不当作路径
    if (!/[\\/]|\.[A-Za-z0-9]{1,6}$/.test(s.target)) continue;
    const abs = path.isAbsolute(s.target) ? s.target : workspace ? path.join(workspace, s.target) : '';
    if (!abs) continue;
    add(path.extname(abs) ? path.dirname(abs) : abs, s.label || s.tool || '文件');
  }
  return [...out.values()].map(x => ({ path: x.path, why: [...x.why].slice(0, 3).join('、'), primary: !!workspace && path.resolve(workspace) === x.path })).slice(0, 12);
}

// 找回旧聊天用过的文件夹：每次运行都记了当时的工作目录（run.cwd）。程序自己的目录（安装目录、userData\workspace）不算，
// 因为那不是这个聊天“自己的”文件夹。按最近使用排序，去重。
function recoverFolders(messages, exclude = []) {
  const skip = exclude.filter(Boolean).map(p => path.resolve(p).toLowerCase());
  const seen = new Map();
  (messages || []).forEach((m, i) => {
    const dir = m && m.run && m.run.cwd;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
    const key = path.resolve(dir).toLowerCase();
    if (skip.includes(key)) return;                                  // 只排除这些目录本身；它们下面的子文件夹可能是用户自己建的
    const hit = seen.get(key) || { path: path.resolve(dir), count: 0, last: 0 };
    hit.count++; hit.last = i; seen.set(key, hit);
  });
  return [...seen.values()].sort((a, b) => b.last - a.last).slice(0, 6);
}

// 文件/文件夹右键菜单要操作的路径：把聊天里显示的路径（可能是相对的）按所在目录解析成绝对路径，并检查是否在“允许的根”之内。
// 允许的根 = 这个聊天的工作文件夹 + 聊天里实际用到的文件夹。不在其内的路径一律拒绝——聊天里的文字可能来自模型或网页，不能借它去打开任意位置。
function resolveTarget(target, base, roots) {
  const raw = String(target ?? '').trim();
  if (!raw || /[\u0000-\u001f]/.test(raw)) return { ok: false, error: '路径为空或包含非法字符' };
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.startsWith('\\\\')) return { ok: false, error: '不支持网络或特殊路径' };
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : base ? path.resolve(base, raw) : '';
  if (!abs) return { ok: false, error: '无法确定相对路径的位置（这个聊天还没有工作文件夹）' };
  const inside = (child, root) => { const c = child.toLowerCase(), r = path.resolve(root).toLowerCase(); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
  if (!(roots || []).filter(Boolean).some(r => inside(abs, r))) return { ok: false, error: '这个位置不在当前聊天用到的文件夹里，出于安全不能从这里打开' };
  return { ok: true, path: abs };
}

// 在 resolveTarget 的字符串检查通过后再做一次“真实路径”检查：符号链接/目录联接不能把允许的根指到别处。
// 目标不存在时（如复制一个尚未生成的路径）退回检查最近的已存在上级目录。
async function realInside(abs, roots) {
  const real = async p => { let cur = p; for (let i = 0; i < 40; i++) { try { return path.join(await fs.realpath(cur), path.relative(cur, p)); } catch { const up = path.dirname(cur); if (up === cur) return p; cur = up; } } return p; };
  const target = (await real(abs)).toLowerCase();
  for (const r of roots || []) {
    if (!r) continue;
    const root = (await real(path.resolve(r))).toLowerCase();
    if (target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
  }
  return false;
}

module.exports = { migrateFolders, nodeFolder, realInside, resolveTarget, recoverFolders, safe, defaultPath, ensureDir, writeWorkflow, foldersUsed };
