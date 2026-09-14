# Mutsumi 项目开发指南（Agent 贡献者版）

> 本文件面向参与 Mutsumi 开发的 AI 编码 Agent，介绍各模块职责、模块间的接线方式，以及非平凡/反直觉的设计约束。
> Mutsumi（若叶睦）是一款 VS Code 多 Agent 笔记本环境插件：Agent 会话以 `.mtm`（JSON）文件持久化，经 VS Code Notebook API 呈现，工具/上下文/编排围绕该模型展开。

---

## 1. 架构总览

```
src/
├── adapters/          # 适配器层：把 AgentRunner 与 UI/传输解耦（Notebook / HTTP / Lite）
├── agent/             # Agent 核心逻辑（执行循环、LLM 客户端、编排、标题生成）
├── codebase/          # 代码库服务（RAG 向量搜索）
├── config/            # 配置系统（AgentType、toolSets、MCP Server 的合并/校验/解析）
├── contextManagement/ # 动态上下文管理（模板引擎、历史装配、幽灵块、Skills）
├── httpServer/        # HTTP API 服务（复用同一套 Agent 执行链路）
├── mcp/               # MCP 宿主（连接 registry、ITool 适配、结果投影）
├── notebook/          # Notebook UI 实现（serializer、自定义渲染器、工具栏命令）
├── sidebar/           # 侧边栏视图（Agent / 审批 / Context / Shell 任务）
├── registry/          # 配置运行时注册表（ToolSetRegistry、AgentTypeRegistry）
├── tools.d/           # 内置工具实现与工具运行时（ToolRegistry、ToolSet、权限）
└── types.ts / utils.ts / i18n.ts / controller.ts / extension.ts
```

### 核心分层原则

1. **适配器解耦**：`AgentRunner` 只依赖 `IAgentSession` 接口，不感知 Notebook 还是 HTTP。Notebook/HTTP 各自通过 adapter 复用同一执行链路。
2. **URI 优先**：所有文件操作使用 `vscode.Uri`，支持多根工作区与其他扩展的 FileSystemProvider 特殊 schema。Mutsumi 自身数据（`.mutsumi/`）固定在工作区列表 `[0]`。
3. **工具分层**：内置工具（静态注册）与 MCP 工具（动态发现）是两套体系，在 ToolSet 构建时组合；`task_finish` 独立于一切工具集配置。
4. **装配点唯一**：`extension.ts` 是唯一激活/装配入口（初始化顺序、配置监听、事件订阅都在这里）。
5. **禁止反向依赖**：`mcp` 不 import `sidebar`/`notebook`；`serializer`/`fileOps` 不发起 MCP 连接；`ToolExecutor` 对 MCP 零特判；sidebar 只读依赖 mcp registry 状态。

---

## 2. Notebook 系统与 UI 层

### 2.1 `.mtm` 文件模型与 Serializer（`notebook/serializer.ts`）

`.mtm` 是 JSON：`{ metadata: AgentMetadata, context: AgentMessage[] }`。VS Code 通过 `NotebookSerializer` 把它与 Notebook 文档互相转换。

核心算法是 **messages ↔ generic cells 双向映射**（`messagesToGenericCells` / `genericCellsToMessages`），并被 HeadlessAdapter 复用，因此协议是"与 UI 无关"的：

- User 消息 → Code cell（kind 2）
- Assistant 消息 → Markup cell（kind 1）
- **紧随 user 的 assistant/tool 消息组不单独建 cell**，而是存入该 user cell 的 `mutsumi_interaction` metadata，渲染为该 cell 的输出区（这是最反直觉的点）
- System 消息 → 带 `**System**: ` 前缀的 Markup cell，反序列化时剥前缀
- 孤儿 assistant/tool 消息（无前置 user）→ 直接拍平成 markdown 存 cell value，**不写** `mutsumi_interaction`
- `mutsumi_interaction` **只存在于 user cell**，永不写在 assistant cell 上
- cell value 中保存的幽灵块 markdown 在反序列化时剥离（`stripGhostBlockFromCell`），结构化版本在 metadata 中

序列化时 `sub_agents_list` 与 `AgentOrchestrator` 内存注册表**双向同步**（打开时注入 childIds，保存时回写）。

### 2.2 自定义渲染器（`notebook/renderer.ts` + `renderTypes.ts`）

Agent 输出不是 HTML 字符串，而是**结构化中间表示 `RenderData`**（`MUTSUMI_AGENT_CHAT_MIME`）：

```text
RenderData = { committed: RenderBlock[], active: {...} | null }
RenderBlock = content | reasoning(collapsed) | toolCall(isStreaming, result?)
```

