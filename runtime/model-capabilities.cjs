'use strict';

// Provider model catalogs are inconsistent. This module only accepts explicit
// metadata returned by the provider or entered by the user; it never guesses a
// model's advertised context window.
const number = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
function normalizeModel(raw) {
  if (typeof raw === 'string') return { id: raw, contextWindow: null, maxOutputTokens: null, source: 'unknown' };
  const id = String(raw?.id || raw?.name || raw?.model || '').trim();
  if (!id) return null;
  const contextWindow = number(raw.context_window ?? raw.contextWindow ?? raw.context_length ?? raw.contextLength ?? raw.max_input_tokens ?? raw.maxInputTokens);
  const maxOutputTokens = number(raw.max_output_tokens ?? raw.maxOutputTokens ?? raw.max_tokens ?? raw.maxTokens);
  return { id, contextWindow, maxOutputTokens, source: contextWindow || maxOutputTokens ? 'provider' : 'unknown' };
}
function catalog(raw) {
  const values = Array.isArray(raw) ? raw : raw?.data || raw?.models || [];
  const result = [];
  for (const value of values) { const item = normalizeModel(value); if (item && !result.some(x => x.id === item.id)) result.push(item); }
  return result;
}
function selected(profile, model) {
  const id = String(model || profile?.model || '');
  const meta = profile?.modelMetadata?.[id];
  const manual = profile?.modelLimits?.[id];
  const source = manual?.contextWindow ? 'manual' : meta?.contextWindow ? meta.source || 'provider' : 'unknown';
  return {
    id,
    contextWindow: number(manual?.contextWindow ?? meta?.contextWindow),
    maxOutputTokens: number(manual?.maxOutputTokens ?? meta?.maxOutputTokens),
    source
  };
}
module.exports = { normalizeModel, catalog, selected, number };
