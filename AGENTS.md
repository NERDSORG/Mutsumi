# Mutsumi 项目开发指南（Agent 贡献者版）

> 本文件面向参与 Mutsumi 开发的 AI 编码 Agent，介绍各模块职责、模块间的接线方式，以及非平凡/反直觉的设计约束。
> Mutsumi（若叶睦）是一款 VS Code 多 Agent 对话环境插件：Agent 会话以 `.mtm`（JSON）文件持久化，经 Custom Editor + WebView 呈现。全部会话状态的唯一权威是 `src/backend/` 的 AgentBackend；前端（WebView / Lite / 将来的 ACP）只经 FtB/BtF 事件与后端通信。

---

## 1. 架构总览

```
src/
├── backend/           # 后端（唯一状态权威，零 UI 依赖）
│   ├── agentBackend.ts    # 单例门面：注册全部 FtB 处理器、物化会话缓存
│   ├── backendSession.ts  # 唯一 Session 实现（metadata+history+队列+RenderData+abort）
│   ├── sessionStore.ts    # .mtm 直读写（每文件写队列），唯一文件写口
│   ├── agentRegistry.ts   # 会话注册表 + 创建/重命名/删除/冲突消毒
│   ├── approvalManager.ts # 审批权威（ApprovalRequestManager，事件化）
│   ├── dispatchManager.ts # 子 Agent 派发协调（DispatchSessionManager）
│   ├── titleGenerator.ts  # 首轮完成后生成标题（ephemeral 会话）
│   ├── snapshot.ts        # 历史 → session.state 快照（水合）
│   ├── events.ts          # FtB/BtF 事件协议（payload 映射 + 名字注册表，satisfies 校验穷尽）
│   ├── interfaces.ts      # 模块纯契约：registry/session/approval/dispatch 接口
│   └── eventBus.ts        # 进程内类型化总线，方向分离
├── agent/             # 每次 run 的执行件：agentRunner / generateStream / renderDataBuilder / toolExecutor
├── frontend/          # 适配器框架（IFrontendAdapter + AdapterRegistry，DI 容器）
├── frontends/
│   ├── webview/       # WebView 宿主：webviewAdapter（单例）+ panelController（每面板）+ ui/（浏览器 bundle）
│   └── lite/          # Lite 适配器：runOnce 一次性程序化运行，自动应答自己审批
├── contextManagement/ # 上下文装配：history.ts、ghostBlocks、templateEngine、prompts、skillManager
├── tools.d/           # 工具系统：toolManager、interface、edit_file（编辑事务）、tools/、preExecution
├── config/ + registry/ # Agent 分角色系统（配置加载/校验/解析）
├── mcp/               # MCP 宿主
├── codebase/          # 代码库服务与 RAG
├── sidebar/           # 三个 TreeView：agent / approval / shellTask
└── types.ts / utils.ts / i18n.ts / extension.ts
```

### 核心分层原则

1. **后端零 UI 依赖**：`src/backend/` 与 `src/agent/` 不 import 任何 `vscode.window` / Notebook API / Webview 类型。允许的 VSCode API 仅 `workspace.fs`、`EventEmitter`、`Uri`、配置读写等纯数据面。唯一例外的 vscode.window 使用点在装配层（extension.ts 的通知微前端）。
2. **一切跨层通信都是事件**：前端→后端只有 FtB（意图），后端→前端只有 BtF（事实）。前端永不监听 FtB；任何改变后端状态的 FtB，后端必须广播对应 BtF 事实。
3. **每个事件携带 `sessionId`**（真正的全局事件除外：`sessions.changed`、`settings.autoApprove`）。
4. **URI 优先**：文件操作使用 `vscode.Uri`；Mutsumi 自身数据（`.mutsumi/`）固定在工作区列表 `[0]`。
5. **装配点唯一**：`extension.ts` 是唯一激活/装配入口。

---

## 2. 后端（`src/backend/`）

### 2.1 事件协议（events.ts + eventBus.ts）

