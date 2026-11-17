'use strict';
// 工作流结果视图：把整个工作流的产出渲染成一个单文件、离线、可交互的 HTML（workflow/index.html）。纯函数，不读写文件。
// 设计取舍：
//   1) 内容在生成时就渲染成静态 HTML（全部转义），脚本只负责“折叠/搜索/过滤/排序/高亮”这类交互。
//      这样：没有脚本也能读（打印、脚本被禁用时内容仍在）；模型文本从不经过 innerHTML；页面结构可以在 Node 里直接测。
//   2) 内联脚本是常量，与数据无关；数据只以 JSON 放在 type="application/json" 的数据块里（不执行）。
//      因此可以在 CSP 里用脚本哈希代替 'unsafe-inline'：即使某处转义出错，被注入的 <script> 也不会执行。
//   3) 脚本里用到的可纯函数化的逻辑（搜索区间、表格排序/筛选、TSV/CSV、过滤、上下游）写在 clientLib 里，
//      Node 测试直接调用同一份函数，浏览器里通过 toString 内联——两边是同一份代码，不会漂移。
//   4) L1 总览 → 流程图 → L2 卡片（一句话结论，展开看要点）→ L3 原文（再展开），对应 workflow-digest.js 的三层结构。
(function (root, factory) { const api = factory(root.PiWorkflowDigest || (typeof require === 'function' ? require('./workflow-digest.js') : null)); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiWorkflowView = api; })(typeof window === 'object' ? window : globalThis, digestLib => {
  const PALETTE = ['#b5522b', '#3d7a8a', '#6f8a3a', '#8a5ea8'], NO_AGENT = '#8a8178';
  const STATUS = {
    done: { label: '已完成', icon: '✓' }, stale: { label: '已过期', icon: '!' }, error: { label: '失败', icon: '×' },
    running: { label: '运行中', icon: '…' }, todo: { label: '未运行', icon: '○' }
  };
  const STATUS_ORDER = ['done', 'stale', 'error', 'running', 'todo'];
  // 单节点原文上限 12000 字：规格是 ≤6000，留一倍余量；再长的内容通常是异常（日志、重复输出），完整内容去看原始文件。
  const LIMITS = { nodes: 40, output: 12000, title: 40, agent: 12, brief: 200, goal: 60, error: 400, model: 80, cols: 20, rows: 500, cell: 300, head: 100 };
  const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const str = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const esc = v => str(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (v, max) => { const a = Array.from(str(v).replace(CTRL, '').trim()); return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join(''); };
  const oneLine = (v, max) => clip(str(v).replace(/\s+/g, ' '), max);

  // ---------- 链接安全 ----------
  // 模型写的链接：只允许 http/https 和相对路径。先在原文（转义前）判断，任何空白/控制字符/引号/反斜杠一律拒绝，
  // 这样 “java\tscript:”、“ javascript:” 之类的变体都过不去；“//host” 协议相对地址在 file:// 下会变成 file://host，也拒绝。
  function safeUrl(raw) {
    const u = str(raw).trim();
    if (!u || u.length > 2000 || /[\u0000-\u0020\u007f-\u009f<>"'`\\\u2028\u2029]/.test(u)) return null;
    const scheme = u.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (scheme) return /^https?$/i.test(scheme[1]) ? u : null;
    if (u.startsWith('//')) return null;
    return u;
  }
  // 集成方给的结果文件路径（相对 index.html）：逐段编码，拒绝绝对路径、盘符、上跳。
  function safeFile(raw) {
    const p = str(raw).trim().replace(/\\/g, '/');
    if (!p || p.length > 400 || /[\u0000-\u001f\u007f<>"'`]/.test(p) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) || p.startsWith('/')) return null;
    const parts = p.split('/').filter(x => x && x !== '.');
    if (!parts.length || parts.includes('..')) return null;
    return parts.map(encodeURIComponent).join('/');
  }

  // ---------- 安全 Markdown 子集 ----------
  // 原则：所有模型文本先转义，再按白名单语法包上我们自己的标签；生成的标签一定成对、一定正确嵌套。
  // 强调语法的内容不允许包含 “<”，所以 ** 与 ~~ 交错时不会生成交叉的标签（宁可不渲染，也不生成坏结构）。
  function emph(s) {
    return esc(s)
      .replace(/\*\*(?=\S)([^*<>\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([^_<>\n]+?)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)([^~<>\n]+?)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*<>\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  }
  const LINK = '\\[([^\\[\\]\\n]{1,300})\\]\\(\\s*<?([^()\\s<>]{1,2000})>?(?:\\s+"[^"\\n]{0,200}")?\\s*\\)|(https?:\\/\\/[^\\s<>"\'()\\[\\]，。；！？、（）【】《》「」]+)';
  function links(s) {
    const re = new RegExp(LINK, 'g'); let out = '', last = 0, m;
    while ((m = re.exec(s))) {
      out += emph(s.slice(last, m.index));
      const label = m[1] !== undefined ? m[1] : m[3], href = safeUrl(m[1] !== undefined ? m[2] : m[3]);
      out += href ? '<a href="' + esc(href) + '" rel="noopener noreferrer" target="_blank">' + emph(label) + '</a>' : emph(m[0]);
      last = m.index + m[0].length;
    }
    return out + emph(s.slice(last));
  }
  const inline = text => str(text).split(/(`[^`\n]+`)/).map(p => (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`' ? '<code>' + esc(p.slice(1, -1)) + '</code>' : links(p))).join('');

  const LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  const isSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]);
  function splitRow(line) {
    let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  }
  // 把 Markdown 表格解析成 {head, rows}；视图里给没有结构化表格的节点也能用（集成方一般已解析好，这里只做兜底）。
  function parseTable(lines, start) {
    const head = splitRow(lines[start]).slice(0, LIMITS.cols), rows = []; let i = start + 2;
    while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { const r = splitRow(lines[i++]); rows.push(head.map((_, k) => r[k] ?? '')); }
    return { head, rows, next: i };
  }
  function renderList(lines, start) {
    const items = []; let i = start;
    while (i < lines.length) {
      const l = lines[i], m = l.match(LIST_RE);
      if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, tag: /\d/.test(m[2]) ? 'ol' : 'ul', num: parseInt(m[2], 10), text: [m[3]] }); i++; continue; }
      if (l.trim() && /^\s+\S/.test(l) && items.length) { items[items.length - 1].text.push(l.trim()); i++; continue; }
      break;
    }
    // 用栈处理缩进嵌套：缩进变深就在当前 <li> 里开一个子列表，变浅就逐层关闭。最多 4 层，再深按同层处理。
    let html = ''; const stack = [];
    for (const it of items) {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
      const top = stack[stack.length - 1], body = it.text.map(inline).join('<br>');
      if (!top || (it.indent > top.indent && stack.length < 4)) {
        html += '<' + it.tag + (it.tag === 'ol' && it.num > 1 && it.num < 10000 ? ' start="' + it.num + '"' : '') + '>';
        stack.push({ indent: it.indent, tag: it.tag });
        html += '<li>' + body;
      } else if (it.tag !== top.tag) {                               // 同层换了列表类型（- 换成 1.）：结束旧列表，另起一个
        html += '</li></' + stack.pop().tag + '>' + (stack.length ? '' : '');
        if (stack.length) html += '</li><li>' + body; else { html += '<' + it.tag + '>'; stack.push({ indent: it.indent, tag: it.tag }); html += '<li>' + body; }
      } else html += '</li><li>' + body;
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return { html, next: i };
  }
  function renderMarkdown(src, depth = 0) {
    const lines = str(src).replace(/\r\n?/g, '\n').replace(CTRL, '').split('\n');
    const out = [], para = []; let i = 0;
    const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para.length = 0; } };
    while (i < lines.length) {
      const line = lines[i]; let m;
      if ((m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,20})/))) {
        flush(); const fence = m[1], buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++; out.push('<pre class="wfv-code"><code>' + esc(buf.join('\n')) + '</code></pre>'); continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); const lv = Math.min(6, m[1].length + 3); out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>'); i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (isTableStart(lines, i)) { flush(); const t = parseTable(lines, i); out.push(mdTable(t.head, t.rows)); i = t.next; continue; }
      if (/^\s{0,3}>/.test(line)) {
        flush(); const buf = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        out.push('<blockquote>' + (depth < 2 ? renderMarkdown(buf.join('\n'), depth + 1) : '<p>' + buf.map(inline).join('<br>') + '</p>') + '</blockquote>'); continue;
      }
      if (LIST_RE.test(line)) { flush(); const r = renderList(lines, i); out.push(r.html); i = r.next; continue; }
      para.push(line.trim()); i++;
    }
    flush();
    return out.join('');
  }
  const mdTable = (head, rows) => '<div class="wfv-scroll"><table class="wfv-mdtable"><thead><tr>' + head.map(h => '<th scope="col">' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';

  // ---------- 数据规整 ----------
  function normTable(t) {
    if (!t || typeof t !== 'object') return null;
    const rows = (Array.isArray(t.rows) ? t.rows : []).filter(Array.isArray).slice(0, LIMITS.rows);
    let head = (Array.isArray(t.head) ? t.head : []).slice(0, LIMITS.cols).map(h => oneLine(h, LIMITS.head));
    const width = Math.min(LIMITS.cols, Math.max(head.length, ...rows.map(r => r.length), 0));
    if (!width) return null;
    head = Array.from({ length: width }, (_, i) => head[i] || '列' + (i + 1));
    return { head, rows: rows.map(r => head.map((_, i) => oneLine(r[i], LIMITS.cell))), truncated: Array.isArray(t.rows) && t.rows.length > LIMITS.rows };
  }
  // 节点产出的文件：只认集成方给的 {name, kind, path}；path 必须是 safeFile 通过的相对路径。kind 决定怎么展示（图 → <img>，网页 → 沙箱 iframe，其余 → 链接）。
  const ART_KINDS = ['image', 'html', 'table', 'file'];
  function normArtifacts(list) {
    return (Array.isArray(list) ? list : []).filter(a => a && typeof a === 'object').slice(0, 8).map(a => ({ name: oneLine(a.name, 80), kind: ART_KINDS.includes(a.kind) ? a.kind : 'file', path: safeFile(a.path), bytes: Number.isFinite(a.bytes) ? Math.max(0, Math.floor(a.bytes)) : 0 })).filter(a => a.name && a.path);
  }
  const normInputs = list => (Array.isArray(list) ? list : []).filter(a => a && typeof a === 'object' && oneLine(a.name, 80)).slice(0, 6).map(a => ({ name: oneLine(a.name, 80), kind: ['text', 'table', 'image', 'binary'].includes(a.kind) ? a.kind : 'binary' }));
  // 节点 key：DOM 里用的唯一、安全标识（只含 [A-Za-z0-9_-]）。合法 id（n0、n1A）原样作 key；重复 id 加后缀，依赖指向第一次出现的那个。
  function prepare(data) {
    const d = data && typeof data === 'object' ? data : {};
    const raw = (Array.isArray(d.nodes) ? d.nodes : []).filter(n => n && typeof n === 'object' && !Array.isArray(n)).slice(0, LIMITS.nodes);
    const used = new Set(), first = new Map();
    const nodes = raw.map((n, i) => {
      const id = oneLine(n.id, 12) || '#' + (i + 1);
      const base = id.replace(/[^A-Za-z0-9_-]/g, '') || 'x' + i; let key = base, c = 1;
      while (used.has(key)) key = base + '-' + (++c);
      used.add(key); if (!first.has(id)) first.set(id, key);
      const output = str(n.output).replace(CTRL, ''), outChars = Array.from(output);
      const files = n.files && typeof n.files === 'object' ? n.files : {};
      return {
        key, id, dupe: first.get(id) !== key, title: oneLine(n.title, LIMITS.title) || id, agent: oneLine(n.agent, LIMITS.agent),
        role: oneLine(n.role, 20), brief: oneLine(n.brief, LIMITS.brief), tier: Number.isInteger(n.tier) && n.tier >= 1 && n.tier <= 5 ? n.tier : null,
        status: STATUS[n.status] ? n.status : 'todo', model: oneLine(n.model, LIMITS.model), error: oneLine(n.error, LIMITS.error),
        output: outChars.length > LIMITS.output ? outChars.slice(0, LIMITS.output).join('') : output, outLen: outChars.length, truncated: outChars.length > LIMITS.output,
        table: normTable(n.table), md: safeFile(files.md), xlsx: safeFile(files.xlsx), artifacts: normArtifacts(files.items), inputs: normInputs(n.inputs), rawDeps: Array.isArray(n.dependsOn) ? n.dependsOn.map(x => oneLine(x, 12)) : []
      };
    });
    for (const n of nodes) {
      n.deps = [...new Set(n.rawDeps.map(x => first.get(x)).filter(k => k && k !== n.key))];
      n.missing = [...new Set(n.rawDeps.filter(x => x && !first.has(x)))];
    }
    for (const n of nodes) n.downs = nodes.filter(m => m.deps.includes(n.key)).map(m => m.key);
    const agents = [...new Set(nodes.map(n => n.agent).filter(Boolean))];
    const color = a => (a ? PALETTE[agents.indexOf(a) % PALETTE.length] : NO_AGENT);
    nodes.forEach(n => { n.color = color(n.agent); });
    const at = Number(d.generatedAt);
    return { goal: oneLine(d.goal, LIMITS.goal), generatedAt: Number.isFinite(at) && at > 0 ? at : null, nodes, agents, digest: d.digest && typeof d.digest === 'object' ? d.digest : null };
  }
  function digestFor(p) {
    const dnodes = p.nodes.map(n => ({ id: n.key, title: n.title, agent: n.agent, status: n.status, output: n.output, error: n.error, dependsOn: n.deps }));
    if (digestLib) return digestLib.complete(p.digest, dnodes, p.goal);
    // 浏览器里没加载 workflow-digest.js 时的最小兜底：用任务简介当一句话结论，页面结构不变。
    return { v: 1, source: 'fallback', headline: '', findings: [], nodes: Object.fromEntries(p.nodes.map(n => [n.key, { gist: n.brief || n.title, points: [], auto: true }])), path: [], caveats: [], autoHeadline: true };
  }

  // ---------- 流程图布局 ----------
  // 与 workflow-graph.js 的 layout 同一思路（层号 = 最长依赖链），但这里必须容忍坏数据：依赖缺失直接忽略、有环时断开，不抛错。
  const G = { col: 196, nw: 164, nh: 60, gap: 16, top: 30, pad: 8 };
  function layoutGraph(nodes) {
    const byKey = new Map(nodes.map(n => [n.key, n])), level = new Map(), visiting = new Set();
    const depth = k => {
      if (level.has(k)) return level.get(k);
      if (visiting.has(k)) return 0;
      visiting.add(k);
      const ds = (byKey.get(k).deps || []).filter(d => byKey.has(d) && d !== k);
      const v = ds.length ? Math.max(...ds.map(depth)) + 1 : 0;
      visiting.delete(k); level.set(k, v); return v;
    };
    nodes.forEach(n => depth(n.key));
    const cols = [];
    for (const n of nodes) (cols[level.get(n.key)] ||= []).push(n.key);
    const row = new Map();
    cols.forEach((ids, c) => {
      const avg = k => { const v = (byKey.get(k).deps || []).map(d => row.get(d)).filter(x => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
      if (c > 0) ids.sort((a, b) => avg(a) - avg(b));
      ids.forEach((k, i) => row.set(k, i));
    });
    const tallest = Math.max(0, ...cols.map(c => c.length)), pos = {};
    cols.forEach((ids, c) => {
      const offset = (tallest - ids.length) * (G.nh + G.gap) / 2;
      ids.forEach((k, i) => { pos[k] = { x: G.pad + c * G.col, y: G.top + offset + i * (G.nh + G.gap), col: c, row: i }; });
    });
    const edges = [];
    for (const n of nodes) for (const d of n.deps || []) {
      if (!pos[d]) continue;
      const a = pos[d], b = pos[n.key], x1 = a.x + G.nw, y1 = a.y + G.nh / 2, x2 = b.x, y2 = b.y + G.nh / 2;
      const dpath = x2 > x1 ? 'M' + x1 + ' ' + y1 + ' C' + (x1 + 36) + ' ' + y1 + ',' + (x2 - 36) + ' ' + y2 + ',' + (x2 - 4) + ' ' + y2
        : 'M' + x1 + ' ' + y1 + ' C' + (x1 + 40) + ' ' + (y1 + 70) + ',' + (x2 - 40) + ' ' + (y2 + 70) + ',' + (x2 - 4) + ' ' + y2;    // 环（坏数据）：绕下方画回去，至少看得见
      edges.push({ from: d, to: n.key, d: dpath });
    }
    return { cols, pos, edges, width: cols.length ? G.pad * 2 + (cols.length - 1) * G.col + G.nw : 0, height: G.top + tallest * (G.nh + G.gap) + G.pad };
  }
  // SVG 文本不会自动换行：按“汉字 1、ASCII 0.55”估算宽度截断。
  function fit(s, units) {
    let w = 0, out = '';
    for (const ch of Array.from(str(s))) { w += /[\u0000-ÿ]/.test(ch) ? 0.55 : 1; if (w > units) return out + '…'; out += ch; }
    return out;
  }

  // ---------- 内联脚本：纯函数库 ----------
  // 注意：clientLib 与 clientMain 会被 toString 后内联进页面，所以不能引用本模块里的任何变量。
  function clientLib() {
    // 大小写不敏感，但保持长度不变（个别字符 toLowerCase 后会变长，会让区间错位，这类字符原样保留）。
    var low = function (s) { return String(s == null ? '' : s).replace(/[\s\S]/g, function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; }); };
    function findRanges(text, q) {
      var needle = low(q).trim(); if (!needle) return [];
      var t = low(text), out = [], i = 0;
      while ((i = t.indexOf(needle, i)) !== -1 && out.length < 500) { out.push([i, i + needle.length]); i += needle.length; }
      return out;
    }
    function num(s) {
      var t = String(s == null ? '' : s).replace(/[,，\s¥$€£元%]/g, '');
      return /^[-+]?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
    }
    // 表格排序：数字按数值、其余按中文排序（数字感知）；空单元格总在最后；相同则保持原顺序（稳定）。col<0 恢复原顺序。
    function sortRows(rows, col, dir) {
      var list = rows.slice();
      if (col < 0 || dir === 'none') return list.sort(function (a, b) { return a.i - b.i; });
      var sign = dir === 'descending' ? -1 : 1;
      return list.sort(function (a, b) {
        var x = String(a.cells[col] == null ? '' : a.cells[col]).trim(), y = String(b.cells[col] == null ? '' : b.cells[col]).trim();
        if (!x || !y) return (!x && !y) ? a.i - b.i : !x ? 1 : -1;
        var nx = num(x), ny = num(y), r;
        if (nx !== null && ny !== null) r = nx - ny; else r = x.localeCompare(y, 'zh-CN', { numeric: true });
        return r ? r * sign : a.i - b.i;
      });
    }
    function rowMatches(cells, q) { var needle = low(q).trim(); if (!needle) return true; for (var i = 0; i < cells.length; i++) if (low(cells[i]).indexOf(needle) !== -1) return true; return false; }
    function toTSV(head, rows) { var f = function (c) { return String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' '); }; return [head].concat(rows).map(function (r) { return r.map(f).join('\t'); }).join('\n'); }
    // CSV：带 BOM 让 Excel 认出 UTF-8；以 = + - @ 开头且不是数字的单元格前加 '，防止在 Excel 里被当成公式执行。
    function toCSV(head, rows) {
      var f = function (c) {
        var s = String(c == null ? '' : c);
        if (/^[=+\-@\t\r]/.test(s) && num(s) === null) s = "'" + s;
        return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      return '\ufeff' + [head].concat(rows).map(function (r) { return r.map(f).join(','); }).join('\r\n');
    }
    // 哪些节点可见：子智能体 + 状态 + 搜索命中，三者取交集。status='problem' 表示“失败或过期”。
    function visible(nodes, f) {
      f = f || {}; var out = {};
      nodes.forEach(function (n) {
        if (f.agent && (f.agent === '__none' ? n.a : n.a !== f.agent)) return;
        if (f.status && (f.status === 'problem' ? (n.s !== 'error' && n.s !== 'stale') : n.s !== f.status)) return;
        if (f.hits && !f.hits[n.k]) return;
        out[n.k] = true;
      });
      return out;
    }
    // 上游/下游（传递闭包），用于选中时高亮。
    function neighbors(nodes, key) {
      var by = {}; nodes.forEach(function (n) { by[n.k] = n; });
      var walk = function (start, next) { var seen = {}, stack = (next(start) || []).slice(); while (stack.length) { var k = stack.pop(); if (seen[k] || k === key || !by[k]) continue; seen[k] = true; stack.push.apply(stack, next(k) || []); } return seen; };
      return { up: walk(key, function (k) { return by[k] && by[k].d; }), down: walk(key, function (k) { return by[k] && by[k].u; }) };
    }
    function step(order, cur, delta) {
      if (!order.length) return null;
      var i = order.indexOf(cur);
      if (i < 0) return delta > 0 ? order[0] : order[order.length - 1];
      return order[Math.max(0, Math.min(order.length - 1, i + delta))];
    }
    var SIZES = [14, 15, 16, 17, 18, 20, 22];
    function font(cur, delta) { var i = SIZES.indexOf(Number(cur)); if (i < 0) i = 2; return SIZES[Math.max(0, Math.min(SIZES.length - 1, i + delta))]; }
    return { findRanges: findRanges, num: num, sortRows: sortRows, rowMatches: rowMatches, toTSV: toTSV, toCSV: toCSV, visible: visible, neighbors: neighbors, step: step, font: font, SIZES: SIZES };
  }

  // ---------- 内联脚本：DOM 交互 ----------
  // 只操作属性、class 与 textContent；模型文本从不经过 innerHTML。
  function clientMain(lib) {
    var doc = document, win = window, root = doc.getElementById('view-root');
    if (!root) return;
    root.classList.remove('no-js'); root.classList.add('js');
    var data; try { data = JSON.parse(doc.getElementById('wfv-data').textContent || '{}'); } catch (e) { data = {}; }
    var nodes = Array.isArray(data.nodes) ? data.nodes : [];
    var $ = function (s, el) { return (el || doc).querySelector(s); };
    var $$ = function (s, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(s)); };
    var card = function (k) { return doc.getElementById('node-' + k); };
    var hide = function (el, b) { if (!el) return; if (b) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); };
    var reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var store = {
      get: function (k) { try { return win.localStorage ? win.localStorage.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { if (win.localStorage) win.localStorage.setItem(k, v); } catch (e) { /* 隐私模式或 file:// 下可能不可用，忽略 */ } }
    };
    var live = $('.wfv-live');
    var say = function (msg) { if (live) live.textContent = msg; };
    var search = $('.wfv-search'), fAgent = $('.wfv-filter-agent'), fStatus = $('.wfv-filter-status'), count = $('.wfv-count'), empty = $('.wfv-empty');
    var current = null, spy = null, timer = null;

    // 生成时间按查看者的本地时区重新显示。
    $$('time[datetime]').forEach(function (t) { var d = new Date(t.getAttribute('datetime')); if (!isNaN(d.getTime())) t.textContent = d.toLocaleString('zh-CN', { hour12: false }); });

    var levelOf = function (el) { return Number(el.getAttribute('data-level')) || 0; };
    function setLevel(el, lv) {
      if (!el) return;
      el.setAttribute('data-level', String(lv));
      var t = $('.wfv-toggle', el); if (t) t.setAttribute('aria-expanded', lv > 0 ? 'true' : 'false');
      var label = $('.wfv-toggle-label', el); if (label) label.textContent = lv > 0 ? '收起要点' : '查看要点';
      var f = $('.wfv-full-toggle', el);
      if (f) { f.setAttribute('aria-expanded', lv === 2 ? 'true' : 'false'); f.textContent = lv === 2 ? '收起全文' : (f.getAttribute('data-label') || '查看全文'); }
    }

    // 选中/悬停：高亮该节点本身、全部上游与下游（流程图、目录、卡片三处一致）。
    function highlight(k) {
      $$('.is-sel, .is-up, .is-down, .is-path').forEach(function (el) { el.classList.remove('is-sel'); el.classList.remove('is-up'); el.classList.remove('is-down'); el.classList.remove('is-path'); });
      if (!k) return;
      var nb = lib.neighbors(nodes, k);
      $$('.wfv-node, .wfv-gnode, .wfv-toc-link, .wfv-flow-item').forEach(function (el) {
        var x = el.getAttribute('data-node');
        if (x === k) el.classList.add('is-sel'); else if (nb.up[x]) el.classList.add('is-up'); else if (nb.down[x]) el.classList.add('is-down');
      });
      $$('.wfv-edge').forEach(function (e) {
        var a = e.getAttribute('data-from'), b = e.getAttribute('data-to');
        if ((b === k || nb.up[b]) && nb.up[a] || (a === k || nb.down[a]) && nb.down[b]) e.classList.add('is-path');
      });
    }
    function select(k) { current = k; highlight(k); }

    function visibleOrder() { return nodes.map(function (n) { return n.k; }).filter(function (k) { var c = card(k); return c && !c.hasAttribute('hidden'); }); }
    function goTo(k, expand) {
      var c = card(k); if (!c) return;
      if (c.hasAttribute('hidden')) clearAll(true);
      if (expand && levelOf(c) === 0) setLevel(c, 1);
      select(k);
      if (c.scrollIntoView) c.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      var t = $('.wfv-toggle', c); if (t && t.focus) t.focus({ preventScroll: true });
      markToc(k);
    }
    function markToc(k) {
      spy = k;
      $$('.wfv-toc-link').forEach(function (a) { var on = a.getAttribute('data-node') === k; a.classList.toggle('is-cur', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
    }

    // ---- 搜索与过滤 ----
    function clearMarks() {
      $$('mark.wfv-hit').forEach(function (m) { var p = m.parentNode; p.replaceChild(doc.createTextNode(m.textContent), m); p.normalize(); });
    }
    function textNodes(el, out) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push(c);
        else if (c.nodeType === 1 && !/^(SCRIPT|STYLE)$/i.test(c.tagName)) textNodes(c, out);
      }
      return out;
    }
    // 在一张卡片里高亮命中，返回命中数与“需要展开到第几层才看得见”。
    function markIn(el, q) {
      var hits = 0, level = 0;
      textNodes(el, []).forEach(function (tn) {
        var text = tn.nodeValue, ranges = lib.findRanges(text, q); if (!ranges.length) return;
        var p = tn.parentNode, last = 0;
        ranges.forEach(function (r) {
          if (r[0] > last) p.insertBefore(doc.createTextNode(text.slice(last, r[0])), tn);
          var m = doc.createElement('mark'); m.className = 'wfv-hit'; m.textContent = text.slice(r[0], r[1]); p.insertBefore(m, tn); last = r[1];
        });
        if (last < text.length) p.insertBefore(doc.createTextNode(text.slice(last)), tn);
        p.removeChild(tn);
        hits += ranges.length;
        var need = p.closest('.wfv-full') ? 2 : p.closest('.wfv-body') ? 1 : 0; if (need > level) level = need;
      });
      return { hits: hits, level: level };
    }
    function apply() {
      clearMarks();
      var q = search ? search.value.trim() : '', hits = null, need = {}, total = 0;
      if (q) {
        hits = {};
        nodes.forEach(function (n) { var c = card(n.k); if (!c) return; var r = markIn(c, q); if (r.hits) { hits[n.k] = true; need[n.k] = r.level; total += r.hits; } });
      }
      var vis = lib.visible(nodes, { agent: fAgent ? fAgent.value : '', status: fStatus ? fStatus.value : '', hits: hits }), shown = 0;
      nodes.forEach(function (n) {
        var on = !!vis[n.k], c = card(n.k); if (on) shown++;
        if (c) { hide(c, !on); if (on && q && need[n.k] > levelOf(c)) setLevel(c, need[n.k]); }
        $$('.wfv-gnode[data-node="' + n.k + '"], .wfv-toc-link[data-node="' + n.k + '"], .wfv-flow-item[data-node="' + n.k + '"]').forEach(function (el) { el.classList.toggle('is-dim', !on); });
      });
      var filtered = !!(q || (fAgent && fAgent.value) || (fStatus && fStatus.value));
      root.classList.toggle('is-filtered', filtered);
      var msg = filtered ? '显示 ' + shown + ' / ' + nodes.length + ' 个步骤' + (q ? '，“' + q + '”共 ' + total + ' 处' : '') : '共 ' + nodes.length + ' 个步骤';
      if (count) count.textContent = msg;
      hide(empty, shown > 0 || !nodes.length);
      if (filtered) say(msg);
    }
    function clearAll(quiet) {
      if (search) search.value = ''; if (fAgent) fAgent.value = ''; if (fStatus) fStatus.value = '';
      apply(); if (!quiet) { select(null); say('已清除搜索和筛选'); }
    }

    // ---- 表格 ----
    function rowsOf(tbl) {
      return $$('tbody tr', tbl).map(function (tr) { return { tr: tr, i: Number(tr.getAttribute('data-i')) || 0, cells: $$('td', tr).map(function (td) { return td.textContent; }) }; });
    }
    var headOf = function (tbl) { return $$('thead th', tbl).map(function (th) { var b = $('.wfv-sort', th); return (b ? b.getAttribute('data-label') : th.textContent) || ''; }); };
    var shownRows = function (tbl) { return rowsOf(tbl).filter(function (r) { return !r.tr.hasAttribute('hidden'); }).map(function (r) { return r.cells; }); };
    function sortBy(btn) {
      var th = btn.closest('th'), tbl = btn.closest('table'), col = Number(btn.getAttribute('data-col'));
      var cur = th.getAttribute('aria-sort'), dir = cur === 'ascending' ? 'descending' : cur === 'descending' ? 'none' : 'ascending';
      $$('thead th', tbl).forEach(function (h) { h.setAttribute('aria-sort', 'none'); });
      th.setAttribute('aria-sort', dir);
      var body = $('tbody', tbl);
      lib.sortRows(rowsOf(tbl), dir === 'none' ? -1 : col, dir).forEach(function (r) { body.appendChild(r.tr); });
      say(dir === 'none' ? '已恢复原始顺序' : '已按“' + btn.getAttribute('data-label') + '”' + (dir === 'ascending' ? '升序' : '降序') + '排列');
    }
    function filterTable(input) {
      var box = input.closest('.wfv-tablebox'), tbl = $('table', box), q = input.value, n = 0, all = rowsOf(tbl);
      all.forEach(function (r) { var on = lib.rowMatches(r.cells, q); hide(r.tr, !on); if (on) n++; });
      var c = $('.wfv-rowcount', box); if (c) c.textContent = q.trim() ? n + ' / ' + all.length + ' 行' : all.length + ' 行';
    }
    function copyText(text, done) {
      var fallback = function () {
        var ta = doc.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'wfv-offscreen'; doc.body.appendChild(ta); ta.select();
        var ok = false; try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
        doc.body.removeChild(ta); done(ok);
      };
      try { if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) { win.navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); return; } } catch (e) { /* 走兜底 */ }
      fallback();
    }
    function download(name, text) {
      try {
        var url = win.URL.createObjectURL(new win.Blob([text], { type: 'text/csv;charset=utf-8' }));
        var a = doc.createElement('a'); a.href = url; a.download = name; a.className = 'wfv-offscreen'; doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
        win.setTimeout(function () { win.URL.revokeObjectURL(url); }, 4000);
        say('已导出 ' + name);
      } catch (e) { say('导出失败：浏览器不允许下载'); }
    }

    // ---- 字号 ----
    var KEY = 'pi-workflow-view:font';
    function setFont(px, quiet) { root.style.setProperty('--fs', px + 'px'); root.setAttribute('data-fs', String(px)); if (!quiet) { store.set(KEY, String(px)); say('字号 ' + px); } }
    var saved = Number(store.get(KEY)); if (lib.SIZES.indexOf(saved) !== -1) setFont(saved, true);

    // ---- 事件 ----
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button, a, .wfv-node') : null; if (!t) return;
      var c = t.closest('.wfv-node'), cls = t.classList;
      if (cls.contains('wfv-node')) { select(t.getAttribute('data-node')); return; }
      if (cls.contains('wfv-toggle')) { setLevel(c, levelOf(c) > 0 ? 0 : 1); select(c.getAttribute('data-node')); return; }
      if (cls.contains('wfv-full-toggle')) { setLevel(c, levelOf(c) === 2 ? 1 : 2); return; }
      if (cls.contains('wfv-expand-all') || cls.contains('wfv-collapse-all')) { var lv = cls.contains('wfv-expand-all') ? 1 : 0; $$('.wfv-node').forEach(function (el) { if (!el.hasAttribute('hidden')) setLevel(el, lv); }); say(lv ? '已展开全部步骤' : '已折叠全部步骤'); return; }
      if (cls.contains('wfv-sort')) { sortBy(t); return; }
      if (cls.contains('wfv-copy-tsv') || cls.contains('wfv-export-csv')) {
        var tbl = $('table', t.closest('.wfv-tablebox')), head = headOf(tbl), rows = shownRows(tbl);
        if (cls.contains('wfv-copy-tsv')) copyText(lib.toTSV(head, rows), function (ok) { say(ok ? '已复制 ' + rows.length + ' 行，可直接粘贴到 Excel' : '复制失败，请手动选择表格复制'); });
        else download(t.getAttribute('data-filename') || 'table.csv', lib.toCSV(head, rows));
        return;
      }
      if (cls.contains('wfv-font-inc') || cls.contains('wfv-font-dec')) { setFont(lib.font(root.getAttribute('data-fs') || 16, cls.contains('wfv-font-inc') ? 1 : -1)); return; }
      if (cls.contains('wfv-show-problems')) { if (fStatus) fStatus.value = 'problem'; apply(); var first = visibleOrder()[0]; if (first) goTo(first, true); return; }
      if (cls.contains('wfv-clear')) { clearAll(false); return; }
      var href = t.getAttribute('href') || '';
      if (href.indexOf('#node-') === 0) { var k = t.getAttribute('data-node') || href.slice(6); if (card(k)) { e.preventDefault(); goTo(k, true); } }
    });
    doc.addEventListener('input', function (e) {
      var t = e.target; if (!t || !t.classList) return;
      if (t.classList.contains('wfv-search')) { win.clearTimeout(timer); timer = win.setTimeout(apply, 120); }
      else if (t.classList.contains('wfv-table-filter')) filterTable(t);
    });
    doc.addEventListener('change', function (e) { var t = e.target; if (t && t.classList && (t.classList.contains('wfv-filter-agent') || t.classList.contains('wfv-filter-status'))) apply(); });
    doc.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      var t = e.target || {}, tag = String(t.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
      if (e.key === 'Escape') { if (t === search && search.value) { search.value = ''; apply(); return; } clearAll(false); if (typing && t.blur) t.blur(); return; }
      if (typing) { if (e.key === 'Enter' && t === search) { win.clearTimeout(timer); apply(); var f = visibleOrder()[0]; if (f && search.value.trim()) goTo(f, false); } return; }
      if (e.key === '/') { e.preventDefault(); if (search) search.focus(); return; }
      if (e.key === 'j' || e.key === 'k') { e.preventDefault(); var k = lib.step(visibleOrder(), current || spy, e.key === 'j' ? 1 : -1); if (k) goTo(k, false); return; }
      if ((e.key === 'Enter' || e.key === ' ') && t.classList && t.classList.contains('wfv-node')) { e.preventDefault(); setLevel(t, levelOf(t) > 0 ? 0 : 1); }
    });
    var inGraph = function (el) { return el && el.closest ? el.closest('.wfv-gnode, .wfv-flow-item, .wfv-toc-link') : null; };
    doc.addEventListener('mouseover', function (e) { var g = inGraph(e.target); if (g) highlight(g.getAttribute('data-node')); });
    doc.addEventListener('mouseout', function (e) { if (inGraph(e.target) && !inGraph(e.relatedTarget)) highlight(current); });
    doc.addEventListener('focusin', function (e) { var g = inGraph(e.target); if (g) highlight(g.getAttribute('data-node')); });

    // 滚动跟随：最后一个顶部越过视口上方 30% 的可见卡片即“当前节点”。用 rAF 节流，节点最多几十个，逐个量一遍足够快。
    var ticking = false;
    function onScroll() {
      ticking = false; var cur = null, line = (win.innerHeight || 800) * 0.3;
      visibleOrder().forEach(function (k) { var r = card(k).getBoundingClientRect(); if (r.top <= line) cur = k; });
      if (!cur) cur = visibleOrder()[0] || null;
      // 页面滚到底时，靠后的卡片永远到不了“30% 线”；此时若选中的卡片在视口里，就以选中的为准，目录与 j/k 不会对不上。
      var sel = current && card(current);
      if (sel && !sel.hasAttribute('hidden')) { var sr = sel.getBoundingClientRect(); if (sr.top < (win.innerHeight || 800) && sr.bottom > 0) cur = current; }
      if (cur !== spy) markToc(cur);
    }
    win.addEventListener('scroll', function () { if (ticking) return; ticking = true; (win.requestAnimationFrame || win.setTimeout)(onScroll); }, { passive: true });
    win.addEventListener('beforeprint', function () { clearMarks(); });

    apply(); onScroll();
    var h = String(win.location && win.location.hash || '');
    if (h.indexOf('#node-') === 0 && card(h.slice(6))) goTo(h.slice(6), true);
  }

  // 内联脚本是常量（与数据无关），所以它的 CSP 哈希也是常量，只算一次。
  // 换行统一成 LF：HTML 解析器会把脚本里的 CRLF 规范化成 LF 再算哈希，源文件若是 CRLF（Windows 检出）哈希就对不上，脚本会被 CSP 拦下。
  const CLIENT_SCRIPT = ('(function(){"use strict";var lib=(' + clientLib.toString() + ')();(' + clientMain.toString() + ')(lib);})();').replace(/\r\n?/g, '\n');
  let scriptHash;
  function cspFor() {
    if (scriptHash === undefined) {
      scriptHash = null;
      try { if (typeof require === 'function') scriptHash = require('node:crypto').createHash('sha256').update(CLIENT_SCRIPT, 'utf8').digest('base64'); } catch { scriptHash = null; }
    }
    // Node 里用哈希（更严格，注入的脚本不会执行）；浏览器里同步算不了哈希，退回 'unsafe-inline'（内容仍全部转义）。
    return "default-src 'none'; style-src 'unsafe-inline'; script-src " + (scriptHash ? "'sha256-" + scriptHash + "'" : "'unsafe-inline'") + "; img-src data: file: 'self'; frame-src file: 'self'; child-src file: 'self'; base-uri 'none'; form-action 'none'";
  }
  // JSON 放进 <script> 数据块：转义 < > & 与 U+2028/2029，杜绝 </script> 与 <!-- 提前结束数据块。
  const jsonForScript = obj => JSON.stringify(obj).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  // ---------- 页面片段 ----------
  const badge = s => '<span class="wfv-badge" data-status="' + s + '"><span aria-hidden="true">' + STATUS[s].icon + '</span> ' + STATUS[s].label + '</span>';
  const nodeLink = (n, cls) => '<a class="' + cls + '" href="#node-' + n.key + '" data-node="' + n.key + '">' + esc(n.id) + ' ' + esc(n.title) + '</a>';
  const fmtTime = ms => { try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return new Date(ms).toISOString(); } };
  const BANNER = {
    stale: () => '<strong>已过期（上游改过）</strong>：它依赖的步骤后来被修改或重新运行过，下面的内容可能已经不准，需要重新运行这一步。',
    error: n => '<strong>运行失败</strong>：' + (n.error ? esc(n.error) : '没有记录失败原因。') + ' 先看失败原因，再重新运行这一步。',
    running: () => '<strong>运行中</strong>：生成这份快照时这一步还没跑完，结果不完整。',
    todo: () => '<strong>尚未运行</strong>：这一步还没有结果。'
  };

  function nextAction(p, counts) {
    const byKey = new Map(p.nodes.map(n => [n.key, n]));
    const pick = status => p.nodes.find(n => n.status === status);
    const problem = pick('error');
    if (problem) return { node: problem, lead: '先处理失败步骤', detail: '查看失败原因并重新运行' };
    const stale = pick('stale');
    if (stale) return { node: stale, lead: '先更新过期步骤', detail: '上游已经变化，结果可能不再可靠' };
    const running = pick('running');
    if (running) return { node: running, lead: '先等待这一步完成', detail: '完成后再继续查看下游步骤' };
    const ready = p.nodes.find(n => n.status === 'todo' && n.deps.every(k => byKey.get(k) && byKey.get(k).status === 'done'));
    if (ready) return { node: ready, lead: '下一步可以运行', detail: '它依赖的上游步骤已经完成' };
    const waiting = pick('todo');
    if (waiting) return { node: waiting, lead: '下一步暂时在等待', detail: '先完成它依赖的上游步骤' };
    if (p.nodes.length && counts.done === p.nodes.length) return { node: null, lead: '工作流已完成', detail: '可以查看结果或导出数据' };
    return { node: null, lead: '暂时没有可执行步骤', detail: '工作流更新后这里会显示下一步' };
  }

  function runState(p, counts) {
    if (!p.nodes.length) return { key: 'empty', icon: '○', label: '还没有步骤' };
    if (counts.error || counts.stale) return { key: 'attention', icon: '!', label: '需要处理' };
    if (counts.running) return { key: 'running', icon: '…', label: '执行中' };
    if (counts.done === p.nodes.length) return { key: 'done', icon: '✓', label: '已完成' };
    return { key: 'ready', icon: '→', label: '可以继续' };
  }

  function hero(p, counts) {
    const state = runState(p, counts), action = nextAction(p, counts), total = p.nodes.length;
    let h = '<div class="wfv-hero" aria-label="工作流状态"><div class="wfv-hero-state"><span class="wfv-run-state" data-state="' + state.key + '"><span aria-hidden="true">' + state.icon + '</span> ' + state.label + '</span>';
    h += '<strong class="wfv-hero-progress">' + (total ? counts.done + ' / ' + total + ' 步已完成' : '等待步骤加入') + '</strong>';
    if (total && (counts.error || counts.stale || counts.running || counts.todo)) h += '<span class="wfv-hero-detail">' + [counts.error ? counts.error + ' 个失败' : '', counts.stale ? counts.stale + ' 个过期' : '', counts.running ? counts.running + ' 个运行中' : '', counts.todo ? counts.todo + ' 个待运行' : ''].filter(Boolean).join(' · ') + '</span>';
    h += '</div><div class="wfv-next"><span class="wfv-label">接下来</span> <strong>' + action.lead + '</strong>：';
    h += action.node ? nodeLink(action.node, 'wfv-next-link') + ' <span class="wfv-next-detail">' + esc(action.detail) + '</span>' : '<span class="wfv-next-detail">' + esc(action.detail) + '</span>';
    return h + '</div></div>';
  }

  function overview(p, dg, counts) {
    const byKey = new Map(p.nodes.map(n => [n.key, n])), total = p.nodes.length;
    const problems = counts.error + counts.stale;
    const auto = dg.source === 'fallback' || dg.autoHeadline;
    let h = '<section class="wfv-overview wfv-panel" id="wfv-overview" aria-labelledby="wfv-ov-h"><h2 id="wfv-ov-h" class="wfv-h2">一句话结论</h2>';
    h += '<p class="wfv-headline">' + esc(dg.headline || '暂无结论') + '</p>';
    if (auto && total) h += '<p class="wfv-note">以上结论是从原文自动摘录的，未经模型整理，建议对照下方详情阅读。</p>';
    if (total) {
      h += '<div class="wfv-progress" role="img" aria-label="' + esc('已完成 ' + counts.done + ' / ' + total + ' 步') + '">' + STATUS_ORDER.filter(s => counts[s]).map(s => '<span class="wfv-seg" data-status="' + s + '" style="flex-grow:' + counts[s] + '"></span>').join('') + '</div>';
      h += '<ul class="wfv-stats"><li class="wfv-stat" data-status="all"><b>' + total + '</b> 个步骤</li>' + STATUS_ORDER.filter(s => counts[s]).map(s => '<li class="wfv-stat" data-status="' + s + '"><b>' + counts[s] + '</b> ' + STATUS[s].label + '</li>').join('') + '</ul>';
    }
    if (problems) h += '<div class="wfv-alert" role="note"><span>有 ' + problems + ' 个步骤需要留意（' + [counts.error ? counts.error + ' 个失败' : '', counts.stale ? counts.stale + ' 个已过期' : ''].filter(Boolean).join('，') + '）。</span> <button type="button" class="wfv-btn wfv-show-problems">只看这些</button></div>';
    const from = keys => { const ls = (keys || []).map(k => byKey.get(k)).filter(Boolean); return ls.length ? ' <span class="wfv-from">依据：' + ls.map(n => nodeLink(n, 'wfv-jump')).join('、') + '</span>' : ''; };
    if (dg.findings.length) h += '<h3 class="wfv-h3">关键发现</h3><ol class="wfv-findings">' + dg.findings.map(f => '<li>' + esc(f.text) + from(f.from) + '</li>').join('') + '</ol>';
    if (dg.caveats.length) h += '<h3 class="wfv-h3">需要留意</h3><ul class="wfv-caveats">' + dg.caveats.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>';
    const path = dg.path.map(k => byKey.get(k)).filter(Boolean);
    if (path.length > 1) h += '<p class="wfv-path"><span class="wfv-label">建议阅读顺序</span> ' + path.map(n => nodeLink(n, 'wfv-jump')).join(' <span aria-hidden="true">→</span> ') + '</p>';
    if (!total) h += '<p class="wfv-note">这个工作流里还没有任何步骤。</p>';
    return h + '</section>';
  }

  function flow(p) {
    if (!p.nodes.length) return '';
    const L = layoutGraph(p.nodes), byKey = new Map(p.nodes.map(n => [n.key, n]));
    const parallelGroups = L.cols.filter(ids => ids.length > 1).length;
    let svg = '<svg class="wfv-svg" xmlns="http://www.w3.org/2000/svg" width="' + L.width + '" height="' + L.height + '" viewBox="0 0 ' + L.width + ' ' + L.height + '" role="group" aria-label="流程图">';
    svg += '<defs><marker id="wfv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="wfv-arrowhead"></path></marker></defs>';
    L.cols.forEach((ids, c) => { svg += '<text class="wfv-stage" x="' + (G.pad + c * G.col) + '" y="18">第 ' + (c + 1) + ' 步' + (ids.length > 1 ? ' · 并行 ' + ids.length + ' 个' : '') + '</text>'; });
    svg += '<g class="wfv-edges">' + L.edges.map(e => '<path class="wfv-edge" data-from="' + e.from + '" data-to="' + e.to + '" d="' + e.d + '" marker-end="url(#wfv-arrow)"></path>').join('') + '</g>';
    for (const n of p.nodes) {
      const q = L.pos[n.key], s = STATUS[n.status];
      svg += '<a class="wfv-gnode" href="#node-' + n.key + '" data-node="' + n.key + '" data-status="' + n.status + '" style="--c:' + n.color + '">' +
        '<title>' + esc(n.id + ' ' + n.title + ' · ' + (n.agent || '未分组') + ' · ' + s.label) + '</title>' +
        '<rect class="wfv-gbox" x="' + q.x + '" y="' + q.y + '" width="' + G.nw + '" height="' + G.nh + '" rx="10"></rect>' +
        '<rect class="wfv-gbar" x="' + q.x + '" y="' + q.y + '" width="6" height="' + G.nh + '" rx="3"></rect>' +
        '<text class="wfv-gid" x="' + (q.x + 16) + '" y="' + (q.y + 22) + '">' + esc(n.id) + '</text>' +
        '<text class="wfv-gtitle" x="' + (q.x + 16 + Math.min(4, Array.from(n.id).length) * 9 + 8) + '" y="' + (q.y + 22) + '">' + esc(fit(n.title, 7.5)) + '</text>' +
        '<text class="wfv-gstatus" data-status="' + n.status + '" x="' + (q.x + 16) + '" y="' + (q.y + 45) + '">' + s.icon + ' ' + s.label + (n.agent ? ' · ' + esc(fit(n.agent, 5)) : '') + '</text></a>';
    }
    svg += '</svg>';
    // 窄屏用的纵向列表：同样的信息，不需要横向滚动。
    const list = '<ol class="wfv-flow-list">' + L.cols.map((ids, c) => '<li class="wfv-flow-stage"><span class="wfv-label">第 ' + (c + 1) + ' 步' + (ids.length > 1 ? '（并行 ' + ids.length + ' 个）' : '') + '</span><ul>' + ids.map(k => { const n = byKey.get(k); return '<li><a class="wfv-flow-item" href="#node-' + k + '" data-node="' + k + '" data-status="' + n.status + '" style="--c:' + n.color + '"><span class="wfv-dot" aria-hidden="true"></span>' + esc(n.id) + ' ' + esc(n.title) + ' ' + badge(n.status) + '</a></li>'; }).join('') + '</ul></li>').join('') + '</ol>';
    const legend = p.agents.length ? '<ul class="wfv-legend" aria-label="颜色说明">' + p.agents.map((a, i) => '<li><span class="wfv-dot" style="--c:' + PALETTE[i % PALETTE.length] + '" aria-hidden="true"></span>' + esc(a) + '</li>').join('') + (p.nodes.some(n => !n.agent) ? '<li><span class="wfv-dot" style="--c:' + NO_AGENT + '" aria-hidden="true"></span>未分组</li>' : '') + '</ul>' : '';
    return '<section class="wfv-flow wfv-panel" id="wfv-flow" aria-labelledby="wfv-flow-h"><div class="wfv-flow-head"><div><h2 id="wfv-flow-h" class="wfv-h2">流程图</h2><p class="wfv-note">先看步骤之间的先后关系，再点某一步查看详情。手机上会自动切换成纵向清单。</p></div><p class="wfv-flow-meta"><strong>' + L.cols.length + '</strong> 个阶段 <span aria-hidden="true">·</span> <strong>' + p.nodes.length + '</strong> 个步骤' + (parallelGroups ? ' <span aria-hidden="true">·</span> ' + parallelGroups + ' 组并行' : '') + '</p></div>' + legend +
      '<div class="wfv-graph wfv-scroll">' + svg + '</div>' + list + '</section>';
  }

  function tableBlock(n) {
    const t = n.table; if (!t) return '';
    const name = (n.id + '-' + n.title).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) + '.csv';
    let h = '<div class="wfv-tablebox"><div class="wfv-tabletools"><label class="wfv-field"><span class="wfv-sr">筛选表格</span><input type="search" class="wfv-table-filter" placeholder="筛选这张表…" aria-label="筛选这张表"></label>' +
      '<span class="wfv-rowcount" aria-live="polite">' + t.rows.length + ' 行</span>' +
      '<button type="button" class="wfv-btn wfv-copy-tsv">复制（可粘贴到 Excel）</button><button type="button" class="wfv-btn wfv-export-csv" data-filename="' + esc(name) + '">导出 CSV</button>' +
      (n.xlsx ? '<a class="wfv-btn wfv-xlsx" href="' + esc(n.xlsx) + '">打开 Excel 原文件</a>' : '') + '</div>';
    h += '<div class="wfv-scroll"><table class="wfv-table"><thead><tr>' + t.head.map((c, i) => '<th scope="col" aria-sort="none"><button type="button" class="wfv-sort" data-col="' + i + '" data-label="' + esc(c) + '">' + esc(c) + '<span class="wfv-sorticon" aria-hidden="true"></span></button></th>').join('') + '</tr></thead><tbody>' +
      t.rows.map((r, i) => '<tr data-i="' + i + '">' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    if (t.truncated) h += '<p class="wfv-note">表格过长，这里只显示前 ' + LIMITS.rows + ' 行，完整内容请打开原文件。</p>';
    return h + '</div>';
  }

  const KIND_NAME = { image: '图', html: '网页', table: '表格', file: '文件' };
  const fmtB = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  // 产出物：图 → <img>（脚本在 img 里永不执行）；网页 → 沙箱 iframe（无 allow-same-origin / allow-scripts 以外的任何权限，且页面自带禁网络 CSP），
  // 默认折叠，点“预览”才加载（loading="lazy" 的 iframe 在 details 里也不会提前请求）；表格与其他文件 → 链接。所有 src/href 都经过 safeFile。
  function artifactsBlock(n) {
    if (!n.artifacts.length) return '';
    let h = '<div class="wfv-arts" aria-label="这一步生成的文件">';
    for (const a of n.artifacts) {
      const href = esc(a.path), name = esc(a.name), tag = '<span class="wfv-artkind" data-kind="' + a.kind + '">' + KIND_NAME[a.kind] + '</span>';
      if (a.kind === 'image') h += '<figure class="wfv-art wfv-art-image">' + '<a href="' + href + '" target="_blank" rel="noopener noreferrer"><img src="' + href + '" alt="' + name + '"></a><figcaption>' + tag + ' ' + name + ' <a class="wfv-btn" href="' + href + '" download>下载</a></figcaption></figure>';
      else if (a.kind === 'html') h += '<details class="wfv-art wfv-art-html"><summary>' + tag + ' ' + name + ' <span class="wfv-muted">点击预览</span></summary><iframe class="wfv-frame" title="' + name + '" src="' + href + '" sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer"></iframe><p class="wfv-note"><a class="wfv-btn" href="' + href + '" target="_blank" rel="noopener noreferrer">在浏览器中单独打开</a></p></details>';
      else h += '<p class="wfv-art wfv-art-file">' + tag + ' <a href="' + href + '" target="_blank" rel="noopener noreferrer">' + name + '</a>' + (a.bytes ? ' <span class="wfv-muted">' + fmtB(a.bytes) + '</span>' : '') + '</p>';
    }
    return h + '</div>';
  }
  const inputsLine = n => (n.inputs.length ? '<p class="wfv-inputs"><span class="wfv-label">输入附件</span> ' + n.inputs.map(i => '<span class="wfv-chip">' + esc(i.name) + '</span>').join(' ') + '</p>' : '');

  function nodeCard(n, dg, byKey, index, total) {
    const g = dg.nodes[n.key] || { gist: n.brief || n.title, points: [], auto: true }, k = n.key;
    let h = '<article class="wfv-node" id="node-' + k + '" data-node="' + k + '" data-agent="' + esc(n.agent) + '" data-status="' + n.status + '" data-level="0" tabindex="-1" style="--c:' + n.color + '" aria-labelledby="t-' + k + '">';
    h += '<header class="wfv-node-head"><h3 class="wfv-node-title" id="t-' + k + '"><button type="button" class="wfv-toggle" aria-expanded="false" aria-controls="b-' + k + '"><span class="wfv-chev" aria-hidden="true"></span><span class="wfv-id">' + esc(n.id) + '</span> <span class="wfv-title-text">' + esc(n.title) + '</span> <span class="wfv-toggle-label">查看要点</span></button></h3><span class="wfv-step-context">第 ' + (index + 1) + ' / ' + total + ' 步</span>';
    h += '<div class="wfv-tags">' + badge(n.status) + '<span class="wfv-agent"><span class="wfv-dot" aria-hidden="true"></span>' + esc(n.agent || '未分组') + '</span>' + (n.model ? '<span class="wfv-model" title="实际使用的模型">' + esc(n.model) + '</span>' : '') + '</div></header>';
    if (BANNER[n.status]) h += '<p class="wfv-banner" data-status="' + n.status + '" role="note">' + BANNER[n.status](n) + '</p>';
    if (n.dupe) h += '<p class="wfv-banner" data-status="stale" role="note">数据里有重复的步骤编号 ' + esc(n.id) + '，其他步骤的“依赖”指向第一个。</p>';
    h += '<p class="wfv-gist">' + esc(g.gist) + (g.auto && SUMMARIZABLE(n) ? ' <span class="wfv-auto" title="这句话是从原文自动摘录的，未经模型整理">摘录</span>' : '') + '</p>';
    h += '<div class="wfv-body" id="b-' + k + '">';
    if (n.brief) h += '<p class="wfv-brief"><span class="wfv-label">这一步要做</span> ' + esc(n.brief) + '</p>';
    if (g.points.length) h += '<ul class="wfv-points">' + g.points.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    h += inputsLine(n) + artifactsBlock(n) + tableBlock(n);
    const ups = n.deps.map(d => byKey.get(d)).filter(Boolean), downs = n.downs.map(d => byKey.get(d)).filter(Boolean);
    h += '<p class="wfv-deps"><span class="wfv-label">依赖</span> ' + (ups.length ? ups.map(m => nodeLink(m, 'wfv-dep')).join('、') : '无（第一步）') + (n.missing.length ? ' <span class="wfv-missing">（找不到：' + n.missing.map(esc).join('、') + '）</span>' : '') +
      ' <span aria-hidden="true">·</span> <span class="wfv-label">被依赖</span> ' + (downs.length ? downs.map(m => nodeLink(m, 'wfv-dep')).join('、') : '无（最后一步）') + '</p>';
    if (n.output.trim() || n.md) {
      const label = n.output.trim() ? '查看全文（约 ' + n.outLen + ' 字）' : '';
      h += '<div class="wfv-fullbar">' + (label ? '<button type="button" class="wfv-btn wfv-full-toggle" aria-expanded="false" aria-controls="f-' + k + '" data-label="' + esc(label) + '">' + esc(label) + '</button>' : '') + (n.md ? '<a class="wfv-btn wfv-file" href="' + esc(n.md) + '">打开原始文件</a>' : '') + '</div>';
      if (label) h += '<div class="wfv-full wfv-md" id="f-' + k + '">' + renderMarkdown(n.output) + (n.truncated ? '<p class="wfv-note">原文过长，这里只显示前 ' + LIMITS.output + ' 字，完整内容请打开原始文件。</p>' : '') + '</div>';
    }
    return h + '</div></article>';
  }
  const SUMMARIZABLE = n => n.status === 'done' || n.status === 'stale';

  function renderView(data) {
    const p = prepare(data), dg = digestFor(p), byKey = new Map(p.nodes.map(n => [n.key, n]));
    const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, p.nodes.filter(n => n.status === s).length]));
    const title = p.goal || '工作流结果';
    const time = p.generatedAt ? '<time datetime="' + new Date(p.generatedAt).toISOString() + '">' + esc(fmtTime(p.generatedAt)) + '</time>' : '时间未知';
    const agentsOpt = p.agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '（' + p.nodes.filter(n => n.agent === a).length + '）</option>').join('') + (p.agents.length && p.nodes.some(n => !n.agent) ? '<option value="__none">未分组</option>' : '');
    const statusOpt = (counts.error + counts.stale ? '<option value="problem">只看有问题的（失败/过期）</option>' : '') + STATUS_ORDER.filter(s => counts[s]).map(s => '<option value="' + s + '">' + STATUS[s].label + '（' + counts[s] + '）</option>').join('');
    const toolbar = '<div class="wfv-toolbar" role="search">' +
      '<label class="wfv-field wfv-grow"><span class="wfv-sr">搜索</span><input type="search" class="wfv-search" id="wfv-search" placeholder="搜索全部内容（按 / 聚焦）" aria-label="搜索全部内容" autocomplete="off"></label>' +
      (p.agents.length > 1 ? '<label class="wfv-field"><span class="wfv-sr">按子智能体筛选</span><select class="wfv-filter-agent" aria-label="按子智能体筛选"><option value="">全部子智能体</option>' + agentsOpt + '</select></label>' : '') +
      '<label class="wfv-field"><span class="wfv-sr">按状态筛选</span><select class="wfv-filter-status" aria-label="按状态筛选"><option value="">全部状态</option>' + statusOpt + '</select></label>' +
      '<span class="wfv-group"><button type="button" class="wfv-btn wfv-expand-all">全部展开</button><button type="button" class="wfv-btn wfv-collapse-all">全部折叠</button></span>' +
      '<span class="wfv-group" aria-label="字号"><button type="button" class="wfv-btn wfv-font-dec" aria-label="缩小字号">A-</button><button type="button" class="wfv-btn wfv-font-inc" aria-label="放大字号">A+</button></span>' +
      '<span class="wfv-toolbar-actions">' + (counts.error + counts.stale ? '<button type="button" class="wfv-btn wfv-show-problems">只看有问题的</button>' : '') + '<button type="button" class="wfv-btn wfv-clear">清除筛选</button></span>' +
      '<span class="wfv-count" aria-live="polite">共 ' + p.nodes.length + ' 个步骤</span></div>';
    const toc = p.nodes.length ? '<nav class="wfv-toc" aria-label="步骤目录"><h2 class="wfv-toc-h">步骤目录</h2><ol>' + p.nodes.map(n => '<li><a class="wfv-toc-link" href="#node-' + n.key + '" data-node="' + n.key + '" data-status="' + n.status + '" style="--c:' + n.color + '"><span class="wfv-dot" aria-hidden="true"></span><span class="wfv-id">' + esc(n.id) + '</span> <span class="wfv-toc-title">' + esc(n.title) + '</span><span class="wfv-sr">（' + STATUS[n.status].label + '）</span>' + (n.status !== 'done' ? '<span class="wfv-toc-flag" data-status="' + n.status + '" aria-hidden="true">' + STATUS[n.status].icon + '</span>' : '') + '</a></li>').join('') + '</ol><p class="wfv-keys">快捷键：j / k 上下切换，Enter 展开，/ 搜索，Esc 清除</p></nav>' : '';
    const json = { nodes: p.nodes.map(n => ({ k: n.key, id: n.id, a: n.agent, s: n.status, d: n.deps, u: n.downs })) };
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="' + cspFor() + '"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta name="generator" content="Pi Workbench workflow-view">' +
      '<title>' + esc(title) + '</title><style>' + CSS + '</style></head><body>' +
      '<a class="wfv-skip" href="#wfv-nodes">跳到各步骤详情</a>' +
      '<div id="view-root" class="wfv no-js" data-fs="16">' +
      '<header class="wfv-top"><p class="wfv-kicker">工作流结果</p><h1 class="wfv-goal">' + esc(title) + '</h1>' +
      '<p class="wfv-meta">生成于 ' + time + ' <span aria-hidden="true">·</span> 这是静态快照；工作流更新后会自动重新生成。</p>' + hero(p, counts) + toolbar + '</header>' +
      '<div class="wfv-layout">' + toc + '<main class="wfv-main" id="wfv-main">' + overview(p, dg, counts) + flow(p) +
      (p.nodes.length ? '<section class="wfv-nodes" id="wfv-nodes" aria-labelledby="wfv-nodes-h"><h2 id="wfv-nodes-h" class="wfv-h2">各步骤详情</h2><p class="wfv-note">每一步先给一句话结论；点标题看要点，再点“查看全文”看原文。</p>' +
        '<p class="wfv-empty" hidden>没有符合条件的步骤。<button type="button" class="wfv-btn wfv-clear">清除搜索和筛选</button></p>' + p.nodes.map((n, i) => nodeCard(n, dg, byKey, i, p.nodes.length)).join('') + '</section>' : '<section class="wfv-empty-state wfv-panel" id="wfv-nodes" aria-labelledby="wfv-empty-h"><h2 id="wfv-empty-h" class="wfv-h2">还没有步骤</h2><p>这个工作流暂时没有可查看的结果。生成步骤后，状态、流程和详情会出现在这里。</p><p class="wfv-note">如果你刚刚启动了工作流，可以稍后重新打开这份结果页。</p></section>') +
      '</main></div><footer class="wfv-foot"><p>由 Pi Workbench 生成 · 离线可用，不联网、不上传任何内容。</p></footer>' +
      '<p class="wfv-live wfv-sr" aria-live="polite"></p></div>' +
      '<script type="application/json" id="wfv-data">' + jsonForScript(json) + '</script><script>' + CLIENT_SCRIPT + '</script></body></html>';
  }

  // ---------- 样式 ----------
  // 配色与 design-tokens.cjs 一致；暗色另配一套，正文与次要文字对比度都 ≥ 4.5:1。子智能体颜色只用于色条/圆点，不用作文字色（部分色板颜色对白底不足 4.5:1）。
  const CSS = [
    ':root{--bg:#fbf9f6;--surface:#f4f0ea;--card:#fff;--text:#2b2823;--muted:#665f56;--line:#e6dfd4;--accent:#b5522b;--accent-strong:#9a4423;--accent-soft:#f8ebe3;--ok:#1f7a5c;--ok-soft:#e4f2ec;--warn:#8a5a00;--warn-soft:#fbf0d9;--error:#b3382f;--error-soft:#f9e5e2;--mark:#ffe28a;--shadow:0 1px 2px rgba(43,40,35,.06);color-scheme:light}',
    '@media (prefers-color-scheme:dark){:root{--bg:#1c1a17;--surface:#24211d;--card:#2a2622;--text:#eee7dc;--muted:#b9af9f;--line:#423c35;--accent:#e8916a;--accent-strong:#f3a985;--accent-soft:#3b2a21;--ok:#6cc9a3;--ok-soft:#1f3229;--warn:#e3b65c;--warn-soft:#3a3020;--error:#f2928a;--error-soft:#3d2422;--mark:#7a5c10;--shadow:none;color-scheme:dark}}',
    '*,*::before,*::after{box-sizing:border-box}html{scroll-padding-top:16px}',
    'body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif}',
    '.wfv{font-size:var(--fs,16px);line-height:1.75;max-width:1240px;margin:0 auto;padding:20px 20px 48px}',
    'h1,h2,h3,h4,h5,h6{line-height:1.4;margin:0}p{margin:.4em 0}a{color:var(--accent-strong)}a:hover{text-decoration-thickness:2px}',
    ':focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}',
    '.wfv-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.wfv-offscreen{position:fixed;left:-9999px;top:0}',
    '.wfv-skip{position:absolute;left:-9999px;top:8px;background:var(--card);padding:8px 12px;z-index:9}.wfv-skip:focus{left:8px}',
    '.wfv-top{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:16px}.wfv-kicker{color:var(--muted);font-size:.85em;margin:0}',
    '.wfv-goal{font-size:1.6em;overflow-wrap:anywhere}.wfv-meta{color:var(--muted);font-size:.875em}',
    '.wfv-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,auto);gap:12px 24px;align-items:center;margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:10px}',
    '.wfv-hero-state{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}.wfv-run-state{font-weight:700}.wfv-run-state[data-state=attention]{color:var(--warn)}.wfv-run-state[data-state=running]{color:var(--accent-strong)}.wfv-run-state[data-state=done]{color:var(--ok)}.wfv-hero-progress{font-size:1.05em}.wfv-hero-detail,.wfv-next-detail{color:var(--muted);font-size:.875em}',
    '.wfv-next{min-width:0;overflow-wrap:anywhere}.wfv-next-link{font-weight:700}.wfv-next .wfv-label{display:block;margin:0}.wfv-next-detail{margin-left:4px}',
    '.wfv-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0}',
    '.wfv-field{display:inline-flex}.wfv-grow{flex:1 1 220px}',
    'input,select,button{font:inherit;font-size:.9em;color:var(--text)}',
    '.wfv-search,.wfv-table-filter,select{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 10px;min-height:36px}.wfv-search{width:100%}',
    '.wfv-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 12px;min-height:36px;cursor:pointer;text-decoration:none;color:var(--text)}',
    '.wfv-btn:hover{border-color:var(--accent);color:var(--accent-strong)}.wfv-group,.wfv-toolbar-actions{display:inline-flex;gap:4px}.wfv-count{color:var(--muted);font-size:.85em}',
    '.wfv-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;align-items:start}',
    '.wfv-toc{position:sticky;top:64px;max-height:calc(100vh - 80px);overflow:auto;font-size:.9em}.wfv-toc-h{font-size:.85em;color:var(--muted);font-weight:600;margin-bottom:4px}',
    '.wfv-toc ol{list-style:none;margin:0;padding:0}.wfv-toc-link{display:flex;gap:6px;align-items:center;padding:5px 8px;border-radius:8px;color:var(--text);text-decoration:none;border-left:3px solid transparent}',
    '.wfv-toc-link:hover{background:var(--surface)}.wfv-toc-link.is-cur{background:var(--accent-soft);border-left-color:var(--accent)}.wfv-toc-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wfv-toc-flag[data-status=error]{color:var(--error)}.wfv-toc-flag[data-status=stale]{color:var(--warn)}.wfv-keys{color:var(--muted);font-size:.8em;margin-top:12px}',
    '.wfv-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--c,#8a8178);flex:none;margin-right:4px}',
    '.wfv-id{font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:var(--muted)}',
    '.wfv-panel{background:var(--surface);border-radius:12px;padding:16px 20px;margin-bottom:20px}',
    '.wfv-h2{font-size:1.15em;margin-bottom:6px}.wfv-h3{font-size:1em;margin:14px 0 4px}.wfv-note{color:var(--muted);font-size:.875em;max-width:40em}.wfv-label{color:var(--muted);font-size:.875em;margin-right:4px}',
    '.wfv-flow-head{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.wfv-flow-meta{color:var(--muted);font-size:.875em;white-space:nowrap;margin:.2em 0 0}.wfv-flow-meta strong{color:var(--text);font-size:1.1em}',
    '.wfv-headline{font-size:1.3em;font-weight:600;max-width:32em;overflow-wrap:anywhere}',
    '.wfv-progress{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line);margin:10px 0 6px;max-width:40em}.wfv-seg{display:block;min-width:4px}',
    '.wfv-seg[data-status=done]{background:var(--ok)}.wfv-seg[data-status=stale]{background:var(--warn)}.wfv-seg[data-status=error]{background:var(--error)}.wfv-seg[data-status=running]{background:var(--accent)}.wfv-seg[data-status=todo]{background:var(--line)}',
    '.wfv-stats{display:flex;flex-wrap:wrap;gap:6px 16px;list-style:none;padding:0;margin:0;font-size:.9em}',
    '.wfv-alert{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--warn-soft);color:var(--text);border-left:4px solid var(--warn);padding:8px 12px;border-radius:8px;margin-top:12px}',
    '.wfv-findings,.wfv-caveats,.wfv-points{margin:4px 0;padding-left:1.4em;max-width:40em}.wfv-findings li,.wfv-caveats li,.wfv-points li{margin:4px 0;overflow-wrap:anywhere}',
    '.wfv-from{color:var(--muted);font-size:.85em;white-space:nowrap}.wfv-path{margin-top:12px}',
    '.wfv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;list-style:none;padding:0;margin:6px 0;font-size:.875em}',
    '.wfv-graph{overflow-x:auto;padding:4px 0}.wfv-svg{display:block;max-width:none}',
    '.wfv-stage{fill:var(--muted);font-size:12px}.wfv-edge{fill:none;stroke:var(--line);stroke-width:2;transition:stroke .15s}.wfv-arrowhead{fill:var(--muted)}',
    '.wfv-edge.is-path{stroke:var(--accent);stroke-width:2.5}',
    '.wfv-gnode{cursor:pointer;outline:none}.wfv-gbox{fill:var(--card);stroke:var(--line);stroke-width:1.5;transition:stroke .15s}.wfv-gbar{fill:var(--c)}',
    '.wfv-gnode[data-status=stale] .wfv-gbox{stroke:var(--warn);stroke-dasharray:5 4}.wfv-gnode[data-status=error] .wfv-gbox{stroke:var(--error)}.wfv-gnode[data-status=running] .wfv-gbox{stroke:var(--accent)}.wfv-gnode[data-status=todo] .wfv-gbox{stroke-dasharray:2 3}',
    '.wfv-gnode:hover .wfv-gbox,.wfv-gnode:focus-visible .wfv-gbox,.wfv-gnode.is-sel .wfv-gbox{stroke:var(--accent);stroke-width:3}.wfv-gnode.is-up .wfv-gbox,.wfv-gnode.is-down .wfv-gbox{fill:var(--accent-soft)}',
    '.wfv-gid{fill:var(--muted);font:12px ui-monospace,Consolas,monospace}.wfv-gtitle{fill:var(--text);font-size:14px;font-weight:600}.wfv-gstatus{fill:var(--muted);font-size:12px}',
    '.wfv-gstatus[data-status=error]{fill:var(--error)}.wfv-gstatus[data-status=stale]{fill:var(--warn)}.wfv-gstatus[data-status=done]{fill:var(--ok)}',
    '.is-dim{opacity:.35}.wfv-flow-list{display:none;list-style:none;padding:0;margin:0}.wfv-flow-stage ul{list-style:none;padding:0 0 0 8px;margin:2px 0 10px;border-left:2px solid var(--line)}',
    '.wfv-flow-item{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:4px 8px;color:var(--text);text-decoration:none;border-radius:8px}.wfv-flow-item.is-sel{background:var(--accent-soft)}',
    '.wfv-nodes>.wfv-h2{margin-top:4px}',
    '.wfv-node{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--c);border-radius:12px;padding:12px 18px 14px;margin:12px 0;box-shadow:var(--shadow);scroll-margin-top:72px}',
    '.wfv-node.is-sel{box-shadow:0 0 0 2px var(--accent)}.wfv-node.is-up,.wfv-node.is-down{border-color:var(--accent-soft)}',
    '.wfv-node-head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;justify-content:space-between}',
    '.wfv-node-title{font-size:1.05em;flex:1 1 260px;min-width:0}.wfv-toggle{all:unset;cursor:pointer;display:flex;gap:6px;align-items:baseline;width:100%;overflow-wrap:anywhere;border-radius:6px}.wfv-toggle-label{color:var(--muted);font-size:.72em;font-weight:400;white-space:nowrap}',
    '.wfv-step-context{color:var(--muted);font-size:.8em;white-space:nowrap}',
    '.wfv-toggle:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    '.wfv-chev{display:inline-block;width:.6em;height:.6em;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;flex:none;position:relative;top:-.1em}',
    '.wfv-node:not([data-level="0"]) .wfv-chev{transform:rotate(45deg)}.no-js .wfv-chev{display:none}',
    '.wfv-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:.8em}',
    '.wfv-badge{display:inline-flex;gap:2px;align-items:center;border-radius:999px;padding:1px 8px;font-weight:600;font-size:.85em;white-space:nowrap}',
    '.wfv-badge[data-status=done]{background:var(--ok-soft);color:var(--ok)}.wfv-badge[data-status=stale]{background:var(--warn-soft);color:var(--warn)}.wfv-badge[data-status=error]{background:var(--error-soft);color:var(--error)}.wfv-badge[data-status=running]{background:var(--accent-soft);color:var(--accent-strong)}.wfv-badge[data-status=todo]{background:var(--surface);color:var(--muted)}',
    '.wfv-agent{display:inline-flex;align-items:center}.wfv-model{color:var(--muted);font-family:ui-monospace,Consolas,monospace;overflow-wrap:anywhere}',
    '.wfv-banner{border-radius:8px;padding:6px 12px;margin:8px 0;max-width:40em;overflow-wrap:anywhere;color:var(--text)}',
    '.wfv-banner[data-status=stale]{background:var(--warn-soft);border-left:4px solid var(--warn)}.wfv-banner[data-status=error]{background:var(--error-soft);border-left:4px solid var(--error)}.wfv-banner[data-status=running],.wfv-banner[data-status=todo]{background:var(--surface);border-left:4px solid var(--line)}',
    '.wfv-gist{font-size:1.02em;max-width:40em;overflow-wrap:anywhere;margin:6px 0 2px}.wfv-auto{font-size:.72em;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;vertical-align:middle}',
    '.wfv-brief,.wfv-deps{max-width:40em;overflow-wrap:anywhere;font-size:.92em}.wfv-missing{color:var(--warn)}',
    '.js .wfv-node[data-level="0"] .wfv-body{display:none}.js .wfv-node:not([data-level="2"]) .wfv-full{display:none}',
    '.wfv-arts{display:grid;gap:10px;margin:10px 0}.wfv-art{margin:0;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--card)}.wfv-art-image img{max-width:100%;max-height:420px;display:block;margin:0 auto;background:#fff;border-radius:6px}.wfv-art figcaption,.wfv-art summary{font-size:.9em;margin-top:6px}.wfv-art summary{cursor:pointer;margin:0}.wfv-frame{width:100%;height:480px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-top:8px}.wfv-artkind{display:inline-block;font-size:.75em;font-weight:600;padding:0 7px;border-radius:999px;background:var(--accent-soft);color:var(--accent-strong)}.wfv-muted{color:var(--muted);font-size:.85em}.wfv-chip{display:inline-block;font-size:.85em;padding:0 8px;border:1px solid var(--line);border-radius:999px;margin-right:4px}',
    '.wfv-fullbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.no-js .wfv-full-toggle{display:none}',
    '.wfv-full{border-top:1px dashed var(--line);margin-top:10px;padding-top:6px}',
    '.wfv-md{max-width:40em;overflow-wrap:anywhere}.wfv-md h4{font-size:1.08em;margin:1em 0 .3em}.wfv-md h5{font-size:1em;margin:.9em 0 .3em}.wfv-md h6{font-size:.95em;margin:.8em 0 .3em;color:var(--muted)}',
    '.wfv-md ul,.wfv-md ol{padding-left:1.5em;margin:.4em 0}.wfv-md blockquote{margin:.6em 0;padding:2px 12px;border-left:4px solid var(--line);color:var(--muted)}',
    '.wfv-md code{font-family:ui-monospace,Consolas,monospace;font-size:.88em;background:var(--surface);border-radius:4px;padding:0 4px}',
    '.wfv-code{background:var(--surface);border-radius:8px;padding:10px 12px;overflow:auto;max-height:480px;font-size:.85em;line-height:1.55;white-space:pre}.wfv-code code{background:none;padding:0}',
    '.wfv-md hr{border:0;border-top:1px solid var(--line);margin:1em 0}',
    '.wfv-scroll{overflow-x:auto;max-width:100%}',
    '.wfv-tablebox{margin:10px 0}.wfv-tabletools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}.wfv-rowcount{color:var(--muted);font-size:.85em}',
    'table{border-collapse:collapse;font-size:.9em;margin:6px 0}th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top;overflow-wrap:anywhere;min-width:4em;max-width:24em}th{background:var(--surface);font-weight:600}',
    '.wfv-table tbody tr:nth-child(even){background:var(--bg)}.wfv-sort{all:unset;cursor:pointer;display:flex;gap:4px;align-items:center;width:100%}.wfv-sort:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    'th[aria-sort=ascending] .wfv-sorticon::after{content:"▲"}th[aria-sort=descending] .wfv-sorticon::after{content:"▼"}th[aria-sort=none] .wfv-sorticon::after{content:"↕";color:var(--muted)}.wfv-sorticon{font-size:.75em}',
    'mark.wfv-hit{background:var(--mark);color:inherit;border-radius:2px}',
    '.wfv-empty{background:var(--surface);border-radius:8px;padding:12px}.wfv-empty .wfv-btn{margin-left:8px}.wfv-empty-state{max-width:720px}.wfv-empty-state p{max-width:42em}',
    '.wfv-foot{color:var(--muted);font-size:.8em;border-top:1px solid var(--line);margin-top:24px;padding-top:8px}',
    '[hidden]{display:none!important}',
    '@media (max-width:900px){.wfv-layout{grid-template-columns:minmax(0,1fr)}.wfv-toc{position:static;max-height:none}.wfv-toc ol{display:flex;gap:4px;overflow-x:auto;padding-bottom:4px}.wfv-toc-link{white-space:nowrap}.wfv-toc-title{max-width:9em}.wfv-keys{display:none}}',
    '@media (max-width:640px){.wfv{padding:12px 12px 32px}.wfv-hero{display:block}.wfv-next{margin-top:10px}.wfv-graph{display:none}.wfv-flow-list{display:block}.wfv-flow-head{display:block}.wfv-flow-meta{margin-top:8px}.wfv-toolbar{position:static}.wfv-toolbar-actions{width:100%}.wfv-toolbar-actions .wfv-btn{flex:1;justify-content:center}.wfv-panel{padding:12px 14px}.wfv-node{padding:10px 12px}.wfv-goal{font-size:1.35em}.wfv-step-context{width:100%;margin-left:calc(.6em + 6px)}}',
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}',
    '@media (forced-colors:active){.wfv-gbar,.wfv-dot,.wfv-seg{forced-color-adjust:none}}',
    '@media print{.wfv-frame{display:none}:root{--bg:#fff;--surface:#f6f3ee;--card:#fff;--text:#000;--muted:#444;color-scheme:light}.wfv{max-width:none;padding:0;font-size:11pt}.wfv-toolbar,.wfv-toc,.wfv-skip,.wfv-fullbar,.wfv-tabletools,.wfv-show-problems,.wfv-empty,.wfv-flow-list,.wfv-chev{display:none!important}',
    '.wfv-layout{display:block}.wfv-node{break-inside:auto;box-shadow:none}.wfv-node-head{break-after:avoid}.wfv-node[hidden]{display:block!important}.js .wfv-node .wfv-body,.js .wfv-node .wfv-full{display:block!important}.is-dim{opacity:1}',
    '.wfv-graph{display:block!important;overflow:visible}.wfv-svg{max-width:100%;height:auto}.wfv-code{max-height:none;white-space:pre-wrap}mark.wfv-hit{background:none}.wfv-md a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em;color:var(--muted)}}'
  ].join('\n');

  return { PALETTE, STATUS, LIMITS, CSS, CLIENT_SCRIPT, renderView, renderMarkdown, safeUrl, safeFile, esc, prepare, layoutGraph, clientLib, jsonForScript, cspFor, parseTable: md => { const lines = str(md).split(/\r?\n/); const i = lines.findIndex((_, k) => isTableStart(lines, k)); return i < 0 ? null : (({ head, rows }) => ({ head, rows }))(parseTable(lines, i)); } };
});
