'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { callModel, buildCall } = require('./provider-call.cjs');

function serve(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }); handler(req, res, seen); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ seen, base: 'http://127.0.0.1:' + server.address().port, close: () => server.close() })));
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const req = { system: 'SYS', user: 'USER', maxTokens: 321 };

test('openai 兼容：路径、鉴权头、max_tokens、json 模式、返回文本与 usage', async () => {
  const s = await serve((r, res) => json(res, 200, { choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 11, completion_tokens: 5 } })); try {
    const out = await callModel({ provider: 'openai-compatible', baseUrl: s.base + '/v1', apiKey: 'k', model: 'm' }, req);
    assert.deepEqual(out, { text: '{"ok":1}', usage: { input: 11, output: 5 } });
    const { url, headers, body } = s.seen[0];
    assert.equal(url, '/v1/chat/completions'); assert.equal(headers.authorization, 'Bearer k'); assert.equal(body.max_tokens, 321); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  } finally { s.close(); }
});

test('anthropic：/v1/messages、x-api-key、system 单独字段；usage 字段名不同也能读', async () => {
  const s = await serve((r, res) => json(res, 200, { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 7, output_tokens: 2 } })); try {
    const out = await callModel({ provider: 'anthropic', baseUrl: s.base + '/v1', apiKey: 'ak', model: 'c' }, req);
    assert.deepEqual(out, { text: 'hi', usage: { input: 7, output: 2 } });
    assert.equal(s.seen[0].url, '/v1/messages'); assert.equal(s.seen[0].headers['x-api-key'], 'ak'); assert.equal(s.seen[0].body.system, 'SYS'); assert.equal(s.seen[0].body.max_tokens, 321);
  } finally { s.close(); }
});

test('ollama：/api/chat、stream=false、format=json；token 用量来自 prompt_eval_count', async () => {
  const s = await serve((r, res) => json(res, 200, { message: { content: 'ol' }, prompt_eval_count: 9, eval_count: 3 })); try {
    const out = await callModel({ provider: 'ollama', baseUrl: s.base + '/v1', model: 'l' }, req);
    assert.deepEqual(out, { text: 'ol', usage: { input: 9, output: 3 } });
    assert.equal(s.seen[0].url, '/api/chat'); assert.equal(s.seen[0].body.stream, false); assert.equal(s.seen[0].body.format, 'json');
  } finally { s.close(); }
});

test('服务商没返回用量时 usage 为 null，不估算、不编造', async () => {
  const s = await serve((r, res) => json(res, 200, { choices: [{ message: { content: 'x' } }] })); try {
    assert.equal((await callModel({ provider: 'openai-compatible', baseUrl: s.base + '/v1', model: 'm' }, req)).usage, null);
  } finally { s.close(); }
});

test('HTTP 错误带状态码与服务商的错误说明；错误响应里的密钥不会被回显', async () => {
  const s = await serve((r, res) => json(res, 401, { error: { message: 'bad key sk-live-123456' } })); try {
    await assert.rejects(() => callModel({ provider: 'openai-compatible', baseUrl: s.base + '/v1', apiKey: 'sk-live-123456', model: 'm' }, req), e => /HTTP 401/.test(e.message) && !e.message.includes('sk-live-123456') && /已隐藏/.test(e.message));
  } finally { s.close(); }
});

test('超时与取消都会中断请求，而不是一直挂着', async () => {
  const s = await serve(() => { /* 永不响应 */ }); try {
    const cfg = { provider: 'openai-compatible', baseUrl: s.base + '/v1', model: 'm' };
    await assert.rejects(() => callModel(cfg, req, { timeoutMs: 150 }));
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 100);
    await assert.rejects(() => callModel(cfg, req, { signal: ctl.signal, timeoutMs: 5000 }));
  } finally { s.close(); }
});

test('没有选择模型时给出明确提示；响应不是 JSON 也不会崩溃', async () => {
  await assert.rejects(() => callModel({ provider: 'openai-compatible', baseUrl: 'http://x' }, req), /选择模型/);
  const s = await serve((r, res) => { res.writeHead(200); res.end('<html>not json</html>'); }); try {
    const out = await callModel({ provider: 'openai-compatible', baseUrl: s.base + '/v1', model: 'm' }, req); assert.equal(out.text, '');
  } finally { s.close(); }
});

