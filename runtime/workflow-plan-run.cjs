'use strict';
// 拆解编排：本地预判 → 调一次模型 → 解析 → 失败则修复重试一次 → 仍失败就降级为“不拆”。
// 原则：拆解永远不能阻塞用户。任何失败（网络、超时、格式错误）都返回 { kind: 'single', fallback: true }，由调用方按普通对话处理。
// 模型调用由调用方注入（call），所以本函数不依赖网络，可以用确定性的假模型测试。
const planner = require('./workflow-planner.js');

async function planWorkflow({ message, recent = [], workbench = '', existing = [], call, signal, inWorkflow = false }) {
  const gate = planner.shouldSkip(message, { inWorkflow });
  if (gate.skip) return { kind: 'single', reason: gate.reason, calls: 0, usage: { input: 0, output: 0 } };
  const usage = { input: 0, output: 0, known: true };
  const add = u => { if (!u || u.input == null || u.output == null) usage.known = false; else { usage.input += u.input; usage.output += u.output; } };
  let calls = 0;
  try {
    const first = await call(planner.buildRequest({ message, recent, workbench, existing }), { signal }); calls++; add(first.usage);
    let result = planner.parse(first.text);
    if (result.kind === 'invalid') {
      const second = await call(planner.repairRequest(result.errors, first.text), { signal }); calls++; add(second.usage);
      result = planner.parse(second.text);
    }
    if (result.kind === 'invalid') return { kind: 'single', fallback: true, reason: '这次没能拆分，已按普通对话处理', errors: result.errors, calls, usage };
    if ((result.kind === 'followup' || result.kind === 'edit') && !(Array.isArray(existing) && existing.length)) return { kind: 'single', reason: '画布上还没有工作流', calls, usage };   // 没有画布却说“追问/修改”：模型误判，按普通对话
    return { ...result, calls, usage };
  } catch (error) {
    if (signal?.aborted) throw error;                                      // 用户取消：向上抛，不当作失败降级
    return { kind: 'single', fallback: true, reason: '拆分失败（' + String(error?.message || error).slice(0, 80) + '），已按普通对话处理', calls, usage };
  }
}
module.exports = { planWorkflow };
