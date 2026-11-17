'use strict';
// 节点附件：把用户选的文件（BOM、电路图、数据表、说明文档……）读成 workflow-artifacts.renderInputs 需要的结构。
// 纯 Node，无依赖。只读不写；写盘（复制到节点文件夹的 inputs/）由调用方做。
// 分类：
//   text   —— 文本/代码/配置/Markdown/JSON/CSV 之外的纯文本：读出文字（限长）
//   table  —— .csv/.tsv/.xlsx：读成 {head, rows}（xlsx 取第一个工作表）
//   image  —— .png/.jpg/.jpeg/.gif/.webp/.bmp/.svg：不读内容；调用方用 base64 送给支持看图的模型。svg 同时当文本读（它本来就是文字）
//   binary —— 其他（pdf、dwg、zip…）：登记但不读，提示词里会明说"内容未读取，不能据此下结论"
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = { fileBytes: 20 * 1024 * 1024, textBytes: 400 * 1024, tableRows: 2000, tableCols: 40, count: 6, imageBytes: 5 * 1024 * 1024 };
const TEXT_EXT = new Set('txt md markdown json jsonl yaml yml toml ini cfg conf xml log sql py c h cpp cc hpp ino s asm v sv vhd vhdl ts tsx jsx js mjs cjs css html htm java kt go rs swift lua r tex dts dtsi ld mk cmake proto net cir spice sp kicad_sch kicad_pcb sch brd'.split(' '));
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
const extOf = name => { const m = /\.([A-Za-z0-9_-]{1,12})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

// 文件名净化：去路径、控制字符、Windows 非法字符，限长；同名加序号。
function safeFileName(raw, used = new Set()) {
  let s = String(raw || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '');
  s = (s.split(/[\\/]/).pop() || '').replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '附件' + (s ? '_' + s : '');
  const ext = extOf(s), stem = ext ? s.slice(0, -(ext.length + 1)) : s;
  let name = Array.from(stem).slice(0, 60).join('') + (ext ? '.' + ext : ''), i = 1;
  while (used.has(name.toLowerCase())) { i++; name = Array.from(stem).slice(0, 56).join('') + '-' + i + (ext ? '.' + ext : ''); }
  used.add(name.toLowerCase());
  return name;
}

// ---------- 文本解码：UTF-8（含 BOM）、UTF-16LE/BE（带 BOM），否则按 GB18030（国内 CSV/日志常见）尝试 ----------
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.slice(2)); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; } return b.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('latin1'); }
}
const hasUtf16Bom = buf => buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));   // UTF-16 文本里到处是 0x00，不能当二进制
const looksBinary = buf => { if (hasUtf16Bom(buf)) return false; const n = Math.min(buf.length, 4096); let bad = 0; for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad++; } return n > 0 && bad / n > 0.02; };

// ---------- ZIP 读取（xlsx 用）：比 xlsx-lite.readZip 宽松——支持数据描述符、stored/deflate，不校验 CRC 之外的东西 ----------
function unzipEntries(buf, want) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('不是有效的 xlsx（zip 结构损坏）');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('xlsx 太大或使用了 ZIP64，暂不支持');
  const out = {};
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 目录项损坏');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    if (usize > 64 * 1024 * 1024) throw new Error('xlsx 内部文件过大：' + name);          // 防 zip 炸弹
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28), start = off + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);
    out[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }) : (() => { throw new Error('不支持的压缩方式 ' + method); })();
  }
  return out;
}
const unxml = s => String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const colIndex = ref => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const textOfSi = si => { const parts = []; si.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { parts.push(unxml(t)); return ''; }); return parts.join(''); };   // 富文本 <r><t> 也拼起来；忽略拼音 <rPh>
function readXlsx(buf) {
  const files = unzipEntries(buf, n => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const wb = (files['xl/workbook.xml'] || '').toString('utf8'), rels = (files['xl/_rels/workbook.xml.rels'] || '').toString('utf8');
  const first = /<sheet\b[^>]*?r:id="([^"]+)"/.exec(wb);
  let target = '';
  if (first) { const rel = new RegExp('<Relationship\\b[^>]*?Id="' + first[1] + '"[^>]*>').exec(rels); const t = rel && /Target="([^"]+)"/.exec(rel[0]); if (t) target = t[1].replace(/^\/?(xl\/)?/, 'xl/'); }
  if (!files[target]) target = Object.keys(files).filter(n => /^xl\/worksheets\//.test(n)).sort()[0];
  if (!target) throw new Error('xlsx 里没有工作表');
  const shared = []; if (files['xl/sharedStrings.xml']) files['xl/sharedStrings.xml'].toString('utf8').replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOfSi(si)); return ''; });
  const sheet = files[target].toString('utf8'), rows = []; let maxCol = 0;
  sheet.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, inner) => {
    if (rows.length >= LIMITS.tableRows + 1) return '';
    const cells = []; let seq = 0;
    inner.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, body) => {
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs), at = ref ? colIndex(ref[1]) : seq, t = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n'; seq = at + 1;
      if (at < 0 || at >= LIMITS.tableCols || !body) return '';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      let val = '';
      if (t === 's') val = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (t === 'inlineStr') val = textOfSi(body);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = unxml(v);
      cells[at] = val; maxCol = Math.max(maxCol, at + 1); return '';
    });
    rows.push(cells); return '';
  });
  const grid = rows.map(r => Array.from({ length: maxCol }, (_, i) => String(r[i] ?? '')));
  const kept = grid.filter(r => r.some(c => c !== ''));
  if (!kept.length) return { head: [], rows: [], truncated: false };
  return { head: kept[0].map((h, i) => h || '列' + (i + 1)), rows: kept.slice(1, LIMITS.tableRows + 1), truncated: rows.length > LIMITS.tableRows };
}

