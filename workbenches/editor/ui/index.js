'use strict';
(() => {
  window.PiWorkbenchModules.editor = {
    mount(host, {data, save, notify, esc, server}) {
      const target = new URLSearchParams(location.search).get('target') || data?.target || 'workbench';
      const labels = {circuit:'量子门电路', qubo:'QUBO 求解器', mcu:'MCU 控制台'};
      const d = {target, name:labels[target] || target, description:'', prompt:'', knowledgePaths:[], revision:0, ...data, target};
      let disposed = false;
      const commit = () => { d.revision++; save(structuredClone(d)); };
      const capture = () => {
        const name = host.querySelector('#design-name');
        const description = host.querySelector('#design-description');
        const prompt = host.querySelector('#design-prompt');
        const paths = host.querySelector('#design-kb');
        if (name) d.name = name.value.trim() || labels[target] || target;
        if (description) d.description = description.value;
        if (prompt) d.prompt = prompt.value;
        if (paths) d.knowledgePaths = [...new Set(paths.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
      };
      function render() {
        if (disposed) return;
        host.innerHTML = '<section class="module design-editor"><div class="module-summary"><div><h2>修改工作台设计</h2><p>当前目标：'+esc(labels[target] || target)+' · 修改会保存到当前任务</p></div><span class="tag">设计模式</span></div>' +
          '<section class="module-card"><div class="module-section-title"><h3>用户可见信息</h3><small>不影响本地计算逻辑</small></div><label class="dialog-label">工作台名称<input id="design-name" class="dialog-input" value="'+esc(d.name)+'"></label><label class="dialog-label">工作台说明<textarea id="design-description" class="free-input" rows="3">'+esc(d.description)+'</textarea></label></section>' +
          '<section class="module-card"><div class="module-section-title"><h3>Agent 设计提示词</h3><small>按需载入</small></div><p class="module-note">这里定义 Agent 如何理解当前工作台、何时读取状态、允许调用哪些语义动作。不会把提示词显示给普通使用者。</p><textarea id="design-prompt" class="free-input prompt-editor" rows="10" placeholder="输入该工作台的领域约束、状态读取规则和动作使用规则">'+esc(d.prompt)+'</textarea></section>' +
          '<section class="module-card"><div class="module-section-title"><h3>设计知识库路径</h3><small>本地只读，可选多个</small></div><textarea id="design-kb" class="free-input path-input" rows="3" placeholder="每行一个目录或文件绝对路径">'+esc((d.knowledgePaths||[]).join('\n'))+'</textarea><p class="module-note">路径仅保存为工作台设计的一部分；需要导入和整理时，请使用创建工作台中的知识库流程。</p></section>' +
          '<div class="module-card design-save-card"><span class="module-note">当前修订 '+d.revision+' · 设计者确认后才会影响后续 Agent 上下文</span><button class="button primary" id="design-save">保存设计</button></div></section>';
        host.querySelector('#design-save').onclick = () => { capture(); commit(); notify('工作台设计已保存'); render(); };
      }
      render();
      return {
        sync(next){Object.assign(d,next);render();},
      invoke(command,payload={}) { return server(command,payload); },
      dispose() { disposed = true; }
      };
    }
  };
})();
