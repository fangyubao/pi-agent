'use strict';
// Used only when neither the provider nor the user declared a value. Pi clamps
// max_tokens to (window - input - 4096), so a small fallback window squeezed the
// output budget to ~1 token on a 34k-token prompt and every run ended in "length".
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_OUTPUT = 32768;
function buildModel(cfg = {}) {
  const contextWindow = Number(cfg.contextWindow) > 0 ? Number(cfg.contextWindow) : DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(Number(cfg.maxOutputTokens) || DEFAULT_MAX_OUTPUT, Math.max(1, contextWindow - 1024));
  let deepseek = false;
  try { deepseek = new URL(cfg.baseUrl).hostname === 'api.deepseek.com'; } catch { /* Other compatible endpoints keep their declared behavior. */ }
  // Capability is not the selected effort. DeepSeek needs reasoning=true even
  // with effort=off so Pi actually sends thinking:{type:'disabled'}.
  return { id: cfg.model, name: cfg.model, reasoning: deepseek || cfg.effort !== 'off', input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens,
    ...(deepseek ? { compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' } } : {}),
    ...(cfg.provider === 'anthropic' ? { api: 'anthropic-messages' } : cfg.provider === 'openai-responses' ? { api: 'openai-responses' } : cfg.provider === 'gemini' ? { api: 'google-generative-ai' } : {}) };
}
module.exports = { buildModel, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT };
