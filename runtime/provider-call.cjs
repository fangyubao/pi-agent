'use strict';
// 直连模型的一次性调用（不经过 Pi、不带工具、不流式）。记忆整理与工作流拆解器共用。
// 协议：openai-compatible、anthropic、ollama、openai-responses、gemini（见 provider-adapters.cjs）。网络与超时都可注入，便于用假服务器测试。
const { adapterOf } = require('./provider-adapters.cjs');

// 具体协议在 provider-adapters.cjs 的适配器表里；这里只做通用部分（extraHeaders / extraBody 浅合并）。
function buildCall(cfg, { system, user, maxTokens = 1500, json = true, temperature = 0.1, effort, images }) {
  const call = adapterOf(cfg).build(cfg, { system, user, maxTokens, json, temperature, effort, images });
  return { ...call, headers: { ...call.headers, ...(cfg.extraHeaders || {}) }, body: { ...call.body, ...(cfg.extraBody || {}) } };
}

function readText(cfg, payload) { return adapterOf(cfg).text(payload); }

// 服务商的错误说明有时会原样回显我们发去的密钥；报错信息会显示给用户、写进日志，所以先抹掉。
function scrub(text, cfg) {
  let out = text;
  if (cfg.apiKey && String(cfg.apiKey).length >= 6) out = out.split(String(cfg.apiKey)).join('[已隐藏]');
  return out.replace(/\b(?:sk|key|tok|ak)-[A-Za-z0-9_-]{8,}/g, "[已隐藏]").replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/g, "Bearer [已隐藏]");
}

// 把状态码翻成普通人看得懂的话；原始状态码仍保留在括号里，方便排查。
function explainStatus(status) {
  const known = { 400: '请求被服务商拒绝了（可能是模型名不对或内容太长）', 401: 'API 密钥无效或已过期，请到 设置 → LLM 检查', 402: '服务商账户余额不足', 403: '没有使用这个模型的权限', 404: '找不到这个模型或接口地址，请检查模型名和 API 地址', 408: '服务商响应超时', 413: '发送的内容太长', 429: '请求太频繁或额度用完了，稍等一会儿再试', 500: '服务商那边出了点问题', 502: '服务商网关暂时不可用', 503: '服务商暂时繁忙', 504: '服务商响应超时' };
  return (known[status] || (status >= 500 ? '服务商那边出了点问题' : '模型请求没有成功')) + ' [HTTP ' + status + ']';
}

// 返回 { text, usage }。usage 来自服务商；服务商没给时为 null，不估算、不编造。
async function callModel(cfg, request, { fetchImpl = fetch, timeoutMs = 60000, signal } = {}) {
  if (!cfg?.model) throw new Error('请先在设置中选择模型');
  const call = buildCall(cfg, request);
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  const response = await fetchImpl(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(call.body), signal: AbortSignal.any(signals) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(explainStatus(response.status) + (payload?.error?.message ? '（服务商说明：' + scrub(String(payload.error.message), cfg).slice(0, 120) + '）' : ''));
  const usage = adapterOf(cfg).usage(payload);
  return { text: readText(cfg, payload), usage };
}
module.exports = { explainStatus, callModel, buildCall, readText, scrub };