- 事件协议自含在 `events.ts`：payload 映射（`FtBEventMap` / `BtFEventMap`）+ 名字注册表（`FTB_EVENT_NAMES` / `BTF_EVENT_NAMES` 两个 `as const` 数组）互相 `satisfies` 校验；新增事件 = 加映射条目 + 加数组条目，漏一个编译报错。
- `bus.registerBackendHandlers(handlers)` 由 AgentBackend 调用一次，mapped type 强制穷尽所有 FtB 处理器。
- 适配器用 `bus.subscribeAllBtF((name, payload) => ...)` 一行订阅全部 BtF，按 payload.sessionId 过滤路由。
- 请求-回执关联：调用方生成 `requestId`，后端在完成事件中原样回带（`session.create` → `session.created.requestId`）。进程内调用者可直接 await 后端方法。

### 2.2 BackendSession —— 唯一 Session 实现

状态即全部真相：`sessionId`、`fileUri`（null = ephemeral）、`metadata`、`history`（扁平消息数组）、`currentTurnRenderData`、`renderDataBuilder`、`queue`、`status`、`currentAbort`。

关键契约：

- **`appendMessage` 是历史的唯一写口**：每条消息产生即追加并触发写队列落盘。
- **运行语义**（排队/插话/轮次边界注入）：
  - drain 循环每会话一条 Promise 链，互斥；idle 后 steer/queue 等价。
  - **steer（插话）**：runner 在每轮工具批次结束、下一次 LLM 调用前调 `session.drainSteering()`，把 steer 消息插在 tool result 之后注入；不打断当前输出。
  - **queue（排队）**：仅在自然停止后由 drain 循环取出；以工具调用告终的轮次不算自然停止。
  - `run.interrupt` 与 `history.truncate` 都会清空队列；打断/截断后 `repairDanglingToolCalls()` 合成 `[Interrupted]` 占位 tool 消息修尾。
- `fileUri = null` 的 **ephemeral 会话**（标题生成 / Lite runOnce / 预执行平面）照常发事件（零成本）、不落盘、不进注册表。
- 工具经 `context.session` 调审批/派发：`requestApproval`（简单工具，返回 `null | 拒绝串`）、`requestApprovalWithAction`（edit 事务，带 customAction/onApprove）、`requestDispatch`、`reportTaskFinished`。空理由拒绝 → `terminationHook` 终止会话（ToolExecutor 每批次注册该 hook）。

### 2.3 sessionStore —— .mtm 直读写（唯一文件写口）

- 读：过滤掉文件中的 system 消息（system prompt 是 metadata + 工作区状态的纯函数，从不入盘；过滤只为兼容更早版本写入的文件）。
- 写：直写目标文件（truncate + write）；每文件一个 Promise 写队列串行化。不用 tmp + rename：rename-over 在 watch 视角是 DELETE + CREATE，会导致 VS Code 关闭 custom editor 并误触本扩展自己的 `.mtm` 删除 watcher。
- 文件开没开着都一样直写。后端是文件唯一写方；运行中文件被外部改动不重新加载（内存为真相）。

### 2.4 AgentRegistry

- **Agent 创建唯一入口** `createAgent(...)`：`resolveAgentDefaults` 解析默认 → 写文件 → 注册 → 广播 `session.created` → 返回物化 BackendSession。prompt 不写入 context，保存在注册表项上由调用方入队（保证恰好装配一次）。
- 重命名（sanitize + 去重 + `fs.rename`）也在这里，由 `session.rename` 与标题生成共用。
- 启动 `scanAllAgents` 扫描 `.mutsumi/`；UUID 冲突（如复制文件）用 `sanitizeAgentFile` 消毒。
- `openClientCount` 由 `session.open`/`session.close` 维护；侧栏 agent 树展示"至少一个 agent 被前端展示（openClientCount > 0）或正在后端运行（isRunning）"的整棵树。

### 2.5 审批 / 派发 / 标题 / 快照

- **ApprovalRequestManager**：自动放行（全局开关 + 预执行平面）→ 留痕；否则广播 `approval.requested` 挂起，首个 `approval.respond` 定案并广播 `approval.resolved`（其余前端立即撤卡）。拒绝理由随 respond 载荷携带。`onDidChangeRequests` 供侧栏审批树订阅。
- **DispatchSessionManager**：子 Agent 文件立即落盘 → 广播 `dispatch.requested` → approve 则后端直接后台开跑，reject 则删除子会话文件；子 `task_finish` → 聚合报告 → resolve 父的挂起 Promise。
- **TitleGenerator**：首轮用户消息完成后 ephemeral 单轮 runner 生成标题，走 `session.rename` 同一路径。
- **snapshot.ts**：历史 → `session.state` 快照（turns + currentTurn + pendingApprovals + contextPanel + availableModels）。`buildInteractionRenderBlocks` 把 assistant/tool 消息组渲染成 RenderBlock[]——它依赖 ToolManager/MCP 注册表，必须在宿主做。水合用快照，不做逐事件回放。

