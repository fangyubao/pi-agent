'use strict';
// 设置页：协议下拉有五种、切换协议时默认地址跟着换（用户改过的不动）、兼容设置（开关/请求头/字段）能保存并回显、
// 格式错误给可读提示、保存后的值真的出现在发往服务端的请求里；测试通信用所选协议。
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
test.use({ video: 'off' });

async function launch() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    calls.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.url.endsWith('/models') || req.url.startsWith('/v1beta/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/v1beta') ? { models: [{ name: 'models/gem-1', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 }] } : { data: [{ id: 'm-1' }, { id: 'm-2' }] })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url.includes('streamGenerateContent')) res.end('data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}\n\n');
    else if (req.url.endsWith('/responses')) res.end('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{}}\n\n');
    else res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(ROOT, '.pset-'));
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [ROOT, '--user-data-dir=' + profile], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  if (await page.locator('#first-launch').isVisible().catch(() => false)) await page.locator('[data-action="dismiss-first-launch"]').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 1000));
  return { app, page, calls, base: 'http://127.0.0.1:' + server.address().port, close: async () => { await app.close().catch(() => {}); server.close(); await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {}); } };
}

test('设置页：五种协议、切换时默认地址跟着换、兼容设置保存回显并真的进入请求、测试通信走所选协议', async () => {
  const fx = await launch();
  try {
    await fx.page.locator('[data-route="settings"]').click();
    const kind = fx.page.locator('#provider-kind'), url = fx.page.locator('#provider-url');
    expect(await kind.locator('option').evaluateAll(o => o.map(x => x.value))).toEqual(['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'ollama']);
    // 默认地址跟着协议走（还是旧协议默认值时）；手动改过的不动
    await kind.selectOption('gemini'); await expect(url).toHaveValue('https://generativelanguage.googleapis.com');
    await kind.selectOption('anthropic'); await expect(url).toHaveValue('https://api.anthropic.com');
    await url.fill(fx.base + '/v1');
    await kind.selectOption('openai-responses'); await expect(url).toHaveValue(fx.base + '/v1');
    await expect(fx.page.locator('#provider-kind-hint')).toContainText('gpt-5');

    // 兼容设置：格式错误给可读提示，不保存
    await fx.page.locator('#provider-name').fill('GPT');
    await fx.page.locator('#provider-key').fill('k-resp');
    await fx.page.locator('#provider-compat summary').click();
    await fx.page.locator('#provider-extra-body').fill('{坏的');
    await fx.page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(fx.page.locator('#provider-status')).toContainText('不是有效的 JSON');
    await fx.page.locator('#provider-extra-body').fill('{"top_p":0.5}');
    await fx.page.locator('#provider-extra-headers').fill('api-key: az-1\nX-Evil: a');
    await fx.page.locator('[data-quirk="noTemperature"]').check();
    // 手动添加模型，避免依赖自动读取
    await fx.page.locator('#provider-manual-model').fill('gpt-x');
    await fx.page.locator('#provider-import').click();
    await fx.page.locator('#provider-compat summary').click();
    await expect(fx.page.locator('#provider-extra-body')).toHaveValue('{"top_p":0.5}');                    // 重绘后表单内容保留
    await fx.page.locator('#provider-form').evaluate(f => f.requestSubmit());
    await expect(fx.page.locator('#provider-status')).toContainText(/配置已保存|已读取|已导入/, { timeout: 15000 });

    // 已保存的密钥默认仍为空白；点击眼睛后从本地安全存储读取并显示，再次点击恢复遮罩。
    await fx.page.locator('#provider-key-toggle').click();
    await expect(fx.page.locator('#provider-key')).toHaveAttribute('type', 'text');
    await expect(fx.page.locator('#provider-key')).toHaveValue('k-resp');
    await fx.page.locator('#provider-key-toggle').click();
    await expect(fx.page.locator('#provider-key')).toHaveAttribute('type', 'password');

    // 回显：重新打开设置页仍在
    const saved = await fx.page.evaluate(async () => (await window.piDesktop.provider.getConfig()).advanced);
    expect(saved.quirks).toEqual({ noTemperature: true });
    expect(saved.extraBody).toEqual({ top_p: 0.5 });
    expect(saved.extraHeaders['api-key']).toBe('az-1');

    // 测试通信：走 Responses（/v1/responses + 流式 + 我们的附加头/字段），并且 noTemperature 生效
    fx.calls.length = 0;
    await fx.page.locator('#provider-test').click();
    await expect(fx.page.locator('#provider-status')).toContainText('测试成功', { timeout: 15000 });
    const call = fx.calls.find(c => c.url.endsWith('/responses'));
    expect(call).toBeTruthy();
    expect(call.headers['api-key']).toBe('az-1'); expect(call.headers.authorization).toBe('Bearer k-resp');
    expect(call.body.top_p).toBe(0.5); expect('temperature' in call.body).toBe(false); expect(call.body.stream).toBe(true);

    // 读取模型：Gemini 形状
    await fx.page.locator('#provider-kind').selectOption('gemini');
    await fx.page.locator('#provider-url').fill(fx.base);
    await fx.page.locator('#provider-key').fill('gk');
    fx.calls.length = 0;
    await fx.page.locator('#refresh-models').click();
    await expect(fx.page.locator('#provider-status')).toContainText('已读取 1 个模型');
    expect(fx.calls[0].url).toBe('/v1beta/models?pageSize=1000'); expect(fx.calls[0].headers['x-goog-api-key']).toBe('gk');
  } finally { await fx.close(); }
});
