'use strict';
(() => {
  const loaded = new Map();
  const registry = Object.create(null);
  const listeners = new Set();
  let active = { workbench: null, plugins: [], mode: 'base', revision: 0 };
  const core = { id: 'pi-core', kind: 'core', version: 1, prompt: '保持 Agent 轻量；先读取当前任务和激活上下文，再执行动作。先自行获取可读取的信息，只有缺少必要需求才使用全局交互确认能力。' };
  window.PiContextRegistry = registry;
  function emit() { listeners.forEach(fn => fn(snapshot())); }
  function snapshot() { return { ...active, contexts: [core, ...loaded.values()].map(x => ({ id: x.id, kind: x.kind, version: x.version })) }; }
  function load(path, id) {
    if (loaded.has(id)) return Promise.resolve(loaded.get(id));
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './' + path;
      script.dataset.context = id;
      script.onload = () => {
        const item = registry[id];
        if (!item) { script.remove(); reject(new Error('上下文未注册：' + id)); return; }
        loaded.set(id, { ...item, script });
        resolve(loaded.get(id));
      };
      script.onerror = () => { script.remove(); reject(new Error('上下文文件未能载入：' + id)); };
      document.head.append(script);
    });
  }
  async function activate(options = {}) {
    const workbench = options.workbench || null;
    const plugins = Array.isArray(options.plugins) ? options.plugins : [];
    const mode = options.mode || (workbench ? 'workbench' : 'base');
    const wanted = [];
    if (workbench) wanted.push(load('contexts/workbenches/' + workbench + '.js', 'workbench:' + workbench));
    if (mode === 'design') wanted.push(load('contexts/workbench-design.js', 'workbench-design'));
    plugins.forEach(id => wanted.push(load('contexts/plugins/' + id + '.js', 'plugin:' + id)));
    const contexts = await Promise.all(wanted);
    const keep = new Set(contexts.map(x => x.id));
    for (const [id, item] of loaded) {
      if (!keep.has(id)) { item.script.remove(); loaded.delete(id); }
    }
    active = { workbench, plugins: [...plugins], mode, revision: active.revision + 1 };
    emit();
    return snapshot();
  }
  function deactivate() { return activate({}); }
  function buildEnvelope(extra = {}) {
    return { core, ...snapshot(), ...extra, contexts: [core, ...loaded.values()].map(x => ({ id: x.id, kind: x.kind, version: x.version, prompt: x.prompt, state: x.state, actions: x.actions, events: x.events,architecture:x.architecture })) };
  }
  window.PiContextManager = Object.freeze({ activate, deactivate, snapshot, buildEnvelope, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } });
})();