---

## 3. Agent 执行核心（`agent/`）

- **AgentRunner**：构造参 `session: BackendSession`；`run(abortController, { systemPrompt, wireHistory })`（system prompt 显式传入；线协议历史中不含 system 消息）。输出走 `session.publishRenderData(renderData)`（对象直传）。错误广播 `session.error`（通知微前端弹原生通知）。标题生成由 drain 循环在首轮完成后触发，runner 不参与。轮次边界有 steer 注入钩子。
- **RenderDataBuilder**：流式状态 → RenderData IR，三级锁（轮次/轮内/工具块）+ 重试回滚快照；`commitTurnBoundary()` 在 steer 注入时封存当前轮、开新一轮。依赖 ToolManager 的 prettyPrint/renderingConfig——这是它留在宿主的原因。
- **ToolExecutor**：`ToolContext.session: BackendSession`；工具错误以字符串结果返回不断循环；abort → `[Interrupted]` + `shouldTerminate`。每批次执行前注册 `session.terminationHook`（审批空理由拒绝 → 终止会话）。
- **generateStream.ts**：kosong `generate()` 的流式泵。

---

## 4. 前端（`src/frontend/` + `src/frontends/`）

### 4.1 适配器框架

- 注册进框架的是单例 host；host 内部按面板 spawn 轻量 controller（不进注册表）。
- `IFrontendAdapter`：`id`、`capabilities.interactive`、`activate(ctx)`、`dispose()`；`AdapterContext = { bus, backend, extensionContext }`。
- 总线永远是单一全局通道，路由靠 payload.sessionId，不搞 per-session channel。

### 4.2 WebView 前端（`src/frontends/webview/`）

- 载体是 Custom Editor（`customEditors` 贡献点 viewType `mutsumi.chat`，selector `*.mtm`），`CustomReadonlyEditorProvider`——不提供文档模型，没有脏缓冲区状态。一个会话可挂多个面板（split）；关窗不杀会话，重开靠 `session.state` 水合。
- **panelController.ts**（每面板一个）是进程间通信唯一关口：
  - WebView→宿主：`vscode.postMessage({kind:'ftb',...})` → controller 注入 `sessionId` + `origin:'webview'` 后 `bus.emitFtB`（脚本不自报）。
  - 宿主→WebView：`subscribeAllBtF` + sessionId 过滤 → `postMessage({kind:'btf',...})`。
  - 适配器本地 RPC（图片上传/解析）用 `{kind:'rpc'}` 信封，只在 panel ↔ controller 之间，不进总线。
  - `ready` → `session.open`（回快照水合）；dispose → `session.close`；激活 → `session.focus`。
- **渲染核心**（`ui/render/`）：micromark GFM、lowlight 高亮、committed DOM 缓存 + active 增量协调（指纹前缀对齐）、`<pre>` 打捞、details 开合继承、复制代码按钮。每 turn 一个 `TurnRenderer`。
- **布局**（Kimi 网页式）：用户消息 = 右对齐气泡（静态 Markdown）；Agent 消息 = 全宽（逐 token 实时渲染）；无 Cell 概念、消息不可编辑。不乐观渲染：发送进排队条，`session.userMessageCommitted` 才转正为气泡。
- **两个可扩展注册表**：`ui/menus.ts`（消息菜单：复制/重试/撤回/继续）、`ui/toolbar.ts`（工具栏：插图/重命名/裁剪引用/调试上下文/自动批准/上下文面板/模型与思考强度面板，全部 codicon 图标）。加项 = 加一条注册；`popupId` 项由同名锚定弹层接管点击。
- **弹出层基类**：`ui/popup.ts` 的 `AnchoredPopup`（锚定按钮上方定位、toggle/Esc/外部点击关闭）+ `renderPickerGroups`（可折叠分组 + codicon 勾选行）共享渲染；`ContextPanel` 与 `SettingsPanel` 均继承基类。
- **上下文面板**：contextItems/rules/skills/MCP 工具的查看与开关。UI 形态是锚定在工具栏"上下文"按钮正上方的弹出面板（点击外部/Esc/再次点击按钮关闭），内容为多级可折叠树（目录树 + MCP server→tool 层级），状态图标用 codicon（check/dash/circle-outline），字体资源由 esbuild 从 `@vscode/codicons` 拷入 dist/ 并经 HTML `<link>` 引入。数据来自快照 + `session.metadata` 增量，操作发 FtB `context.*`。
- **图片链路**：粘贴/拖入/工具栏插图 → RPC 上传 → 宿主写 `os.tmpdir()/mutsumi_images` → 插入 `![image](file://…)`；历史图片懒解析（`file://` img → RPC 换 webview URI）。

