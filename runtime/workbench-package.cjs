'use strict';
// 工作台包：校验、打包（发布/导出）、导入。
// 发布与导入共用同一套校验——它们的共同风险是：把一个目录里的 Node 代码登记成“可以运行的工作台”。
// 本模块只做“检查与复制”，不执行任何工作台代码，所以可以安全地对不受信任的包先检查再决定。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateManifest } = require('./workbench-protocol.cjs');

const LIMITS = { files: 400, bytes: 20 * 1024 * 1024, depth: 8, file: 4 * 1024 * 1024 };
const SKIP_DIRS = new Set(['node_modules', '.git', '.pi-design', 'dist', 'coverage']);
const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.css', '.html', '.txt', '.svg', '.map', '.yml', '.yaml', '.csv']);
const BINARY_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf']);
const within = (root, target) => { const r = path.resolve(root), t = path.resolve(target); return t === r || t.startsWith(r + path.sep); };
const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// 把 Agent 工程里常见的“入口写成传输层”纠正成宿主需要的形态，并给出可读的修复建议。
// 宿主要求：server.entry 是一个被 require 后导出 dispatch 的文件。
async function resolveServerEntry(root, manifest) {
  const declared = manifest.server.entry;
  const candidates = [declared, 'index.cjs', 'index.js'];
  for (const candidate of candidates) {
    const file = path.resolve(root, 'server', candidate);
    if (!within(path.join(root, 'server'), file)) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    if (/(^|[\\/])transport[\\/]/.test(candidate)) continue;            // 传输层文件 require 时会直接开始读 stdin，不能当入口
    return candidate;
  }
  return null;
}

async function walk(root, onFile) {
  let files = 0, bytes = 0;
  async function go(dir, depth) {
    if (depth > LIMITS.depth) throw new Error('目录层级过深（超过 ' + LIMITS.depth + ' 层）');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.pi-design') { if (entry.isDirectory() || entry.isSymbolicLink()) continue; }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('不允许符号链接：' + path.relative(root, full));          // 防止指向包外
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await go(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full);
      if (stat.size > LIMITS.file) throw new Error('单个文件过大：' + path.relative(root, full));
      if (++files > LIMITS.files) throw new Error('文件数量过多（超过 ' + LIMITS.files + '）');
      if ((bytes += stat.size) > LIMITS.bytes) throw new Error('整体体积过大（超过 20MB）');
      await onFile(full, path.relative(root, full).split(path.sep).join('/'), stat);
    }
  }
  await go(root, 0);
  return { files, bytes };
}

// 静态检查：只读文件内容，找出会让工作台在宿主里跑不起来、或明显越界的写法。
const RISKY = [
  { re: /child_process|\bspawn\(|\bexec(Sync)?\(|\bfork\(/, label: '会启动其他程序（child_process）', level: 'warn' },
  { re: /require\(['"]https?['"]\)|fetch\(\s*['"`]https?:|XMLHttpRequest|new WebSocket\(\s*['"`]wss?:/, label: '会访问网络', level: 'warn' },
  { re: /require\(['"](electron|node:electron)['"]\)/, label: '引用了 Electron（后端不允许）', level: 'error' },
  { re: /\bprocess\.(exit|kill)\(/, label: '会结束进程', level: 'warn' },
  { re: /\beval\(|new Function\(/, label: '使用了 eval / new Function', level: 'warn' },
  { re: /fs\.(rm|rmdir|unlink)(Sync)?\(\s*['"`](\/|[A-Za-z]:[\\/])/, label: '会删除绝对路径上的文件', level: 'error' }
];

async function inspectPackage(root, options = {}) {
  const issues = [];                   // { level: 'error' | 'warn', text }
  const add = (level, text) => issues.push({ level, text });
  let manifest = null, summary = { files: 0, bytes: 0 };
  try {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('目录不存在');
    let raw; try { raw = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')); } catch (e) { throw new Error('manifest.json 缺失或不是有效 JSON'); }
    try { manifest = validateManifest(raw, root); } catch (e) { throw new Error('manifest.json 不合规：' + e.message); }

    // UI 入口：内置工作台用 ui/index.js（注册式），Agent 工程用 ui/index.html（独立页面）。两种都支持，但必须存在。
    const uiFile = path.resolve(root, 'ui', manifest.ui.entry);
    if (!within(path.join(root, 'ui'), uiFile)) throw new Error('ui.entry 路径越界');
    if (!(await fs.stat(uiFile).catch(() => null))?.isFile()) add('error', '界面入口不存在：ui/' + manifest.ui.entry);
    const uiKind = /\.html?$/i.test(manifest.ui.entry) ? 'page' : 'module';

    const entry = await resolveServerEntry(root, manifest);
    if (!entry) add('error', '找不到可被宿主加载的后端入口：server/' + manifest.server.entry + ' 是传输层文件（require 时会直接读 stdin），请把 manifest.server.entry 改为导出 dispatch 的文件（通常是 index.cjs）');
    else if (entry !== manifest.server.entry) add('warn', 'manifest.server.entry 将由 “' + manifest.server.entry + '” 修正为 “' + entry + '”');
    if (!manifest.actions.length) add('error', 'manifest 没有声明任何动作（actions）');

    summary = await walk(root, async (full, rel) => {
      const ext = path.extname(rel).toLowerCase();
      if (!TEXT_EXT.has(ext) && !BINARY_OK.has(ext)) add('warn', '包含不常见的文件类型：' + rel);
      if (!TEXT_EXT.has(ext) || !rel.startsWith('server/') && !rel.startsWith('ui/')) return;
      if (/\.test\.|^tests\//.test(rel)) return;                                                   // 测试文件不会被宿主运行
      const text = await fs.readFile(full, 'utf8');
      for (const risk of RISKY) if (risk.re.test(text)) add(risk.level, rel + '：' + risk.label);
    });
    summary.uiKind = uiKind;
    if (!summary.files) add('error', '包是空的');
    if (options.requireTests) {
      const hasTests = await fs.stat(path.join(root, 'tests')).then(s => s.isDirectory()).catch(() => false);
      if (!hasTests) add('error', '没有 tests/ 目录：发布前需要后端测试');
    }
  } catch (error) { add('error', error.message); }
  return { ok: !issues.some(i => i.level === 'error'), issues, manifest, summary, serverEntry: manifest ? await resolveServerEntry(root, manifest).catch(() => null) : null };
}

// 复制工作台目录（只复制通过检查的、受限的文件），并把 manifest 规范化后写入目标。
async function copyPackage(from, to, { manifest, serverEntry, source = {} }) {
  await fs.mkdir(to, { recursive: true });
  await walk(from, async (full, rel) => {
    const target = path.resolve(to, rel);
    if (!within(to, target)) throw new Error('目标路径越界：' + rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(full, target);
  });
  const normalized = { ...JSON.parse(await fs.readFile(path.join(from, 'manifest.json'), 'utf8')), id: manifest.id, server: { ...manifest.server, entry: serverEntry || manifest.server.entry } };
  await fs.writeFile(path.join(to, 'manifest.json'), JSON.stringify(normalized, null, 2), 'utf8');
  await fs.writeFile(path.join(to, '.pi-package.json'), JSON.stringify({ schema: 1, source, installedAt: Date.now() }, null, 2), 'utf8');
}

module.exports = { inspectPackage, copyPackage, resolveServerEntry, slug, LIMITS, within };