渲染器对 `committed` 做 DOM 缓存（渲染一次、永不再渲染），只重渲 `active` 流式区。**协议方（adapter）只负责产出 RenderData JSON**，HTML 生成全部在渲染器侧。

### 2.3 UIRenderer 三级锁定（`agent/uiRenderer.ts`）

`AgentRunner` 侧的流式状态机，保证"已提交块不重渲"：

- **L1（轮次）**：`commitRoundUI()` 把整轮剩余内容锁入 committed
- **L2（轮内）**：content 出现 → reasoning 锁定；tools 出现 → content 锁定
- **L3（工具）**：`appendBlock()` 提交单个完成的工具调用

### 2.4 工具栏与命令（`notebook/toolbar.ts` + `commands/`）

工具栏命令（selectModel、renameSession、debugContext、toggleAutoApprove、testRagSearch、compressConversation、pruneGhostBlocks）经 `registerToolbarCommands` 统一注册；每个命令一个文件，依赖 `buildInteractionHistory` 或 metadata 读写。

命令式交互遵循的通用模式：

- 读 metadata → 不可变展开 → `WorkspaceEdit` 写回
- 涉及上下文缩短的操作（pruneGhostBlocks、removeFile、MCP 开关）默认使前缀缓存失效（见 §5.2）

### 2.5 侧边栏（`sidebar/`）——四个 TreeView 的设计模式

| View | Provider | 数据源 | 结构 |
|------|----------|--------|------|
| Agents | `agentTreeProvider` | `AgentOrchestrator`（内存注册表 + childIds） | 树：parent → children，双向引用 |
| Approvals | `approvalTreeProvider` | `approvalManager`（permission.ts） | 平铺，pending 优先、新的在前 |
| Context | `contextTreeProvider` | Notebook metadata + 文件系统 + SkillManager + McpRegistry | 分类树 |
| ShellTasks | `shellTaskTreeProvider` | shell 任务注册表 | 平铺 + 状态 |

统一的 TreeView 模式：

- provider 持有 `_onDidChangeTreeData` EventEmitter，`refresh()` 即 `fire(null)`
- **子节点缓存在 item.children 上**：`getChildren(element)` 大部分只是返回 `element.children`（只有根节点才构建）；ContextTree 的 `getChildren` 必须按 `element.data.type` 分发（category/directory/mcpServer 返回 children，其余为空）
- 数据变化来源多样（运行状态、审批、metadata、registry、配置），刷新触发点分散在 `AgentSidebarProvider.registerTreeView` 的订阅里
- `AgentSidebarProvider.update()` 是聚合刷新入口（agent + context + shell 三棵树）

**ContextTree 分类**（`contextTreeItem.ts`）：AGENT TYPE 节点 + RULES / SKILLS / MACROS / FILES / MCPS 分类。`ContextItemType`/`CategoryType` 是判别联合，新增分类必须同步：类型定义、`getIconPath`、`getContextValue`（决定菜单 `when`）、`buildTooltip`、package.json `view/item/context` 菜单、i18n。

菜单机制：树项的 `contextValue` 与 package.json `menus["view/item/context"]` 的 `when: viewItem == xxx` 匹配决定显示哪些内联命令；"只读态"用独立 contextValue（如 `mcpServerReadOnly`）隐藏操作。

---

## 3. Agent 执行核心（`agent/`）

### 3.1 执行入口：controller → runner（`controller.ts` → `agentRunner.ts`）

Notebook 执行链路（`AgentController.execute`）：

```text
用户运行 cell
  → notifyAgentStarted(uuid)
  → processCell：解析模型（metadata 完整对 → 用；缺 model → 全局默认；有 model 无 provider → 迁移错误）
  → 取凭据（getModelCredentials）
  → NotebookAdapter.createSession
  → createToolSetForAgent(metadata 快照)   ← 内置 + MCP + task_finish 在此组合
  → buildInteractionHistory(session)       ← 装配上下文（见 §5）
  → new AgentRunner(...).run(abortController, history)
  → session.setHistory + save
  → notifyAgentStopped(uuid)
```

HTTP 执行（`httpServer/chat.ts`）走 HeadlessAdapter + 同一 `createToolSetForAgent` / `AgentRunner`，因此 Notebook 与 HTTP 的 Agent 能力必须一致。

### 3.2 AgentRunner 主循环

每轮（最多 `maxLoops`）：

