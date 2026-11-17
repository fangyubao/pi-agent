'use strict';
// 视图测试：不依赖浏览器。三类检查：
//   1) 结构：用一个很小的 HTML 词法器把整页拆成标签，检查标签/属性白名单、成对嵌套、无外链、无事件属性、链接协议安全。
//   2) 纯函数：Markdown 安全渲染、链接/路径过滤、布局、clientLib（搜索/排序/筛选/TSV/CSV/上下游/字号）。
//   3) 内联脚本：在 node:vm 里配一个最小 DOM 桩执行，确认初始化和常用键盘/点击路径不抛错。真实交互需要在 Chromium 里验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const V = require('./workflow-view.js');

const EVIL = '</script><script>alert(1)</script><img src=x onerror=alert(2)> <svg onload=alert(3)> [点我](javascript:alert(4)) [x](JaVaScRiPt:alert(5)) [y](java\tscript:alert(6)) <a href="javascript:alert(7)">a</a> <!-- x --> \u2028\u2029 <style>body{display:none}</style>';
const node = (id, extra = {}) => ({ id, title: '节点' + id, agent: '研究员', role: '分析师', brief: '做 ' + id, tier: 3, effort: null, dependsOn: [], status: 'done', model: 'cheap-1', output: '结论：' + id + ' 完成。\n- 要点一\n- 要点二', error: '', table: null, files: { md: 'results/' + id + '.md', xlsx: null }, ...extra });
const SAMPLE = () => ({
  goal: '比较 A 和 B 两个方案',
  generatedAt: Date.UTC(2025, 0, 2, 3, 4, 5),
  nodes: [
    node('n0', { title: '调研', output: '## 调研\n结论：A 更便宜。\n- A 每月 1200 元\n- B 每月 1700 元\n\n> 注意：价格含税\n\n```js\nconst x = "<b>";\n```\n访问 [官网](https://example.com/a?b=1&c=2) 或 [本地](results/n0.md)。' }),
    node('n10', { title: '价格对比', agent: '分析师', dependsOn: ['n0'], table: { head: ['方案', '价格', '备注'], rows: [['A', '1,200', '=HYPERLINK("x")'], ['B', '1700', ''], ['C', '900', '含"引号",逗号']] }, files: { md: null, xlsx: 'results/n10-对比.xlsx' } }),
    node('n11', { title: '风险', agent: '分析师', dependsOn: ['n0'], status: 'error', output: '', error: '模型超时 <b>' }),
    node('n2', { title: '汇总', agent: '撰稿', dependsOn: ['n10', 'n11'], status: 'stale', output: '推荐 A。' + EVIL }),
    node('n3', { title: '发布', agent: '撰稿', dependsOn: ['n2'], status: 'todo', output: '', model: null })
  ],
  digest: null
});

