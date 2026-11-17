'use strict';
// 新协议（Responses / Gemini）与协议适配器表：请求形状、鉴权头、流式结束标记、模型列表解析、图片输入。
// 用本地假服务器按各家文档的真实形状回包；没有用真实服务商验证，真实验证见最终报告。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probe } = require('./provider-probe.cjs');
const { callModel, buildCall } = require('./provider-call.cjs');
const { ADAPTERS, PROTOCOLS, adapterOf, quirksOf } = require('./provider-adapters.cjs');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}
const readBody = async req => { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; };

test('协议表：每个协议都有 build/text/usage/models，设置页用的 PROTOCOLS 与适配器一一对应', () => {
  for (const p of PROTOCOLS) { const a = ADAPTERS[p.id]; assert.ok(a, p.id); for (const k of ['build', 'text', 'usage']) assert.equal(typeof a[k], 'function', p.id + '.' + k); assert.ok(a.models && a.models.url && a.models.headers && a.models.list, p.id + '.models'); }
  assert.deepEqual(PROTOCOLS.map(p => p.id).sort(), Object.keys(ADAPTERS).sort());
  assert.equal(adapterOf({ provider: '不存在' }), ADAPTERS['openai-compatible']);       // 未知协议按 OpenAI 兼容
});

test('Responses：流式 probe 认 response.completed；失败事件当作失败', async t => {
  let seen;
  const ok = await fixture(t, async (req, res) => { seen = { url: req.url, auth: req.headers.authorization, body: await readBody(req) }; res.end('data: {"type":"response.created"}\n\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{}}\n\n'); });
  const r = await probe({ provider: 'openai-responses', baseUrl: ok + '/v1', model: 'gpt-x', apiKey: 'k1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.url, '/v1/responses'); assert.equal(seen.auth, 'Bearer k1'); assert.equal(seen.body.stream, true); assert.ok(seen.body.input);
  const bad = await fixture(t, (_q, res) => res.end('data: {"type":"response.failed","response":{"error":{"message":"额度不足"}}}\n\n'));
  const r2 = await probe({ provider: 'openai-responses', baseUrl: bad + '/v1', model: 'gpt-x', apiKey: 'k' });
  assert.equal(r2.ok, false); assert.match(r2.error, /额度不足/);
});

test('Gemini：流式 probe 走 streamGenerateContent?alt=sse，密钥在 x-goog-api-key，finishReason 为结束标记', async t => {
  let seen;
  const base = await fixture(t, async (req, res) => { seen = { url: req.url, key: req.headers['x-goog-api-key'], body: await readBody(req) }; res.end('data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}]}\n\n'); });
  const r = await probe({ provider: 'gemini', baseUrl: base, model: 'gemini-2.5-flash', apiKey: 'gk' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.url, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'); assert.equal(seen.key, 'gk');
  assert.ok(seen.body.contents[0].parts[0].text); assert.ok(seen.body.systemInstruction);
  const r2 = await probe({ provider: 'gemini', baseUrl: await fixture(t, (_q, res) => res.end('data: {"candidates":[{"content":{"parts":[{"text":"半截"}]}}]}\n\n')), model: 'm', apiKey: 'k' });
  assert.equal(r2.ok, false); assert.match(r2.error, /没有正常结束标记/);
});

test('模型列表解析：各协议返回形状不同，都能取出 id、上下文长度；Gemini 只留能生成内容的模型并去掉 models/ 前缀', () => {
  const caps = require('./model-capabilities.cjs');
  const list = (provider, body) => caps.catalog(ADAPTERS[provider].models.list(body));
  assert.deepEqual(list('openai-compatible', { data: [{ id: 'gpt-4o' }, { id: 'o3' }] }).map(x => x.id), ['gpt-4o', 'o3']);
  assert.deepEqual(list('openai-responses', { data: [{ id: 'gpt-5' }] }).map(x => x.id), ['gpt-5']);
  assert.deepEqual(list('anthropic', { data: [{ id: 'claude-x', max_input_tokens: 200000 }] }).map(x => [x.id, x.contextWindow]), [['claude-x', 200000]]);
  assert.deepEqual(list('ollama', { models: [{ name: 'qwen3:8b' }] }).map(x => x.id), ['qwen3:8b']);
  const g = list('gemini', { models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] });
  assert.deepEqual(g.map(x => [x.id, x.contextWindow, x.maxOutputTokens]), [['gemini-2.5-pro', 1048576, 65536]]);
  assert.equal(ADAPTERS.gemini.models.url({ baseUrl: '', apiKey: 'k' }), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  assert.equal(ADAPTERS.gemini.models.headers({ apiKey: 'k' })['x-goog-api-key'], 'k');
  assert.equal(ADAPTERS.anthropic.models.headers({ apiKey: 'k' })['x-api-key'], 'k');
});

test('图片输入：四种协议各用自己的格式；没有图片时请求体与以前完全一致', () => {
  const img = [{ mime: 'image/png', base64: 'QUJD' }], req = { system: 's', user: 'u', images: img };
  const oa = buildCall({ provider: 'openai-compatible', baseUrl: 'http://h/v1', model: 'm' }, req).body.messages[1].content;
  assert.deepEqual(oa, [{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
  const an = buildCall({ provider: 'anthropic', baseUrl: 'http://h', model: 'm' }, req).body.messages[0].content;
  assert.deepEqual(an, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'u' }]);
  const rs = buildCall({ provider: 'openai-responses', baseUrl: 'http://h/v1', model: 'm' }, req).body.input;
  assert.deepEqual(rs, [{ role: 'user', content: [{ type: 'input_text', text: 'u' }, { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }] }]);
  const ge = buildCall({ provider: 'gemini', model: 'm' }, req).body.contents[0].parts;
  assert.deepEqual(ge, [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }, { text: 'u' }]);
  const ol = buildCall({ provider: 'ollama', baseUrl: 'http://h', model: 'm' }, req).body.messages[1];
  assert.deepEqual(ol.images, ['QUJD']);
  for (const provider of Object.keys(ADAPTERS)) { const plain = buildCall({ provider, baseUrl: 'http://h/v1', model: 'm' }, { system: 's', user: 'u' }).body; assert.ok(!JSON.stringify(plain).includes('image'), provider); }
});

test('quirks / extraHeaders / extraBody：官方 gpt-5 自动处理；自定义服务可手动开关并附加头与字段', () => {
  assert.deepEqual(quirksOf({ baseUrl: 'https://api.openai.com/v1', model: 'o3-mini' }), { maxCompletionTokens: true, noTemperature: true });
  assert.deepEqual(quirksOf({ baseUrl: 'https://relay.example/v1', model: 'gpt-5' }), {});                  // 中转站不自动改（它们多数兼容 max_tokens）
  const c = buildCall({ provider: 'openai-compatible', baseUrl: 'https://relay.example/v1', model: 'gpt-5', quirks: { maxCompletionTokens: true, noJsonMode: true }, extraHeaders: { 'api-key': 'az' }, extraBody: { top_p: 0.5 } }, { system: 's', user: 'u', json: true });
  assert.equal(c.body.max_completion_tokens, 1500); assert.equal('max_tokens' in c.body, false); assert.equal('response_format' in c.body, false); assert.equal(c.body.top_p, 0.5); assert.equal(c.headers['api-key'], 'az');
});

test('callModel 端到端（假服务器）：Responses 与 Gemini 的 URL/鉴权/解析', async t => {
  const calls = [];
  const base = await fixture(t, async (req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization, gk: req.headers['x-goog-api-key'], body: await readBody(req) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes(':generateContent')) res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '嗨' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }));
    else res.end(JSON.stringify({ output_text: '好', usage: { input_tokens: 3, output_tokens: 4 } }));
  });
  assert.deepEqual(await callModel({ provider: 'openai-responses', baseUrl: base + '/v1', model: 'm', apiKey: 'k' }, { system: 's', user: 'u' }), { text: '好', usage: { input: 3, output: 4 } });
  assert.deepEqual(await callModel({ provider: 'gemini', baseUrl: base, model: 'g', apiKey: 'gk' }, { system: 's', user: 'u', json: true }), { text: '嗨', usage: { input: 2, output: 1 } });
  assert.equal(calls[0].url, '/v1/responses'); assert.equal(calls[0].auth, 'Bearer k');
  assert.equal(calls[1].url, '/v1beta/models/g:generateContent'); assert.equal(calls[1].gk, 'gk'); assert.equal(calls[1].body.generationConfig.responseMimeType, 'application/json');
});
