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
  async function probeCapabilities(config) {
    const api = desktop();
    if (api?.probeCapabilities) return api.probeCapabilities(config);
    return { ok: false, error: '浏览器预览模式不支持能力探测，请在桌面应用中使用。' };
  }
  async function parseAgentImport(input) {
    const api = desktop();
    if (api?.parseAgentImport) return api.parseAgentImport(input);
    return { ok: false, error: '浏览器预览模式不支持 AI 解析，请在桌面应用中使用。' };
  }
  async function startPairing(input) {
    const api = desktop();
    if (api?.startPairing) return api.startPairing(input);
    return { ok: false, error: '浏览器预览模式不支持本地配对服务，请在桌面应用中使用。' };
  }
  async function pairingStatus() {
    const api = desktop();
    if (api?.pairingStatus) return api.pairingStatus();
    return { ok: false, status: 'idle' };
  }
  async function openConnectDir() {
    const api = desktop();
    if (api?.openConnectDir) return api.openConnectDir();
    return { ok: false, error: '浏览器预览模式不支持打开本地目录' };
  }
  async function launchAgent(input) {
    const api = desktop();
    if (api?.launchAgent) return api.launchAgent(input);
    return { ok: false, error: '浏览器预览模式不支持链式启动外部 Agent' };
  }
  async function deleteMany(profileIds) {
    const api = desktop();
    if (api?.deleteMany) return api.deleteMany(profileIds);
    return { ok: false, error: '浏览器预览模式不支持批量删除配置' };
  }
  async function refreshRankings() {
    const api = desktop();
    if (api?.refreshRankings) return api.refreshRankings();
    return { ok: true, rankings: window.PiModelLeaderboard?.defaultSnapshot?.() || null };
  }
  async function saveRankingSettings(input) {
    const api = desktop();
    if (api?.saveRankingSettings) return api.saveRankingSettings(input);
    return { ok: true };
  }
  function onUpdated(callback) {
    const api = desktop();
    return api?.onUpdated ? api.onUpdated(callback) : () => {};
  }
  window.PiProviderManager = Object.freeze({ getConfig, saveConfig, listModels, test, probeCapabilities, parseAgentImport, startPairing, pairingStatus, openConnectDir, launchAgent, deleteMany, refreshRankings, saveRankingSettings, onUpdated });
})();