1. `llmStreamHandler.streamResponse(messages, toolSet.getDefinitions(), ...)`——流式回调里用 UIRenderer 更新活动区
2. 无 tool call → 结束；有 → 提交 assistant 消息
3. `toolExecutor.executeTools(toolCalls, ...)`：
   - 解析参数 JSON → 建 `ToolSession`（AbortController）
   - 构建 `ToolContext`（allowedUris、session、abortSignal、appendOutput、signalTermination）
   - 缓存查询（仅 `shouldCache` 工具）→ `toolSet.execute` → `raceAbort` 包裹
   - 渲染工具调用块、收集 tool 消息
4. `task_finish` → `markSessionAsFinished`（写 `is_task_finished`）；拒绝类终止 → break
5. 首次 user 消息后生成标题（**跳过 `LiteAgentSession`**，避免递归）

### 3.3 ToolExecutor 的契约

- 工具错误一律以**字符串结果**返回给模型（`Error: ...`），不抛断循环；只有 abort/取消才走异常路径
- 取消语义：外层 `raceAbort` 在 signal 触发时 reject；工具若响应 `toolSession.abortSignal` 可立即停止；被强制打断 → `[Interrupted] ...` 并 `shouldTerminate`
- `signalTermination(isTaskComplete)` 是工具主动终止会话的唯一通道

### 3.4 子母 Agent 编排（`agentOrchestrator.ts` + `dispatch.ts`）

生命周期：

```text
父 Agent 调用 dispatch_subagents（tools.d/tools/agent_control.ts）
  → AgentOrchestrator.requestDispatch(parentId, ...)
  → DispatchSessionManager.createSession(parentId, childUuids, resolve, reject)   ← 挂起父执行
  → 为每个子 Agent 调 createAndOpenAgent（子 Agent 文件写入 .mutsumi/）
  → 子 Agent 独立运行（可在边栏/新窗口），完成后调用 task_finish
  → reportTaskFinished(childUuid, summary)
  → addResult + isSessionComplete 判定（result 或 deleted 全部到齐）
  → generateReport 聚合 → resolve 父的挂起 promise
```

关键点：

- `DispatchSessionManager` 是"父等子"的协调器：children 可能被用户删除（`addDeletedChild`）也算完成
- 子 Agent **用自己的 agentType 默认值**（rules/skills/MCP 快照），不继承父 Agent 的手动选择
- `context_broadcast` 拼进每个子 Agent 的 prompt 前缀（`## Context Summary`）
- abort 信号 → `cancelSession` → reject 父的挂起 promise
- `AgentRegistry`（agent/registry.ts）是内存真相，启动时 `scanAllAgents` 从磁盘加载，UUID 冲突（如复制文件）用 `setAgentWithConflictCheck` 清洗

---

## 4. 适配器层（`adapters/`）

契约见 `interfaces.ts`：`IAgentAdapter`（createSession/getSession/持久化辅助）+ `IAgentSession`（getInput/getHistory/appendOutput/replaceOutput/save/getConfig/setConfig/updateTitle/幽灵块钩子）。

三个实现：

| Adapter | 用途 | 特性 |
|---------|------|------|
| `NotebookAdapter` | Notebook 会话 | 单元格历史 1:1 映射、`execution.replaceOutput`、metadata 经 WorkspaceEdit 保存 |
| `HeadlessAdapter` | HTTP 会话 | 从 .mtm 内容反序列化、SSE/JSON 输出 RenderData |
| `LiteAdapter` | 后台任务（标题、压缩） | 无 UI、无幽灵块投影；`AgentRunner` 用 `instanceof` 跳过递归标题生成 |

反直觉点：

- `buildInteractionHistory` 在 adapter 之外完成（controller 调用），adapter 的 `getHistory` **不做展开**（注释明确：Do NOT expand here）
- metadata 保存走"打开文档 WorkspaceEdit / 关闭文档直写"双路径（见 `agent/fileOps.ts` 的 update 系列函数）

---

## 5. 上下文装配（`contextManagement/`）

### 5.1 buildInteractionHistory（history.ts）——单次运行的上下文总装

```text
宏合并（persisted contextItems 宏 + 当前输入提取的宏，local 覆盖 persisted）
  → System Prompt（Rules 递归收集 + Skills markdown）
  → 历史幽灵块解码 → 文件版本地图（差分更新用）
  → 当前输入 TemplateEngine 渲染（APPEND：收集幽灵块）
  → 逐条处理历史（含 mutsumi_interaction 展开）→ 组装消息数组
```

### 5.2 前缀缓存一致性（重要设计约束）

会话前缀被刻意保持稳定以最大化 LLM KV Cache 命中：

- 文件引用按版本 + 哈希**差分更新**：内容未变只注入"回溯历史"命令，不重复注入全文
- 任何缩短上下文的操作（Remove File、Prune Old Versions、规则/技能/宏/MCP 开关）都使从最早被修改 Cell 起的前缀缓存失效；**ContextTree 操作作废缓存是预期语义，不是 bug**
- 不要为省事在会话中途注入易变内容破坏前缀稳定

