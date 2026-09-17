# Mutsumi Agent 后端化重构 · 最终设计文档（P0+P1 实施蓝本）

> **版本**：v1.0（设计冻结）
> **读者设定**：你是对本仓库、对这次重构讨论**完全没有上下文**的实现者。本文档假设你只读代码和本文档，不假设你听过任何口头讨论。读完本文档后，你应当能够 100% 无损地完成 P0（后端 + Lite 适配器 + 旧代码清除）与 P1（WebView 前端）两个阶段。
> **纪律**：本文档是唯一真相源。实现时发现文档与代码现实冲突，先改文档再改代码，或停下来向维护者确认。

---

## 0. 阅读指南

本文档按"理解旧系统 → 理解它为什么坏 → 理解每个设计决策的来龙去脉 → 按蓝图施工"的顺序组织：

- **第 1 章**：旧架构全景导读。即使你从没见过这个仓库，读完也能知道每个文件是干什么的、数据怎么流动。
- **第 2 章**：病理诊断。为什么必须重构，而不是修补。
- **第 3 章**：设计裁决记录。本章记录初版设计中那些被维护者纠正的"直觉设计"，以及为什么纠正后的方案更好。**施工前必读**——它能防止你在实现时"顺手"把这些错误重新引入。
- **第 4~14 章**：目标架构的完整规格（事件协议、后端模块、适配器框架、WebView UI）。
- **第 15~18 章**：格式兼容、构建变更、删除/保留清单、行为语义契约。
- **第 19 章**：实施计划（P0/P1 的逐文件施工顺序与验收标准）。
- **第 20 章**：已拍板的小决策汇总。

---

## 1. 旧架构全景（实现者导读）

### 1.1 .mtm 文件格式

一个 Agent 会话 = 一个 `.mtm` 文件（JSON）：

```jsonc
{
  "metadata": { /* AgentMetadata，见 src/types.ts */ },
  "context": [ /* AgentMessage[]，扁平的 kosong 消息数组 */ ]
}
```

- `AgentMetadata`（`src/types.ts`）：`uuid`、`name`、`created_at`、`parent_agent_id`、`allowed_uris`、`is_task_finished?`、`model?`/`provider?`、`reasoning_effort?`、`contextItems?`、`activeRules?`、`activeSkills?`、`agentType?`、`enabledMcpTools?`、`mtm_version?`（当前为 2，只写不读）、`sub_agents_list?`。
- `AgentMessage` = kosong `Message`（`role`、`content: ContentPart[]`、`toolCalls: ToolCall[]` 必填）+ 可选 `metadata`（管道元数据，不上线）。
- **关键事实**：文件里的 `context` 是**扁平消息数组**。ghost block（上下文引用快照）以 `last_ghost_block` 键存于 **user 消息的 `metadata`** 上。这个格式在新架构中**原样保留**（见第 14 章）。

### 1.2 模块地图（现状）

| 路径 | 职责 |
|---|---|
| `src/notebook/serializer.ts` | `MutsumiSerializer`（vscode `NotebookSerializer`）：.mtm 字节 ↔ `NotebookData`；内含消息↔cell 转换（`messagesToGenericCells` / `genericCellsToMessages`）、`buildInteractionRenderBlocks`（历史→渲染块）、`createDefaultContent`（新 Agent 文件工厂） |
| `src/notebook/renderer.ts` + `css.ts` + `renderTypes.ts` | 自定义 notebook renderer（独立 bundle `dist/notebookRenderer.js`）：把 `RenderData` JSON 增量渲染成 DOM（micromark GFM + lowlight 高亮 + 增量 DOM 协调 + `<pre>` 打捞） |
| `src/notebook/commands/` | 笔记本工具栏命令：选模型、重命名、压缩、裁剪 ghost、调试上下文等 |
| `src/controller.ts` | `AgentController`：`NotebookController` 的执行入口，一次 cell 执行 = 一次 Agent run |
| `src/agent/agentRunner.ts` | Agent 主循环：流式生成 → 工具执行 → 循环，直到无 toolCall / 被打断 / 达到 maxLoops |
| `src/agent/generateStream.ts` | kosong `generate()` 的流式泵：逐 part 累积显示值、重试分类、retry-after |
| `src/agent/uiRenderer.ts` | **名字误导**：它不是 UI 渲染器，是"流式状态 → `RenderData` IR"的构建器，带三级锁（轮次/轮内/工具块）与重试回滚快照 |
| `src/agent/toolExecutor.ts` | 执行一批 toolCall：建 `ToolSession`、查缓存、执行、格式化结果块 |
| `src/agent/agentOrchestrator.ts` | 单例：会话注册表门面、tab 跟踪（`isWindowOpen`）、dispatch 协调、侧栏刷新 |
| `src/agent/registry.ts` / `fileOps.ts` / `treeUtils.ts` / `dispatch.ts` | 会话注册表 / Agent 文件创建与元数据改写 / 树工具 / 派发会话管理器 |
| `src/agent/titleGenerator.ts` | 首轮用户消息后生成会话标题（内部用 LiteAdapter + 单轮 runner） |
| `src/adapters/` | `interfaces.ts`（`IAgentAdapter` / `IAgentSession`）、`notebookAdapter.ts`、`headlessAdapter.ts`、`liteAdapter.ts` |
| `src/httpServer/` | Express HTTP 服务器（默认关闭）：自建 REST 协议，chat 端点用**猴子补丁替换 `session.replaceOutput`** 来截获流式输出转 SSE |
| `src/tools.d/` | 工具系统：`toolManager.ts`（ToolSet/ToolRegistry/ToolManager）、`interface.ts`（`ITool`/`ToolContext`）、`permission.ts`（审批）、`edit_file.ts`（编辑事务）、`tools/`（各工具实现） |
| `src/contextManagement/` | 上下文管理：`history.ts`（`buildInteractionHistory`）、`ghostBlocks.ts`、`templateEngine.ts`、`prompts.ts`、`skillManager.ts` |
| `src/config/` + `src/registry/` | Agent 分角色系统：配置加载/校验、`AgentTypeRegistry`、`ToolSetRegistry` |
| `src/mcp/` | MCP 服务器注册表与工具适配 |
| `src/codebase/` | 代码库服务与 RAG |
| `src/sidebar/` | 四个 TreeView：agent 树、审批树、上下文树、shell 任务树 |

### 1.3 一次执行的完整链路（现状）

1. 用户在 notebook 的 **code cell** 里输入文本，点"执行"。
2. `NotebookController.executeHandler` → `AgentController.execute(cells, notebook, controller)`（`src/controller.ts`）。
3. `processCell`：从 `notebook.metadata` 解析模型对（`model`+`provider`，缺失则全局默认），`getModelCredentials` 拿凭证。
4. `new NotebookAdapter(controller).createSession(...)` → `NotebookAgentSession` 包住 `NotebookCellExecution`。**session 的 id 是 cell 的 document URI**。
5. `createToolSetForAgent({ agentType, agentId, parentAgentId, enabledMcpTools })` 构建工具集。
6. `buildInteractionHistory(session)`（`src/contextManagement/history.ts`）：
   - 组装 system prompt（角色宏 + rules + skills）；
   - 从 session 读历史（`NotebookAgentSession.getHistory()` 遍历**当前 cell 之前的所有 cell**）；
   - 用 `TemplateEngine` 渲染当前输入（`@文件` 引用、宏、`@[tool{...}]` 预执行）；
   - 对上下文文件做哈希/版本差分，算 ghost block；
   - `persistGhostBlock` / `updateContextItems`（NotebookAgentSession 里是 pending 状态，save 时落进 cell/notebook metadata）；
   - 返回 `[system, ...历史, 当前user]`。
7. `new AgentRunner(options, toolSet, session).run(abortController, history)`：
   - 每轮：剥离 system 消息拼 `systemPrompt` → `streamGenerate`（kosong，带重试）→ `onProgress` 里 `UIRenderer.updateActive` → `session.replaceOutput(JSON.stringify(renderData), { mimeType: 'application/vnd.mutsumi.agent-chat' })` → **写进 cell output** → 自定义 renderer 每 tick 重渲染；
   - assistant 消息若有 toolCalls → `ToolExecutor.executeTools` → 每个工具结果格式化成 `toolCall` RenderBlock 追加；
   - `task_finish` → `signalTermination(true)` → 元数据置 `is_task_finished`。
8. `session.setHistory([...history, ...newMessages])` → `session.save()`：`NotebookAgentSession.save()` 用 **`WorkspaceEdit`** 写 notebook metadata + 当前 cell metadata（`mutsumi_interaction` = 自最后一条 user 消息之后的新消息、`last_ghost_block`）→ **只写进 VSCode 脏缓冲区**，等用户保存或 auto-save 时才经 `serializeNotebook` 落盘（cell → 扁平 context）。
9. 首轮用户消息后触发标题生成（跳过 `LiteAgentSession`——用的是 `instanceof` 判断）；`onDidSaveNotebookDocument` 钩子在保存时按标题自动重命名文件。

### 1.4 审批链路（现状）

`src/tools.d/permission.ts`：

- 工具调 `requestApproval(actionDescription, targetUri, context, toolName, details)`。
- 自动放行条件：全局 `mutsumi.autoApproveEnabled` 或处于预执行平面（`isInPreExecution()`，用户在自己文本里写的 `@[tool{...}]` 调用）。
- 否则 `approvalManager.createRequest(...)` 挂起 Promise → 侧栏审批树显示 → 用户在侧栏点批准/拒绝。
- **拒绝理由靠 `vscode.window.showInputBox` 直接弹输入框**（`handleRejectionFlow`）；空理由 = 终止会话。
- abort 时取消请求并返回 `[Cancelled] ...`。