### 4.3 Lite 适配器（`src/frontends/lite/`）

无 UI、无工具（`createEmptyToolSet()`）、不可交互。`runOnce(prompt, {model, provider})`：ephemeral 会话 + 入队一条消息 + 订阅自己的 `session.output`/`session.status` 收敛文本；自动应答自己会话的审批。用途：程序化"发一条取结果"与后端冒烟测试。

### 4.4 侧栏（`src/sidebar/`）与通知微前端

- 三棵树：agent 树（backend AgentRegistry + `sessions.changed`；打开 = `vscode.openWith(uri, 'mutsumi.chat')`）、审批树（ApprovalRequestManager + DispatchSessionManager；按钮发 FtB respond，origin 'sidebar'；拒绝理由由侧栏输入框收集随载荷携带）、shell 任务树。审批树是常驻兜底前端：未打开面板的会话的审批都落在这里。
- 通知微前端（extension.ts）：`session.error` → showErrorMessage（带复制详情）；`approval.requested` → node-notifier OS 通知。

---

## 5. 上下文装配（`contextManagement/`）

history.ts 提供三个纯函数（持久化形态 ↔ 线协议形态的投影）：

- `assembleSystemPrompt(metadata)`：角色宏 + rules（递归收集 + 模板展开）+ skills markdown。
- `assembleUserMessage(session, text)`：模板引擎 APPEND 渲染 + 文件哈希/版本差分 + 更新 `metadata.contextItems` + ghost block 挂到该消息 `metadata.last_ghost_block`，返回可持久化 user 消息。
- `assembleWireHistory(session)`：每条历史 user 消息投影 ghost markdown + 图片链接解析为 image_url 分片（`projectUserMessageToWire`，steer 注入时单条复用）。
- 前缀缓存一致性约束：会话前缀刻意保持稳定以最大化 KV Cache 命中；任何缩短上下文的操作使从最早被修改处起的前缀缓存失效，是预期语义。
- 预执行平面（`@[tool{...}]`）：`tools.d/preExecution.ts`（独立小模块，避免 contextManagement → backend 依赖环）；`executeToolCall` 用后端注册的共享 ephemeral 会话（`registerPreExecutionSessionFactory`）。

---

## 6. 配置 / 工具 / MCP

- 配置流（`config/` + `registry/`）：整体校验候选 → 原子替换 → 仅 `mutsumi.mcpServers` 变化才重连 MCP。
- 工具链路：`createToolSetForAgent` 组合内置 + MCP 快照 ∩ 当前可用 + 子 Agent task_finish。MCP 工具不进 toolSets；`ToolSet.addTool` 拒绝重名。
- MCP 宿主：单例 McpRegistry、无连接池/自动重连；`McpToolAdapter` readOnlyHint 自动执行，其余经 `session.requestApproval` 审批。
- RAG/codebase：`query_codebase` 按 embedding endpoint 是否配置被条件剔除。

---

## 7. 激活时序与装配（extension.ts）

```text
debugLogger / toolsLogger 初始化
  → ToolRegistry.initialize()
  → loadMutsumiConfig + 校验 + ToolSetRegistry/AgentTypeRegistry
  → McpRegistry.reload
  → SkillManager / Codebase / RAG
  → AgentBackend 构造 + initialize()（scanAllAgents + registerBackendHandlers + 预执行会话工厂注册）
  → AgentSidebarProvider（三棵树）
  → 配置变化监听（原子替换 + MCP 按需 reload）
  → AdapterRegistry：Lite + WebView 适配器 activate
  → 通知微前端订阅（session.error / approval.requested）
  → .mtm 删除 watcher → backend.notifyFileDeleted
  → 命令注册（newAgent/copyReference/clearToolCache/testRagSearch）+ activateEditSupport
```

