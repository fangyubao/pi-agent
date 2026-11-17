'use strict';
(() => {
  const fallbackKey = 'pi-workbench-provider-draft';
  function desktop() { return window.piDesktop?.provider || null; }
  async function getConfig() {
    const api = desktop();
    if (api) return api.getConfig();
    try { return JSON.parse(localStorage.getItem(fallbackKey) || '{}'); } catch { return {}; }
  }
  async function saveConfig(config) {
    const api = desktop();
    if (api) return api.saveConfig(config);
    localStorage.setItem(fallbackKey, JSON.stringify({ ...config, apiKey: '' }));
    return { ok: true, browserPreview: true };
  }
  async function listModels(config) {
    const api = desktop();
    if (api) return api.listModels(config);
    return { ok: false, models: [], error: '浏览器预览模式不发起模型请求，请在桌面应用中使用。' };
  }
  async function test(config) {
    const api = desktop();
    if (api) return api.test(config);
    return { ok: false, error: '浏览器预览模式不发起模型请求，请在桌面应用中使用。' };
  }
  window.PiProviderManager = Object.freeze({ getConfig, saveConfig, listModels, test });
})();