### 1.5 子 Agent 派发链路（现状）

`dispatch_subagents` 工具（`src/tools.d/tools/agent_control.ts`）：

1. 校验子类型（`AgentTypeRegistry.isValidChildType`）；
2. `AgentOrchestrator.requestDispatch(parentId, context_broadcast, subAgents, signal)`；
3. 每个子 Agent：`AgentFileOperations.createAgentFile(...)` 写 .mtm 文件（prompt 作为首条 user 消息）→ 注册 → **`vscode.workspace.openNotebookDocument` + `showNotebookDocument` 打开窗口**；
4. 工具向模型输出 `"Created N sub-agents... Please run them manually in the sidebar or opened windows. Waiting for completion..."`——**子 Agent 不会自动运行**，要等用户手动执行；
5. 子 Agent 跑完调 `task_finish` → `reportTaskFinished` → `DispatchSessionManager` 聚合 → 全部到齐后生成报告 → 工具的 Promise 返回。

### 1.6 edit/write 的"带用户编辑的批准"（现状）

`src/tools.d/edit_file.ts`：

1. 工具的 edit/write 请求 → `EditService.requestEdit` → 创建 `EditTransaction`：在原文件旁写两个临时文件（`.<name>.<id>.temp-backup<ext>` = AI 提议原样，`.<name>.<id>.temp-edit<ext>` = 用户可编辑副本，初始为 AI 提议内容）；
2. 非自动批准时**自动弹出 diff 编辑器**（`vscode.diff`：原文件 ↔ 可编辑副本），用户可直接在右侧修改 AI 的提议；
3. 在 `approvalManager` 上注册带 `onApprove`/`onReject`/`customAction`（"重新打开 diff"按钮）的请求；
4. 批准 → `accept()`：读 `.temp-edit` **磁盘文件**内容覆写原文件，生成"AI 提议 vs 用户终稿"的 unified diff 作为给模型的反馈（"User accepted the changes with manual edits..."）；
5. 结算后 `cleanup()`：关 diff 标签页、删临时文件、若原文件是本次新建且仍为空则删除。
6. 同一文件的第二个编辑事务会取消前一个（`cancelExistingTransaction`）。

### 1.7 适配器层（现状）

`src/adapters/interfaces.ts` 定义 `IAgentAdapter` / `IAgentSession`。`IAgentSession` 的方法面：`id`、`token`（vscode `CancellationToken`）、`supportsUI`、`getInput`、`getHistory`、`appendOutput`/`replaceOutput`（**RenderData 必须 JSON.stringify + mimeType 过界**）、`save`、`getConfig`/`setConfig`、`updateTitle`、`setHistory`、`getCurrentOutput?`、`getPreviousGhostBlocks?`、`persistGhostBlock?`、`updateContextItems?`。

三个实现：`NotebookAgentSession`（脏缓冲区 + cell output）、`HeadlessAgentSession`（直接读写 .mtm，被 httpServer 用）、`LiteAgentSession`（纯内存，被标题生成/压缩用）。

---

## 2. 病理诊断：为什么必须重构而不是修补

### 2.1 Serializer 的三重身份（抽象层级击穿）

`MutsumiSerializer` 名义上是 `NotebookSerializer`（文件字节 ↔ `NotebookData`），实际上同时是：(a) .mtm 文件格式的编解码器（`HeadlessAgentSession.save()`、`httpServer/chat.ts`、`httpServer/agents.ts` 全都 `new MutsumiSerializer()`）；(b) 新 Agent 文件工厂（`createDefaultContent` 被命令层和 HTTP 层调用）；(c) 消息→UI 渲染桥（`buildInteractionRenderBlocks`）。一个类横跨**文件格式层、VSCode 文档层、UI 层**，任何改动穿透三层。

### 2.2 Agent 创建逻辑三处并行

`extension.ts` 的 `mutsumi.newAgent` 命令（走 `MutsumiSerializer.createDefaultContent`）、`fileOps.createAgentFile`（子 Agent，另一套 metadata 拼装）、`httpServer/agents.ts`（第三套，回头又调 serializer）。三份代码各自拼 `AgentMetadata`、各自注册 registry、各自解析 rules/skills/MCP 默认值。

### 2.3 元数据写入双路径

`fileOps.ts` 的 `updateAgentParentInFile` / `updateAgentModelSelection` / `updateParentSubAgentsList` 每个方法都是"文档开着 → `WorkspaceEdit` 改脏缓冲区；没开 → 直接写文件"两套分支。同一份状态两个写入口，脏缓冲区与磁盘可能不一致——这是"后端要通知前端只能写脏文件"的 Notebook 宿命的直接后果。

### 2.4 交互语义被 Notebook 模型锁死

`NotebookController.execute` 是纯前端→后端触发模型。于是：

- **没有排队/插话**：一次只能执行一个 cell，运行中发消息无门；
- **删消息不能级联**：删一条老消息想自动删后面全部消息，只能操作 cell；
- **子 Agent 无法后台启动**：工具输出自己在说 *"Please run them manually"* ——这是 Notebook 语义锁死的最强证据；
- **关窗即断流**：运行状态绑在 cell execution 上；
- **上下文压缩/microcompact 无处安放**：没有后端主动改历史的语义通道。

### 2.5 `IAgentSession` 抽象失效

这套接口是为"不同 adapter = 不同持久化方式 + 不同 UI"设计的。一旦持久化统一收归后端，就只剩一个实现，接口本身变成纯间接层税。病灶症状：`AgentRunner` 里的 `LiteAgentSession instanceof` 判断和 `'execution' in session` 探测、`session.token` 这个 vscode `CancellationToken` 依赖、RenderData 被迫 `JSON.stringify` 过界、httpServer 靠**猴子补丁 `session.replaceOutput`** 才能拿到流式输出。

### 2.6 审批 UI 耦合

`handleRejectionFlow` 在工具执行链路里直接 `vscode.window.showInputBox` 弹窗——后端逻辑里长出了 UI。

---

## 3. 设计裁决记录（被纠正的直觉设计）

本章记录设计过程中**初版直觉设计 → 维护者纠正 → 为什么纠正后更好**。施工时若产生"这里是不是可以……"的念头，先对照本章。

### 3.1 禁止兼容层：旧 Notebook 路径整体删除，不留过渡

- **直觉设计**：新后端与旧 Notebook 路径并存一段时间，逐步迁移。
- **纠正**：纯原生 notebook 被放弃；破坏性变更全部允许（当前版本 0.0.8，没有历史包袱）。
- **为什么更好**：双套抽象并存必然在中间态产生有损投影，而且过渡代码会生根。一次切干净，反而只有"一个真相源"，总风险更低。

### 3.2 `IAgentSession` / `IAgentAdapter` 接口整体删除

- **直觉设计**：让新的 `BackendSession` 实现 `IAgentSession`，保留接口。
- **纠正**：以后只有 BackendSession 这一种 Session，接口就没有存在必要，直接删。
- **为什么更好**：接口的价值在于多实现。只剩一个实现时，接口是纯间接层税，还会把旧语义（`token`、`supportsUI`、JSON 过界）继续漏给新代码。**动地基是可接受且被鼓励的。**

### 3.3 不造 `replay.ts` / `historyHygiene.ts` 这类"听起来像模式"的模块

- **直觉设计**：设 `replay.ts`（历史→渲染回放）与 `historyHygiene.ts`（悬空 toolCall 修补）两个模块。
- **纠正**：质疑其必要性——"如果快照就够了，要这些东西干嘛？搞个反序列化器反序列化出快照然后直接往后追加 delta 行不行？"
- **结论**：`replay.ts` 就是**快照构建器**，改名 **`snapshot.ts`** 一语中的（它的确就是维护者说的"反序列化器"：读历史 → 产出快照，之后前端只收增量）；悬空 toolCall 修补只是两个纯函数，**内联进 `backendSession.ts`**，不单独成文件。
- **为什么更好**：模块即概念负载。能不造概念就不造。

### 3.4 命名：禁止 `xxxService`，沿用项目已有领域词汇

- **直觉设计**：`runService` / `agentCatalog` / `approvalBroker` / `dispatchService` / `titleService` / `compressService`。
- **纠正**：维护者不这么命名。项目已有词汇表是 **Registry / Manager / Generator / Provider / Adapter / Controller / Operations**。
- **最终命名**：`AgentRegistry`（合并原 registry+fileOps）、`ApprovalRequestManager`（沿用现有 `approvalManager` 的类名）、`DispatchSessionManager`（沿用）、`TitleGenerator`（沿用）、运行队列并入 `BackendSession` 自身、`snapshot.ts`。
- **为什么更好**：`Service` 不传达职责信息，是套路化命名；沿用领域词汇降低认知成本，新人读 `approvalManager.ts` 就知道它是什么。

### 3.5 `tools.d/permission.ts` 整个文件删除，工具直接调后端

- **直觉设计**：permission.ts 保留为工具侧入口，内部委托后端。
- **纠正**：像删 `IAgentSession` 一样删掉这层。工具已经有 `context.session` 句柄，直接 `session.requestApproval(...)`（BackendSession 委托给后端的 `ApprovalRequestManager`）。
- **为什么更好**：工具→全局单例 import→后端 是多余一跳；审批的唯一权威在后端。同时 `handleRejectionFlow` 的 `showInputBox` 随之消灭——拒绝理由改由 FtB 事件载荷携带。

### 3.6 `uiRenderer.ts` 留在宿主，改名 `renderDataBuilder.ts`

