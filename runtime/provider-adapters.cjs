'use strict';
// 协议适配器表：每种协议只负责 build（构造请求）、text（取正文）、usage（取用量）。
// 新增协议 = 在 ADAPTERS 里加一项，provider-call 不用动。
// cfg 里可选的通用扩展：extraHeaders、extraBody（浅合并）、quirks（见 quirksOf）。

const trimBase = base => String(base || '').replace(/\/+$/, '');
const stripV1 = base => trimBase(base).replace(/\/v1$/, '');
const baseHeaders = () => ({ 'Content-Type': 'application/json', Accept: 'application/json' });
const bearer = (h, cfg) => { if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey; return h; };

// 官方 OpenAI 的新模型（gpt-5、o 系列）不收 max_tokens 和自定义 temperature。
// 自动识别官方地址 + 这类模型名；其他服务可在 cfg.quirks 里手动打开。
function quirksOf(cfg) {
  const official = /(^|\/\/)api\.openai\.com/i.test(String(cfg.baseUrl || ''));
  const reasoning = /^(gpt-5|o\d)/i.test(String(cfg.model || ''));
  const auto = official && reasoning ? { maxCompletionTokens: true, noTemperature: true } : {};
  return { ...auto, ...(cfg.quirks || {}) };
}

const joinText = parts => (parts || []).map(x => x?.text || '').join('');

