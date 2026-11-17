'use strict';
// MCP 服务器配置的存取。要点：
//  1) 新添加的服务器默认 enabled=false，必须由用户手动启用；
//  2) 环境变量里的值（常含 API Key）用系统安全存储加密落盘，对界面只返回“已设置”，永不回显；
//  3) 启动命令与参数以明文保存并原样展示给用户，让用户看清将要执行什么。
// 加解密函数由调用方注入（main.cjs 传入 safeStorage），本模块不依赖 Electron，方便单测。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SERVERS = 24, MAX_ARGS = 40, MAX_ENV = 40;
const NAME_RE = /^[\p{L}\p{N}_ .-]{1,40}$/u;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);

function normalizeInput(input = {}) {
  const name = clean(input.name, 40).trim();
  if (!NAME_RE.test(name)) throw new Error('名称只能包含字母、数字、空格、下划线、点和连字符（最多 40 字）');
  const command = clean(input.command, 400).trim();
  if (!command) throw new Error('请填写启动命令，例如 npx');
  const args = (Array.isArray(input.args) ? input.args : []).slice(0, MAX_ARGS).map(a => clean(a, 600));
  const env = {};
  for (const [key, value] of Object.entries(input.env && typeof input.env === 'object' ? input.env : {}).slice(0, MAX_ENV)) {
    if (!ENV_KEY_RE.test(key)) throw new Error('环境变量名不合法：' + key);
    env[key] = value === null ? null : clean(value, 4000);           // null = 删除；空串 = 保持不变（见 save）
  }
  return { name, command, args, env, cwd: clean(input.cwd, 500).trim() };
}

function createStore({ file, encrypt, decrypt }) {
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  async function readAll() { try { const raw = JSON.parse(await fs.readFile(file, 'utf8')); return Array.isArray(raw.servers) ? raw.servers : []; } catch { return []; } }
  async function writeAll(servers) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify({ schema: 1, servers }, null, 2), 'utf8'); await fs.rename(tmp, file);
  }
  const publicView = server => ({ id: server.id, name: server.name, command: server.command, args: server.args, cwd: server.cwd || '', enabled: Boolean(server.enabled), envKeys: Object.keys(server.env || {}).map(key => ({ key, set: Boolean(server.env[key]) })), createdAt: server.createdAt, updatedAt: server.updatedAt });

  return {
    async list() { return (await readAll()).map(publicView); },
    save(input) {
      return serial(async () => {
        const fields = normalizeInput(input), servers = await readAll();
        const existing = input.id ? servers.find(s => s.id === input.id) : null;
        if (input.id && !existing) throw new Error('找不到要修改的服务器');
        if (!existing && servers.length >= MAX_SERVERS) throw new Error('最多保存 ' + MAX_SERVERS + ' 个服务器');
        if (servers.some(s => s.name === fields.name && s.id !== existing?.id)) throw new Error('已有同名服务器：' + fields.name);
        const env = { ...(existing?.env || {}) };
        for (const [key, value] of Object.entries(fields.env)) {
          if (value === null) delete env[key];
          else if (value !== '') env[key] = encrypt(value);          // 非空 = 设置/更新；空串 = 保持原值，所以编辑时不必重新输入密钥
          else if (!(key in env)) env[key] = '';
        }
        const now = Date.now();
        const next = { id: existing?.id || 'mcp-' + crypto.randomBytes(6).toString('hex'), name: fields.name, command: fields.command, args: fields.args, cwd: fields.cwd, env,
          enabled: existing ? Boolean(existing.enabled) && JSON.stringify([existing.command, existing.args]) === JSON.stringify([fields.command, fields.args]) : false,   // 新建默认关闭；改了命令也要重新手动启用
          createdAt: existing?.createdAt || now, updatedAt: now };
        await writeAll(existing ? servers.map(s => (s.id === existing.id ? next : s)) : [...servers, next]);
        return publicView(next);
      });
    },
    setEnabled(id, enabled) {
      return serial(async () => { const servers = await readAll(); const s = servers.find(x => x.id === id); if (!s) throw new Error('找不到服务器'); s.enabled = Boolean(enabled); s.updatedAt = Date.now(); await writeAll(servers); return publicView(s); });
    },
    remove(id) { return serial(async () => { const servers = await readAll(); const next = servers.filter(s => s.id !== id); if (next.length === servers.length) throw new Error('找不到服务器'); await writeAll(next); return { ok: true }; }); },
    // 启动时才解密，仅供主进程使用；不经过 IPC 返回给界面。
    async resolveForLaunch(id) {
      const s = (await readAll()).find(x => x.id === id); if (!s) throw new Error('找不到服务器');
      const env = {}; for (const [key, value] of Object.entries(s.env || {})) if (value) env[key] = decrypt(value);
      return { id: s.id, name: s.name, command: s.command, args: s.args, cwd: s.cwd || undefined, env, enabled: Boolean(s.enabled) };
    }
  };
}
module.exports = { createStore, normalizeInput };