// CSV/TSV：复用产物库里的解析（含引号内换行、分隔符判断）
function readCsv(text) {
  const art = require('./workflow-artifacts.js');
  const t = art.parseCsv(text);
  return t ? { head: t.head, rows: t.rows, truncated: !!t.truncated } : null;
}

// 读一个文件。返回 { name, kind, bytes, text?, table?, truncated?, mime?, base64?, note? }；不抛错（读不了的退化为 binary + note）。
async function readInput(file, { name, used } = {}) {
  const abs = typeof file === 'string' ? file : file.path;
  const display = safeFileName(name || path.basename(abs), used || new Set());
  const ext = extOf(display);
  const out = { name: display, kind: 'binary', bytes: 0 };
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ...out, note: '不是文件' };
    out.bytes = st.size;
    if (st.size > LIMITS.fileBytes) return { ...out, note: '文件超过 ' + LIMITS.fileBytes / 1048576 + 'MB，未读取' };
    const buf = await fs.readFile(abs);
    if (ext === 'xlsx') { const t = readXlsx(buf); return t.head.length ? { ...out, kind: 'table', table: { head: t.head, rows: t.rows }, truncated: t.truncated } : { ...out, note: '表格是空的' }; }
    if (ext === 'xls') return { ...out, note: '旧版 .xls 暂不支持，请另存为 .xlsx 或 .csv' };
    if (IMAGE_EXT[ext]) {
      const o = { ...out, kind: 'image', mime: IMAGE_EXT[ext] };
      if (ext === 'svg') { const text = decodeText(buf); o.text = text.slice(0, LIMITS.textBytes); o.truncated = text.length > LIMITS.textBytes; }
      else if (st.size <= LIMITS.imageBytes) o.base64 = buf.toString('base64');
      else o.note = '图片超过 ' + LIMITS.imageBytes / 1048576 + 'MB，未发送给模型';
      return o;
    }
    if (ext === 'csv' || ext === 'tsv') { const t = readCsv(decodeText(buf)); if (t) return { ...out, kind: 'table', table: { head: t.head, rows: t.rows }, truncated: t.truncated }; }
    if (TEXT_EXT.has(ext) || ext === 'csv' || ext === 'tsv' || (!ext && !looksBinary(buf)) || (ext && !looksBinary(buf) && buf.length <= LIMITS.textBytes)) {
      if (looksBinary(buf)) return { ...out, note: '看起来是二进制文件，未读取' };
      const text = decodeText(buf); return { ...out, kind: 'text', text: text.slice(0, LIMITS.textBytes), truncated: text.length > LIMITS.textBytes };
    }
    return { ...out, note: ext === 'pdf' ? 'PDF 暂不读取正文，请另存为文本或导出表格/图片' : '这种文件类型暂不读取' };
  } catch (error) { return { ...out, note: '读取失败：' + String(error && error.message || error).slice(0, 100) }; }
}

module.exports = { LIMITS, IMAGE_EXT, extOf, safeFileName, decodeText, readXlsx, readInput };
