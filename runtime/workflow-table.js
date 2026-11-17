'use strict';
// 从节点结果里找出“表格”。判断依据是结果文本里真的有表格，而不是节点的标题/角色里有没有“数据”“设计”之类的词——
// 关键词会误判（“数据库设计说明”其实是文字），而文本里有没有表格是事实。
// 只认两种形态：Markdown 管道表格（模型最常用）、整段 CSV/TSV。一个节点里有多个表格时取最大的那个（行×列最多）。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiWorkflowTable = api; })(typeof window === 'object' ? window : globalThis, () => {
  const MIN_ROWS = 2, MIN_COLS = 2;

  const splitPipe = line => {
    let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = []; let cur = '';
    for (let i = 0; i < s.length; i++) { if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i]; }
    cells.push(cur.trim()); return cells;
  };
  const isSeparator = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  const clean = c => String(c).replace(/<br\s*\/?>/gi, '\n').replace(/\*\*|__|`/g, '').trim();

  // 所有 Markdown 管道表格
  function pipeTables(text) {
    const lines = String(text || '').split(/\r?\n/), out = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!lines[i].includes('|') || !isSeparator(lines[i + 1])) continue;
      const head = splitPipe(lines[i]).map(clean); if (head.length < MIN_COLS) continue;
      const rows = []; let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) { const r = splitPipe(lines[j]).map(clean); rows.push(Array.from({ length: head.length }, (_, k) => r[k] ?? '')); }
      if (rows.length >= MIN_ROWS - 1) out.push({ head, rows, kind: 'markdown' });
      i = j;
    }
    return out;
  }

  // 整段 CSV/TSV：每行分隔符个数一致、至少 2 列 2 行，且不像普通散文（有标点的长句不算）
  function delimited(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < MIN_ROWS) return null;
    for (const sep of ['\t', ',']) {
      const parsed = lines.map(l => parseDelimited(l, sep));
      const n = parsed[0].length;
      if (n < MIN_COLS || !parsed.every(r => r.length === n)) continue;
      if (sep === ',' && parsed.some(r => r.some(c => c.length > 80))) continue;               // 带逗号的长句子不是 CSV
      return { head: parsed[0].map(clean), rows: parsed.slice(1).map(r => r.map(clean)), kind: sep === '\t' ? 'tsv' : 'csv' };
    }
    return null;
  }
  function parseDelimited(line, sep) {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"' && cur === '') q = true; else if (ch === sep) { cells.push(cur.trim()); cur = ''; } else cur += ch;
    }
    cells.push(cur.trim()); return cells;
  }

  const size = t => t.rows.length * t.head.length;
  // 返回 { head, rows, kind, coversMost } 或 null。coversMost = 表格占了结果的大部分（决定是否值得单独出 .xlsx）。
  function extract(output) {
    const text = String(output || '');
    const found = pipeTables(text); const d = found.length ? null : delimited(text);
    const best = found.sort((a, b) => size(b) - size(a))[0] || d;
    if (!best || best.rows.length < MIN_ROWS - 1) return null;
    const cells = best.head.join('').length + best.rows.reduce((n, r) => n + r.join('').length, 0);
    return { ...best, coversMost: cells >= text.replace(/\s/g, '').length * 0.4 };
  }

  return { extract, pipeTables, delimited, MIN_ROWS, MIN_COLS };
});
