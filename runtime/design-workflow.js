'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PiDesignWorkflow=api;})(typeof window==='object'?window:globalThis,()=>{
  // Shared by every stage that touches the UI. Written for people who are not designers or programmers.
  const designRules='界面规则（面向普通用户，越简单越好）：①【底色与配色，最高优先级】工作台必须和桌面应用同一色调：浅暖灰白底 #fbf9f6、侧栏/面板 #f4f0ea、卡片白 #ffffff、文字 #2b2823、次要文字 #6b655c、分割线 #e6dfd4，强调色（主按钮、选中、进度）赤陶 #b5522b，成功 #1f7a5c、警告 #8a5a00、错误 #b3382f。这些值已写在 ui/styles.css 的 :root 变量里，只用变量（var(--bg) 等），不要写死色值，不要改这些变量。禁止：自选深色主题、纯黑/纯白整页底、蓝紫渐变、高饱和大色块、与桌面应用不同的强调色；用户明确要求深色时先说明会与桌面应用不一致并请其确认。②一屏只做一件主要的事：主操作用一个醒目按钮，次要操作用普通按钮，不堆叠功能入口。③用户能看懂的中文词，不出现内部术语、字段名、英文报错；状态用“正常/未连接/运行中”这类短句，错误要说明原因和下一步怎么做。④空状态要有一句引导，危险操作要二次确认并可撤销。⑤字号不小于 12px，正文与背景对比度不低于 4.5:1，状态不能只靠颜色区分，控件有悬停与焦点样式，窄窗口不错位。⑥不要让用户填写技术参数；确需填写的给出默认值和单位。';
  // Where the user sees the work. The builder page has no layout tools any more; layout lives only in the 设计画布 tab.
  const previewRules='预览与布局：「设计设置」页只管需求、知识库、提示词和设计进度，没有布局工具，不要让用户去那里拖拽。右侧「设计画布」标签加载工程真实的 ui/index.html，ui/ 下任何文件变化都会自动刷新，写文件就是同步预览。拖拽、缩放和 readLayout/setLayout 只作用在这个预览页上，结果保存到 ui/layout.json 与 ui/layout.css（index.html 自动引用）；不要手改这两个文件，自己的样式也不要用 !important、transform 或 translate 去改已被布局的元素位置和尺寸；给主要区块写稳定的 id，布局记录才不会因调整结构而失效。预览页在沙箱里：拿不到桌面应用，也加载不到 server/，页面只能经 window.__wbTransport(action,payload) 调后端；没有该通道时显示友好提示（如“预览模式：未连接后端”），不要红色报错或整页空白。入口脚本用普通 <script> 加载，不用 type="module"。';
  // The single test standard the agent must follow; evidence, not claims.
  const testRules='后端测试规范（全部满足才算交互验证完成）：①逐个动作：manifest 里每个 action 至少一条正常路径用例，断言具体返回值、状态变化、revision 变化和事件（读动作断言 revision 不变）；每个带参数的动作至少一条参数校验错误用例，断言错误内容且状态未被改动；每个写动作一条 revision 冲突用例（旧 baseRevision 被拒、状态不变、用最新 revision 重试成功）；未知 action 被拒。另写一条测试把 manifest.actions 与后端实际支持的动作逐一对照，声明了却未实现、实现了却未声明都要失败。②持久化与恢复：宿主会保存后端返回的 state 并在下次调用时传回——测试“写入→JSON 序列化→用还原的 state 继续调用”结果一致且 revision 连续；后端若自己写文件，测试“写入→重启进程→读回一致”，目录用 os.tmpdir() 下临时目录并在结束时删除，不写用户目录。③进程级端到端：至少一个用例用 child_process.spawn(process.execPath,[\'server/transport/stdio.cjs\']) 起真实进程，逐行发送 JSONL 请求、按 id 对应响应，走通“读→写→旧版本写被拒→未知动作→读回”，断言 ok/error 与最终状态；加超时，结束时关闭 stdin 并确认进程退出。只调用内部 dispatch 不算端到端。④不自欺：不得 mock、替换或打桩被测的 dispatch、领域、应用或传输代码；只允许用假的外部设备、网络或硬件适配器，并且至少一条用例让假适配器失败，验证返回用户能懂的错误。断言要精确（具体值、错误内容、revision 数字），不能只断言 ok 为真、不抛错或 assert.ok(result)；不得 skip/todo 失败用例，不得改测试期望去迁就 bug。⑤变异检查：全绿后故意破坏至少 2 处后端逻辑（例如删掉 revision 校验、让某个写动作不再保存数据），运行测试必须变红，记下失败的用例名，再恢复代码并重跑确认全绿；没变红就说明测试无效，必须补测试。⑥隔离：server/ 不得引用 DOM、window、document、Electron 或 ui/，写一条测试扫描 server/ 源码确认；测试不依赖网络、真实硬件和用户目录。⑦完整生命周期门禁：最后一次源码修改后必须调用宿主 verifyWorkbench；宿主会实际运行 tests/**/*.test.cjs/js/mjs，拒绝失败、跳过、todo、取消、空测试或未覆盖的 manifest action，并实际执行打开会话→读取动作→关闭→重新打开→再次读取。没有这份宿主验证记录，不得提交交互验证、预览或发布准备阶段报告，也不能发布工作台。⑧如实汇报：evidence 写实际运行的命令和真实的通过/失败/跳过数量、完整生命周期结果、变异检查的破坏点与结果；有失败就列出，没运行就不得声称通过；只用假设备验证的写明“真实设备未验证”。';
  const stages=[
    {name:'需求确认',work:'读取当前草稿（readDraft）、对话和已应用的知识库约束。用普通人能懂的话澄清：谁在用、想完成什么、要放进去什么、希望看到什么结果、先不做什么；有关键歧义才询问，一次最多问 3 个并给选项。视觉方向不要让用户选主题或配色：统一使用桌面应用的暖灰白底与赤陶强调色，只询问是否有想参考的软件或特别要求。本阶段右侧预览可能是空白或只有文档，这是正常的，可以告诉用户。交付 docs/requirements.md：每条需求标“已确认/待确认”，列出“先不做”的内容，并把每个用户操作写成一句可检验的话（“做了 A 之后应该看到 B，出错时应该提示 C”），后续测试据此编写。不能把没有回答的问题当作已确认。'},
    {name:'结构设计',work:'基于已确认的需求，在 task.workspacePath 内建立或修改 ui/server 分离的工程，保留现有代码和用户布局。交付：①manifest.json 声明全部 action，docs/structure.md 为每个 action 写清输入、输出、可能的错误、是否写操作；②状态模型与事件；写动作都带 baseRevision 并校验；错误要带可区分的类别（参数错误、版本冲突、未知动作、找不到对象、设备失败）和用户能懂的中文说明；③设备、网络、存储经 server/ports 定义接口、在 adapters 实现，并能在测试里换成假的适配器；存储目录可由参数或环境变量指定；④server/ 不依赖 DOM、window、Electron 或 ui/，可用 node server/transport/stdio.cjs 独立运行；⑤按“后端测试规范”为每个 action 列出要写的用例清单。UI 只经 ui/api/client.js 调用后端。本阶段预览可能仍是空白或占位页。不要改动 ui/styles.css 里的 :root 配色变量；新增样式只引用这些变量。'},
    {name:'布局调整',work:'根据已确认结构写出真实可打开的页面（ui/index.html 及其脚本样式），从本阶段起「设计画布」显示的必须是真实页面而不是说明文字。先读取已有源码和 ui/layout.json（如有），再读取 ui/styles.css 已有的设计令牌并在其上扩展（不要另起一套色板），保证层级、对齐与留白，不修改桌面壳。'+previewRules+'需要精细调整位置时，用 readLayout 读取预览页元素后用 setLayout 修改，如处于试运行，先调用 stopWorkbenchTrial 返回布局再试；缺少页面时先写出 ui/index.html。'+designRules+'验收：说明预览里能看到哪些区块、主操作在哪里、没有后端时显示什么。'},
    {name:'交互验证',work:'把页面上的每个操作接到 UI 与 Agent 共用的后端语义动作，完成状态同步、错误反馈和版本冲突处理；从本阶段起预览必须是可用的完整页面，没有宿主通道时给出友好降级提示。读取 agent/TESTING.md；自行 startWorkbenchTrial，再 inspectWorkbenchUI/actWorkbenchUI/captureWorkbenchUI 检查真实页面，编写 tests/ui-scenarios.json 覆盖全部可操作控件、页面结果、后端业务状态和 afterReopen。后端规范与前端验收必须同时满足，verifyWorkbench 失败时读取具体证据修复重测，不让用户代操作。然后按下面的规范编写并实际运行测试，修到全部通过。'+testRules},
    {name:'预览',work:'在已有工程上逐项检查并修复：①离线启动：node server/transport/stdio.cjs 能独立运行，重新运行全部测试并报告真实数量；②主要操作在「设计画布」里走一遍，有宿主通道与没有时都不报红色错误；③视觉一致性：页面底色是否为 #fbf9f6、强调色是否为 #b5522b、有没有写死的其他色值、有没有深色整页底或蓝紫渐变，再看对比度、控件悬停/焦点/禁用状态、窄宽窗口不错位、有没有普通用户看不懂的词；④布局：自己的样式没有覆盖 ui/layout.css 的位置尺寸。能截图就截图核对；无法渲染、硬件或环境无法验证的项目必须标明。'},
    {name:'发布准备',work:'整理本地可交付源码、入口、依赖、使用说明与检查清单；README 写清如何启动、如何运行测试（npm test）和已知限制。运行最终验证（全部测试）并报告实际命令、通过/失败/跳过数量、产物路径；注意若本阶段修改了 README 或任何工程文件，必须在最后一次修改后重新调用 verifyWorkbench，确保源码指纹与验证记录一致。此阶段只准备本地交付，不自动安装、远程上传或对外发布。'}
  ];
  const labels={idle:'待开始',running:'执行中',review:'待确认',error:'执行失败',interrupted:'已中断',complete:'已确认完成'};
  function explainError(error,status){
    const raw=String(error||'').trim();
    if(/stopReason[^\n]{0,40}length|单次模型输出|输出[^\n]{0,20}(?:截断|预算|长度)/i.test(raw))return '单次模型输出被截断：阶段交付尚未完成。请检查输出预算，按小批次续接当前阶段；已完成文件和阶段报告不会自动撤销。仅压缩上下文不一定能解决输出截断。';
    if(/context_length_exceeded|maximum context|上下文[^\n]{0,20}(?:上限|超限|耗尽)/i.test(raw))return '输入上下文超出模型窗口：请压缩或重建任务上下文，再继续当前阶段，先核对已有文件。';
    if(/request timed out|timeout waiting for response/i.test(raw))return '模型请求超时：接口在限定时间内没有返回结果。请检查 API 地址、网络、余额或限流状态，也可以更换模型后重试。';
    if(/工作台动作响应超时/i.test(raw))return '工作台动作超时：工作台后端没有在限定时间内返回结果。请检查工作台状态或重试。';
    if(/EPIPE|broken pipe|stdin is not writable|会话已结束/i.test(raw))return 'Agent 会话已断开：当前进程或输入通道已结束。请重新执行当前阶段。';
    if(raw)return raw.slice(0,2000);
    return status==='complete'?'Agent 已结束，但没有提交阶段交付报告。请查看操作记录后重试。':status==='stopped'||status==='paused'?'本次阶段执行已停止，已执行的操作不会自动撤销。':'本次阶段未成功结束，且没有收到更具体的错误信息。请展开操作记录查看失败的工具或文件。';
  }
  function ensure(design){
    if(!design) return null;
    if(design.workflow?.schema!==1){
      const legacyStage=Number(design.stage)||0;
      design.workflow={schema:1,stage:0,status:'idle',revision:0,attempt:null,report:null,accepted:[],legacyStage};
      // Old counters never represented completed work. Preserve their value for
      // traceability but do not convert clicks into accepted deliverables.
    }
    design.stage=design.workflow.stage;design.completed=design.workflow.status==='complete';
    return design.workflow;
  }
  const clone=value=>JSON.parse(JSON.stringify(value));
  function view(design){const f=ensure(design);if(!f)return null;return {...clone(f),stages:stages.map(s=>s.name),name:stages[f.stage].name,next:stages[f.stage+1]?.name||'',label:labels[f.status],work:stages[f.stage].work};}
  function begin(design,{revision,requestId,revise=false}={}){
    const f=ensure(design);
    if(!f)throw new Error('当前不是设计任务');
    if(revision!==f.revision)throw new Error('阶段状态已更新，请使用当前确认卡');
    if(['running','complete'].includes(f.status))throw new Error(f.status==='running'?'当前阶段正在执行，请勿重复确认':'设计流程已经确认完成');
    if(f.status==='review'&&!revise){
      if(!f.report)throw new Error('尚未收到阶段交付，不能进入下一阶段');
      f.accepted.push({stage:f.stage,report:clone(f.report),time:Date.now()});
      if(f.stage===stages.length-1){f.status='complete';f.revision++;ensure(design);return {complete:true};}
      f.stage++;
    }
    if(f.attempt) { f.attemptHistory ||= []; f.attemptHistory.push({attempt:clone(f.attempt),report:f.report?clone(f.report):null,status:f.status,error:f.rawError||f.error||''}); f.attemptHistory=f.attemptHistory.slice(-12); }
    f.status='running';f.report=null;f.error='';f.attempt={id:requestId,runId:null,startedAt:Date.now()};f.revision++;ensure(design);
    return {complete:false,stage:f.stage,requestId};
  }
  function attach(design,requestId,runId){const f=ensure(design);if(f?.status==='running'&&f.attempt?.id===requestId)f.attempt.runId=runId;}
  function report(design,payload,runId){
    const f=ensure(design);
    if(f?.status!=='running'||!runId||f.attempt?.runId!==runId)throw new Error('当前没有匹配的设计阶段执行任务');
    if(payload?.attemptId!==f.attempt.id||payload?.stage!==f.stage)throw new Error('阶段或执行批次不匹配，请 readDesignWorkflow 后重新提交');
    const summary=String(payload.summary||'').trim(),evidence=Array.isArray(payload.evidence)?payload.evidence.map(String).filter(x=>x.trim()).slice(0,12):[];
    if(!summary||!evidence.length)throw new Error('请提交阶段结果 summary 和可供用户核对的 evidence 列表');
    f.report={summary:summary.slice(0,6000),evidence:evidence.map(x=>x.slice(0,1500)),runId};
    // A report is not a completion event. Wait for the actual run to settle.
    return {status:'recorded',message:'阶段结果已记录；本轮成功结束后等待用户确认，不会自动跳步。'};
  }
  function settle(design,runId,status,error=''){
    const f=ensure(design);if(f?.status!=='running'||f.attempt?.runId!==runId)return false;
    f.status=status==='complete'&&f.report?'review':['stopped','paused','interrupted'].includes(status)?'interrupted':'error';
    f.rawError=f.status==='review'?'':String(error||'').trim();
    f.error=f.status==='review'?'':explainError(error,status);
    f.revision++;ensure(design);return true;
  }
  function interrupt(design){const f=ensure(design);if(f?.status==='running'){f.status='interrupted';f.error='应用重启前的执行未完成，请核对已有结果后继续。';f.revision++;ensure(design);}}
  function prompt(design,options={}){
    const f=view(design);
    const full=options?.approval==='full';
    const clarify=full
      ?(options?.autoAdvance?'当前处于「完全批准」连续自动推进模式：不要调用 interaction_request 或用文字征求用户同意，直接根据已有需求、草稿和知识库采取合理默认方案并标注假设，自主推进并完成本阶段全部开发与测试工作。':'当前处于「完全批准」模式：写文件、命令执行、试运行（startWorkbenchTrial）、页面检查与操作（inspectWorkbenchUI / actWorkbenchUI）和 verifyWorkbench 均已预先批准，直接自主完成本阶段工作；常规设计/技术细节直接采用合理默认值，不要调用 interaction_request 请求执行许可。')
      :'需要澄清时在聊天中使用 interaction_request，一次最多 3 个问题并给选项，不能自行假设已经确认。';
    const stageRule=full?'不要执行后续阶段，也不要调用 advanceStage；提交 reportDesignStage 后宿主会按流程继续。':'不要执行后续阶段，也不要调用 advanceStage；阶段仅由用户确认后推进。';
    return `工作台设计阶段：${f.name}（${f.stage+1}/${stages.length}）。\n本阶段工作：${f.work}\n做法：先调用 workbench_action readDesignWorkflow 读取当前阶段和执行批次，再读取任务工程（task.workspacePath）里已有的文件（若尚无工程目录可调用 workbench_action scaffoldWorkbench），然后实际完成工作。${clarify}按小批次交付：长内容写入任务工程文件，不在聊天或单个工具参数中生成整套工程；优先一个文件或一段 edit，完成后读取验证。中途输出截断时先检查已写入文件，只补未完成部分。\n对用户说话：用普通人能懂的中文短句，说清做了什么、在哪里能看到、还差什么；不甩内部术语、字段名或英文报错，技术细节放进 evidence。\n汇报靠证据：只写实际做过、实际运行过的结果；命令、数量、文件路径都要真实；没运行的测试不得说通过，无法验证的写明“未验证”及原因，不要说“保证无误”。\n结束前用 workbench_action reportDesignStage 提交 {stage:${f.stage},attemptId:${JSON.stringify(f.attempt?.id)},summary:"本阶段实际交付（简短）",evidence:["实际文件路径、运行的命令及结果、验收依据"]}。若工作未完成或缺少关键需求，不得提交报告，说明阻碍即可。${stageRule}`;
  }
  return {stages,labels,ensure,view,begin,attach,report,settle,interrupt,prompt,explainError};
});