### 5.3 幽灵块（ghostBlocks.ts）

- 持久化的是**结构化 GhostBlock 对象**（cell metadata `last_ghost_block`），markdown 只在发送前投影
- 非法/旧格式 metadata 在边界解码失败时按"无 ghost block"处理，**不做迁移**（保证索引对齐用 null 占位）
- 涉及幽灵块的修改必须走 `buildGhostStripEdits` / `decodeGhostBlock` / `collectAvailableFileVersions` 等边界函数，不要直接拼字符串

### 5.4 模板引擎（templateEngine.ts）

- `@[path]` 文件引用、`@[tool{json}]` 工具预执行
- APPEND（顶层）收集进幽灵块；INLINE（递归层）直接替换进父内容
- 工具预执行走 `executeToolCall`（控制面），与运行时 ToolExecutor 是**两条执行路径**
- 预执行平面 = 内置 common tools + McpRegistry 当前 connected/schemaValid 的**全部** MCP 工具（与 Agent 快照无关），暴露名 `mcp__<server>__<tool>__<hash>` 与运行时一致
- 预执行是用户手写内容，所有工具（内置与 MCP、无论 readOnlyHint）一律直接执行、**不进入审批**；由 permission.ts 的预执行模式（`withPreExecution`/`isInPreExecution`）放行，Agent 运行路径审批不受影响
- ToolManager 缓存预执行 ToolSet，McpRegistry 状态变化（reload/断连/工具列表更新）自动失效重建

---

## 6. 配置系统与工具系统（`config/` + `registry/` + `tools.d/`）

### 6.1 配置流

```text
VS Code 设置 mutsumi.agentConfig / mutsumi.mcpServers
  → loader（深合并内置默认）
  → utils 校验（结构 + 交叉引用：toolSet 存在、defaultMcpServers 引用存在）
  → resolver（创建 Agent 时解析默认：模型/规则/技能/MCP Servers）
  → registry 原子替换
```

配置变化处理：**先整体校验候选，成功才替换运行时 registry**；失败保留旧有效配置并报错，不允许半更新。只有 `mutsumi.mcpServers` 变化才重连 MCP；`agentConfig` 单独变化不重启 Server。

### 6.2 工具链路：两套体系，一次组合

内置（静态）与 MCP（动态）在 `createToolSetForAgent` 组合为单次运行的 `ToolSet`：

```text
内置:  AgentType.toolSets → ToolSetRegistry.getCombinedToolSet → ITool[]
MCP:   AgentMetadata.enabledMcpTools ∩ McpRegistry 当前可用 → McpToolAdapter[]
子Agent: parent_agent_id 存在 → task_finish
```

反直觉点：

- MCP 工具**不允许**出现在 `agentConfig.toolSets` 中——toolSets 只认静态内置工具
- `AgentType.defaultMcpServers` 只在 Agent 创建时生成 `enabledMcpTools` **冻结快照**，之后不参与运行权限；运行时 MCP 能力 = 快照 ∩ 当前连接可用工具
- `ToolSet.addTool` 拒绝重名（禁止 `Map.set` 静默覆盖）
- `query_codebase` 按 embedding endpoint 是否配置被条件剔除
- `ToolManager`（toolManager.ts 中的控制面管理器）只服务控制面/预执行场景，Agent 运行不使用它；其预执行 ToolSet 含全部可用 MCP 工具并随 registry 变化失效（见 5.4）

### 6.3 MCP 宿主（`mcp/`）

- 扩展级单例 `McpRegistry`：统一连接（stdio / Streamable HTTP）、`tools/list` 发现、状态跟踪、`tools/call`、串行 reload、dispose。**无连接池、无自动重连、无 per-agent 连接**
- `McpToolAdapter implements ITool`：schema 校验、`readOnlyHint === true` 自动执行（其余走 permission 审批）、结果文本化
- 暴露名 `mcp__<server>__<tool>__<hash>`（逻辑身份与模型名分离）；二进制/非文本结果只投影摘要，绝不把 base64 塞入上下文
- 设计细节见 `docs/mcp-host-final-target.md`

### 6.4 审批（permission.ts）

`requestApproval` 是唯一审批入口，内部处理：AutoApprove、预执行模式（用户手写的 `@[tool{...}]` 调用一律自动放行，Rules 解析只是其中一个场景）、审批边栏（approvalManager）、拒绝原因、**取消**（监听 ToolContext abort，取消后移除 pending 请求）。任何工具都不得直接操作审批 UI。

