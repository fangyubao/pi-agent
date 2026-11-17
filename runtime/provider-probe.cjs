'use strict';
function redact(text, key) {
  let value = String(text || '');
  if (key) value = value.split(key).join('[已隐藏密钥]');
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 600);
}
async function probe(cfg, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let httpStatus = null;
  try {
    if (!cfg.model) throw new Error('请先选择一个模型，再测试连接');
    const base = new URL(cfg.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('请填写不含账号密码的 HTTP/HTTPS API 地址');
    const kind = cfg.provider, anthropic = kind === 'anthropic', ollama = kind === 'ollama', responses = kind === 'openai-responses', gemini = kind === 'gemini';
    const { adapterOf } = require('./provider-adapters.cjs');
    // 用适配器按“真实调用”的方式构造一次请求（地址、鉴权头、字段名都和实际使用一致），再改成流式。
    const built = adapterOf(cfg).build(cfg, { system: 'Reply briefly.', user: 'Reply with OK.', maxTokens: 256, json: false, temperature: 0.1 });
    let url = built.url;
    const headers = { ...built.headers, Accept: ollama ? 'application/x-ndjson' : 'text/event-stream', ...(cfg.extraHeaders || {}) };
    const body = { ...built.body, ...(cfg.extraBody || {}) };
    if (gemini) url = url.replace(':generateContent', ':streamGenerateContent') + '?alt=sse';
    else if (ollama) { body.stream = true; body.options = { num_predict: 256 }; }
    else body.stream = true;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    httpStatus = response.status;
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 2000));
    let pending = '', bytes = 0, frames = 0, finished = false, output = false;
    function consume(line) {
      const raw = ollama ? line : line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!raw || raw === '[DONE]') return;
      let event; try { event = JSON.parse(raw); } catch { throw new Error('响应流包含无法解析的 JSON'); }
      frames++;
      if (event.error) throw new Error(typeof event.error === 'string' ? event.error : event.error.message || 'API 返回流式错误');
      if (ollama) { output ||= Boolean(event.message?.content || event.message?.thinking); finished ||= event.done === true; }
      else if (anthropic) { output ||= Boolean(event.delta?.text || event.delta?.thinking); finished ||= event.type === 'message_stop'; }
      else if (responses) { output ||= Boolean(event.type === 'response.output_text.delta' && event.delta); finished ||= event.type === 'response.completed'; if (event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('响应未完成：' + (event.response?.error?.message || event.response?.incomplete_details?.reason || event.type)); }
      else if (gemini) { const c = event.candidates?.[0]; output ||= Boolean((c?.content?.parts || []).some(x => x.text)); finished ||= Boolean(c?.finishReason); }
      else { for (const choice of event.choices || []) { output ||= Boolean(choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls); finished ||= Boolean(choice.finish_reason); } }
    }
    if (!response.body) throw new Error('API 未返回响应流');
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('测试响应超过 1 MB，已停止');
      pending += decoder.decode(chunk, { stream: true });
      let pos; while ((pos = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, pos).trim()); pending = pending.slice(pos + 1); }
    }
    pending += decoder.decode(); if (pending.trim()) consume(pending.trim());
    if (!finished) throw new Error('响应流已结束，但没有正常结束标记（finish_reason / message_stop / done）。与聊天中的流式中断属于同类问题。');
    return { ok: true, httpStatus, elapsedMs: Date.now() - started, frames, model: cfg.model, message: '模型流式通信正常' + (output ? '' : '；未返回正文，请检查模型推理与输出预算') };
  } catch (error) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
    return { ok: false, httpStatus, elapsedMs: Date.now() - started, model: cfg.model, error: redact(timedOut ? '请求超时：API 未在限定时间内完成响应' : error.message + (error.cause?.code ? '（' + error.cause.code + '）' : ''), cfg.apiKey) };
  }
}
module.exports = { probe, redact };
