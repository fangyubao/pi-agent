'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiTranscript = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const host = typeof window === 'object' ? window : globalThis;
  const graphApi = host.PiExecutionGraph || (typeof require === 'function' ? require('./execution-graph') : null);
  host.PiExecutionGraph ||= graphApi;
  const labels = { read: '读取文件', write: '写入文件', edit: '修改文件', grep: '搜索文件', find: '查找文件', ls: '列出目录', bash: '执行命令', powershell: '执行命令', workbench_action: '操作工作台', interaction_request: '确认需求' };
  const formatDuration = ms => { const total = Math.max(0, Math.round(Number(ms || 0) / 100) / 10); if (total < 60) return total.toFixed(1) + ' 秒'; const minutes = Math.floor(total / 60); const seconds = Math.round(total % 60); return minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒'; };
  const textOf = message => Array.isArray(message?.content) ? message.content.filter(x => x.type === 'text').map(x => x.text || '').join('') : typeof message?.content === 'string' ? message.content : '';
  const hasTools = message => Array.isArray(message?.content) && message.content.some(x => x.type === 'toolCall');
  const formatTokens = value => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return ''; return n.toLocaleString('en-US'); };
  function lengthFailure(value) {
    const usage = value?.usage || {};
    const input = formatTokens(usage.input);
    const output = formatTokens(usage.output);
    const total = formatTokens(usage.totalTokens);
    const detail = input ? `本轮输入约 ${input} tokens` + (output ? `，已生成 ${output} tokens` : '') + (total ? `，合计 ${total} tokens` : '') + '。' : '';
    return '单次模型输出被截断：' + detail + '未生成完整最终回复；这不等同于输入上下文超限。Agent 将按小批次续接，保留已完成操作；恢复耗尽后可检查输出预算设置。';
  }
  function start(message) {
    message.run = { status: 'running', label: '正在连接 Agent…', steps: [], changedFiles: [], hasFinal: false, stopReason: null, rawStopReason: null, usage: null, lastUsage: null, recoveryAttempts: 0, recovering: false, startedAt: Date.now() };
    graphApi.start(message);
    return message.run;
  }
  function archiveText(message) {
    if (message.text?.trim()) message.run.steps.push({ kind: 'text', text: message.text });
    message.text = '';
    message.run.hasFinal = false;
  }
  function acceptMessage(message, value) {
    const text = textOf(value);
    if (hasTools(value)) {
      message.text = text || message.text;
      archiveText(message);
    } else {
      // A short final answer must replace a longer streaming/intermediate answer.
      message.text = text;
      message.run.hasFinal = Boolean(text.trim());
    }
    if (value?.stopReason) message.run.stopReason = value.stopReason;
    if (value?.rawStopReason) message.run.rawStopReason = value.rawStopReason;
    if (value?.usage) { message.run.lastUsage = value.usage; message.run.usage = value.usage; }
    if (value?.stopReason === 'length') message.run.error = lengthFailure(value);
    if (value?.stopReason === 'error') message.run.error = value.errorMessage || '模型响应失败';
    if (value?.stopReason === 'aborted') message.run.stopping = true;
    if (message.run.hasFinal && value?.stopReason && !['error', 'length', 'aborted'].includes(value.stopReason)) {
      message.run.error = '';
      message.run.stopping = false;
    }
  }
  function finish(message, status) {
    const run = message.run;
    if (!run || run.status !== 'running') return;
    run.steps = Array.isArray(run.steps) ? run.steps.filter(Boolean) : [];
    const failedStep = run.steps.findLast?.(x => x.kind === 'tool' && x.status === 'error') || [...run.steps].reverse().find(x => x.kind === 'tool' && x.status === 'error');
    const failedDetail = failedStep ? [failedStep.label || failedStep.tool || '工具操作', failedStep.target || '', failedStep.output || '工具返回失败'].filter(Boolean).join('：').slice(0, 1800) : '';
    if (!run.error && !run.hasFinal && failedDetail) run.error = failedDetail;
    if (run.hasFinal && /^发送前自动压缩上下文失败/.test(String(run.error || ''))) run.error = '';
    const finalStatus = status || (run.pauseRequested ? 'paused' : run.stopping ? 'stopped' : run.error ? 'error' : run.hasFinal ? 'complete' : failedStep ? 'error' : 'incomplete');
    graphApi.finish(message, finalStatus);
    run.status = finalStatus;
    run.finishedAt = Date.now();
    run.steps.filter(x => x.kind === 'tool' && x.status === 'running').forEach(x => { x.status = 'interrupted'; });
    if (finalStatus === 'stopped' || finalStatus === 'paused' || finalStatus === 'error') {
      archiveText(message);
      message.text = finalStatus === 'paused' ? '已暂停本次运行。可以从已记录状态继续；执行到一半的工具需要先核对结果。' : finalStatus === 'stopped' ? '已停止本次运行。已执行的操作不会自动撤销。' : '本次请求未完成：' + (run.error || 'Agent 运行失败') + '。已执行的操作不会自动撤销。';
    } else if (!run.hasFinal) {
      archiveText(message);
      message.text = '本轮运行已结束，但 Agent 没有返回最终结论，暂时无法确认任务是否完成。可以展开操作记录查看已执行的内容。';
    }
    run.label = finalStatus === 'complete' ? '本轮已结束' : finalStatus === 'paused' ? '已暂停' : finalStatus === 'stopped' ? '已停止' : finalStatus === 'error' ? '请求未完成' : '缺少最终结论';
  }
  function apply(message, event) {
    const run = message.run;
    if (!run || run.status !== 'running') return;
    graphApi.apply(message, event);
    switch (event.type) {
      case 'agent_start': run.label = 'Agent 已启动'; break;
      case 'turn_start': run.label = '正在处理…'; break;
      case 'message_start':
        if (event.message?.role === 'assistant') { archiveText(message); run.label = '正在回复…'; }
        break;
      case 'message_update':
        if (event.assistantMessageEvent?.type === 'text_delta') {
          message.text += event.assistantMessageEvent.delta || '';
          run.label = '正在回复…';
        }
        break;
      case 'message_end':
        if (event.message?.role === 'assistant') {acceptMessage(message, event.message);}
        break;
      case 'tool_execution_start': {
        const args = event.args || event.input || {};
        const tool = event.toolName || '工具';
        const target = String(args.path || args.file_path || args.filePath || args.filename || args.command || '');
        const stepId = event.toolCallId || 'tool-' + run.steps.length;
        if (!run.steps.some(x => x.kind === 'tool' && x.id === stepId && x.status === 'running')) run.steps.push({ kind: 'tool', id: stepId, tool, label: labels[tool] || tool, target, status: 'running', output: '' });
        run.label = (labels[tool] || tool) + (target ? ' · ' + target.slice(0, 160) : '');
        break;
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const step = run.steps.findLast(x => x.kind === 'tool' && (event.toolCallId ? x.id === event.toolCallId : x.status === 'running'));
        if (!step) break;
        const output = textOf(event.result || event.partialResult);
        if (output) step.output = output.slice(-4000);
        if (event.type === 'tool_execution_end') {
          step.status = event.isError ? 'error' : 'done';
          // A recoverable tool failure is not a failed task. The final answer decides the outcome.
          run.label = event.isError ? '操作失败，等待 Agent 处理…' : '正在继续…';
          if (!event.isError && ['write', 'edit'].includes(step.tool) && step.target) {
            const key = step.target.replace(/\\/g, '/');
            const existing = run.changedFiles.find(x => x.path.replace(/\\/g, '/') === key);
            if (!existing) run.changedFiles.push({ path: step.target, cwd: event.cwd || '', operation: step.tool === 'write' ? '写入' : '修改' });
          }
        }
        break;
      }
      case 'extension_ui_request': run.label = '等待你的确认'; break;
      case 'context_compaction_start': run.label = '正在压缩上下文…'; break;
      case 'context_compaction_end': run.label = '上下文已压缩，正在继续…'; break;
      case 'context_compaction_error': run.error = '发送前自动压缩上下文失败：' + String(event.error || '未返回具体原因'); break;
      case 'auto_retry_start': run.recovering = true; run.recoveryAttempts = Number(event.attempt) || run.recoveryAttempts; run.label = 'Pi 正在重试连接…'; break;
      case 'auto_retry_end': run.recovering = false; run.label = event.success ? '连接已恢复，正在继续…' : 'Pi 内部重试未完成，正在诊断…'; break;
      case 'agent_recovery_start':
        if (message.text?.trim()) archiveText(message);
        run.recoveryAttempts = Number(event.attempt) || run.recoveryAttempts + 1;
        run.recovering = true;
        run.error = '';
        run.stopReason = null;
        run.rawStopReason = null;
        run.hasFinal = false;
        run.label = '正在诊断并恢复…';
        break;
      case 'agent_recovery_attempt_error': run.label = '恢复尝试失败，正在分析下一步…'; run.lastRecoveryError = String(event.error || '恢复尝试失败'); break;
      case 'agent_recovery_exhausted': run.recovering = false; run.error = String(event.failure?.reason || '自动恢复已停止'); run.label = '自动恢复未完成'; break;
      case 'agent_recovery_complete': run.recovering = false; run.recovered = true; run.label = '已恢复，正在整理结果…'; break;
      case 'file_changes':
        {
          const known=run.changedFiles;
          run.changedFiles = event.files || [];
          const full=file=>(/^(?:[a-z]:|\/)/i.test(file.path)?file.path:(file.cwd||run.cwd||'')+'/'+file.path).replace(/\\/g,'/').toLowerCase();
          for(const file of known)if(!run.changedFiles.some(x=>full(x)===full(file)))run.changedFiles.push({...file,missingSnapshot:true});
        }
        run.reviewLimited = Boolean(event.limited);
        run.reviewError = event.error || '';
        break;
      case 'agent_error': run.error = String(event.error || event.message || 'Agent 运行失败'); run.failure = event.failure || null; break;
      case 'agent_end': {
        // Only the final assistant message can be a final answer; earlier text may precede a tool.
        const last = (event.messages || []).findLast(x => x.role === 'assistant');
        if (last && !hasTools(last)) acceptMessage(message, last);
        run.label = '正在整理结果…';
        break;
      }
      case 'agent_settled': run.failure = event.failure || null; if (event.failure?.reason) run.error = String(event.failure.reason); finish(message); break;
    }
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function reference(href) {
    const value = String(href || '').trim();
    if (!value || /[\x00-\x1f]/.test(value)) return null;
    if (/^https?:\/\//i.test(value)) return { kind: 'web', value };
    if (/^(?:[A-Za-z]:[\\/]|\/(?!\/)|\.\.?[\\/])/.test(value) && !/^\/\//.test(value)) return { kind: 'file', value };
    if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('#') && !value.startsWith('\\') && /[\/.]/.test(value)) return { kind: 'file', value };
    return null;
  }
  function createMarkdown(markdownit) {
    const md = markdownit({ html: false, breaks: true, linkify: false });
    md.validateLink = href => Boolean(reference(href));
    md.renderer.rules.link_open = (tokens, index, _options, env) => {
      const ref = reference(tokens[index].attrGet('href'));
      if (!ref) return '<span>';
      return '<a href="#" data-reference="' + escape(ref.value) + '" data-cwd="' + escape(env.cwd || '') + '" title="' + escape(ref.value) + '">';
    };
    // Never fetch remote images or interpret HTML returned by the model.
    md.renderer.rules.image = (tokens, index) => '<span class="image-reference">[图片：' + escape(tokens[index].content) + ']</span>';
    const fence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => '<div class="code-block"><div class="code-heading"><span>' + escape(tokens[index].info.trim().split(/\s/)[0] || '代码') + '</span><button type="button" data-action="copy-code" title="复制代码">复制代码</button></div>' + fence(tokens, index, options, env, self) + '</div>';
    return md;
  }
  function toolEntries(steps) {
    return steps.map(x => '<details class="tool-entry" data-step="' + escape(x.id) + '"><summary><span class="tool-state ' + x.status + '">' + ({ running: '进行中', done: '完成', error: '失败', interrupted: '中断' }[x.status]) + '</span><span>' + escape(x.label) + (x.target ? '<code>' + escape(x.target) + '</code>' : '') + '</span></summary>' + (x.output ? '<pre>' + escape(x.output) + '</pre>' : '<p class="muted">没有额外输出</p>') + '</details>').join('');
  }
  function detailMarkup(message, kind, group) {
    if(kind==='graph')return graphApi.graphMarkup(message);
    if(kind==='metrics')return graphApi.metricsMarkup(message);
    const steps=message.run?.steps||[],start=steps.findIndex(x=>x.kind==='tool'&&x.id===group),tools=[];
    for(let i=start;i>=0&&i<steps.length&&steps[i].kind==='tool';i++)tools.push(steps[i]);
    return toolEntries(tools);
  }
  const PROCESS_PAGE=18,processPages=new WeakMap();
  function processGroups(message){const groups=[];for(const step of message.run?.steps||[]){if(!step)continue;const last=groups.at(-1);if(step.kind==='tool'&&last?.kind==='tools')last.steps.push(step);else groups.push(step.kind==='tool'?{kind:'tools',steps:[step]}:{kind:'text',step});}return groups;}
  function processPage(message,direction){const groups=processGroups(message),last=Math.max(0,groups.length-PROCESS_PAGE),old=processPages.get(message),start=old??Math.max(0,groups.length-(message.run?.status==='running'?PROCESS_PAGE:6));processPages.set(message,direction==='latest'?null:Math.max(0,Math.min(last,start+(direction==='older'?-PROCESS_PAGE:PROCESS_PAGE))));}
  function revealStep(message,id){const groups=processGroups(message),index=groups.findIndex(g=>g.steps?.some(s=>s.id===id)||g.step?.id===id);if(index>=0)processPages.set(message,Math.floor(index/PROCESS_PAGE)*PROCESS_PAGE);}
  function progressMarkup(message, summary, render, {lazy=false}={}) {
    const run = message.run;
    if (!run) return '';
    let html = '<div class="run-progress">';
    let tools = [];
    const flush = () => {
      if (!tools.length) return;
      const failed = tools.filter(x => x.status === 'error');
      const errors = failed.length;
      const failurePreview = failed.slice(0, 2).map(x => '<span class="tool-failure-preview"><strong>'+escape(x.label || x.tool || '工具操作')+'</strong>'+(x.target?' · <code>'+escape(x.target)+'</code>':'')+'：'+escape(String(x.output || '工具返回失败').slice(0, 240))+'</span>').join('');
      const deferred=lazy&&summary&&(tools.length>8||(run.steps?.length||0)>48);
      html += '<details class="tool-group" data-group="' + escape(tools[0].id) + '" '+(deferred?'data-lazy-detail="tools" ':'') + (summary ? '' : 'open') + '><summary>操作记录 · ' + tools.length + ' 项' + (errors ? ' · ' + errors + ' 项操作失败' : '') + '</summary>'+(failurePreview?'<div class="tool-failure-previews" aria-label="失败操作摘要">'+failurePreview+'</div>':'')+'<div class="tool-list">';
      if(!deferred)html += toolEntries(tools);
      html += '</div></details>';
      tools = [];
    };
    // Older/imported turns can contain a final answer without tool history.
    // Missing steps must not blank the entire conversation.
    const groups=processGroups(message),saved=processPages.get(message),pageSize=saved==null&&run.status!=='running'?6:PROCESS_PAGE,start=lazy?Math.min(saved??Math.max(0,groups.length-pageSize),Math.max(0,groups.length-1)):0,end=lazy?Math.min(groups.length,start+pageSize):groups.length;
    const pageButton=(direction,label)=>'<button type="button" class="process-page-control" data-process-page="'+direction+'">'+label+'</button>';
    if(start)html+=pageButton('older','查看更早的过程 · 还有 '+start+' 组');
    for (const group of groups.slice(start,end)) {
      if(group.kind==='tools'){tools=group.steps;flush();}
      else html += '<div class="agent-commentary">' + render(group.step.text) + '</div>';
    }
    flush();
    if(end<groups.length)html+=pageButton('newer','查看后续过程 · 还有 '+(groups.length-end)+' 组')+pageButton('latest','回到最新进展');
    const duration = formatDuration((run.finishedAt || Date.now()) - (run.startedAt || Date.now()));
    if (run.status === 'running') html += '<div class="run-indicator" role="status"><span class="running-dot"></span><span>' + escape(run.label) + '</span><time>用时 ' + duration + '</time></div>';
    else html += '<div class="run-summary" role="status"><span class="run-summary-status">' + escape(run.label) + '</span><time>用时 ' + duration + '</time></div>';
    const files = run.changedFiles?.length ? '' : '<details><summary>Files</summary><div class="run-summary-tab-body"><p class="review-empty">本轮没有检测到文件变化。</p></div></details>';
    html += files + '<div class="run-summary-tabs" aria-label="运行摘要标签"><details data-summary-kind="graph" '+(lazy?'data-lazy-detail="graph"':'')+'><summary>Execution graph</summary><div class="run-summary-tab-body">' + (lazy?'':graphApi.graphMarkup(message)) + '</div></details><details data-summary-kind="metrics" '+(lazy?'data-lazy-detail="metrics"':'')+'><summary>Run summary</summary><div class="run-summary-tab-body">' + (lazy?'':graphApi.metricsMarkup(message)) + '</div></details></div>';
    return html + '</div>';
  }
  function fileMarkup(message) {
    if (message.run?.status === 'running' || !message.run?.changedFiles?.length) return '';
    const files = message.run.changedFiles;
    const icon = '<svg class="changed-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
    const chevron = '<svg class="changed-files-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg>';
    const rows = files.map((file,index) => {
      const path = String(file.path || '未命名文件');
      const normalized = path.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      const name = normalized.slice(slash + 1) || path;
      const directory = slash < 0 ? '项目根目录' : normalized.slice(0, slash + 1);
      const operation = String(file.operation || '修改');
      const kind = ({ '新增': 'added', '删除': 'deleted', '修改': 'modified', '写入': 'modified' })[operation] || 'modified';
      return '<li><button type="button" class="file-review-link" data-action="review-file" data-message="'+escape(message.id)+'" data-index="'+index+'" title="'+escape(path)+'" aria-label="'+escape('查看文件差异：'+path)+'">'+icon+'<span class="changed-file-info"><span class="changed-file-name">'+escape(name)+'</span><span class="changed-file-directory">'+escape(directory)+'</span></span><span class="changed-file-operation '+kind+'">'+escape(operation)+'</span>'+chevron+'</button></li>';
    }).join('');
    const notice = message.run.reviewError ? '<p class="changed-files-note">部分文件差异未能采集：'+escape(message.run.reviewError)+'</p>' : message.run.reviewLimited ? '<p class="changed-files-note">部分大文件或二进制文件未采集完整文本差异。</p>' : '';
    return '<details class="changed-files" data-group="files-'+escape(message.id)+'" aria-label="修改文件" open><summary>'+icon+'<strong>'+files.length+' 个文件已更改</strong><span class="changed-files-hint">查看差异</span>'+chevron+'</summary><ul aria-label="已修改的文件">'+rows+'</ul>'+notice+'</details>';
  }
  function copyText(message) {
    const progress = (message.run?.steps || []).filter(x => x.kind === 'text').map(x => x.text);
    const files = message.run?.changedFiles?.length ? '\n\n修改文件：\n' + message.run.changedFiles.map(x => '- ' + x.path).join('\n') : '';
    return [...progress, message.text].filter(Boolean).join('\n\n') + files;
  }
  return { start, apply, finish, textOf, reference, createMarkdown, progressMarkup, processPage, revealStep, detailMarkup, fileMarkup, copyText, formatDuration, graphMarkup: graphApi.graphMarkup, metricsMarkup: graphApi.metricsMarkup, metrics: graphApi.metrics };
});
