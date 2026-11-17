'use strict';
// 接口协议清单：设置页的下拉与新建时的默认地址。浏览器和 Node 通用（Node 端 provider-adapters.cjs 引用同一份，不会各写一遍）。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiProviderProtocols = api; })(typeof window === 'object' ? window : globalThis, () => {
  const PROTOCOLS = [
    { id: 'openai-compatible', label: 'OpenAI 兼容接口（/chat/completions）', defaultBase: 'https://api.openai.com/v1', hint: 'OpenAI、DeepSeek、通义、Kimi、OpenRouter 及大多数中转站' },
    { id: 'openai-responses', label: 'OpenAI Responses（/responses）', defaultBase: 'https://api.openai.com/v1', hint: 'OpenAI 官方新接口；gpt-5 / codex 系列推荐' },
    { id: 'anthropic', label: 'Anthropic（/v1/messages）', defaultBase: 'https://api.anthropic.com', hint: 'Claude 官方接口，或兼容 Anthropic 协议的服务' },
    { id: 'gemini', label: 'Google Gemini（原生接口）', defaultBase: 'https://generativelanguage.googleapis.com', hint: 'Google AI Studio 的 API Key' },
    { id: 'ollama', label: 'Ollama 本地服务', defaultBase: 'http://127.0.0.1:11434', hint: '本机运行的模型，不需要 API Key' }
  ];
  const byId = id => PROTOCOLS.find(p => p.id === id) || PROTOCOLS[0];
  return { PROTOCOLS, byId };
});
