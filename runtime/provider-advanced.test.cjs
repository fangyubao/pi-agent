'use strict';
// main.cjs 里的 cleanAdvanced 不导出，这里从源码里取出同一段函数来测（与 provider-probe.test.cjs 取 main.cjs 片段的做法一致）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const start = source.indexOf('const NEWLINE_RE'), end = source.indexOf('async function effectiveProvider');
assert.ok(start > 0 && end > start, '找不到 cleanAdvanced');
const cleanAdvanced = new Function(source.slice(start, end).replace(/\r/g, '') + '\nreturn cleanAdvanced;')();

test('cleanAdvanced：只收已知开关；请求头禁止覆盖鉴权/主机/长度并拒绝换行（头注入）；extraBody 只收对象且限大小', () => {
  assert.deepEqual(cleanAdvanced({ quirks: { noTemperature: true, evil: true, maxCompletionTokens: false } }), { quirks: { noTemperature: true } });
  const h = cleanAdvanced({ extraHeaders: { 'api-key': 'a', 'X-Fine': 'ok', Authorization: 'x', 'X-API-KEY': 'y', Host: 'evil', 'Content-Length': '1', 'x-goog-api-key': 'z', 'bad name': 'v', 'X-Ok': 'line1\r\nInjected: 1', 'X-Fine': 'ok' } }).extraHeaders;
  assert.deepEqual(h, { 'api-key': 'a', 'X-Fine': 'ok' });
  assert.deepEqual(cleanAdvanced({ extraBody: { top_p: 0.5, nested: { a: [1] } } }).extraBody, { top_p: 0.5, nested: { a: [1] } });
  assert.equal(cleanAdvanced({ extraBody: [1, 2] }).extraBody, undefined);
  assert.equal(cleanAdvanced({ extraBody: { big: 'x'.repeat(5000) } }).extraBody, undefined);
  assert.equal(Object.keys(cleanAdvanced({ extraHeaders: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['h' + i, 'v'])) }).extraHeaders).length, 8);
  assert.deepEqual(cleanAdvanced(undefined), {}); assert.deepEqual(cleanAdvanced(null), {}); assert.deepEqual(cleanAdvanced({ quirks: 'x', extraHeaders: 5, extraBody: 'x' }), {});
});