test('json:false 时不强制 JSON 模式；baseUrl 末尾斜杠不会产生双斜杠', () => {
  const c = buildCall({ provider: 'openai-compatible', baseUrl: 'http://h/v1/', model: 'm' }, { system: 's', user: 'u', json: false });
  assert.equal(c.url, 'http://h/v1/chat/completions'); assert.equal(c.body.response_format, undefined);
});

test('即使服务商回显的不是我们的密钥，常见密钥格式也会被抹掉；普通文字不受影响', () => {
  const { scrub } = require('./provider-call.cjs');
  const out = scrub('bad key sk-proj-abcdef1234567890 and Authorization: Bearer abc123def456ghi789', { apiKey: 'unrelated-xyz' });
  assert.ok(!out.includes('abcdef1234567890') && !out.includes('abc123def456ghi789'), out);
  assert.equal(scrub('model not found', { apiKey: 'abc' }), 'model not found');
  assert.equal(scrub('the sky-blue colour', { apiKey: 'abc' }), 'the sky-blue colour');
});

test('推理模型：content 为空时读取 reasoning_content；有正文时绝不改用推理字段', async () => {
  const s = await serve((r, res) => json(res, 200, { choices: [{ message: { content: '', reasoning_content: '{"from":"reasoning"}' } }] })); try {
    assert.equal((await callModel({ provider: 'openai-compatible', baseUrl: s.base + '/v1', model: 'm' }, req)).text, '{"from":"reasoning"}');
  } finally { s.close(); }
  const t = await serve((r, res) => json(res, 200, { choices: [{ message: { content: '{"from":"content"}', reasoning_content: '思考过程，不应被使用' } }] })); try {
    assert.equal((await callModel({ provider: 'openai-compatible', baseUrl: t.base + '/v1', model: 'm' }, req)).text, '{"from":"content"}');
  } finally { t.close(); }
});

test('模型报错说人话：常见状态码有中文解释并保留状态码；未知状态码也不是干巴巴的 HTTP 数字', () => {
  const { explainStatus } = require('./provider-call.cjs');
  assert.match(explainStatus(401), /密钥无效.*\[HTTP 401\]/); assert.match(explainStatus(429), /太频繁|额度/); assert.match(explainStatus(402), /余额不足/);
  assert.match(explainStatus(503), /繁忙/); assert.match(explainStatus(418), /没有成功/); assert.match(explainStatus(599), /服务商那边/);
});

test('官方 OpenAI 的 gpt-5 / o 系列：用 max_completion_tokens，不带 temperature', () => {
  const c = buildCall({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: 'k' }, { system: 's', user: 'u' });
  assert.equal(c.body.max_completion_tokens, 1500);
  assert.equal('max_tokens' in c.body, false);
  assert.equal('temperature' in c.body, false);
  const old = buildCall({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'k' }, { system: 's', user: 'u' });
  assert.equal(old.body.max_tokens, 1500);
  assert.equal(old.body.temperature, 0.1);
});

test('Responses 与 Gemini 适配器：请求形状、取正文、取用量', async () => {
  const r = buildCall({ provider: 'openai-responses', baseUrl: 'http://h/v1', model: 'm', apiKey: 'k' }, { system: 's', user: 'u' });
  assert.equal(r.url, 'http://h/v1/responses');
  assert.equal(r.body.instructions, 's');
  const g = buildCall({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'k' }, { system: 's', user: 'u' });
  assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(g.headers['x-goog-api-key'], 'k');
  const fake = payload => async () => ({ ok: true, status: 200, json: async () => payload });
  const a = await callModel({ provider: 'openai-responses', baseUrl: 'http://h/v1', model: 'm' }, { system: 's', user: 'u' }, { fetchImpl: fake({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '好' }] }], usage: { input_tokens: 3, output_tokens: 4 } }) });
  assert.deepEqual(a, { text: '好', usage: { input: 3, output: 4 } });
  const b = await callModel({ provider: 'gemini', model: 'm' }, { system: 's', user: 'u' }, { fetchImpl: fake({ candidates: [{ content: { parts: [{ text: '嗨' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 } }) });
  assert.deepEqual(b, { text: '嗨', usage: { input: 5, output: 6 } });
});