- **疑问**：它是不是该吸收进 WebView？
- **裁决**：**不移，但改名**。它不是 UI 渲染器，是"流式状态 → `RenderData` IR"的构建器；它依赖 `ToolManager.getPrettyPrint` / `getRenderingConfig`（MCP 注册表知识只在宿主进程有）。真正的 UI 渲染器是 `RenderData → DOM` 的另一半（原 `notebook/renderer.ts` 核心），那一半进 WebView bundle。
- **为什么更好**：按**数据依赖**而不是按**名字**决定归属。宿主构建 IR，前端渲染 IR，边界干净。

### 3.7 插话/排队语义：轮次边界注入，而不是打断

- **直觉设计**：`userMessage.send` 的 mode 为 `'queue' | 'interrupt'`，interrupt = 打断当前输出立即发。
- **纠正**：
  - **steer（插话）** = 等 Agent **下一次工具批次执行结束**（或自然停止）后，把 user message **插在 tool result 之后**、随下一次 LLM 调用发出。**不是打断当前输出**。
  - **queue（排队）** = 仅在 Agent **自然停止**（assistant 消息无 toolCalls / task_finish / 出错 / maxLoops）后才插入并发出；Agent 因"本轮以工具调用告终"而暂停生成**不算**自然停止，继续排。
- **为什么更好**：打断会制造悬空 toolCall、丢弃已生成的有效内容；轮次边界注入既保持线协议历史合法，又保留"尽快让 Agent 看到我的话"的体验。这个二分（注入时机：轮次边界 vs 整场 run 结束）比 queue/interrupt 二分更贴合 Agent 循环的真实结构。

### 3.8 压缩功能：本轮整体删除，不做半成品

- **直觉设计**：实现原地压缩 + fork 新文件两种模式。
- **纠正**：本轮**直接删除整个压缩功能**。未来回归时要改 .mtm 格式：metadata 加稀疏映射表 `{ index: AgentMessage }`（语义 = 线协议发送时，context 第 index 条之前的所有消息被该条替换），同时清空所有跟踪文件的哈希值（防止重新引用被误判为复用）。不要 fork 模式。本轮只需留出挂钩点（见第 14 章）。
- **为什么更好**：正确的压缩需要格式演进支持；半成品会固化错误语义。支路功能不能拖累主路质量，删除比做错便宜。

### 3.9 ACP 适配器：本轮不实现，传输形态由真实客户端决定

- **直觉设计**：本轮实现 ACP，传输选 WebSocket。
- **纠正**：第一阶段**不实现 ACP**，只了解它、在架构上留好扩展位。届时按 Zed、Paseo 等真实客户端怎么接 ACP 来定传输。
- **为什么更好**：对不存在的需求选传输是赌博；事件目录 + 适配器框架已经让 ACP 变成纯增量工作，推迟决策零成本。

### 3.10 "无交互前端时的审批策略"是个伪需求

- **直觉设计**：审批管理器需要"无交互前端时默认 deny/approve"的策略配置。
- **纠正**：**侧栏审批树永远在线**——它就是常驻前端的兜底。任何审批都会在侧栏出现；恰好在 ACP 客户端里就在那里批，恰好在 WebView 里就在那里批。
- **为什么更好**：不虚构场景、不加策略配置项、不产生行为分叉。唯一例外是 Lite 适配器（见 §11），它对自己拥有的会话自动应答。

### 3.11 edit/write 的 DiffEditor：默认不弹出，按钮触发

- **现状/直觉**：请求审批时自动弹出 diff 编辑器。
- **纠正**：默认**不弹**（编辑器突然跳出会吓人一跳）。审批请求事件携带 `customAction: { label, localOnly: true }`，侧栏审批项和 WebView 审批卡片上都渲染"查看/编辑差异"按钮，用户点击才打开；审批结算时事务自己关窗清理。
- **为什么更好**：审批的第一现场是审批卡片/侧栏；diff 是按需深入。窗口不突袭用户。

### 3.12 审批的跨前端可见性：FtB=意图，BtF=事实

- **问题**：一个会话挂了多个前端（两个 WebView 面板 + 侧栏 + ACP），在一个前端点了批准，其他前端如何**立即**知道？难道前端要监听 FtB 事件？会不会击穿抽象？
- **裁决**：**前端永不监听 FtB。**后端收到 FtB 意图、改变状态后，必须广播对应的 BtF 事实。审批即：`approval.respond`（FtB）→ 后端结算 Promise 并广播 `approval.resolved { sessionId, requestId, outcome, reason?, origin? }`（BtF）→ 所有前端立即撤下卡片。`origin` 由适配器桥接时注入（`'webview'` / `'acp'`），供其他前端显示来源。
- **为什么更好**：FtB 是**意图（command）**，BtF 是**事实（fact）**。后端是唯一状态权威，前端之间互相不可见。这条铁律同时回答了所有"其他前端怎么知道"的问题：改名、换模型、开关自动批准、用户消息落盘……全部以 BtF 事实广播。

---

## 4. 目标架构总览

### 4.1 分层图

```
┌───────────────────────── Extension Host ─────────────────────────┐
│  Frontends（适配器，单例 host，DI 注册）                            │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ WebView host │  │ ACP server   │  │ Lite adapter          │  │
│  │ (每面板一个   │  │ (本轮不实现,   │  │ (程序化一次性运行,      │  │
│  │  controller) │  │  仅留扩展位)  │  │  自动应答自己的审批)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────────────┘  │
│         │ BtF ↑   FtB ↓   │                 │                    │
│  ═══════╪═════════════════╪═════════════════╪══════════════════  │
│         │            EventBus（进程内，类型化，方向分离）           │
│  ═══════╪══════════════════════════════════════════════════════  │
│         ↓ FtB（仅后端订阅）              ↑ BtF（所有前端订阅）       │
│  ┌─────────────────────────────────────────────────────┐        │
│  │              AgentBackend（单例）                     │        │
│  │  AgentRegistry │ ApprovalRequestManager │            │        │
│  │  TitleGenerator │ （无 DispatchSessionManager：       │        │
│  │  派发是工具内部逻辑，结果经 steer 回报）              │        │
│  └────────┬──────────────────────────────┬─────────────┘        │
│           │ 每会话                        │ 每次 run              │
│  ┌────────▼─────────┐          ┌─────────▼──────────┐          │
│  │  BackendSession  │─────────→│ AgentRunner         │          │
│  │ （唯一 Session    │          │ generateStream      │          │
│  │  实现：metadata+  │          │ RenderDataBuilder   │          │
│  │  history+队列+    │          │ ToolExecutor        │          │
│  │  RenderData+abort)│          └─────────┬──────────┘          │
│  └────────┬─────────┘                    │ ToolContext.session  │
│           │ fileUri≠null       ┌─────────▼──────────┐          │
│  ┌────────▼─────────┐          │ tools.d / mcp /    │          │
│  │ sessionStore     │          │ codebase(RAG) /    │          │
│  │ （.mtm 直读写,    │          │ contextManagement  │          │
│  │  直写+写队列)     │          └────────────────────┘          │
│  └──────────────────┘                                            │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 三条铁律

1. **后端零 UI 依赖**：`src/backend/` 与 `src/agent/` 不 import 任何 `vscode.window` / Notebook API / Webview 类型。允许的 VSCode API 只有 `vscode.workspace.fs`（纯字节 I/O，**不是**脏缓冲区）、`vscode.EventEmitter`（事件原语）、`vscode.Uri` 等纯数据类型。
2. **一切跨层通信都是事件**：前端→后端只有 FtB 事件；后端→前端只有 BtF 事件。不存在"后端写缓冲区前端被动感知"的暗道。
3. **每个事件携带 `sessionId`**（会话 UUID；真正的全局事件除外：`sessions.changed`、`settings.autoApprove`）。后端靠它路由到会话；WebView host 靠它路由到面板；将来的 ACP host 靠它路由到对应连接的 `session/update` 流。

### 4.3 FtB=意图，BtF=事实

FtB 事件是**意图（command）**；BtF 事件是**事实（fact / 状态迁移）**。任何改变了后端状态的 FtB 意图，后端都必须广播对应的 BtF 事实。前端之间互相不可见。（见 §3.12）

---

## 5. 内部事件协议

### 5.1 定义方式：数组即注册表

事件名收进两个 `as const` 数组，与 payload 映射类型互相 `satisfies` 校验；批量订阅/批量注册都从数组驱动（这是维护者点名的"类似 Python 装饰器的批量注册"在 TS 的落地）：

```ts
// src/backend/events.ts —— 类型映射（示意，非实现代码）
interface FtBEventMap { 'session.create': {...}; 'userMessage.send': {...}; /* … */ }
interface BtFEventMap { 'session.output': {...}; /* … */ }

const FTB_EVENT_NAMES = ['session.create', /* … */] as const
  satisfies readonly (keyof FtBEventMap)[];
const BTF_EVENT_NAMES = ['session.created', /* … */] as const
  satisfies readonly (keyof BtFEventMap)[];
```

```ts
// src/backend/eventBus.ts —— 总线接口（示意）
class EventBus {
  emitFtB<K extends keyof FtBEventMap>(name: K, payload: FtBEventMap[K]): void;
  onFtB<K extends keyof FtBEventMap>(name: K, h: (p: FtBEventMap[K]) => void): Disposable;
  emitBtF<K extends keyof BtFEventMap>(name: K, payload: BtFEventMap[K]): void;
  onBtF<K extends keyof BtFEventMap>(name: K, h: (p: BtFEventMap[K]) => void): Disposable;

