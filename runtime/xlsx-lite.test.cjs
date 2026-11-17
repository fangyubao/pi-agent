'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('./xlsx-lite.cjs');
const T = require('./workflow-table.js');

test('xlsx：结构完整（6 个部件）、zip 校验通过、表头加粗样式、首行冻结、带筛选', () => {
  const buf = X.buildXlsx({ head: ['型号', '功耗(μA)'], rows: [['STM32L0', '80'], ['GD32E2', '95']] }, { sheetName: '对比' });
  const parts = X.readZip(buf);                                                // readZip 内部会校验 CRC 与长度
  assert.deepEqual(Object.keys(parts).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(parts['xl/workbook.xml'], /name="对比"/);
  const sheet = parts['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /ySplit="1"/); assert.match(sheet, /<autoFilter ref="A1:B3"\/>/); assert.match(sheet, /<dimension ref="A1:B3"\/>/);
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/);                      // 表头用样式 1（加粗）
  for (const xml of Object.values(parts)) assert.ok(xml.startsWith('<?xml'), '每个部件都是合法 XML 开头');
  assert.equal(buf.readUInt32LE(0), 0x04034b50);                              // zip 魔数
});
test('xlsx：数字存成数字（能排序求和）；前导零、超 15 位的数字、带单位的值存成文本', () => {
  const sheet = X.readZip(X.buildXlsx({ head: ['a', 'b', 'c', 'd', 'e'], rows: [['80', '007', '1234567890123456', '12.5', '3 mA']] }))['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A2"><v>80<\/v><\/c>/); assert.match(sheet, /<c r="D2"><v>12\.5<\/v><\/c>/);
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">007</); assert.match(sheet, /<c r="C2" t="inlineStr">/); assert.match(sheet, /<c r="E2" t="inlineStr">/);
});
test('xlsx：XML 特殊字符与非法控制字符被处理（否则 Excel 会提示文件已损坏）；超限被截断而不是报错', () => {
  const sheet = X.readZip(X.buildXlsx({ head: ['x'], rows: [['<b>&"\'</b>\u0001\u0008']] }))['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;')); assert.ok(!/[\u0000-\u0008]/.test(sheet));
  const big = X.buildXlsx({ head: Array.from({ length: 80 }, (_, i) => 'c' + i), rows: Array.from({ length: 6000 }, () => ['x']) });
  assert.match(X.readZip(big)['xl/worksheets/sheet1.xml'], /<dimension ref="A1:AX5001"\/>/);           // 50 列、5000 行 + 表头
  assert.equal(X.colName(0), 'A'); assert.equal(X.colName(25), 'Z'); assert.equal(X.colName(26), 'AA'); assert.equal(X.colName(701), 'ZZ'); assert.equal(X.colName(702), 'AAA');
});
test('xlsx：空表、畸形输入、非法工作表名都不抛错', () => {
  for (const t of [null, undefined, {}, { head: [], rows: [] }, { head: 'x', rows: 5 }, { head: ['a'], rows: [null, 'x', [1, 2, 3]] }]) assert.doesNotThrow(() => X.readZip(X.buildXlsx(t)));
  assert.match(X.readZip(X.buildXlsx({ head: ['a'], rows: [] }, { sheetName: 'a/b?*[]:\\' + 'x'.repeat(50) }))['xl/workbook.xml'], /name="a b[^"]{0,29}"/);
  assert.deepEqual(X.buildXlsx({ head: ['a'], rows: [['1']] }), X.buildXlsx({ head: ['a'], rows: [['1']] }));    // 同样内容 → 同样字节
});

const MD = '前言\n\n| 型号 | 功耗 | 价格 |\n| --- | :---: | ---: |\n| STM32L0 | 80 | 12 |\n| GD32E2 | 95 | **9** |\n\n结论：选 GD32。';
test('表格提取：Markdown 管道表格（含对齐行、加粗、转义竖线、<br>）', () => {
  const t = T.extract(MD);
  assert.deepEqual(t.head, ['型号', '功耗', '价格']); assert.deepEqual(t.rows, [['STM32L0', '80', '12'], ['GD32E2', '95', '9']]); assert.equal(t.kind, 'markdown');
  assert.deepEqual(T.extract('| a | b |\n|---|---|\n| x \\| y | 1<br>2 |').rows, [['x | y', '1\n2']]);
  assert.deepEqual(T.extract('a | b\n--|--\n1 | 2').rows, [['1', '2']]);                                // 没有首尾竖线的写法
});
test('表格提取：一个结果里有多个表格取最大的；行长度不齐时补空；没有表格返回 null；散文和代码里的竖线不算', () => {
  const two = '| a | b |\n|--|--|\n| 1 | 2 |\n\n| 型号 | 值 | 备注 |\n|--|--|--|\n| x | 1 | p |\n| y | 2 | q |\n| z | 3 | r |';
  assert.equal(T.extract(two).head.length, 3); assert.equal(T.extract(two).rows.length, 3);
  assert.deepEqual(T.extract('| a | b | c |\n|--|--|--|\n| 1 |').rows, [['1', '', '']]);
  for (const none of ['', null, undefined, '只是一段文字，没有表格。', 'a | b | c', 'if (a || b) { x }', '| 只有表头 |\n|--|']) assert.equal(T.extract(none), null, JSON.stringify(none));
});
test('表格提取：整段 CSV/TSV（引号、转义引号）；带逗号的普通句子不会被当成 CSV', () => {
  assert.deepEqual(T.extract('姓名,年龄\n"张,三",30\n李四,25').rows, [['张,三', '30'], ['李四', '25']]);
  assert.deepEqual(T.extract('a\tb\n1\t2').rows, [['1', '2']]); assert.equal(T.extract('a\tb\n1\t2').kind, 'tsv');
  assert.equal(T.extract('首先，我们要看功耗，其次要看价格，最后做选择。\n然后，再比较封装，包括引脚数，还有温度范围，最后给出建议。'), null);
  assert.equal(T.extract('一行就不是表格,x'), null);
});
test('表格占比：整段就是表 → coversMost；表格只是长文里的一小块 → 不单独出文件', () => {
  assert.equal(T.extract(MD.replace('前言\n\n', '').replace('\n\n结论：选 GD32。', '')).coversMost, true);
  const long = '这是一大段分析文字。'.repeat(80) + '\n\n| a | b |\n|--|--|\n| 1 | 2 |';
  assert.equal(T.extract(long).coversMost, false);
});
