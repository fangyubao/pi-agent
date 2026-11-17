'use strict';
// 宿主桌面应用的设计令牌，是工作台配色的唯一来源。
// runtime/theme-warm.css（宿主）、脚手架 ui/styles.css、Agent 提示词都必须与此一致，
// runtime/design-tokens.test.cjs 会检查它们没有漂移。
const TOKENS = Object.freeze({
  bg: '#fbf9f6', surface: '#f4f0ea', soft: '#f1ece4', card: '#ffffff',
  text: '#2b2823', muted: '#6b655c', line: '#e6dfd4',
  accent: '#b5522b', accentStrong: '#9a4423', accentSoft: '#f8ebe3',
  ok: '#1f7a5c', warn: '#8a5a00', error: '#b3382f',
  radius: '12px'
});
const css = () => ':root{--bg:' + TOKENS.bg + ';--surface:' + TOKENS.surface + ';--soft:' + TOKENS.soft + ';--card:' + TOKENS.card + ';--text:' + TOKENS.text + ';--muted:' + TOKENS.muted + ';--line:' + TOKENS.line + ';--accent:' + TOKENS.accent + ';--accent-strong:' + TOKENS.accentStrong + ';--accent-soft:' + TOKENS.accentSoft + ';--ok:' + TOKENS.ok + ';--warn:' + TOKENS.warn + ';--error:' + TOKENS.error + ';--radius:' + TOKENS.radius + ';--gap:12px;font-family:Inter,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:14px;color:var(--text)}';
// 注入提示词的一句话版本，带真实色值，Agent 不必猜。
const promptLine = () => '底色必须与桌面应用一致：浅暖灰白，页面底 ' + TOKENS.bg + '、侧栏/面板 ' + TOKENS.surface + '、卡片 ' + TOKENS.card + '、文字 ' + TOKENS.text + '、次要文字 ' + TOKENS.muted + '、分割线 ' + TOKENS.line + '、强调色（主按钮/选中）赤陶 ' + TOKENS.accent + '、成功 ' + TOKENS.ok + '、警告 ' + TOKENS.warn + '、错误 ' + TOKENS.error + '。这些值已写在工程 ui/styles.css 的 :root 变量里，直接用变量，不要改色值。';
module.exports = { TOKENS, css, promptLine };
