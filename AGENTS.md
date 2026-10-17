# Mutsumi 开发约定（Agent 贡献者版）

Mutsumi 是一个 VS Code 多 Agent 对话环境：Agent 会话以 `.mtm` 文件持久化，经 Custom Editor + WebView 呈现。本文档写给参与本项目开发的 AI Agent，含有最重要的架构约束与工程约定；各模块内部的机制细节以模块 docstring 为准。

## 架构：三层拆分

```
后端 (src/backend, src/agent)  →  前端适配器 (src/frontend)  →  前端 UI (如 frontends/webview/ui)
```

- **后端**是唯一状态权威，零 UI 依赖：不得 import `vscode.window` / WebView 类型，只用 `workspace.fs`、`Uri`、`EventEmitter` 等纯数据面 API。需要用户可见的通知时，广播 `session.error`。
- **后端 ↔ 前端适配器**：唯一通道是 `EventBus` 的类型化事件协议。前端到后端只有 FtB（意图），后端到前端只有 BtF（事实）；前端永不监听 FtB；任何改变后端状态的 FtB 必须广播对应 BtF。除 `sessions.changed`、`settings.autoApprove` 外，事件都携带 `sessionId` 路由。
- **事件协议自含于 `src/backend/events.ts`**：payload 映射与事件名数组互相 `satisfies` 校验，`registerBackendHandlers` 的 mapped type 强制穷尽——新增事件漏登任何一处，编译直接报错。
- **适配器 ↔ 前端 UI**：协议由各适配器自定，不进总线（WebView 用 adapter-local RPC 信封；将来可能有 ACP）。
- **会话的真相**：`.mtm` 文件，`sessionStore` 是唯一写口；运行中以内存为准，外部改文件不触发重载。

## 目录与文件约定

- 每个模块（含子模块）尽量独占一个目录。
- 各模块目录内：实际类型和常量集中放 `types.ts`；抽象接口放 `interfaces.ts`；可复用的（尤其是无副作用的）工具函数放 `utils.ts`。
- WebView `ui/` 下的代码只能 import 纯类型/纯工具，不得 import 宿主模块；静态文案由宿主 `t()` 翻译后注入（键表为 `WEBVIEW_LABEL_KEYS`，新增文案须同步两个 l10n bundle）。

## 工程原则

- **最小实现**：不产生耦合，不产生冗余。优先考虑能否用一条或少数几条正交的声明式规则"涌现"出复杂行为，而不是堆叠命令式逻辑。
- **最小抽象**：不写只有一个消费者的抽象，除非路线图上有确定的其他消费者。
- **发现耦合或冗余就重构**：既有代码已耦合/冗余，或原设计在加新功能时必然退化为耦合/冗余，就重构。重构时不要追求最小变更——如果某个功能成了架构精简的拦路虎，可以直接砍掉。
- **不需要重构时反过来，追求最小变更**：例如实现 UI 行为时先考虑纯 CSS，CSS 做不到再上 JS。

## 注释与命名

- 注释即纯技术文档：只描述当前代码的架构设计与功能行为。禁止教学性内容；禁止只有看过特定对话才能理解的表述（如引用设计文档的章节编号、对话中的选项字母或编号）；禁止叙述历史版本的错误行为或"为什么不要那样做"。
- 例外：如果某个错误做法极其符合直觉、按直觉写必被坑，可以加防呆警示（指向坑本身，不指向历史）。
- 标识符（变量/类/属性/函数/模块）按正式工程标准命名，不带对话或教学色彩。
- 事实上，本项目中的 JSDoc 注释就是本项目的技术文档。通过及时维护所有 JSDoc 注释，可以尽可能轻松地为人类读者和将来的 Agents 读者提供清晰准确的方法/类/模块语义。这就是为什么我们必须要确保它描述，且仅描述，**当前**代码的行为，并随代码改动而改动。

## 构建与验证

包管理器是 pnpm（新环境先 `corepack enable`；不要回退 npm）。提交前必须通过：

```bash
pnpm run check-types   # tsc --noEmit（主配置 + webview 的 tsconfig.renderer.json）
node esbuild.js        # 打包
git diff --check       # 空白符检查
```

## 真坑清单

只记录按直觉写就会被坑的地方：

- **不要用 tmp+rename 更新 `.mtm` 文件**：rename 在 watcher 视角是 DELETE+CREATE，会导致 VS Code 关掉对应 Custom Editor，并误触本扩展自己的 `.mtm` 删除监听。直写目标文件（truncate + write），每文件一条 Promise 写队列串行化。
- **system 消息从不写入 `.mtm`**：system prompt 是 metadata 与工作区状态的纯函数，落盘读回时须过滤。
- **`pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 不能改**：vsce 的依赖分析依赖它；带 install 脚本的新原生依赖必须加进 `allowBuilds`，否则 `pnpm install` 中止。
