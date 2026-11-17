'use strict';
// A draft opens at its saved state, including an entirely empty canvas.
window.PiWorkbenchModules.mcu = {
  mount(host, {data, save, server}) {
    const draft = { html: '', revision: 0, ...data, status: 'draft' };
    function render() {
      host.replaceChildren();
      if (!draft.html) return;
      const preview = document.createElement('iframe');
      preview.title = 'MCU 控制台设计草稿';
      // Scripts remain disabled; same-origin access lets the editor address
      // individual DOM elements without granting the draft Electron privileges.
      preview.setAttribute('sandbox', 'allow-same-origin');
      preview.style.cssText = 'display:block;width:100%;height:100vh;border:0;background:white';
      preview.srcdoc = draft.html;
      host.append(preview);
    }
    render();
    save(structuredClone(draft));
    return {
      sync(next){Object.assign(draft,next);render();},
      invoke(command,payload={}) { return server(command,payload); },
      dispose() { host.replaceChildren(); }
    };
  }
};
