'use strict';
// 预览页里的布局设计：把编辑器脚本注入工程自己的 ui/index.html，布局结果落成真实文件。
//   ui/layout.json  —— 编辑器自己的数据（节点几何、撤销前的状态）
//   ui/layout.css   —— 由 layout.json 生成的真实 CSS，index.html 自动引用，所以导出的工作台自带布局
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_NODES = 2000;
const num = value => (Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 20000 ? Math.round(Number(value) * 100) / 100 : null);
// 节点 id 来自编辑器扫描：<标签>[序号] 或 <标签>#<id>，不是 CSS 选择器；这里不信任它，只当作 data 属性值。
const attr = id => String(id).replace(/[\u0000-\u001f"\\]/g, '');

function cssFor(layout) {
  const lines = ['/* 由「界面预览」里的布局设计自动生成，请不要手动编辑；在预览里重新拖拽即可。 */'];
  const nodes = layout && typeof layout.nodes === 'object' ? layout.nodes : {};
  let count = 0;
  for (const [id, geometry] of Object.entries(nodes)) {
    if (++count > MAX_NODES || !geometry || typeof geometry !== 'object') continue;
    const x = num(geometry.x), y = num(geometry.y), w = num(geometry.width), h = num(geometry.height), z = num(geometry.zIndex);
    const rules = [];
    // 页面根容器（<id>/page）用外边距表达位置：它自己的 transform 被预览画布的缩放占用。
    const isRoot = id.endsWith('/page');
    if ((x || y) && isRoot) rules.push('margin-left:' + (x || 0) + 'px', 'margin-top:' + (y || 0) + 'px');
    else if (x || y) rules.push('translate:' + (x || 0) + 'px ' + (y || 0) + 'px');
    if (w !== null) rules.push('width:' + w + 'px', 'min-width:0', 'max-width:none', 'box-sizing:border-box');
    if (h !== null) rules.push('height:' + h + 'px', 'min-height:0', 'max-height:none', 'box-sizing:border-box');
    if (z !== null) rules.push('z-index:' + z, 'position:relative');
    if (rules.length) lines.push('[data-pi-node-id="' + attr(id) + '"]{' + rules.join(';') + '}');
  }
  return lines.join('\n') + '\n';
}

async function readLayout(uiDir) {
  try { const value = JSON.parse(await fs.readFile(path.join(uiDir, 'layout.json'), 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

async function writeLayout(uiDir, layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('布局数据无效');
  if (Object.keys(layout.nodes || {}).length > MAX_NODES) throw new Error('布局元素过多');
  const json = JSON.stringify({ revision: Number(layout.revision) || 0, canvasWidth: num(layout.canvasWidth), nodes: layout.nodes || {}, order: layout.order || [], titles: layout.titles || {} }, null, 2);
  await fs.writeFile(path.join(uiDir, 'layout.json.tmp'), json, 'utf8');
  await fs.rename(path.join(uiDir, 'layout.json.tmp'), path.join(uiDir, 'layout.json'));
  await fs.writeFile(path.join(uiDir, 'layout.css.tmp'), cssFor(layout), 'utf8');
  await fs.rename(path.join(uiDir, 'layout.css.tmp'), path.join(uiDir, 'layout.css'));
  return { revision: Number(layout.revision) || 0, nodes: Object.keys(layout.nodes || {}).length };
}

// 给工程的 index.html 注入：编辑器样式与脚本。幂等：已含标记则不重复注入。
function injectEditor(html, { editorScript, editorCss, bootstrap }) {
  if (/data-pi-injected/.test(html)) return html;
  // 不再注入 layout.css：预览里由编辑器按 layout.json 自己应用布局，再加载 layout.css 会把同一份坐标叠加两次。
  const head = '<style data-pi-injected>' + editorCss + '</style>';
  const tail = '<script data-pi-injected>' + bootstrap + '<\/script><script data-pi-injected>' + editorScript + '<\/script>';
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => head + '</head>') : head + html;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => tail + '</body>') : out + tail;
  return out;
}

// 嵌进 <script> 的 JSON 必须转义 < > & 以及 U+2028/2029，否则内容里的 </script> 会截断脚本并注入代码。
function safeJson(value) {
  // 输出里要的是“反斜杠 + u003c”这几个字符，所以源码里的反斜杠必须成对写。
  const map = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, ch => map[ch]);
}

module.exports = { cssFor, readLayout, writeLayout, injectEditor, safeJson, MAX_NODES };
