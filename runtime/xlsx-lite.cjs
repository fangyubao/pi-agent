'use strict';
// 最小的 .xlsx 生成器：只做“一张表，表头加粗，列宽自适应，首行冻结，带筛选”。不依赖任何第三方库。
// xlsx 本质是 zip 里的几个 XML；这里手写 zip（stored/deflate 均可），再按 Office Open XML 最小集写 5 个部件。
// 目的：设计、数据分析类节点的结果用表格文件给用户（Excel/WPS 直接打开），而不是一大段 .md。
const zlib = require('node:zlib');

const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');                 // XML 1.0 不允许的控制字符，留着会让 Excel 报“文件已损坏”

// 列号 → 字母：0→A, 25→Z, 26→AA
function colName(i) { let s = ''; for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s; return s; }

// 单元格：纯数字当数字（让 Excel 能排序/求和），其余一律当文本。以 0 开头的编号（如 007、0123）、超过 15 位的数字当文本，避免丢精度或丢前导零。
function isPlainNumber(v) {
  const t = String(v).trim();
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return false;
  return t.replace(/^-/, '').replace('.', '').length <= 15;
}

const LIMITS = { rows: 5000, cols: 50, cell: 32000, sheet: 31 };                          // Excel 单元格上限 32767 字符

function sheetXml(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, c) => Math.min(60, Math.max(8, ...all.map(r => { const t = String(r[c] ?? ''); return [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2; }))));
  const cell = (v, r, c, style) => {
    const ref = colName(c) + (r + 1), t = String(v ?? '');
    if (t === '') return '';
    if (style === 1 || !isPlainNumber(t)) return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xml(t) + '</t></is></c>';
    return '<c r="' + ref + '"><v>' + t.trim() + '</v></c>';
  };
  const rowXml = all.map((r, ri) => '<row r="' + (ri + 1) + '">' + head.map((_, c) => cell(r[c], ri, c, ri === 0 ? 1 : 0)).join('') + '</row>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:' + colName(Math.max(0, head.length - 1)) + all.length + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
    '<sheetData>' + rowXml + '</sheetData>' +
    (head.length ? '<autoFilter ref="A1:' + colName(head.length - 1) + all.length + '"/>' : '') + '</worksheet>';
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4F0EA"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

// ---- zip 容器（单文件 zip，无 zip64，文件都很小）
function zip(entries) {
  const chunks = [], central = []; let offset = 0;
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const dosTime = 0, dosDate = (46 << 9) | (1 << 5) | 1;                                    // 固定时间戳 → 同样内容生成同样字节，便于测试与比较
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), raw = Buffer.from(data, 'utf8'), comp = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate), u32(crc), u32(comp.length), u32(raw.length), u16(nameBuf.length), u16(0), nameBuf]);
    chunks.push(head, comp);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate), u32(crc), u32(comp.length), u32(raw.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += head.length + comp.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...chunks, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
}

// table: { head: string[], rows: string[][] }。返回 Buffer（.xlsx 文件内容）。超出上限的行列会被截掉（并在 meta.truncated 里说明），不抛错。
function buildXlsx(table, { sheetName = '结果' } = {}) {
  const head0 = Array.isArray(table?.head) ? table.head : [], rows0 = Array.isArray(table?.rows) ? table.rows : [];
  const cols = Math.min(LIMITS.cols, Math.max(head0.length, ...rows0.map(r => (Array.isArray(r) ? r.length : 0)), 1));
  const head = Array.from({ length: cols }, (_, i) => String(head0[i] ?? '列' + (i + 1)).slice(0, LIMITS.cell));
  const rows = rows0.slice(0, LIMITS.rows).map(r => Array.from({ length: cols }, (_, i) => String((Array.isArray(r) ? r[i] : '') ?? '').slice(0, LIMITS.cell)));
  const name = xml(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, LIMITS.sheet) || '结果');
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(head, rows) }
  ];
  return zip(entries);
}

// 读回 zip 里的文件名与内容（测试与自检用；只支持本生成器写出的 deflate 条目）
function readZip(buf) {
  const out = {}; let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('不是 zip 文件');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('目录项损坏');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28), start = off + 30 + lnlen + lelen;
    const data = method === 8 ? zlib.inflateRawSync(buf.slice(start, start + csize)) : buf.slice(start, start + csize);
    if (data.length !== usize || zlib.crc32(data) !== crc) throw new Error('校验失败：' + name);
    out[name] = data.toString('utf8'); p += 46 + nlen + elen + clen;
  }
  return out;
}

module.exports = { buildXlsx, readZip, colName, isPlainNumber, LIMITS };
