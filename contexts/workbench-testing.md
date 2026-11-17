# 工作台前后端自主验收

仅在打开工作台时加载这些能力。日常聊天不加载页面驱动或测试规范。

## 操作当前工作台

- 先 `inspectWorkbenchRuntime`；设计状态下自行 `startWorkbenchTrial`，不让用户代点按钮。
- `inspectWorkbenchUI({offset:0,limit:50})` 返回真实页面文字、控件选择器/名称/值/禁用状态、资源和脚本错误、分页信息。只操作实际读到的控件。
- `actWorkbenchUI({operation:"click",selector:"#run"})` 操作运行页面。支持 `fill`（value）、`select`（value）、`check`（checked）、`press`（key）、`drag`（from/to 为 0–1 相对坐标，可用 toSelector）。拖拽支持画布；画布语义结果还必须核对后端状态和页面反馈。操作需要遵守当前批准模式；不能通过页面绕过动作批准。
- `captureWorkbenchUI()` 返回截图和本地路径。截图辅助检查视觉与遮挡，不能替代业务结果断言。
- 页面操作与用户、Agent 共用同一个真实会话；执行后继续读取页面、后端状态和事件确认结果。测试自己的草稿也不能悄悄改变用户正式业务数据。

## 完整生命周期验收

`verifyWorkbench` 在独立工程副本和浏览器进程运行测试，不改变当前任务的会话状态。它强制执行后端测试、动作覆盖和恢复检查，再运行 `tests/ui-scenarios.json`，通过正式 runtime-bridge、真实 Chromium 输入和真实后端 Worker 检查页面操作。此能力内置于桌面程序，安装版也可使用，无须用户安装 Playwright 或浏览器插件。

前端用例格式（JSON，不是可执行脚本）：

```json
{
  "schema": 1,
  "initialState": {"revision": 0, "data": {}},
  "cases": [{
    "name": "计数并重新打开",
    "steps": [{
      "operation": "click",
      "selector": "#increment",
      "expect": {
        "actions": ["updateState"],
        "state": {"data.count": 1},
        "ui": [{"selector": "#value", "text": "1"}]
      }
    }],
    "afterReopen": [{"selector": "#value", "text": "1"}]
  }]
}
```

每条用例重新打开干净会话；steps 顺序执行。每步必须断言真实页面结果。写操作同时断言业务 state（不能只看 revision）；actions 必须来自页面真实发出的请求。纯界面操作必须产生被断言的变化，不能只断言“按钮可见”。参数错误用 `expect.errorCode` 并检查用户看到的错误。ui 断言支持 text、contains、value、checked、visible、disabled、exists。每条用例结束后宿主关闭页面和后端、恢复状态并重开，再检查 afterReopen。所有观察到的可操作控件都必须有实际操作覆盖；为自定义可点击区添加 data-pi-control 或语义 role，主要控件使用稳定 id。不可把未测控件藏起来逃避覆盖。

新增功能时同步维护后端用例与前端用例。至少覆盖正常输入、错误输入、主要按钮、状态同步和重开恢复；涉及拖拽、长计算、取消等必须写相应场景。初始空白模板的 cases 为空，不能通过验收或发布。

每步默认等待 5 秒，可通过 step.timeoutMs 调整到最多 60 秒。长计算应使用 __wbJobs，先断言运行状态，再测试取消或完成结果；不要让前端等待阻塞式计算。整体验收有独立超时，超时或主动停止会清理测试进程。

验证失败会返回 `ok:false`、失败用例、步骤、控件、预期/实际值、后端调用、页面错误与证据目录；读取 `frontend.failure` 和报告/截图，修复后重新 verifyWorkbench。不要再次问用户是否继续已要求的修复，不让用户抄日志或代测。不得删用例、放宽断言或绕过发布检查来消除失败。

最后一次源码修改后必须重新验证。只有后端和前端均通过才能 reportDesignStage 的交互验证及后续阶段、发布。报告真实通过数量和未验证范围；测试不能证明所有未知场景都无 bug。真实硬件、外部服务和视觉审美未实际检查时明确标注，不能用模拟器结果冒充真实设备结果。在请求批准模式下，发布或确认需求遵守既有权限与阶段确认设计；在完全批准（approval=full）模式下，试运行、页面操作（actWorkbenchUI）、verifyWorkbench 与修复重测均已预先授权，直接自主执行到底，不再向用户请求操作确认。