  /** 后端一次性注册全部 FtB 处理器；mapped type 强制穷尽，漏一个编译报错 */
  registerBackendHandlers(handlers: { [K in keyof FtBEventMap]: (p: FtBEventMap[K]) => void }): Disposable;
  /** 适配器一行订阅全部 BtF 事件（遍历 BTF_EVENT_NAMES） */
  subscribeAllBtF(handler: (name: string, payload: unknown) => void): Disposable;
}
```

纪律：`registerBackendHandlers` **只允许 `AgentBackend` 调用一次**；`onBtF` 面向所有适配器。方向性由类型系统 + 单入口约定保证。

### 5.2 FtB 事件目录（前端 → 后端，仅后端订阅）

| 事件 | 载荷（`sessionId` 外） | 说明 |
|---|---|---|
| `session.create` | `requestId`, `agentType`, `name?`, `prompt?`, `allowedUris?`, `model?`+`provider?`, `rules?`, `skills?`, `mcpServers?` | **建会话唯一入口**（命令/dispatch 工具/将来 ACP 共用） |
| `session.open` | — | 一个前端开始展示该会话；后端物化会话并回 `session.state` 快照 |
| `session.close` | — | 前端不再展示（面板关闭）；后端照跑，与运行状态无关 |
| `session.focus` | — | 该会话成为"当前会话"（驱动上下文面板等） |
| `session.delete` | — | 删除文件 + 注册表 |
| `session.rename` | `name` | 改 metadata.name + 后端自动改文件名 |
| `session.setModel` | `model`, `provider` | 走 `resolveModelSelection` 门禁 |
| `session.setReasoningEffort` | `effort?` | 写入/删除 metadata 键 |
| `userMessage.send` | `text`, `mode?: 'queue' \| 'steer'` | 见 §6.3 语义 |
| `run.interrupt` | — | 硬停止当前 run；**清空该会话排队**；修尾落盘 |
| `history.truncate` | `fromIndex` | 删除该条及之后全部消息（级联删除）；运行中先打断；清空排队 |
| `history.pruneGhostBlocks` | — | 裁剪过期引用（ghost block 条目），逻辑收归后端 |
| `context.debug` | — | 从**最后一条消息**装配完整上下文（不再有"光标所在消息"概念） |
| `context.toggleRule` | `rule`, `active` | 元数据修改 → 落盘 → 广播 |
| `context.toggleSkill` | `skill`, `active` | 同上 |
| `context.setMcpTools` | `selection: McpToolSelection[]` | 同上 |
| `approval.respond` | `requestId`, `outcome: 'approve'\|'reject'\|'custom'`, `reason?`, `origin?` | 拒绝理由随载荷携带；`origin` 由适配器桥接时注入 |
| `settings.setAutoApprove` | `enabled` | 全局开关（写 VSCode 配置） |

### 5.3 BtF 事件目录（后端 → 前端，所有前端订阅）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `session.created` | `sessionId`, `requestId?`, `fileUri`, `metadata` | 调用方靠 `requestId` 对回执 |
| `session.deleted` | `sessionId` | |
| `session.state` | **快照**（见 §5.5） | 面板"水合" + 历史变更（truncate/prune）后的全量刷新 |
| `session.output` | `sessionId`, `renderData: RenderData` | 流式增量（渲染 IR 全量快照，前端增量协调 DOM） |
| `session.status` | `sessionId`, `status: 'idle'\|'running'`, `reason?: 'completed'\|'interrupted'\|'error'`, `queuedCount` | |
| `session.metadata` | `sessionId`, `metadata` | 标题/模型/effort/rules/skills/MCP 变更 |
| `session.userMessageCommitted` | `sessionId`, `text`, `historyIndex` | 一条用户消息**落进历史**（queue 开跑或 steer 注入时）。前端：封存当前流式区 → 追加用户气泡 → 开新流式区 |
| `session.error` | `sessionId`, `message`, `recoverable` | 通知微前端订阅它弹原生通知 |
| `approval.requested` | `sessionId`, `request: ApprovalRequestInfo` | 挂起直到某前端 respond |
| `approval.resolved` | `sessionId`, `requestId`, `outcome`, `reason?`, `origin?` | 其余前端立即撤下卡片 |
| `context.debugResult` | `sessionId`, `formatted` | `context.debug` 的回执 |
| `sessions.changed` | — | 会话树/列表变化，侧栏刷新 |
| `settings.autoApprove` | `enabled` | 全局开关回播 |

```ts
// ApprovalRequestInfo（示意）
{ id, sessionId, toolName, actionDescription, targetUri, details?,
  customAction?: { label: string; localOnly?: boolean }, autoApproved, timestamp }
```

### 5.4 请求-回执关联

事件是单向的；需要结果的操作由调用方生成 `requestId`，后端在完成事件中**原样回带**（`session.create` → `session.created.requestId`；`context.debug` → `context.debugResult`）。进程内调用者（dispatch 工具等）可以直接 await 后端方法的 Promise，事件回带主要服务跨进程前端。

### 5.5 快照（`session.state`）内容

一次性给足，前端无需二次询问：

```
{ sessionId, metadata,
  turns: Turn[],                    // 历史回放（committed-only RenderData）
  currentTurn: RenderData | null,   // 运行中的实时渲染 IR
  status, reason?, queuedCount,
  pendingApprovals: ApprovalRequestInfo[],
  availableModels: Record<string, string[]>,   // provider → models
  autoApproveEnabled: boolean,
  contextPanel: { rules: {name,active}[], skills: {name,active}[],
                  mcpServers: {...}[], contextItems: ContextItem[] } }
```

`Turn = { userText: string | null, messageIndex: number, renderData: RenderData }`；一个 turn = 一条 user 消息 + 其后 assistant/tool 消息组渲染出的 committed RenderData；没有前置 user 的孤儿 assistant/tool 消息也成 turn（`userText: null`）。`messageIndex` 是该 user 消息在扁平历史中的索引，供 `history.truncate` 使用。

**"水合"（hydration）的精确定义**：面板打开时 DOM 为空，而后端里会话可能已有完整历史、正在流式输出、挂着待审批。水合 = 后端把上述快照一次性发给空面板将其"灌满"，之后面板只收增量事件（`session.output` 等）。运行中的会话：快照里 `turns` 是已落盘历史，`currentTurn` 是当前轮的实时 RenderData，之后的 `session.output` 无缝续上。**不做逐事件回放，快照即可。**

---

## 6. 后端详设（`src/backend/`，全部新文件）

### 6.1 `agentBackend.ts` —— 单例门面

- 持有：`EventBus`、`AgentRegistry`、`ApprovalRequestManager`、`DispatchSessionManager`、`Map<uuid, BackendSession>`（物化缓存，**不淘汰**——内存占用与旧 notebook 持有全部 cell 相当，可接受）。
- 激活时调 `bus.registerBackendHandlers({...})`（mapped type 强制穷尽所有 FtB 事件）。
- 会话物化：`session.open`/任何针对某 sessionId 的 FtB 到达时，若内存无此会话 → `sessionStore.read` → 建 `BackendSession`。
- 文件删除监听（`.mtm` watcher）：注册表移除 + 广播 `session.deleted`。**后端是文件唯一写方**；运行中文件被外部改动不重新加载（内存为真相），文档化即可。

### 6.2 `backendSession.ts` —— 唯一 Session 实现（具体类，不是接口）

状态字段（即全部真相）：

```
sessionId (= metadata.uuid)
fileUri: Uri | null          // null = ephemeral（标题生成 / Lite 一次性运行）
metadata: AgentMetadata      // 内存即真相
history: AgentMessage[]      // 扁平消息数组，即 .mtm 的 context（不含 system，见 §14）
currentTurnRenderData        // 当前轮的渲染 IR
renderDataBuilder            // 当前轮的 RenderDataBuilder 实例
queue: { text, mode }[]      // 待处理用户消息
status: 'idle' | 'running'
currentAbort?: AbortController
```

公开方法（供 `AgentBackend` 的 FtB 处理器与 runner/工具调用）：

- `enqueueUserMessage(text, mode)`：入队 + 广播 `session.status(queuedCount)`；若 idle 则启动 drain。
- `interrupt()`：abort 当前 run；修尾（见下）；落盘；**清空队列**；广播 `session.status('idle', 'interrupted')`。
- `truncateFrom(index)`：运行中先 `interrupt()` → `history = history.slice(0, index)` → 修尾 → 落盘 → 清队 → 广播新 `session.state` 快照。
- `pruneGhostBlocks()` / `rename(name)` / `setModel(...)` / `setReasoningEffort(...)` / `toggleRule/Skill/setMcpTools(...)`：改 metadata 或 history → 落盘 → 广播 `session.metadata` / `session.state`。
- `appendMessage(msg)`：历史的唯一写口。追加 → 触发落盘写队列 → 必要时广播。**runner 不再维护私有副本、结束后 setHistory；每条消息产生即 append。**（运行中打开面板拿到的快照永远最新；崩溃恢复损失最小；steer 注入语义天然一致。）
- `requestApproval(...)` / `requestDispatch(...)`：薄委托给后端的 manager（工具经 `context.session` 调它们）。
- `drainSteering()`：**仅供 runner 在轮次边界调用**（见 §6.3）。
- `persist()`：经 `sessionStore` 的每会话写队列落盘（`fileUri = null` 时为空操作）。

内部函数（**不单独成模块**，§3.3）：`repairDanglingToolCalls()`——扫描尾部，凡 assistant 消息的 toolCalls 未配齐后续 tool 消息，合成 `[Interrupted]` 占位 tool 消息补齐（或截掉该 assistant）。打断/截断后调用。这是插话/截断正确性的地基。

### 6.3 运行语义：排队、插话、轮次边界注入

**drain 循环**（每会话一条 Promise 链，互斥）：

```
while queue 非空:
  msg = queue.shift()                       // idle 后 steer/queue 等价
  await executeTurn(msg.text)

