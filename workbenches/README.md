# 工作台工程约定

工作台是本地软件；HTML 只是交互层。业务状态、计算和设备操作不放在 UI 中。

```text
workbench/
├── manifest.json             # 版本、UI/Server 入口、状态/动作/事件契约
├── ui/
│   ├── index.html / index.js # 本地界面
│   ├── components/          # 控件
│   ├── pages/               # 页面
│   └── api/                 # 动作客户端，不承担计算
├── server/
│   ├── index.cjs            # 可被独立 Node 程序使用的后端入口
│   ├── domain/              # 领域状态与规则
│   ├── contracts/           # 版本化状态、动作、事件
│   ├── application/tasks/   # 用例编排、任务队列
│   ├── ports/               # 设备、计算、存储接口
│   ├── adapters/
│   │   ├── devices/         # 摄像头、串口、采集卡适配
│   │   ├── processing/      # OpenCV、GPU 等外部库适配
│   │   └── storage/         # 文件/数据库适配
│   ├── processing/          # 纯算法
│   └── transport/           # JSONL/HTTP 等传输适配
├── agent/                   # 仅激活工作台时载入的上下文
└── tests/                   # 后端契约和回归测试
```

生成器创建上述标准目录；内置工作台按实际职责采用其中必要目录，空目录不表示已有驱动。

UI 和 Agent 调用同一套后端动作。后端返回完整新状态、结果与语义事件，桌面壳按任务串行提交修改；布局状态单独合并，避免覆盖业务状态。后端动作在 Worker 中执行，不占用渲染线程。

`server` 禁止依赖 DOM、window 或 Electron。应用层依赖领域规则和 ports；具体设备/库由 adapters 实现；纯算法不依赖 UI 或设备。未来另做桌面软件时保留 server，替换 UI/transport 即可。

生成工程可直接运行 `npm test` 和 `npm start`，后者提供 JSONL 后端。设计画布提供本地热预览，试运行连接真实后端，通过验证后发布到本地目录。工程骨架仍需要作者补充领域业务。

内置 QUBO 的 CPU 枚举和量子电路的状态向量模拟是真实计算。摄像头、OpenCV、GPU 和串口只提供分层规范，不会自动实现或安装驱动。

## 长任务与动态上下文

UI 使用 `window.__wbJobs.start(action,payload)` 返回任务 ID；`list/get/cancel` 查询与取消。Agent 使用 `startWorkbenchJob/listWorkbenchJobs/getWorkbenchJob/cancelWorkbenchJob` 操作同一批任务，`job.updated` 事件包含进度、状态和结果。

运行桥接会在 DOM 就绪或注册模块的 `mount` 完成后重新请求宿主状态；收到状态前页面暂不接受交互。异步模块须在 `mount` 返回的 Promise 中完成控件事件绑定。通过返回控制器的 `sync(state)` 或 `workbench-state` 事件接收恢复状态，不要依赖页面启动前已发出的事件。

后端 `dispatch` 接收 `signal` 与 `progress(value,message)`；需要定期检查取消并让出事件循环。计算密集算法应放在计算线程或子进程中，避免堵塞工作台会话。取消不会自动撤销已经写入的文件或发出的设备命令。

`agent/CONTEXT.md` 只在当前工作台打开时载入。知识库通过 `searchWorkbenchKnowledge` / `readWorkbenchKnowledge` 按需读取，并保持来源标识及版本，不应将全部资料追加到每轮提示词。

## 发布验收

`tests/host-scenarios.json` 声明初始状态和行为用例。每个动作至少有成功用例；写动作须验证业务数据、revision 增长和旧 revision 拒绝；错误输入不能改变状态。宿主实际执行用例并检查关闭重开后的状态。生成器已提供可运行样例，添加业务动作时同步扩展。

最终源码修改后调用 `verifyWorkbench`。验证在独立进程与临时副本中执行，失败、超时、取消、跳过和源码变化不能获得发布许可。测试应使用离线适配器或临时资源，不能把宿主验证当作系统安全沙箱。发布版本独立保存，已有使用任务不自动迁移。