const ADAPTERS = {
  'openai-compatible': {
    build(cfg, { system, user, maxTokens, json, temperature, effort, images }) {
      const q = quirksOf(cfg);
      const body = {
        model: cfg.model,
        ...(q.noTemperature ? {} : { temperature }),
        [q.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
        ...(effort && effort !== 'off' ? { reasoning_effort: effort } : {}),
        ...(json && !q.noJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: images && images.length ? [{ type: 'text', text: user }, ...images.map(i => ({ type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.base64 } }))] : user }]
      };
      return { url: trimBase(cfg.baseUrl) + '/chat/completions', headers: bearer(baseHeaders(), cfg), body };
    },
    text(p) {
      const m = p?.choices?.[0]?.message || {};
      // 推理类模型可能把答案放在 reasoning_content、content 为空；正文优先，为空才退回推理字段。
      return m.content || m.reasoning_content || m.reasoning || '';
    },
    usage: p => p?.usage ? { input: p.usage.prompt_tokens ?? null, output: p.usage.completion_tokens ?? null } : null,
    models: { url: cfg => trimBase(cfg.baseUrl) + '/models', headers: cfg => bearer({ Accept: 'application/json' }, cfg), list: b => b?.data || b?.models || [] }
  },

  anthropic: {
    build(cfg, { system, user, maxTokens, images }) {
      const headers = { ...baseHeaders(), 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
      const content = images && images.length ? [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })), { type: 'text', text: user }] : user;
      return { url: stripV1(cfg.baseUrl) + '/v1/messages', headers, body: { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] } };
    },
    text: p => joinText(p?.content),
    usage: p => p?.usage ? { input: p.usage.input_tokens ?? null, output: p.usage.output_tokens ?? null } : null,
    models: { url: cfg => stripV1(cfg.baseUrl) + '/v1/models?limit=1000', headers: cfg => ({ Accept: 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }), list: b => b?.data || [] }
  },

  ollama: {
    build(cfg, { system, user, json, images }) {
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user, ...(images && images.length ? { images: images.map(i => i.base64) } : {}) }];
      return { url: stripV1(cfg.baseUrl) + '/api/chat', headers: bearer(baseHeaders(), cfg), body: { model: cfg.model, stream: false, ...(json ? { format: 'json' } : {}), messages } };
    },
    text: p => p?.message?.content || '',
    usage: p => p?.prompt_eval_count !== undefined ? { input: p.prompt_eval_count ?? null, output: p.eval_count ?? null } : null,
    models: { url: cfg => stripV1(cfg.baseUrl) + '/api/tags', headers: cfg => bearer({ Accept: 'application/json' }, cfg), list: b => (b?.models || []).map(x => ({ ...x, id: x.name })) }
  },

  // OpenAI Responses API（/v1/responses）。
  'openai-responses': {
    build(cfg, { system, user, maxTokens, json, temperature, effort, images }) {
      const q = quirksOf(cfg);
      const body = {
        model: cfg.model, instructions: system, input: images && images.length ? [{ role: 'user', content: [{ type: 'input_text', text: user }, ...images.map(i => ({ type: 'input_image', image_url: 'data:' + i.mime + ';base64,' + i.base64 }))] }] : user, max_output_tokens: maxTokens,
        ...(q.noTemperature ? {} : { temperature }),
        ...(effort && effort !== 'off' ? { reasoning: { effort } } : {}),
        ...(json && !q.noJsonMode ? { text: { format: { type: 'json_object' } } } : {})
      };
      return { url: trimBase(cfg.baseUrl) + '/responses', headers: bearer(baseHeaders(), cfg), body };
    },
    text(p) {
      if (typeof p?.output_text === 'string' && p.output_text) return p.output_text;
      return (p?.output || []).filter(i => i?.type === 'message').map(i => joinText((i.content || []).filter(c => c?.type === 'output_text'))).join('');
    },
    usage: p => p?.usage ? { input: p.usage.input_tokens ?? null, output: p.usage.output_tokens ?? null } : null,
    models: { url: cfg => trimBase(cfg.baseUrl) + '/models', headers: cfg => bearer({ Accept: 'application/json' }, cfg), list: b => b?.data || b?.models || [] }
  },

  // Google Gemini 原生接口。baseUrl 缺省为官方地址；模型名放在 URL 里，密钥走 x-goog-api-key。
  gemini: {
    build(cfg, { system, user, maxTokens, json, temperature, images }) {
      const base = trimBase(cfg.baseUrl) || 'https://generativelanguage.googleapis.com';
      const headers = { ...baseHeaders(), ...(cfg.apiKey ? { 'x-goog-api-key': cfg.apiKey } : {}) };
      const generationConfig = { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) };
      const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [...(images || []).map(i => ({ inlineData: { mimeType: i.mime, data: i.base64 } })), { text: user }] }], generationConfig };
      return { url: base + '/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent', headers, body };
    },
    text: p => joinText(p?.candidates?.[0]?.content?.parts),
    usage: p => p?.usageMetadata ? { input: p.usageMetadata.promptTokenCount ?? null, output: p.usageMetadata.candidatesTokenCount ?? null } : null,
    models: {
      url: cfg => (trimBase(cfg.baseUrl) || 'https://generativelanguage.googleapis.com') + '/v1beta/models?pageSize=1000',
      headers: cfg => ({ Accept: 'application/json', ...(cfg.apiKey ? { 'x-goog-api-key': cfg.apiKey } : {}) }),
      list: b => (b?.models || []).filter(m => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => ({ id: String(m.name || '').replace(/^models\//, ''), context_window: m.inputTokenLimit, max_output_tokens: m.outputTokenLimit }))
    }
  }
};

// 协议清单（设置页下拉）与浏览器共用同一份数据。
const { PROTOCOLS } = require('./provider-protocols.js');

// 聊天主流程走 Pi 运行时：我们的协议名 → Pi 的 api 类型（Pi 原生支持这四种；Ollama 走它的 OpenAI 兼容端点）。
const PI_API = { 'openai-compatible': 'openai-completions', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages', gemini: 'google-generative-ai', ollama: 'openai-completions' };
const piApiOf = cfg => PI_API[cfg?.provider] || 'openai-completions';

// 需要密钥的协议：用来在“测试/读取模型”前给出明确提示，而不是等服务端返回 401。
const needsKey = cfg => cfg?.provider !== 'ollama';

// 未知协议名一律按 OpenAI 兼容处理（与旧行为一致）。
const adapterOf = cfg => ADAPTERS[cfg?.provider] || ADAPTERS['openai-compatible'];

module.exports = { ADAPTERS, PROTOCOLS, PI_API, piApiOf, adapterOf, quirksOf, needsKey };
