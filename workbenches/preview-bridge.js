'use strict';
// 注入到「界面预览」页面里，把布局编辑器接到应用：
//   页面 → 应用  postMessage {source:'pi-preview', type:'layout-save'|'layout-ready'|'notify'|'invoke-result'}
//   应用 → 页面  postMessage {source:'pi-preview-shell', type:'invoke'|'freeze'|'mode'}
// 页面运行在沙箱 iframe 中，拿不到桌面接口；一切落盘都由应用完成。
(() => {
  if (window.__piPreviewBridge || !window.PiWorkbenchLayout) return;
  window.__piPreviewBridge = true;
  const boot = window.__piPreview || {};
  const post = message => parent.postMessage({ source: 'pi-preview', ...message }, '*');
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='o'){
      event.preventDefault();post({type:'open-source'});
    }
  });
  let controller = null;
  let timer = null;
  function mount() {
    // 工程自己的 index.html 可能引用了 layout.css（真实运行时用它）。预览里由编辑器独自应用布局，所以先停用，避免坐标叠加两次。
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      if (/(^|\/)layout\.css(\?|#|$)/.test(link.getAttribute('href') || '')) link.disabled = true;
    }
    // 编辑器会把宿主节点搬进自己的画布，所以不能直接用 <body>：先把页面内容包进一个容器再交给它。
    const host = document.createElement('div');
    host.id = 'pi-preview-host';
    for (const node of [...document.body.childNodes]) {
      if (node.nodeType === 1 && node.hasAttribute('data-pi-injected')) continue;
      host.appendChild(node);
    }
    document.body.prepend(host);
    controller = window.PiWorkbenchLayout({
      host, key: 'preview', mode: boot.mode || 'design', rootNode: true, data: { _layout: boot.layout || {} },
      persist(next) {
        clearTimeout(timer);
        timer = setTimeout(() => post({ type: 'layout-save', layout: next._layout }), 250);
      },
      notify(message) { post({ type: 'notify', message }); }
    });
    post({ type: 'layout-ready' });
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.source !== 'pi-preview-shell') return;
    const { type, command, payload, requestId } = event.data;
    if (type === 'freeze') { controller?.freeze(); return; }
    if (type !== 'invoke' || !controller) return;
    Promise.resolve().then(() => controller.invoke(command, payload || {}))
      .then(result => post({ type: 'invoke-result', requestId, result }), error => post({ type: 'invoke-result', requestId, error: error.message }));
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