// ---------- 极简 HTML 词法器 ----------
const VOID = new Set(['meta', 'br', 'hr', 'input', 'img', 'link', 'path', 'rect']);
const RAW = new Set(['script', 'style', 'title', 'textarea']);
function tokenize(html) {
  const tags = [], texts = []; let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { texts.push(html.slice(i)); break; }
    texts.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) throw new Error('页面里不应有 HTML 注释（只可能来自注入）：' + html.slice(lt, lt + 40));
    if (html.startsWith('<!doctype', lt)) { i = html.indexOf('>', lt) + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!m) throw new Error('无法解析的标签（可能是未转义的 <）：' + JSON.stringify(html.slice(lt, lt + 60)));
    const name = m[2].toLowerCase(), attrs = {};
    for (const a of m[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] ?? '';
    tags.push({ close: !!m[1], name, attrs, at: lt });
    i = lt + m[0].length;
    if (!m[1] && RAW.has(name)) {
      const end = html.indexOf('</' + name, i);
      if (end < 0) throw new Error('<' + name + '> 没有闭合');
      tags[tags.length - 1].content = html.slice(i, end); i = end;
    }
  }
  return { tags, text: texts.join('') };
}
const TAGS = new Set('html head meta title style body a div header h1 h2 h3 h4 h5 h6 p span button label input select option nav ol ul li main section article strong em del code pre blockquote hr br table thead tbody tr th td time footer mark script svg defs marker path g text rect b'.split(' '));
const ATTRS = new Set('lang charset name content http-equiv class id href rel target data-node data-status data-state data-level data-agent data-col data-label data-from data-to data-i data-fs data-filename tabindex style aria-labelledby aria-label aria-expanded aria-controls aria-sort aria-live aria-hidden aria-current role type placeholder autocomplete value hidden scope start datetime title xmlns width height viewbox d marker-end x y rx refx refy markerwidth markerheight orient'.split(' '));
function checkPage(html) {
  const { tags, text } = tokenize(html), stack = [];
  for (const t of tags) {
    assert.ok(TAGS.has(t.name), '不在白名单的标签：' + t.name);
    for (const [k, v] of Object.entries(t.attrs)) {
      assert.ok(ATTRS.has(k), '不在白名单的属性：' + k + ' on <' + t.name + '>');
      assert.ok(!/^on/.test(k), '事件属性：' + k);
      if (k === 'href') assert.ok(/^(#|https?:\/\/|results\/|[a-zA-Z0-9%_.-]+(\/|\.|$)|url\()/.test(v) && !/^\s*(javascript|data|vbscript):/i.test(v), '可疑链接：' + v);
      if (k === 'style') assert.match(v, /^(--c:#[0-9a-f]{6}|flex-grow:\d+)$/, '可疑内联样式：' + v);
    }
    if (VOID.has(t.name)) continue;
    if (t.close) { const top = stack.pop(); assert.equal(top, t.name, '标签嵌套错误：期望 </' + top + '>，实际 </' + t.name + '>'); }
    else if (!RAW.has(t.name)) stack.push(t.name);
    else stack.push(t.name);
  }
  assert.deepEqual(stack, [], '有未闭合的标签：' + stack.join(','));
  const scripts = tags.filter(t => t.name === 'script' && !t.close);
  assert.equal(scripts.length, 2, '只能有一个数据块和一个常量脚本');
  assert.equal(scripts[0].attrs.type, 'application/json');
  assert.equal(scripts[1].content, V.CLIENT_SCRIPT, '可执行脚本必须是与数据无关的常量');
  return { tags, text, data: JSON.parse(scripts[0].content) };
}

test('整页：合法单文件 HTML，标签/属性白名单，成对嵌套，恰好一个常量脚本', () => {
  const html = V.renderView(SAMPLE());
  assert.ok(html.startsWith('<!doctype html><html lang="zh-CN">')); assert.ok(html.endsWith('</html>'));
  const { data } = checkPage(html);
  assert.equal(data.nodes.length, 5); assert.deepEqual(data.nodes.find(n => n.k === 'n2').d, ['n10', 'n11']);
});

test('CSP：存在、default-src none、无外链；脚本哈希与内联脚本一致', () => {
  const html = V.renderView(SAMPLE());
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/); assert.match(csp, /style-src 'unsafe-inline'/); assert.match(csp, /img-src data:/); assert.match(csp, /base-uri 'none'/);
  const hash = crypto.createHash('sha256').update(V.CLIENT_SCRIPT, 'utf8').digest('base64');
  assert.ok(csp.includes("script-src 'sha256-" + hash + "'"), '哈希应锁定内联脚本，注入的 <script> 无法执行');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  // 零外链：除了模型写的 http 链接（只在 <a href> 里）之外，不能有任何 URL；尤其不能有 src=、@import、url(http、<link>
  assert.doesNotMatch(html, /<[^>]*\ssrc=/i); assert.doesNotMatch(html, /<link/i); assert.doesNotMatch(html, /@import|url\(\s*['"]?(https?:|\/\/)/i);
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]);
  assert.deepEqual([...new Set(urls)].filter(u => !u.startsWith('https://example.com/') && u !== 'http://www.w3.org/2000/svg'), []);
});

test('转义：恶意输出只以文本出现；</script>、<img onerror>、javascript: 均无效', () => {
  const html = V.renderView(SAMPLE()), { text, tags } = checkPage(html);
  assert.ok(!tags.some(t => t.name === 'img' || t.name === 'svg' && t.attrs.onload !== undefined));
  assert.ok(text.includes('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(text.includes('&lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(!tags.some(t => t.name === 'a' && /script:/i.test(t.attrs.href || '')));
  assert.ok(text.includes('[点我](javascript:alert(4))'), '不安全的链接保留为纯文本');
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.ok(!html.includes('\u2028') && !html.includes('\u2029') || !html.slice(html.indexOf('id="wfv-data"')).includes('\u2028'));
  assert.ok(html.includes('<title>比较 A 和 B 两个方案</title>'));
  const t2 = V.renderView({ goal: '</title><script>alert(1)</script>', nodes: [] });
  assert.ok(t2.includes('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')); checkPage(t2);
});

test('内嵌 JSON：转义 < > & U+2028 U+2029，可被 JSON.parse 还原', () => {
  const s = V.jsonForScript({ a: '</script><!--\u2028\u2029&' });
  assert.doesNotMatch(s, /[<>&\u2028\u2029]/); assert.deepEqual(JSON.parse(s), { a: '</script><!--\u2028\u2029&' });
  const html = V.renderView({ nodes: [node('n0', { id: 'n0', agent: '</script>\u2028' })] });
  checkPage(html);
});

test('三层结构：L1 结论/发现/进度；L2 gist 与要点；L3 原文；状态说真话', () => {
  const html = V.renderView(SAMPLE());
  assert.match(html, /class="wfv-overview/); assert.match(html, /class="wfv-headline">（结果已过期）推荐 A。/);
  assert.match(html, /<li class="wfv-stat" data-status="all"><b>5<\/b> 个步骤/); assert.match(html, /data-status="error"><b>1<\/b> 失败/);
  assert.match(html, /有 2 个步骤需要留意（1 个失败，1 个已过期）/);
  assert.match(html, /id="node-n0"[^>]*data-level="0"/); assert.match(html, /class="wfv-gist">A 更便宜。/);
  assert.match(html, /<ul class="wfv-points"><li>A 每月 1200 元<\/li>/);
  assert.match(html, /<div class="wfv-full wfv-md" id="f-n0"><h5>调研<\/h5>/);
  assert.match(html, /已过期（上游改过）/); assert.match(html, /运行失败<\/strong>：模型超时 &lt;b&gt;/); assert.match(html, /尚未运行<\/strong>/);
  assert.match(html, /生成于 <time datetime="2025-01-02T03:04:05.000Z">/); assert.match(html, /这是静态快照；工作流更新后会自动重新生成/);
  assert.match(html, /依赖<\/span> <a class="wfv-dep" href="#node-n10" data-node="n10">n10 价格对比<\/a>、<a class="wfv-dep" href="#node-n11"/);
  assert.match(html, /被依赖<\/span> <a class="wfv-dep" href="#node-n3"/);
  assert.match(html, /<a class="wfv-btn wfv-file" href="results\/n0.md">打开原始文件/);
});

test('首屏状态、下一步、流程摘要和空状态给出可执行的引导', () => {
  const html = V.renderView(SAMPLE());
  assert.match(html, /class="wfv-hero" aria-label="工作流状态"/);
  assert.match(html, /class="wfv-run-state" data-state="attention"/);
  assert.match(html, /2 \/ 5 步已完成/);
  assert.match(html, /接下来<\/span> <strong>先处理失败步骤<\/strong>：<a class="wfv-next-link" href="#node-n11"/);
  assert.match(html, /class="wfv-flow-meta"><strong>4<\/strong> 个阶段/);
  assert.match(html, /class="wfv-step-context">第 1 \/ 5 步<\/span>/);
  assert.match(html, /class="wfv-toggle-label">查看要点<\/span>/);
  const empty = V.renderView({ goal: '空工作流', nodes: [] });
  checkPage(empty);
  assert.match(empty, /class="wfv-run-state" data-state="empty"/);
  assert.match(empty, /class="wfv-empty-state wfv-panel"/);
  assert.match(empty, /还没有步骤/);
  const running = V.renderView({ nodes: [node('run', { status: 'running', output: '' })] });
  assert.match(running, /data-state="running"/); assert.match(running, /先等待这一步完成/);
  const ready = V.renderView({ nodes: [node('done'), node('next', { status: 'todo', dependsOn: ['done'], output: '' })] });
  assert.match(ready, /data-state="ready"/); assert.match(ready, /下一步可以运行/);
  const complete = V.renderView({ nodes: [node('done')] });
  assert.match(complete, /data-state="done"/); assert.match(complete, /工作流已完成/);
});

test('有 digest 时使用它；坏 digest 不崩并用摘录补齐', () => {
  const d = SAMPLE(); d.digest = { headline: '选 A，每月 1200 元', findings: [{ text: 'A 每月 1200 元', from: ['n0'] }], nodes: { n0: { gist: 'A 比 B 便宜', points: ['价格含税'] } }, path: ['n2', 'n0'], caveats: ['风险评估失败'] };
  let html = V.renderView(d);
  assert.match(html, /wfv-headline">选 A，每月 1200 元/); assert.doesNotMatch(html, /自动摘录的，未经模型整理，建议/);
  assert.match(html, /依据：<a class="wfv-jump" href="#node-n0"/); assert.match(html, /建议阅读顺序/); assert.match(html, /<ul class="wfv-caveats"><li>风险评估失败/);
  for (const bad of ['x', 1, [], { headline: 5, findings: 'oops', nodes: [1, null, { id: '<b>' }], path: {}, caveats: [{}] }]) {
    d.digest = bad; html = V.renderView(d); checkPage(html);
  }
});

test('表格节点：真正的表格、可排序表头、筛选/复制/导出控件、xlsx 链接', () => {
  const html = V.renderView(SAMPLE());
  assert.match(html, /<table class="wfv-table"><thead><tr><th scope="col" aria-sort="none"><button type="button" class="wfv-sort" data-col="0" data-label="方案">/);
  assert.match(html, /<tr data-i="2"><td>C<\/td><td>900<\/td><td>含&quot;引号&quot;,逗号<\/td><\/tr>/);
  for (const c of ['wfv-table-filter', 'wfv-copy-tsv', 'wfv-export-csv']) assert.ok(html.includes(c));
  assert.match(html, /href="results\/n10-%E5%AF%B9%E6%AF%94.xlsx">打开 Excel 原文件/);
});

test('边界数据：缺字段/null/空数组/重复 id/悬空依赖/环/超长/RTL/emoji 都不崩且结构合法', () => {
  const long = 'A'.repeat(30000), cases = [
    undefined, null, {}, { nodes: null }, { nodes: [] }, { nodes: [null, 1, 'x', [], {}] },
    { goal: 123, generatedAt: 'x', nodes: [{ id: 'n0' }, { id: 'n0', dependsOn: ['n0', 'zz', null] }, { id: '<b>', dependsOn: 'n0' }] },
    { nodes: [node('n0', { dependsOn: ['n1'] }), node('n1', { dependsOn: ['n0'] })] },
    { nodes: [node('n0', { output: long, title: long, agent: long, error: long, model: long, status: 'weird', tier: 99 })] },
    { nodes: [node('n0', { output: '\u202eRTL مرحبا 😀👨‍👩‍👧 \u0000\u0007 `code` **b *i* b** ~~x~~ |a|b|\n|-|-|\n|1|2|', title: '😀'.repeat(40) })] },
    { nodes: [node('n0', { table: { head: null, rows: [[1, null, { x: 1 }], 'bad', ['<b>']] } }), node('n1', { table: { head: [], rows: [] } })] },
    { nodes: Array.from({ length: 60 }, (_, i) => node('n' + i, { agent: 'a' + (i % 7) })) },
    { nodes: [node('n0', { files: { md: '../secret.md', xlsx: 'C:/x.xlsx' } }), node('n1', { files: { md: 'javascript:alert(1)', xlsx: '/etc/passwd' } }), node('n2', { files: null })] }
  ];
  for (const c of cases) { const html = V.renderView(c); checkPage(html); }
  const dupe = V.renderView(cases[6]);
  assert.match(dupe, /id="node-n0"/); assert.match(dupe, /id="node-n0-2"/); assert.match(dupe, /重复的步骤编号/); assert.match(dupe, /找不到：zz/);
  assert.doesNotMatch(V.renderView(cases[13]), /secret|C:\/x|passwd|javascript:alert/);
  assert.ok(V.renderView(cases[12]).split('class="wfv-node"').length - 1 <= V.LIMITS.nodes);
});

test('规模：12 个节点、每个 6000 字 + 表格，页面 ≤ 400KB 且生成很快', () => {
  const para = '这是一段用于压测的中文结果，包含 **重点** 和 `代码`，以及一个[链接](https://example.com)。\n';
  const nodes = Array.from({ length: 12 }, (_, i) => node('n' + i.toString(36).toUpperCase(), { dependsOn: i ? ['n' + (i - 1).toString(36).toUpperCase()] : [], agent: ['研究员', '分析师', '撰稿', '审校'][i % 4], output: ('## 第' + i + '部分\n- 要点\n' + para.repeat(80)).slice(0, 6000), table: i % 3 ? null : { head: ['a', 'b', 'c'], rows: Array.from({ length: 50 }, (_, r) => ['行' + r, String(r * 3), 'x']) } }));
  const t0 = Date.now(), html = V.renderView({ goal: '压测', generatedAt: Date.now(), nodes, digest: null }), ms = Date.now() - t0;
  const kb = Buffer.byteLength(html) / 1024;
  assert.ok(kb <= 400, '页面大小 ' + kb.toFixed(0) + 'KB'); assert.ok(ms < 1500, '生成耗时 ' + ms + 'ms'); checkPage(html);
});

test('Markdown 安全渲染：白名单语法正确，原始 HTML 一律转义', () => {
  const md = V.renderMarkdown;
  assert.equal(md('# 标题'), '<h4>标题</h4>');
  assert.equal(md('**粗** *斜* `a<b` ~~删~~'), '<p><strong>粗</strong> <em>斜</em> <code>a&lt;b</code> <del>删</del></p>');
  assert.equal(md('- a\n- b\n  - c\n1. x'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>x</li></ol>');
  assert.equal(md('3. 三\n4. 四'), '<ol start="3"><li>三</li><li>四</li></ol>');
  assert.equal(md('> 引用\n> **强调**'), '<blockquote><p>引用<br><strong>强调</strong></p></blockquote>');
  assert.equal(md('```\n<script>x</script>\n```'), '<pre class="wfv-code"><code>&lt;script&gt;x&lt;/script&gt;</code></pre>');
  assert.equal(md('```\n未闭合'), '<pre class="wfv-code"><code>未闭合</code></pre>');
  assert.match(md('|a|b|\n|--|--|\n|1|<i>|'), /<table class="wfv-mdtable"><thead><tr><th scope="col">a<\/th><th scope="col">b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>&lt;i&gt;<\/td><\/tr>/);
  assert.equal(md('[a](https://x.com/?q=1&r="2")'), '<p>[a](https://x.com/?q=1&amp;r=&quot;2&quot;)</p>', '带引号的链接被拒绝');
  assert.equal(md('[a](https://x.com/?q=1&r=2)'), '<p><a href="https://x.com/?q=1&amp;r=2" rel="noopener noreferrer" target="_blank">a</a></p>');
  assert.equal(md('看 https://x.com/a，然后'), '<p>看 <a href="https://x.com/a" rel="noopener noreferrer" target="_blank">https://x.com/a</a>，然后</p>');
  assert.equal(md('[本地](results/n0.md)'), '<p><a href="results/n0.md" rel="noopener noreferrer" target="_blank">本地</a></p>');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', ' javascript:x', 'java\tscript:x', 'data:text/html,x', 'vbscript:x', '//evil.com', 'file:///c:/x']) {
    assert.doesNotMatch(md('[x](' + bad + ')'), /<a /, bad);
  }
  assert.equal(md('**a ~~b** c~~'), '<p><strong>a ~~b</strong> c~~</p>', '交错的强调不生成交叉标签');
  assert.equal(md('2*3*4 和 a_b_c'), '<p>2*3*4 和 a_b_c</p>', '乘号与下划线不误判为强调');
  assert.equal(md(''), ''); assert.equal(md(null), '');
  checkPage('<!doctype html><html><head><title>x</title></head><body>' + md(EVIL + '\n# <x>\n- [a](javascript:1)\n> > > > deep') + '<script type="application/json">{}</script><script>' + V.CLIENT_SCRIPT + '</script></body></html>');
});

test('safeUrl / safeFile', () => {
  assert.equal(V.safeUrl('https://a.com'), 'https://a.com'); assert.equal(V.safeUrl('HTTP://a.com'), 'HTTP://a.com'); assert.equal(V.safeUrl('a/b.md'), 'a/b.md'); assert.equal(V.safeUrl('#x'), '#x');
  for (const b of ['javascript:x', 'data:x', '//a.com', 'a b', 'mailto:x', '', null, 'https://a.com/"x']) assert.equal(V.safeUrl(b), null, String(b));
  assert.equal(V.safeFile('results/n0-调研.md'), 'results/n0-%E8%B0%83%E7%A0%94.md'); assert.equal(V.safeFile('results\\a b.md'), 'results/a%20b.md');
  for (const b of ['../x', 'a/../../x', '/x', 'C:/x', 'c:\\x', 'javascript:x', '', null, 'a"b']) assert.equal(V.safeFile(b), null, String(b));
});

test('布局：按阶段分列、并行上下排；坏依赖与环不崩；连线只连存在的节点', () => {
  const p = V.prepare(SAMPLE()), L = V.layoutGraph(p.nodes);
  assert.deepEqual(L.cols, [['n0'], ['n10', 'n11'], ['n2'], ['n3']]);
  assert.equal(L.pos.n10.x, L.pos.n11.x); assert.ok(L.pos.n11.y > L.pos.n10.y); assert.equal(L.edges.length, 5);
  const c = V.prepare({ nodes: [{ id: 'a', dependsOn: ['b', 'zz'] }, { id: 'b', dependsOn: ['a'] }] }), Lc = V.layoutGraph(c.nodes);
  assert.equal(Object.keys(Lc.pos).length, 2); assert.equal(Lc.edges.length, 2);
  assert.deepEqual(V.layoutGraph([]).cols, []);
  assert.equal(p.nodes.find(n => n.key === 'n10').color, V.PALETTE[1]); assert.equal(p.nodes.find(n => n.key === 'n0').color, V.PALETTE[0]);
});

test('clientLib：搜索区间、排序（数字/中文/空值/稳定/恢复）、行筛选、TSV、CSV（公式注入防护）', () => {
  const L = V.clientLib();
  assert.deepEqual(L.findRanges('Abc abc ABC', 'abc'), [[0, 3], [4, 7], [8, 11]]); assert.deepEqual(L.findRanges('x', '  '), []);
  assert.deepEqual(L.findRanges('İstanbul 方案A', '方案a'), [[9, 12]], '大小写转换不改变下标');
  const rows = [['A', '1,200'], ['B', '900'], ['C', ''], ['D', '1700'], ['E', '甲']].map((cells, i) => ({ i, cells }));
  assert.deepEqual(L.sortRows(rows, 1, 'ascending').map(r => r.cells[0]), ['B', 'A', 'D', 'E', 'C']);
  assert.deepEqual(L.sortRows(rows, 1, 'descending').map(r => r.cells[0]), ['E', 'D', 'A', 'B', 'C'], '空值总在最后');
  assert.deepEqual(L.sortRows(L.sortRows(rows, 1, 'ascending'), -1, 'none').map(r => r.i), [0, 1, 2, 3, 4]);
  assert.deepEqual(L.sortRows([{ i: 0, cells: ['第10'] }, { i: 1, cells: ['第2'] }], 0, 'ascending').map(r => r.i), [1, 0]);
  assert.equal(L.rowMatches(['Apple', '1'], 'APP'), true); assert.equal(L.rowMatches(['x'], 'y'), false); assert.equal(L.rowMatches(['x'], ''), true);
  assert.equal(L.toTSV(['a', 'b'], [['1\t2', 'x\ny']]), 'a\tb\n1 2\tx y');
  assert.equal(L.toCSV(['a', 'b'], [['=1+1', '-5'], ['x,"y"', '@me']]), '\ufeffa,b\r\n\'=1+1,-5\r\n"x,""y""",\'@me');
  assert.equal(L.num('¥1,200元'), 1200); assert.equal(L.num('12%'), 12); assert.equal(L.num('abc'), null);
});

test('clientLib：过滤（子智能体/状态/只看有问题/搜索交集）、上下游闭包、j/k 步进、字号档位', () => {
  const L = V.clientLib(), ns = V.prepare(SAMPLE()).nodes.map(n => ({ k: n.key, a: n.agent, s: n.status, d: n.deps, u: n.downs }));
  assert.deepEqual(Object.keys(L.visible(ns, {})), ['n0', 'n10', 'n11', 'n2', 'n3']);
  assert.deepEqual(Object.keys(L.visible(ns, { agent: '分析师' })), ['n10', 'n11']);
  assert.deepEqual(Object.keys(L.visible(ns, { status: 'problem' })), ['n11', 'n2']);
  assert.deepEqual(Object.keys(L.visible(ns, { agent: '撰稿', status: 'problem', hits: { n2: true, n0: true } })), ['n2']);
  const nb = L.neighbors(ns, 'n10');
  assert.deepEqual(Object.keys(nb.up), ['n0']); assert.deepEqual(Object.keys(nb.down).sort(), ['n2', 'n3']);
  const cyc = L.neighbors([{ k: 'a', d: ['b'], u: ['b'] }, { k: 'b', d: ['a'], u: ['a'] }], 'a'); assert.deepEqual(Object.keys(cyc.up), ['b']);
  assert.equal(L.step(['a', 'b', 'c'], null, 1), 'a'); assert.equal(L.step(['a', 'b', 'c'], 'c', 1), 'c'); assert.equal(L.step(['a', 'b'], 'b', -1), 'a'); assert.equal(L.step([], 'a', 1), null);
  assert.equal(L.font(16, 1), 17); assert.equal(L.font(22, 1), 22); assert.equal(L.font(14, -1), 14); assert.equal(L.font('abc', 1), 17);
});

// ---------- 内联脚本冒烟：最小 DOM 桩 ----------
function fakeDom(json) {
  const listeners = {}, el = (tag = 'div') => {
    const attrs = {}, cls = new Set();
    return {
      tagName: tag.toUpperCase(), nodeType: 1, style: { setProperty() {} }, textContent: '', value: '', firstChild: null,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle: (c, on) => (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c) },
      getAttribute: k => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: k => { delete attrs[k]; }, hasAttribute: k => k in attrs,
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, blur() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ top: 0 }), _cls: cls
    };
  };
  const root = el(), data = el('script'); data.textContent = json; root.classList.add('no-js');
  const document = {
    getElementById: id => (id === 'view-root' ? root : id === 'wfv-data' ? data : null), querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, createElement: el, createTextNode: t => ({ nodeType: 3, nodeValue: t }), body: el('body'), execCommand: () => false
  };
  const window = { document, localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, location: { hash: '#node-zz' }, innerHeight: 800, matchMedia: () => ({ matches: true }), setTimeout: f => f(), clearTimeout() {}, requestAnimationFrame: f => f(), addEventListener: (t, f) => { (listeners['w:' + t] ||= []).push(f); }, navigator: {}, URL: {}, Blob: function () {} };
  return { window, document, root, listeners };
}

test('内联脚本：在 vm 里能初始化（localStorage 抛错也不影响），常用事件路径不抛错', () => {
  const html = V.renderView(SAMPLE()), json = html.match(/<script type="application\/json" id="wfv-data">([\s\S]*?)<\/script>/)[1];
  const dom = fakeDom(json), ctx = vm.createContext({ window: dom.window, document: dom.document });
  vm.runInContext(V.CLIENT_SCRIPT, ctx, { timeout: 1000 });
  assert.ok(dom.root._cls.has('js') && !dom.root._cls.has('no-js'), '脚本运行后切到 js 模式（无脚本时内容全部可见）');
  const fire = (type, ev) => (dom.listeners[type] || []).forEach(f => f({ preventDefault() {}, target: dom.document.body, ...ev }));
  for (const key of ['/', 'j', 'k', 'Escape', 'Enter', ' ', 'x']) fire('keydown', { key });
  fire('click', {}); fire('input', {}); fire('change', {}); fire('mouseover', {}); fire('mouseout', {}); fire('focusin', {});
  (dom.listeners['w:scroll'] || []).forEach(f => f());
  // 数据块损坏也只是没有交互，不抛错
  const broken = fakeDom('{not json'); vm.runInContext(V.CLIENT_SCRIPT, vm.createContext({ window: broken.window, document: broken.document }));
  // 没有 #view-root 直接返回
  vm.runInContext(V.CLIENT_SCRIPT, vm.createContext({ window: {}, document: { getElementById: () => null } }));
});

test('内联脚本：不含 innerHTML/eval/外部请求，不含会提前结束脚本的序列', () => {
  const s = V.CLIENT_SCRIPT;
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'import(', '</script', '<!--']) assert.ok(!s.includes(bad), bad);
  assert.doesNotThrow(() => new vm.Script(s));
});

test('UMD：浏览器环境（无 module）下挂到 window.PiWorkflowView，并能复用 PiWorkflowDigest', () => {
  const fs = require('node:fs'), path = require('node:path'), win = {};
  const ctx = vm.createContext({ window: win });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'workflow-digest.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'workflow-view.js'), 'utf8'), ctx);
  assert.equal(typeof win.PiWorkflowDigest.parse, 'function'); assert.equal(typeof win.PiWorkflowView.renderView, 'function');
  const html = win.PiWorkflowView.renderView(SAMPLE());
  assert.match(html, /script-src 'unsafe-inline'/, '浏览器里同步算不了哈希，退回 unsafe-inline'); assert.match(html, /wfv-headline">（结果已过期）推荐 A。/);
});

test('产出物：图用 <img>、网页用沙箱 iframe（无同源权限）、其他文件是链接；越界路径被丢弃；输入附件列出', () => {
  const html = V.renderView({ goal: 'g', nodes: [{ id: 'n0', title: '框图', status: 'done', output: '结论：见图', inputs: [{ name: 'BOM.xlsx', kind: 'table' }, { name: 'x"><script>alert(1)</script>.png', kind: 'image' }],
    files: { items: [
      { name: '框图.svg', kind: 'image', path: 'n0-框图/框图.svg', bytes: 10 },
      { name: '演示.html', kind: 'html', path: 'n0-框图/演示.html', bytes: 10 },
      { name: '对比.xlsx', kind: 'table', path: 'n0-框图/对比.xlsx', bytes: 2048 },
      { name: 'evil', kind: 'file', path: '../../etc/passwd' }, { name: 'abs', kind: 'file', path: 'C:/Windows/win.ini' }, { name: 'js', kind: 'file', path: 'javascript:alert(1)' }, { name: 'x"onerror="1', kind: 'image', path: 'a"b.svg' }
    ] } }] });
  assert.match(html, /<img src="n0-%E6%A1%86%E5%9B%BE\/%E6%A1%86%E5%9B%BE\.svg" alt="框图\.svg">/);
  assert.doesNotMatch(html, /<img[^>]*loading="lazy"/);                                     // lazy 的 <img> 在隐藏/折叠区里不会加载
  assert.match(html, /<iframe class="wfv-frame"[^>]*src="n0-%E6%A1%86%E5%9B%BE\/%E6%BC%94%E7%A4%BA\.html" sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /sandbox="[^"]*allow-same-origin/);                             // 绝不给同源权限
  assert.match(html, /href="n0-%E6%A1%86%E5%9B%BE\/%E5%AF%B9%E6%AF%94\.xlsx"[^>]*>对比\.xlsx/);
  for (const bad of ['etc/passwd', 'Windows', 'javascript:', 'a"b.svg', 'onerror="1']) assert.ok(!html.includes(bad), '不该出现：' + bad);
  assert.match(html, /<span class="wfv-chip">BOM\.xlsx<\/span>/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.match(V.cspFor(), /frame-src file: 'self'/);
});
