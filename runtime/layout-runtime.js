'use strict';
// 导出的工作台在没有编辑器时使用的布局标记脚本：按与布局编辑器完全相同的规则给元素写 data-pi-node-id，
// 这样 ui/layout.css 里的 [data-pi-node-id="…"] 规则才能选中元素。必须与 workbenches/layout-editor.js 的 scan() 保持同一套 id 规则
// （runtime/layout-runtime.test.cjs 会对比两者的结果，防止漂移）。
(() => {
  const ignored = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'OPTION', 'BR']);
  function tag(root, key) {
    const host = root || document.getElementById('pi-preview-host') || document.body;
    const walk = (parent, prefix) => {
      [...parent.children].forEach((el, index) => {
        if (ignored.has(el.tagName) || el.dataset.piEditor !== undefined) return;
        const identity = el.getAttribute('data-design-id') || el.id || el.getAttribute('data-cell') || el.getAttribute('data-gate-id');
        const part = identity ? el.tagName.toLowerCase() + '#' + encodeURIComponent(identity) : el.tagName.toLowerCase() + '[' + index + ']';
        const id = el.dataset.piNodeId || (prefix + '/' + part);
        el.dataset.piNodeId = id;
        walk(el, id);
      });
    };
    const rootId = (key || 'preview') + '/page';
    host.dataset.piNodeId = rootId;
    // 与布局编辑器一致：根的子元素以 key 为前缀（不含 /page），这样编辑器保存的 id 在导出后仍能对上。
    walk(host, key || 'preview');
  }
  window.PiLayoutRuntime = { tag };
  // 运行态下 body 就是页面根（没有预览桥包装容器）；预览里桥已经包好并交给编辑器，此时不重复处理。
  if (!window.__piPreviewBridge) {
    const run = () => { if (!document.getElementById('pi-preview-host')) tag(document.body, 'preview'); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();
  }
})();
