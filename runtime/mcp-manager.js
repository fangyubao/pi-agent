'use strict';
// MCP 页面：添加服务器、启用/停用、测试连接、删除。所有读写经 window.piDesktop.mcp（主进程负责加密与启动）。
window.PiMcpManager = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = () => window.piDesktop?.mcp;
  let servers = [], tests = new Map(), editing = null, root = null, notify = () => {};

  const PRESETS = [
    { label: '文件系统', name: '文件系统', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\你的目录'], note: '让 Agent 读写你指定的目录。请把最后一项换成真实路径。' },
    { label: '网页抓取', name: '网页抓取', command: 'uvx', args: ['mcp-server-fetch'], note: '抓取网页并转成文本。需要已安装 uv。' }
  ];

  async function refresh() {
    const r = await api()?.list();
    servers = r?.ok ? r.result : [];
    if (r && !r.ok) notify('读取 MCP 列表失败：' + r.error);
    draw();
  }

  function card(s) {
    const t = tests.get(s.id);
    let result = '';
    if (t?.busy) result = '<span class="mcp-note">正在连接…</span>';
    else if (t?.error) result = '<p class="mcp-error" role="alert">连接失败：' + esc(t.error) + '</p>';
    else if (t?.tools) result = '<details class="mcp-tools"' + (t.tools.length <= 6 ? ' open' : '') + '><summary>已连接 · ' + esc(t.server) + ' · ' + t.tools.length + ' 个工具</summary><ul>' + t.tools.map(x => '<li><strong>' + esc(x.name) + '</strong><span>' + esc(x.description) + '</span></li>').join('') + '</ul></details>';
    const cmd = [s.command, ...s.args].join(' ');
    return '<article class="mcp-card' + (s.enabled ? ' on' : '') + '" data-id="' + esc(s.id) + '">' +
      '<header><div><h3>' + esc(s.name) + '</h3><code class="mcp-cmd" title="将要执行的完整命令">' + esc(cmd) + '</code></div>' +
      '<label class="toggle" title="' + (s.enabled ? '已启用：Agent 可以请求调用它的工具（每次都需要你批准）' : '未启用') + '"><input type="checkbox" data-mcp-toggle aria-label="启用 ' + esc(s.name) + '"' + (s.enabled ? ' checked' : '') + '><span></span></label></header>' +
      (s.envKeys.length ? '<p class="mcp-env">环境变量：' + s.envKeys.map(e => esc(e.key) + (e.set ? '（已设置）' : '（空）')).join('、') + '</p>' : '') +
      result +
      '<footer><button type="button" class="button" data-mcp-test>测试连接</button><button type="button" class="button" data-mcp-edit>编辑</button><button type="button" class="button danger" data-mcp-remove>删除</button></footer></article>';
  }

  function form() {
    const s = editing && editing !== 'new' ? servers.find(x => x.id === editing) : null;
    // 已设置的密钥只显示变量名（值留空 = 保持原值），绝不回显。
    const env = s ? s.envKeys.map(e => e.key + '=').join('\n') : '';
    return '<form class="mcp-form" id="mcp-form" autocomplete="off"><h3>' + (s ? '编辑服务器' : '添加服务器') + '</h3>' +
      '<label>名称<input name="name" required maxlength="40" value="' + esc(s?.name || '') + '" placeholder="例如：文件系统"></label>' +
      '<label>启动命令<input name="command" required value="' + esc(s?.command || '') + '" placeholder="npx"></label>' +
      '<label>参数（每行一个）<textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;C:\\你的目录">' + esc((s?.args || []).join('\n')) + '</textarea></label>' +
      '<label>环境变量（每行 名称=值；值留空表示保持原来的）<textarea name="env" rows="3" placeholder="API_KEY=…">' + esc(env) + '</textarea></label>' +
      '<p class="mcp-warn">⚠ 启动命令会在你的电脑上运行，只添加你信任的服务器。新添加的服务器默认不启用；修改命令后也会自动停用。</p>' +
      '<div class="mcp-form-actions"><button type="button" class="button" data-mcp-cancel>取消</button><button type="submit" class="button primary">保存</button></div></form>';
  }

  function draw() {
    if (!root) return;
    const presets = PRESETS.map((p, i) => '<button type="button" class="button" data-mcp-preset="' + i + '" title="' + esc(p.note) + '">＋ ' + esc(p.label) + '</button>').join('');
    root.innerHTML = '<section class="section-page mcp-page"><div class="eyebrow">MODEL CONTEXT PROTOCOL</div><h1 class="page-heading">MCP</h1>' +
      '<p class="intro">给 Agent 接入外部工具：文件、数据库、搜索等。启用后 Agent 可以调用它们，<strong>每一次调用都会先请求你批准</strong>（完全批准模式除外）。</p>' +
      '<div class="mcp-toolbar"><button type="button" class="button primary" data-mcp-new>＋ 添加服务器</button>' + presets + '</div>' +
      (editing ? form() : '') +
      '<div class="mcp-list">' + (servers.length ? servers.map(card).join('') : '<div class="empty-state mcp-empty">还没有 MCP 服务器<br>点「添加服务器」，或从上面的常用项开始。</div>') + '</div></section>';
  }

  const parseLines = text => String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  function parseEnv(text) {
    const env = {};
    for (const line of parseLines(text)) {
      const i = line.indexOf('=');
      if (i < 1) throw new Error('环境变量格式应为 名称=值：' + line);
      env[line.slice(0, i).trim()] = line.slice(i + 1);
    }
    return env;
  }

  async function onClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.closest('.mcp-card')?.dataset.id;
    if (b.matches('[data-mcp-new]')) { editing = 'new'; draw(); root.querySelector('[name="name"]')?.focus(); }
    else if (b.matches('[data-mcp-preset]')) {
      const p = PRESETS[Number(b.dataset.mcpPreset)]; editing = 'new'; draw();
      const f = root.querySelector('#mcp-form'); f.elements.name.value = p.name; f.elements.command.value = p.command; f.elements.args.value = p.args.join('\n');
    }
    else if (b.matches('[data-mcp-cancel]')) { editing = null; draw(); }
    else if (b.matches('[data-mcp-edit]')) { editing = id; draw(); }
    else if (b.matches('[data-mcp-remove]')) {
      const s = servers.find(x => x.id === id);
      if (!window.confirm('删除服务器「' + (s?.name || '') + '」？它保存的密钥也会一并删除。')) return;
      const r = await api().remove({ id }); if (!r.ok) notify(r.error);
      tests.delete(id); await refresh();
    }
    else if (b.matches('[data-mcp-test]')) {
      tests.set(id, { busy: true }); draw();
      const r = await api().test({ id });
      tests.set(id, r.ok ? r.result : { error: r.error }); draw();
    }
  }

  async function onChange(e) {
    const box = e.target.closest('[data-mcp-toggle]'); if (!box) return;
    const id = box.closest('.mcp-card').dataset.id, s = servers.find(x => x.id === id);
    if (box.checked && !window.confirm('启用后，Agent 可以请求调用这个服务器的工具（每次调用仍需你批准）。\n\n它会在你的电脑上运行：\n' + [s.command, ...s.args].join(' ') + '\n\n确认启用？')) { box.checked = false; return; }
    const r = await api().setEnabled({ id, enabled: box.checked });
    if (!r.ok) notify(r.error);
    await refresh();
  }

  async function onSubmit(e) {
    const f = e.target.closest('#mcp-form'); if (!f) return;
    e.preventDefault();
    try {
      const input = { name: f.elements.name.value, command: f.elements.command.value, args: parseLines(f.elements.args.value), env: parseEnv(f.elements.env.value) };
      if (editing && editing !== 'new') input.id = editing;
      const r = await api().save(input);
      if (!r.ok) { notify(r.error); return; }
      editing = null; notify('已保存。新服务器默认未启用，确认无误后请手动打开开关。'); await refresh();
    } catch (error) { notify(error.message); }
  }

  function mount(container, options = {}) {
    notify = options.notify || notify;
    if (root !== container) { root = container; root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('submit', onSubmit); }
    editing = null; draw(); void refresh();
  }
  return Object.freeze({ mount, parseEnv, parseLines });
})();