executeTurn(text):
  userMsg = await assembleUserMessage(this, text)   // 见 §8.1
  appendMessage(userMsg)
  emit session.userMessageCommitted { text, historyIndex }
  persist()
  renderDataBuilder = new RenderDataBuilder()
  systemPrompt = assembleSystemPrompt(metadata)      // 纯函数自 metadata+工作区
  wireHistory = assembleWireHistory(this)            // 见 §8.1
  new AgentRunner(options, toolSet, this).run(abortController, { systemPrompt, wireHistory })
  // run 结束后：落盘、广播 session.status('idle', reason)
  // 首轮用户消息完成 → TitleGenerator（见 §6.6）
```

**steer 注入点**（在 runner 主循环内，见 §7.1）：每轮工具批次执行完毕、下一次 `streamGenerate` 之前：

```
steered = await session.drainSteering()        // 只取 mode='steer'，queue 消息留下
for text of steered:
  userMsg = await session.assembleUserMessage(text)
  session.appendMessage(userMsg)               // 追加在 tool result 之后
  emit session.userMessageCommitted
  session.persist()
  builder.commitTurnBoundary()                 // 封存当前轮，开新一轮
  messages.push(userMsg)                       // 进入下一次 LLM 调用的 history
```

- 注入点天然满足"插在 tool result 之后"。
- steer 消息在**流式中途**到达 → 等当前轮工具批次结束才注入；当前轮无工具调用（自然停止）→ 由 drain 循环按新 turn 处理。
- 等待审批期间到达的 steer 消息 → 等审批结算、工具批次完成后注入。
- queue 消息**永不**在 run 中途注入，只在自然停止后由 drain 循环取出。
- 打断（`run.interrupt`）与截断（`history.truncate`）都会**清空队列**。

### 6.4 `sessionStore.ts` —— .mtm 直读写（唯一文件写口）

- 读：`workspace.fs.readFile` → `JSON.parse` → `{ metadata, context }`；**读取时 `context = context.filter(m => m.role !== 'system')`**（旧文件兼容，见 §14）。
- 写：`JSON.stringify({ metadata, context }, null, 2)` → **直写目标文件**（truncate + write；崩溃时可能留下截断文件，读取侧按错误处理即可）→ **每会话一个 Promise 写队列**串行化，杜绝 runner 与 registry 并发写交叉。**禁止 tmp + rename 的"原子写"**：rename-over 在文件 watch 视角是 DELETE + CREATE——VS Code 会把"被删除"资源的 custom editor 直接关掉，且本扩展自己的 `.mtm` 删除 watcher 也会把会话当成外部删除处理（中断运行、广播 `session.deleted`）。
- **不存在** cell 投影：`messagesToGenericCells` / `genericCellsToMessages` / `GenericCellData` 概念整体删除。
- **不存在** WorkspaceEdit 双路径：文件开没开着都一样直写。

### 6.5 `agentRegistry.ts` —— 合并 `registry.ts` + `fileOps.ts`

- 会话注册表：uuid → `{ uuid, parentId, name, fileUri, status, isTaskFinished, childIds: Set, openClientCount, prompt? }`（原 `isWindowOpen` 改为 `openClientCount`，由 `session.open`/`session.close` 事件维护，面板和将来的 ACP 连接都算客户端）。
- **Agent 创建唯一入口** `createAgent({ agentType, name?, prompt?, allowedUris?, overrides?, parentId?, requestId? })`：
  1. `resolveAgentDefaults`（`src/config/resolver.ts`，**唯一默认值来源**）解析 rules/skills/model/MCP；
  2. 生成 uuid + `.mutsumi/<uuid>.mtm`，经 `sessionStore` 写文件（**prompt 不写入 context**：它保存在注册表项 `prompt` 字段上，由调用方（dispatch 审批通过 / session.create 处理）经 `enqueueUserMessage` 入队，从而恰好走一次 `assembleUserMessage` 装配管线——若创建时写入 context 再入队同一条 prompt，消息会被重复追加且跳过装配）；
  3. 注册；
  4. 广播 `session.created`（回带 `requestId`）；
  5. 返回 `BackendSession`（进程内调用者直接拿 Promise 结果）。
- 重命名（sanitize + 去重 + `workspace.fs.rename`）也在这里，由 `session.rename` 和标题生成触发——**不再依赖** `onDidSaveNotebookDocument` 钩子。
- 启动扫描 `.mutsumi/`（原 `scanAllAgents` 逻辑）+ UUID 冲突消毒（原 `sanitizeAgentFile` 逻辑）保留。

### 6.6 `approvalManager.ts` / `dispatchManager.ts` / `titleGenerator.ts` / `snapshot.ts`

- **`approvalManager.ts`**（`ApprovalRequestManager`，从 `tools.d/permission.ts` 迁入并事件化）：
  - `request(session, info)`：自动放行判定（全局 `mutsumi.autoApproveEnabled` + 预执行平面）→ 放行则留痕返回；否则广播 `approval.requested`、挂起 Promise 等 `approval.respond`（首个 respond 定案，广播 `approval.resolved`）。
  - 拒绝：`reason` 为空 → 调 `signalTermination(false)` 并返回 `[Rejected] ...`；非空 → `[Rejected with Reason] ...`。语义同旧 `handleRejectionFlow`，**但没有输入框**。
  - abort 时取消该会话的 pending 请求并返回 `[Cancelled] ...`（ACP 规范同样要求取消时以 cancelled 了结）。
  - 保留 pending 列表 + `onDidChangeRequests` 发射器供侧栏审批树订阅。
- **派发与跨会话通信（无 `dispatchManager.ts`；派发是工具内部逻辑）**：
  1. `dispatch_subagents` 工具：校验子类型 → `session.requestApproval`（**普通工具审批，先于创建**；尊重自动批准与预执行平面）→ 拒绝则不创建任何文件、工具立即返回（空理由终止会话 / 带理由反馈模型）；
  2. 批准 → 预生成全部子 UUID → 每个子 Agent `AgentRegistry.createAgent`（文件落盘，prompt 含身份块：自己/母/同事的 UUID）→ 各自立即后台开跑；
  3. 工具**立即 resolve**，返回全部子 Agent 的 UUID 清单；**不等待、无等待池、无聚合**——汇总由父 Agent 自己用模型能力做；
  4. 结果回收复用 steer：子 `task_finish` → 向父会话注入一条带发送者身份的 user 消息（运行中 → 轮次边界注入；停着 → 唤醒开新轮；已删除 → 丢弃）。子会话被删除 → 同样注入一条"已删除（取消）"通知；
  5. `task_finish` = 向母汇报 + 标记自己完成，**可多次调用**（用户可直接与子 Agent 对话并要求它再次汇报）；`communicate` 工具（免审批）= 任意两会话间投递：`{ target_session_id, message }`，与 `task_finish` 共享同一个投递原语；
  6. 子会话是一等会话：`session.created/status/output` 照常广播，任何前端可打开它的 .mtm 实时围观。
- **`titleGenerator.ts`**（沿用名字，去 notebook 化）：首轮用户消息完成后触发。内部建 **ephemeral `BackendSession`（`fileUri = null`）** + `createEmptyToolSet()` + `maxLoops: 1` 的 runner。ephemeral 会话照常发事件（无人订阅，零成本）。生成后走 `session.rename` 同一条路径（改 metadata → 改文件名 → 广播 `session.metadata` + `sessions.changed`）。
- **`snapshot.ts`**：历史 → §5.5 快照。原 `serializer.ts` 的 `buildInteractionRenderBlocks`（把一组 assistant/tool 消息渲染成 RenderBlock[]，含 pretty-print 与渲染配置查询）**迁移到这里**。这是快照构建中必须在宿主做的部分（依赖 ToolManager/MCP 注册表）。

---

## 7. Runner 与工具层手术

### 7.1 `src/agent/agentRunner.ts`

- 构造参 `session: IAgentSession` → `session: BackendSession`（具体类）。
- `run(abortController, { systemPrompt, wireHistory })`：system prompt 显式传入；删除"send-boundary 剥离 system 消息"逻辑（历史里不再有 system，见 §14）。
- 输出路径：`session.replaceOutput(JSON.stringify(renderData), { mimeType })` → `session.publishRenderData(renderData)`（**对象直传**，mimeType 约定删除；session 内部存 `currentTurnRenderData` 并广播 `session.output`）。
- 删除 `vscode.window.showErrorMessage` → 改广播 `session.error`（宿主里一个订阅该事件弹原生通知的"通知微前端"接住，见 §12）。
- 删除 `LiteAgentSession instanceof` 与 `'execution' in session` 探测：标题生成移出 runner，由 drain 循环在 run 结束后判断"首轮用户消息完成"触发 `TitleGenerator`。
- **新增轮次边界 steer 注入钩子**（§6.3）：`toolExecutor.executeTools` 返回后、下一轮 `streamGenerate` 之前调 `session.drainSteering()`。
- 取消检查从 `session.token.isCancellationRequested` 改为 `AbortSignal`。

### 7.2 `src/agent/uiRenderer.ts` → `renderDataBuilder.ts`

- 改名（§3.6），逻辑不动（三级锁、重试回滚快照保留）。
- **新增 `commitTurnBoundary()`**：把当前 committed + active 整体封存为上一轮终态，重置内部状态开始新一轮（steer 注入时调用）。
- 继续依赖 `ToolSet.getPrettyPrint` / `getRenderingConfig`（宿主能力，这正是它留在宿主的原因）。

### 7.3 `src/agent/toolExecutor.ts` 与 `src/agent/generateStream.ts`

- `toolExecutor.ts`：`ToolContext.session` 类型换成 `BackendSession`；其余不动。
- `generateStream.ts`：**不动**。

### 7.4 `src/tools.d/` 手术

- **`interface.ts`**：`ToolContext.session` 类型 = `BackendSession`；**删除** `notebook` / `execution` 两个 deprecated 字段（不是继续标 deprecated，是删）。
- **`permission.ts`：整个文件删除。**拆出 `PreExecutionManager`（`withPreExecution` / `isInPreExecution`）为独立小模块 `src/tools.d/preExecution.ts`（它与审批无关，是 templateEngine 的"用户预执行平面"标记；保持独立避免 contextManagement → backend 的反向依赖环）。审批实现迁入 `src/backend/approvalManager.ts`。
- 各工具的 `requestApproval(...)` 调用改为 `context.session.requestApproval(...)`。
- **`edit_file.ts` 瘦身**（事务机保留，§3.11）：
  - 删 `approvalManager` / `handleRejectionFlow` / `isAutoApproveEnabled` import，改走 `context.session.requestApproval`；
  - **删除请求时自动 `openDiff`**；diff 打开只发生在 `customAction` 被触发时；
  - 审批请求的 `customAction` 增加 `localOnly: true`（将来的 ACP 适配器不向远程客户端广告此项）；
  - **修复现存的脏缓冲区 bug**：`accept()` 目前读 `.temp-edit` **磁盘文件**，用户在 diff 里改了没按 Ctrl+S 就丢编辑。改为覆写前检查该临时 URI 是否有打开的脏文档，有则读文档缓冲区内容（或直接替用户保存该文档后再读盘）；
  - 事务机（`EditTransaction` / `TempFileHandler` / `DiffEditorController` / `EditService` / `cancelExistingTransaction` / abort-cleanup）**保留**——它是 edit 工具的领域逻辑，不进后端（后端不认识 DiffEditor，§3.11）。
- **`tools/agent_control.ts`**：`dispatch_subagents` → `context.session.requestDispatch(...)`；`task_finish` → `context.session` 委托的 `reportTaskFinished`；删除工具输出里 "Please run them manually" 的话术（子 Agent 批准后自动后台运行）。
- 其余工具、`toolManager.ts`、`cache.ts`、`toolSession.ts`、`shell/`：**不动**。

---

## 8. 上下文管理系统（`src/contextManagement/`）手术

架构不变（维护者明确要求兼容），只有两处变动：

### 8.1 `history.ts` 拆分

原 `buildInteractionHistory` 大一统函数拆成两个纯职能：

1. **`assembleUserMessage(session, text)`**：模板引擎渲染（`@引用`→ghost block、宏、`@[tool{}]` 预执行）、`parseUserMessageWithImages`、更新 `metadata.contextItems`（哈希/版本差分）、把 ghost block 挂到该 user 消息的 `metadata.last_ghost_block`。返回一条**可持久化**的 user `AgentMessage`。
2. **`assembleWireHistory(session)`**（每次 run 启动时调用一次）：组装 system prompt（角色宏 + rules + skills，纯函数自 metadata + 工作区）+ 把历史投影为线协议形态（每条历史 user 消息附加其持久化 ghost markdown、解析图片链接为 image_url 分片）。

**这是合理的投影**（持久化形态 → 线协议形态），不是兼容层。中间产物（轮次边界 steer 注入时）只对**新注入的那条** user 消息做 `assembleUserMessage`，不重放全量。

### 8.2 其他

- `imagePasteProvider.ts`：**删除**（图片能力在 WebView 输入区重做，见 §10.6）。
- `ghostBlocks.ts` / `templateEngine.ts` / `prompts.ts` / `skillManager.ts` / `utils.ts`：不动（import 路径随签名调整）。
- `config/`、`registry/`、`mcp/`、`codebase/`（含 RAG）：**完全不动**。

---

## 9. 适配器框架（`src/frontend/`，新）

### 9.1 粒度裁决：单例 host + 内部 per-panel/per-session controller

- **注册进框架的是单例 host**：CustomEditorProvider 注册、HTTP 端口、进程资源在物理上只能单例。
- **host 内部按面板 spawn 轻量 controller**（不进注册表、无传输资源）：闭包直接持有 `panel` 与 `sessionId`，订阅总线时按 sessionId 过滤——"一个实例一个会话、靠 UUID 过滤"的心智保留在 controller 层。
- 总线永远是**单一全局通道**，路由靠 payload 里的 `sessionId`，不搞 per-session channel。

### 9.2 接口

```ts
// src/frontend/adapter.ts（示意）
interface IFrontendAdapter {
  readonly id: string;                              // 'webview' | 'lite' | 'acp'
  readonly capabilities: { interactive: boolean };
  activate(ctx: AdapterContext): void | Promise<void>;
  dispose(): void;
}
// AdapterContext: { bus, backend, extensionContext }