当前命令集：`newAgent`（原生 QuickPick + 后端 createSession + openWith）、`openAgentFile`、审批三命令（`approveRequest`/`rejectRequest`/`customRequestAction`，发 FtB）、shell 任务三命令、`copyReference`、`clearToolCache`、`testRagSearch`。

---

## 8. 开发陷阱 checklist

1. **新增事件**：events.ts 加 payload 映射 + 名字数组；FtB 处理器漏一个编译报错。改变状态的 FtB 必须广播对应 BtF。
2. **后端禁 UI**：backend/ 与 agent/ 不得 import vscode.window / Notebook / Webview 类型；需要用户可见的通知 → 广播 `session.error`。
3. **前端互不通信**：想知道别的前端做了什么 → 等后端的 BtF 事实，永不监听 FtB。
4. 新增工具：实现 `ITool`，注册进 `ToolRegistry.TOOL_NAME_MAPPING`；审批一律 `context.session.requestApproval*`。
5. edit/write 默认不弹 DiffEditor（custom action `localOnly` 触发）；事务机关窗清理由 EditTransactionManager 自闭环。
6. metadata/history 修改一律经 BackendSession 方法 → 落盘 → 广播；不要直接写文件（sessionStore 是唯一写口）。
7. 上下文相关改动：默认考虑前缀缓存一致性；缩短上下文作废缓存是预期行为。
8. WebView UI 改动：`ui/` 下代码只能 import 纯类型/纯工具（不能 import 宿主模块）；静态文案由宿主 `t()` 翻译后经 initial-data 注入。
9. 新增命令/菜单：同步 package.json（contributes + menus when）与 l10n bundle（en/zh-cn）。
10. 不修改 `docs/vscode-api.md`（外部 API 快照，内容极长，只能 grep）。
11. 压缩功能当前不存在；其回归挂钩的设计见 `docs/AGENT_BACKEND_REFACTOR_DESIGN_CN.md`。

---

## 9. 构建与验证

包管理器为 **pnpm**（`packageManager: pnpm@12.4.1`）。新环境首次构建前必须 `corepack enable`（Node ≥ 24 自带 corepack）安装 pnpm shim，否则终端与 vsce（它按 `packageManager` 字段调用 pnpm）都找不到 `pnpm` 命令。pnpm 配置集中在 `pnpm-workspace.yaml`：**`nodeLinker: hoisted`** 是为了让 vsce 的 `npm ls` 依赖分析继续工作，从而使 better-sqlite3 等 4 个原生 external 正常进入 vsix；**`allowBuilds`** 是依赖 install 脚本的白名单（pnpm ≥11 不再读 package.json 的 `pnpm` 字段）。新增带 install 脚本的原生依赖时必须把它加进 `allowBuilds`，否则 `pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` 中止。禁止回退 npm（`#ref&path:` 等 pnpm 私有语法与 lockfile 不兼容）。

```bash
pnpm run check-types   # tsc --noEmit（主 tsconfig + webview UI 的 tsconfig.renderer.json）
pnpm run compile       # 类型检查 + 开发打包（dist/extension.js + dist/webview.js）
node esbuild.js        # 打包（--watch 开发）
pnpm run package       # 出 .vsix（vsce package；自动触发 prepublish = 类型检查 + production 打包）
```

提交前必须通过：`pnpm run check-types`、`node esbuild.js`、`git diff --check`。

---

## 10. 重要参考文档

- `docs/AGENT_BACKEND_REFACTOR_DESIGN_CN.md` — 后端架构的完整设计蓝本：事件协议、运行语义、行为契约
- `docs/mcp-host-final-target.md` — MCP 宿主最终目标状态
- `docs/AGENT_TYPES_DESIGN.md`（及 `_CN`）— AgentType 角色系统设计
- `docs/PROMPT_ENGINEERING_DESIGN.md`（及 `_CN`）— Prompt 工程与上下文设计
- `src/types.ts` — 核心类型（`AgentMetadata`、`AgentMessage`、`AgentStateInfo`）

---

## 11. 许可证

Apache License 2.0（见 LICENSE）。