---

## 7. 激活时序与装配（extension.ts）

`activate()` 的顺序有依赖关系，**不可随意调整**：

```text
debugLogger / toolsLogger 初始化
  → ToolRegistry.initialize()（静态内置工具表）
  → loadMutsumiConfig + 校验 + ToolSetRegistry/AgentTypeRegistry 初始化
  → McpRegistry.reload(config.mcpServers)（并发连接全部 Server，单点失败降级为 error）
  → SkillManager.initialize（扫描 skills）
  → Codebase/RAG 服务
  → AgentOrchestrator.initialize（从磁盘扫描 .mutsumi/*.mtm 重建内存注册表）
  → 注册 Notebook controller、serializer、命令、侧边栏、事件监听
```

事件监听要点：

- 配置变化：`mutsumi.mcpServers` / `mutsumi.agentConfig` → 整体校验 → 原子替换 → （仅 mcpServers 变化时）registry reload → 刷新侧边栏
- notebook 打开/保存：与 AgentOrchestrator 注册表同步
- 侧边栏订阅：active notebook 变化、notebook metadata 变化、MCP registry 变化、配置 reload 完成

---

## 8. 开发陷阱 checklist

1. 新增工具：实现 `ITool`，注册进 `ToolRegistry.TOOL_NAME_MAPPING`，之后才可被 toolSets 引用；需要缓存才设 `shouldCache`
2. 新增命令/菜单：必须同步 package.json（`contributes.commands` + `menus` 的 `when: viewItem == ...`）与 l10n bundle（en/zh-cn），否则 UI 缺失且类型检查不报错
3. 新增会话级 metadata 字段：在 `AgentMetadata` 加可选字段，确认 serializer / fileOps / compress 路径保留它（serializer 透明 round-trip，但创建/复制/压缩路径可能丢弃）
4. metadata 更新一律不可变展开（`{...}`）后经 WorkspaceEdit 写回；VS Code 的 metadata 是冻结对象
5. MCP 相关改动：遵守"快照冻结、运行交集、失败降级"三原则；不要引入自动重连/连接池
6. 上下文相关改动：默认考虑前缀缓存一致性；ContextTree 操作作废缓存是预期行为
7. async 初始化（如 MCP 连接）不得阻塞 `activate()` 过久；失败必须降级而不是抛断整个扩展
8. `GenericCellData` / `messagesToGenericCells` 是 Notebook 与 Headless 共用的协议，改动 serializer 前先评估两边的兼容
9. 不修改 `docs/vscode-api.md`（外部 API 快照，内容极长，只能 grep）

---

## 9. 构建与验证

包管理器为 **pnpm**（`packageManager: pnpm@12.4.1`）。新环境首次构建前必须 `corepack enable`（Node ≥ 24 自带 corepack）安装 pnpm shim，否则终端与 vsce（它按 `packageManager` 字段调用 pnpm）都找不到 `pnpm` 命令。pnpm 配置集中在 `pnpm-workspace.yaml`：**`nodeLinker: hoisted`** 是为了让 vsce 的 `npm ls` 依赖分析继续工作，从而使 better-sqlite3 等 4 个原生 external 正常进入 vsix；**`allowBuilds`** 是依赖 install 脚本的白名单（pnpm ≥11 不再读 package.json 的 `pnpm` 字段）。新增带 install 脚本的原生依赖时必须把它加进 `allowBuilds`，否则 `pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` 中止。禁止回退 npm（`#ref&path:` 等 pnpm 私有语法与 lockfile 不兼容）。

```bash
pnpm run check-types   # tsc --noEmit（含 renderer tsconfig）
pnpm run compile       # 类型检查 + 开发打包
node esbuild.js        # 打包（--watch 开发）
pnpm run package       # 出 .vsix（vsce package；自动触发 prepublish = 类型检查 + production 打包）
```

提交前必须通过：`pnpm run check-types`、`node esbuild.js`、`git diff --check`。

---

## 10. 重要参考文档

- `docs/mcp-host-final-target.md` — MCP 宿主最终目标状态
- `docs/AGENT_TYPES_DESIGN.md`（及 `_CN`）— AgentType 角色系统设计
- `docs/PROMPT_ENGINEERING_DESIGN.md`（及 `_CN`）— Prompt 工程与上下文设计
- `docs/CHANGES_IN_TOOL_SYSTEM_CN.md` — 工具系统演进说明
- `src/types.ts` — 核心类型（`AgentMetadata`、`AgentMessage`、`AgentContext`）

---

## 11. 许可证

Apache License 2.0（见 LICENSE）。