// src/frontend/registry.ts —— 依赖注入容器（就这几个方法，不要过度设计）
class AdapterRegistry {
  register(adapter: IFrontendAdapter): void;
  disposeAll(): void;
}
```

`AgentBackend` 在 `activate` 时 ready；各适配器 `activate(ctx)` 后一行 `ctx.bus.subscribeAllBtF((name, payload) => this.route(name, payload))` 完成全量订阅。

---

## 10. WebView 前端（`src/frontends/webview/`，P1 主体）

### 10.1 载体：Custom Editor，不是 Notebook

- `package.json` 用 **`customEditors`** 贡献点 `{ viewType: 'mutsumi.chat', selector: [{ filenamePattern: '*.mtm' }] }` **替换** `notebooks` + `notebookRenderer` 贡献点。
- `webviewAdapter.ts`（host 单例）实现 `vscode.window.registerCustomEditorProvider('mutsumi.chat', provider)`，provider 为 `CustomReadonlyEditorProvider`：`openCustomDocument(uri)` 只返回 `{ uri, dispose(){} }`——**VSCode 不管理文档模型，没有脏缓冲区概念**；`resolveCustomEditor(document, webviewPanel)` 里建 `panelController`。
- 一个会话可挂多个面板（split）；状态在后端，面板只是观察窗。**关窗不杀会话**；重开靠 `session.state` 水合。

### 10.2 IPC：acquireVsCodeApi / postMessage 双向桥

`panelController.ts`（每面板一个）是进程间通信的唯一关口：

- **WebView → 宿主（FtB 方向）**：webview 脚本里 `const vscode = acquireVsCodeApi()`（**只调用一次**并缓存句柄），发 `vscode.postMessage({ kind: 'ftb', name, payload })`；宿主侧 `webviewPanel.webview.onDidReceiveMessage` 收到后 → `bus.emitFtB(name, { ...payload, origin: 'webview' })`（origin 由 controller 注入，不是脚本自报）。
- **宿主 → WebView（BtF 方向）**：controller 用 `bus.subscribeAllBtF` + sessionId 谓词过滤 → `webviewPanel.webview.postMessage({ kind: 'btf', name, payload })`；webview 脚本 `window.addEventListener('message', ...)` 接收。
- **适配器本地 RPC**（不进总线）：图片上传等纯传输需求用 `{ kind: 'rpc', id, method, args }` / `{ kind: 'rpc-result', id, result }` 信封，只在 panel ↔ 它的 controller 之间。**总线事件只承载会话/领域状态；传输特有的需求留在适配器内部。**
- 面板 dispose → `bus.emitFtB('session.close')`；`onDidChangeViewState` 激活 → `session.focus`；`resolveCustomEditor` → `session.open`（后端回快照）。
- webview 脚本崩了/重载：重新 `session.open` 拿快照即可，无状态恢复问题（不用 `getState/setState`）。
- HTML 生成时注入：CSP（`script-src 'nonce-…'`，`img-src` 允许 webview 资源）、`dist/webview.js` 经 `webview.asWebviewUri` 引用、`localResourceRoots` 含 `dist/` 与图片临时目录、初始 `sessionId` 与宿主侧 `t()` 翻译好的静态文案。

### 10.3 渲染核心复用（必须无损迁移）

从 `src/notebook/renderer.ts` + `css.ts` 迁入 webview bundle（`ui/render/`）：

- `renderMarkdown`（micromark + GFM，`allowDangerousHtml`）、lowlight 全语法高亮（含别名注册）、`renderBlock`（content/reasoning/toolCall 三种块）、`reconcileActive`（指纹前缀对齐的增量 DOM 协调）、`salvagePreElements`/`salvageActivePreElements`（`<pre>` 打捞，保住已完成的高亮）、`inheritDetailsOpenState`（保住用户开合的 details）、`RENDERER_CSS`、复制代码按钮逻辑。
- **删除的只是文件尾部的 notebook renderer 入口壳**（`activate()` 返回 `renderOutputItem` 那层）。
- `RenderData` / `RenderBlock` 类型定义移到共享位置（如 `src/shared/renderTypes.ts`），宿主与 webview 两处 import——注意 webview bundle 只能 import 纯类型，不能 import 宿主模块。

### 10.4 布局（Kimi 网页对话式）

自上而下：

1. **消息流**（滚动区）：
   - **用户消息 = 右对齐气泡**：静态渲染 Markdown（含图片），发出即定稿，无实时渲染需求。
   - **Agent 消息 = 全窗口宽度**（左右留 padding）：用迁移来的渲染核心**逐 token 实时渲染**（committed 块 DOM 缓存、active 区增量协调）。
   - **没有 Cell 概念**，消息不可编辑。
2. **每条消息下方的菜单条**（悬停/常驻，用户消息与 Agent 消息菜单项不同）。
3. **输入区**（底端固定）：
   - **排队条**：显示已发送但未提交的消息（queue 中等待的 steer/queue 消息文本）。
   - **工具栏**（见 §10.5）。
   - **附件预览条**：多模态图片缩略图。
   - **输入框**：多行；**Markdown 仅语法高亮、不渲染**（不做所见即所得；经典做法：透明 textarea 叠在高亮 pre 上）；Enter 发送 / Shift+Enter 换行；运行中发送 = 按所选 mode 入队；打断按钮（`run.interrupt`）。

### 10.5 两个可扩展注册表

- **`ui/menus.ts` —— 消息菜单注册表**：`{ id, when: 'user' | 'agent', label, icon?, run(ctx) }`。首批：
  - 用户气泡：**复制**（复制该条文本）、**重试**（FtB `history.truncate(fromIndex=该条)` 然后 `userMessage.send(该条文本)`）、**撤回**（`history.truncate` + 把该条文本填回输入框，不发送）。
  - Agent 消息：**复制**（复制该轮 Markdown）、**继续**（`userMessage.send('继续')`）。
  - 加菜单项 = 加一条注册。
- **`ui/toolbar.ts` —— 工具栏注册表**：`{ id, label, icon?, run(ctx) }`。首批：插入图片、选模型、思考强度、重命名会话、裁剪过期引用、调试上下文、自动批准开关。**为将来的压缩按钮留位**（加按钮 = 加一条注册 + 一个 FtB 事件）。
- 工具栏右侧：**可临时展开的上下文面板**（原 ContextTree 的功能：contextItems/rules/skills/MCP 工具的查看与开关）。数据全部来自快照 + `session.metadata` 增量；操作发 FtB `context.*` 事件。

### 10.6 图片链路

- 输入：粘贴/拖入/工具栏"插入图片" → webview 把字节经**适配器本地 RPC** 发给宿主 → 宿主写临时目录（沿用旧 `imagePasteProvider` 的落盘逻辑：`os.tmpdir()/mutsumi_images`，搬进 webviewAdapter）→ 返回文件 URI → 输入框插入 `![image](file://…)` + 附件预览条显示缩略图。
- 发送时：`parseUserMessageWithImages`（现有逻辑，不动）把链接变 image_url 分片。
- 渲染历史中的图片：渲染器遇到 `file://` 的 img src → 懒请求宿主经 RPC 换成 webview URI（带缓存）。

### 10.7 其他 UI 行为

- **不乐观渲染**：发送后消息进排队条；收到 `session.userMessageCommitted` 才转正为气泡（事件在进程内往返，实际延迟可忽略；保证多面板一致性零去重逻辑）。
- **审批卡片**：`approval.requested` 在对应会话消息流里内联渲染（批准 / 拒绝+理由输入 / custom action 按钮）；`approval.resolved` 撤下。**未打开面板的会话（如后台子 Agent）的审批落在侧栏审批树**——同一个事件，处处可达。
- **dispatch 审批卡片**：展示子 Agent 清单（prompt/agentType），批准/拒绝。
- **选模型**：webview 原生下拉（数据来自快照 `availableModels`）→ `session.setModel`；思考强度同理（值域 `REASONING_EFFORT_SETTING_VALUES`）。
- **调试上下文**：`context.debug` → 后端从**最后一条消息**装配 → `context.debugResult` → webview 弹层展示。
- **重命名**：工具栏按钮 → 内联输入 → `session.rename`。

---

## 11. Lite 适配器（`src/frontends/lite/liteAdapter.ts`）

- 无 UI、**无工具**（`createEmptyToolSet()`）、不可交互。
- 程序化入口 `runOnce(prompt, opts): Promise<string>`：建 ephemeral 会话（`fileUri = null`）→ 入队一条消息 → 订阅自己会话的 `session.output`/`session.status` 收敛最终文本 → 完成时 resolve。
- **自动应答自己会话的审批**（反正没工具可批，策略默认 approve）。
- 用途：外部脚本/命令的"发一条取结果"、后端冒烟测试驱动器。
- `TitleGenerator` **不走** Lite 适配器——它直接用后端内部 ephemeral 能力。Lite 是前端，不是后端工具。

---

## 12. 侧栏、命令与通知

### 12.1 侧栏（`src/sidebar/`）

- **保留并改订后端事件**：agent 树（从 backend `AgentRegistry` 取数 + 订 `sessions.changed`；双击/按钮 → `vscode.openWith(uri, 'mutsumi.chat')`）、审批树（订后端 `ApprovalRequestManager.onDidChangeRequests`；按钮发 FtB `approval.respond`/`dispatch.respond`，custom 按钮 `outcome: 'custom'`）、shell 任务树（与 notebook 无关，不动）。
- **删除**：`contextTreeProvider.ts` / `contextTreeItem.ts`（功能迁入 WebView 上下文面板），以及 `package.json` 里 `mutsumi.contextSidebar` 的 view 贡献。

### 12.2 命令

- **保留并重接**：`mutsumi.newAgent`（原生 QuickPick 选 agentType 保留——创建时还没有任何 UI 载体；但内部发 `session.create`，等 `session.created` 回执后 `openWith` 打开 WebView）、`mutsumi.openAgentFile`、审批三命令（`approveRequest`/`rejectRequest`/`customRequestAction`，改发 FtB）、shell 任务三命令、`copyReference`、`clearToolCache`、`testRagSearch`。
- **删除**（功能进 WebView 工具栏/上下文面板，不再注册 VSCode 命令、不再申请 notebook toolbar）：`selectModel`、`renameSession`、`debugContext`、`pruneGhostBlocks`、`compressConversation`（功能整体删除）、`toggleAutoApprove`/`toggleAutoApproveOn`、`viewContextItem`、`toggleRule`、`toggleSkill`、`toggleMcpTool`、`toggleMcpServer`、`refreshContextTree`、`removeMacro`、`removeFile`、`generateHttpServerPassword`（httpServer 消亡）。

### 12.3 通知微前端

`extension.ts` 里一个小订阅：`bus.onBtF('session.error', …)` → `vscode.window.showErrorMessage`（带"复制详情"按钮，沿用现文案）；`approval.requested` → `notifyApprovalNeeded`（node-notifier OS 通知，现有逻辑保留）。**这是唯一允许出现在后端的 vscode.window 使用点——它在前端层（extension.ts 装配层），不在 backend/。**

---

## 13. 命名规范（本项目惯例）

- 领域词汇：**Registry / Manager / Generator / Provider / Adapter / Controller / Operations**。
- **禁止 `xxxService` 套路命名**（`EditService` 是遗留，本轮顺手改为 `EditTransactionManager` 或保留类名但文件内注释说明；优先改成前者）。
- 新模块命名对照：`agentRegistry.ts`（AgentRegistry）、`approvalManager.ts`（ApprovalRequestManager）、`dispatchManager.ts`（DispatchSessionManager）、`titleGenerator.ts`（TitleGenerator）、`sessionStore.ts`、`snapshot.ts`、`backendSession.ts`（BackendSession）、`agentBackend.ts`（AgentBackend）、`eventBus.ts`（EventBus）、`renderDataBuilder.ts`（RenderDataBuilder）。

---

## 14. .mtm 格式、迁移与压缩回归挂钩

- **格式不变**：`{ metadata, context }`，`mtm_version = 2`。旧文件零迁移可读。
- **一个行为变更**：system prompt 不再写入 `context`（它是 metadata + 工作区状态的纯函数，入盘只会过期）。`sessionStore` 读取时 `context.filter(m => m.role !== 'system')` 一行兼容旧文件。
- ghost block 继续挂在 user 消息的 `metadata.last_ghost_block`（与现格式逐字节兼容；删消息即删 ghost，索引对齐问题自动消失）。
- **压缩回归挂钩**（本轮不实现）：`mtm_version` 升 3，metadata 加稀疏映射表 `{ [index: number]: AgentMessage }`（语义：线协议发送时 context 第 index 条之前的消息被该条替换），应用点只有一个——`assembleWireHistory`；同时清空 `metadata.contextItems` 的文件哈希。届时 = 加一个 FtB 事件 + 一个工具栏注册项 + 该投影逻辑，不动主路。

---

## 15. 构建与 package.json 变更

- `package.json`：删 `notebooks`、`notebookRenderer` 贡献点与 `notebook/toolbar` 菜单；加 `customEditors`；删 §12.2 列出的命令与 `mutsumi.contextSidebar` view；`activationEvents` 相应调整（customEditors 贡献点自动生成激活事件）。
- `esbuild.js`：删 renderer bundle 入口（`src/notebook/renderer.ts` → `dist/notebookRenderer.js`），加 webview bundle 入口（`src/frontends/webview/ui/main.ts` → `dist/webview.js`，platform browser，format esm）。扩展宿主 bundle（`src/extension.ts` → `dist/extension.js`）不变。
- `tsconfig.renderer.json` 改为覆盖 webview UI 源码目录。

---

## 16. 删除 / 改造 / 保留总清单

### 16.1 删除（无替代或被吞并）

| 删除项 | 原因 |
|---|---|
| `src/adapters/` 全部（`IAgentSession`/`IAgentAdapter`/`NotebookAdapter`/`HeadlessAdapter`/`LiteAdapter`/`AgentSessionConfig`） | 抽象失效（§2.5、§3.2） |
| `src/notebook/serializer.ts` | cell 投影层消灭；`buildInteractionRenderBlocks` 迁 `snapshot.ts`；`createDefaultContent` 并入 `AgentRegistry` |
| `src/notebook/completionProvider.ts`、`toolbar.ts`、`commands/` 全部 | notebook 体系附属；功能进 WebView |
| `src/notebook/renderer.ts` 的入口壳 | 渲染核心迁 webview bundle |
| `src/controller.ts` | NotebookController 消亡 |
| `src/agent/agentOrchestrator.ts`、`registry.ts`、`fileOps.ts`、`treeUtils.ts`、`dispatch.ts` | 职责被 backend 各模块分食 |
| `src/httpServer/` 全部 | 被将来的 ACP 适配器取代（本轮无 HTTP 前端） |
| `src/tools.d/permission.ts` | 审批收归后端；PreExecution 拆出独立小模块 |
| `src/contextManagement/imagePasteProvider.ts` | 图片能力在 WebView 重做 |
| `src/sidebar/contextTreeProvider.ts` / `contextTreeItem.ts` | 功能迁入 WebView 上下文面板 |

### 16.2 改造后保留

`agentRunner.ts`（§7.1）、`renderDataBuilder.ts`（§7.2）、`toolExecutor.ts`（§7.3）、`titleGenerator.ts`（迁 backend）、`history.ts`（§8.1）、`tools.d/interface.ts` + `edit_file.ts` + `tools/agent_control.ts`（§7.4）、`sidebar/` 三树（§12.1）、`extension.ts`（重写装配）、`types.ts`（`AgentMetadata` 不动；`AgentStateInfo` 调整后端化：`isWindowOpen` → `openClientCount`）。

### 16.3 原样保留

`generateStream.ts`、`contextManagement/` 其余、`config/`、`registry/`、`tools.d/` 其余、`mcp/`、`codebase/`（RAG）、`utils.ts`（模型门禁）、`debugLogger.ts`、`notifications.ts`、`i18n.ts`。

---

## 17. 行为语义契约（逐场景，实现的验收口径）

| 场景 | 契约 |
|---|---|
| idle 时发送 | 立即 `assembleUserMessage` → `appendMessage` → `userMessageCommitted` → 开跑 |
| running 时发送（queue） | 入队，排队条可见；自然停止后依次处理 |
| running 时发送（steer） | 入队；**下一轮次边界**（工具批次结束、下次 LLM 调用前）注入到 tool result 之后；若本轮自然停止则按 queue 处理 |
| `run.interrupt` | abort → 修尾 → 落盘 → 清空队列 → **级联打断所有已物化后代会话** → `session.status('idle','interrupted')` |
| `history.truncate(i)` | 运行中先 interrupt → 截到 i 之前 → 修尾 → 落盘 → 清队 → 广播新 `session.state` |
| 重试（用户消息菜单） | truncate(该条索引) + userMessage.send(该条文本) |
| 撤回（用户消息菜单） | truncate + 文本填回输入框（不发送） |
| 继续（Agent 消息菜单） | `userMessage.send('继续')` |
| 关闭面板 | `session.close`；后端照跑；重开 `session.open` → 快照水合 |
| 子 Agent 派发 | 工具审批（先于创建）→ 批准才建文件并后台开跑 → 工具立即返回 UUID 清单；子 `task_finish`/被删除 → steer 通知父会话 |
| 跨会话通信 | `communicate`（免审批）：目标运行中 → 轮次边界注入；停着 → 唤醒开新轮；已删除 → 调用方收到错误 |
| 工具审批 | `approval.requested` 广播 → 任一前端首个 `approval.respond` 定案 → `approval.resolved` 广播 → 事务/工具继续 |
| edit/write 审批 | 默认不弹 diff；custom action 打开 diff；结算时事务自闭环（关窗、清理、覆写、反馈 diff） |
| 改名/模型/effort/rules/skills/MCP | FtB → 改 metadata → 落盘 → `session.metadata` 广播 |
| 标题 | 首轮用户消息完成后 ephemeral 生成 → 走 rename 路径 |
| 后台运行 | 会话运行不依赖任何面板存在；`session.output` 无人订阅也无害 |
| 同一会话多前端 | 全部收同一 BtF 广播；任何一端的操作经 FtB→后端→BtF 广播，其余端立即一致（§3.12） |

---

## 18. 实施计划

### P0：后端 + Lite 适配器 + 旧代码清除

施工顺序（依赖先行）：

1. `src/backend/events.ts`、`eventBus.ts`
2. `src/backend/sessionStore.ts`
3. `src/backend/agentRegistry.ts`（合并 registry+fileOps，删 WorkspaceEdit 双路径）
4. `src/backend/backendSession.ts`（历史权威、append/persist、truncate+修尾、队列、drainSteering、drain 循环）
5. `src/tools.d/preExecution.ts`（从 permission.ts 拆出）；`src/backend/approvalManager.ts`
6. `src/backend/dispatchManager.ts`、`titleGenerator.ts`、`snapshot.ts`
7. `src/contextManagement/history.ts` 拆分（`assembleUserMessage` / `assembleWireHistory` / `assembleSystemPrompt`）
8. `src/agent/` 手术：`agentRunner.ts`、`renderDataBuilder.ts`（改名）、`toolExecutor.ts`、`interfaces.ts` 清理
9. `src/tools.d/` 手术：`interface.ts`、`edit_file.ts`、`tools/agent_control.ts`；删 `permission.ts`
10. `src/frontend/`（adapter.ts、registry.ts）+ `src/frontends/lite/liteAdapter.ts`
11. `extension.ts` 重写装配；删 §16.1 全部；侧栏三树重接
12. `package.json` / `esbuild.js` 变更
13. **验收**：`pnpm run check-types` 通过；旧 Notebook 痕迹清零（全仓搜不到 `NotebookSerializer`/`NotebookController`/`IAgentSession`/`HeadlessAdapter`）；Lite `runOnce` 端到端跑通一个真实 prompt。

### P1：WebView 前端

1. esbuild webview bundle + `tsconfig.renderer.json` 调整
2. 渲染核心迁移（`ui/render/`）
3. `webviewAdapter.ts` + `panelController.ts` + IPC 信封
4. UI 组件：消息流/用户气泡/Agent 全宽轮次、输入框（高亮不渲染）、排队条、附件预览条、审批卡片、dispatch 审批卡片
5. `menus.ts` / `toolbar.ts` 注册表 + 首批项（§10.5）
6. 上下文面板
7. 图片链路（RPC 上传、预览、历史图片懒解析）
8. **验收**：新建议程→发消息→流式渲染→工具审批（WebView 卡片与侧栏双通道）→steer/queue→interrupt→truncate/重试/撤回/继续→改名/选模型/思考强度/裁剪引用/调试上下文/自动批准→关窗重开状态无损→子 Agent 派发审批与后台运行→同会话双面板一致性。

### ACP（本轮不实现）

扩展位已留好：`IFrontendAdapter` + BtF 全量广播 + `requestId` 回执关联。届时只做一件事：把 FtB/BtF 投影成 ACP JSON-RPC（`@zed-industries/agent-client-protocol`，Agent 角色：`session/new`↔`session.create`、`session/prompt`↔`userMessage.send`+run 完成回执、`session/cancel`↔`run.interrupt`、BtF `session.output`→`session/update` chunk 投影、`approval.requested`↔`session/request_permission`）。传输形态按届时 Zed/Paseo 等真实客户端的接法定。

---

## 19. 已拍板小决策汇总

1. 用户气泡右对齐、Agent 消息全宽（Kimi 网页式）。
2. `newAgent` 保留命令 + 原生 QuickPick，内部走新后端事件。
3. 会话在内存中不淘汰。
4. 撤回/重试/打断均清空该会话排队；打断级联到所有已物化后代会话（紧急制动）；删除会话不级联（删除是管理操作）。
5. 派发审批先于创建（拒绝即不创建任何文件）；批准后工具立即返回（不等子 Agent），结果经 task_finish/删除通知以 steer 消息回报父会话。
6. 水合用快照，不做逐事件回放。
7. edit/write 默认不弹 DiffEditor，按钮触发；`customAction.localOnly` 标记本地专属动作。
8. 无"无交互前端审批策略"——侧栏审批树是常驻兜底前端；Lite 自动应答自己的会话。
9. ACP 本轮不实现；传输形态届时按真实客户端定。
10. 压缩功能本轮整体删除，仅留 §14 的回归挂钩。
11. 跨会话消息不区分"怎么停下来的"：停着的会话收到消息一律唤醒；紧急制动丢弃的是刹车时在队列里的通知。
12. 子 Agent 可多次 task_finish 汇报（用户可直接与子 Agent 对话并要求再报一次）。

---

## 20. 术语表

- **FtB / BtF**：Frontend→Backend / Backend→Frontend 事件方向。
- **水合（hydration）**：前端从空状态被后端一次性快照灌满的过程。
- **快照（snapshot）**：`session.state` 事件的载荷，会话全量可渲染状态。
- **RenderData / RenderBlock**：宿主构建、前端渲染的流式渲染中间表示（IR）。
- **轮次（round）**：一次 LLM 流式生成 + 其后的一批工具执行。
- **轮次边界**：工具批次结果落齐、下一次 LLM 调用之前的注入点。
- **turn**：一条 user 消息 + 其后 assistant/tool 消息组构成的对话单元。
- **ghost block**：用户消息附带的上下文引用快照，持久化在 user 消息的 `metadata.last_ghost_block`。
- **ephemeral 会话**：`fileUri = null` 的 BackendSession，不落盘（标题生成、Lite 一次性运行）。
