# 移除 RAG 系统 —— 最终目标状态

> 本文档是"从 Mutsumi 整体移除 RAG 系统"任务唯一权威的目标状态描述，供 implementer / reviewer 使用。
> 决策已冻结，不再讨论方向，只按本文档执行与验收。

## 1. 目标终态

Mutsumi 不再包含任何 RAG（向量语义搜索 / 代码库索引）能力：无 embedding 客户端、无 SQLite 向量库、无 `query_codebase` 工具、无相关配置项 / 命令 / 测试入口、无平台特定原生 node 模块。Agent 的代码感知能力由 `grep` / `glob` / `read` / `find_filename` / `project_outline`（Tree-sitter 即时大纲）承担。

## 2. 已冻结决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | `project_outline`（Tree-sitter 大纲）去留 | **保留**。它按需单文件解析、无索引、无 embedding、无 DB，不属于 RAG。`src/codebase/service.ts` 与 `src/codebase/definitions.ts` 保留，`web-tree-sitter` 依赖、`assets/tree-sitter/`、`.gitignore` 的 wasm 条目、CI 的 WASM 下载步骤全部保留。 |
| D2 | release.yml 形态 | **塌缩为单一 universal 构建**。删除 better-sqlite3 / sqlite-vec 后无任何平台特定原生 node 模块（`node-notifier` 自带全平台 vendor 二进制、随 node_modules 常规打包；`web-tree-sitter` 是平台无关 WASM），4 平台矩阵与原生构件处理全部失去意义。 |
| D3 | 用户旧配置中的 `query_codebase` | **严格校验，零特殊处理**（用户决策：本项目不做历史版本兼容）。该名字从工具注册表与默认配置中彻底消失；含此名的用户配置将以 unknown tool 校验报错，由用户自行从 settings 移除。（loader 层 `loadMutsumiConfig()` 未传 `registeredTools`，不做工具存在性校验，无需改动。） |
| D4 | 历史设计文档 | `docs/AGENT_BACKEND_REFACTOR_DESIGN_CN.md`、`docs/tool-rename-plan.md`、`docs/AGENT_TYPES_DESIGN*.md` 是历史记录，**不改**。活文档 `AGENTS.md`、`README*.md`、`docs/ci-multiplatform-target.md` 必须更新。 |
| D5 | 残留数据 | 不加任何迁移 / 清理代码。用户工作区遗留的 `.mutsumi/cache/rag.db` 由用户自行删除；settings 中遗留的 `mutsumi.embeddingEndpoint` 成为未知配置项，VS Code 天然容忍。 |
| D6 | 依赖瘦身 | `dependencies` 删 `better-sqlite3`、`sqlite-vec`；`devDependencies` 删 `@types/better-sqlite3`、`@electron/rebuild`、`electron`、`electron-rebuild`（三者仅为 better-sqlite3 的 Electron ABI 重建服务，全仓无其他用途）。`node-notifier`、`web-tree-sitter` 保留。 |

## 3. 变更清单

### 3.1 删除文件 / 目录

- `src/codebase/rag/`（整个目录：service.ts、utils.ts、taskQueue.ts）
- `src/tools.d/tools/rag.ts`（`query_codebase` 工具）
- `src/commands/testRagSearch.ts` —— 删除后 `src/commands/` 为空目录，一并删除

### 3.2 `src/extension.ts`

- 删除 `RagService`、`registerTestRagSearchCommand` 两个 import；**保留** `CodebaseService` import 及其初始化调用（`CodebaseService.getInstance().initialize(context)`，project_outline 依赖）。
- 删除 RagService 初始化整块（getInstance + `context.subscriptions.push(ragService)`）。
- 删除"只在 RAG 启用时执行索引更新和注册文件监听器"整块：启动时的 `updateWorkspace` 循环与 `onDidSaveTextDocument` 防抖监听器（含 `pendingUpdates` Map），**无替代物**。
- 删除 `registerCommands` 末尾的 `registerTestRagSearchCommand(context)` 调用及其注释。
- 文件头 module 注释中的 "skills and RAG" 字样改为不含 RAG。

### 3.3 `src/tools.d/toolManager.ts`

- 删除 `import { queryCodebaseTool } from "./tools/rag";`。
- 删除 `TOOL_NAME_MAPPING` 中的 `query_codebase` 条目。
- `ToolRegistry.initialize()`：删除 embedding endpoint 读取与 `isRagEnabled` 条件逻辑，`commonTools` 变为静态列表（即删去末尾的条件 push）。
- 清理因此不再使用的 import（如 `vscode`——以 tsc 为准；其余符号的既有用途不受影响）。

### 3.4 `src/registry/toolSetRegistry.ts`

- 按 D3 删除 `initialize()` 中的 embedding 检测与条件过滤段，工具名直通 `validateToolNames` 严格校验；代码中不存在任何针对 `"query_codebase"` 的特殊分支。
- `initialize()` 的 docstring 更新为普通加载语义。
- 清理不再使用的 import（如 `vscode`，以 tsc 为准）。

### 3.5 `src/config/types.ts`

- `DEFAULT_MUTSUMI_CONFIG.toolSets.read` 中删除 `"query_codebase"`。

### 3.6 `src/utils.ts`

- 删除 `getBetterSqlite3NativeBinding` 及其注释（全仓仅 rag/service.ts 使用，删除后无引用）。

### 3.7 `package.json`

- `dependencies`：删 `better-sqlite3`、`sqlite-vec`。
- `devDependencies`：删 `@types/better-sqlite3`、`@electron/rebuild`、`electron`、`electron-rebuild`。
- `contributes.commands`：删 `mutsumi.testRagSearch` 条目。
- `contributes.configuration.properties`：删 `mutsumi.embeddingEndpoint`。
- 其余字段不动（版本号不 bump）。

### 3.8 `pnpm-lock.yaml`

- 运行 `pnpm install` 重新生成，确认 better-sqlite3 / sqlite-vec / electron 相关条目消失。**禁止手工编辑 lockfile。**

### 3.9 `esbuild.js`

- extension bundle 的 `external` 数组删 `better-sqlite3`、`sqlite-vec`；保留 `vscode`、`web-tree-sitter`、`node-notifier`。

### 3.10 `pnpm-workspace.yaml`

- `allowBuilds`：删 `better-sqlite3`、`electron` 条目。
- `nodeLinker: hoisted` **保留**（vsce 的 `npm ls` 依赖分析仍需它让 external 依赖进入 vsix），但其行内注释中"better-sqlite3 等原生 external"的表述更新为当前事实。
- 其余 allowBuilds 条目（esbuild / lzma-native / vsce-sign / keytar / genai / protobufjs）保留；若 `pnpm install` 后确认某包已不在依赖树中，可顺带删其条目（以 lockfile 事实为准）。

### 3.11 本地化（4 个文件）

- `l10n/bundle.l10n.json`、`l10n/bundle.l10n.zh-cn.json`：删全部 6 个 `testRag.*` 键。
- `package.nls.json`、`package.nls.zh-cn.json`：删 `command.testRagSearch.title` 与 `configuration.embeddingEndpoint.description`。

### 3.12 `.github/workflows/release.yml`（按 D2 塌缩）

终态为三个 job：

1. **check**：保持现状（checkout → pnpm → node 24 → install --frozen-lockfile → check-types → compile）。
2. **package**：`needs: check`，单 Job `ubuntu-latest`。步骤：checkout → pnpm → node 24 → install → **下载 tree-sitter WASM（保留，D1）** → compile → `vsce package`（**不带 `--target`**）→ 上传 artifact，名称 `mutsumi-universal`，路径 `./*.vsix`，`if-no-files-found: error`。
3. **release**：`needs: package`（删去对 package-universal 的依赖），保持从 package.json 读版本号、`softprops/action-gh-release` 创建 Release；`files` 列表只剩 `artifacts/mutsumi-universal/*.vsix`。

删除：4 平台 matrix、better-sqlite3 artifact 上传 / 下载 / 整理、sqlite-vec 跨平台包装入与注入、universal 包内 better-sqlite3 去重、`delete-artifact` 步骤、`package-universal` job 及其 `actions: write` 权限。

### 3.13 `docs/ci-multiplatform-target.md`

重写为与 3.12 一致的目标状态：单一 universal VSIX、无原生处理、保留 WASM 下载、Node 版本以 workflow 实际（24.x）为准；只描述当下目标状态，不写历史缘由（用户指示）。`ci.yml` 部分按仓库现状校对（文件已存在）。

### 3.14 `AGENTS.md`

- 目录树 `codebase/` 行：改为 Tree-sitter 大纲服务（project_outline 依赖），不含 RAG。
- §6 删去"RAG/codebase：`query_codebase` 按 embedding endpoint 是否配置被条件剔除"整条。
- §7 激活时序：`SkillManager / Codebase / RAG` → `SkillManager / Codebase`；命令注册行的 `testRagSearch` 删去；"当前命令集"列举中的 `testRagSearch` 删去。
- §9 pnpm 段落：更新"从而使 better-sqlite3 等 4 个原生 external 正常进入 vsix"的表述——现存 external 为 `web-tree-sitter` 与 `node-notifier`（均非原生但需随 vsix 分发），`nodeLinker: hoisted` 保留理由不变；"新增带 install 脚本的原生依赖时必须加 allowBuilds"的告诫保留（面向未来）。

### 3.15 `README.md` / `README_zh.md`

- 删去 Observability 小节中"preview RAG search results"一句（en 约 80 行处，zh 对应位置）。
- 工具列表"Code Search / 代码搜索"行删去 `query_codebase`（约 312 行处）。
- 依赖表删去 `better-sqlite3`、`sqlite-vec` 两行；保留 `web-tree-sitter` 行。
- 两份 README 中若另有 RAG / embedding 相关描述，一并清理（以 grep 为准）。

## 4. 边界情况与分支行为

- **旧 .mtm 会话历史含 `query_codebase` 工具调用**：必须仍能正常渲染。`ToolSet.getPrettyPrint` 对未知工具有通用回退（`🔧 Tool Call: <name>`），无需迁移代码；implementer 确认该回退路径未被破坏即可。
- **用户配置含 `query_codebase`**：按 D3 严格校验报错（unknown tool），用户自行从 settings 中移除；代码中不存在任何针对该名字的特殊分支。
- **多工作区 / 远程 scheme**：随 RAG 监听器删除而不再相关，无新增行为。
- **`project_outline` 功能回归**：依赖链 `projectOutlineTool → CodebaseService → web-tree-sitter + assets/tree-sitter/*.wasm` 全部保留；extension.ts 中 CodebaseService 初始化不得误删。

## 5. 明确不做（Out of Scope）

- 不 bump `package.json` version；不改任何发布流程的触发方式（仍 workflow_dispatch）。
- 不新增任何替代性代码搜索工具；不调整 grep/glob/read 等现有工具。
- 不清理用户机上的 rag.db 残留；不为 `embeddingEndpoint` 写设置迁移。
- 不修改历史设计文档（D4）；不动 `docs/vscode-api.md`；不动 `.VSCodeCounter/` 输出。
- 不改动 `ci.yml`（日常检查 workflow）。
- 不重构 / 不更名 `CodebaseService`（保持最小 diff）。

## 6. 验收标准

1. `pnpm install` 成功，lockfile 更新且无被删依赖残留。
2. `pnpm run check-types` 通过。
3. `node esbuild.js` 通过。
4. `git diff --check` 干净。
5. 清扫式 grep：`RagService`、`query_codebase`、`queryCodebase`、`embeddingEndpoint`、`testRag`、`better-sqlite3`、`sqlite-vec`、`sqlite_vec` 在 `src/`、`package.json`、`package.nls*.json`、`l10n/`、`esbuild.js`、`pnpm-workspace.yaml`、`.github/workflows/` 中零命中（`pnpm-lock.yaml` 与被明确豁免的历史文档除外；`.VSCodeCounter/` 忽略）。
6. `web-tree-sitter`、`node-notifier`、`assets/tree-sitter/download_wasm.py` 引用仍然存在且正确。
7. release.yml 不含 matrix / `--target` / better-sqlite3 / sqlite-vec 字样，YAML 无诊断错误。
8. （尽力而为）`pnpm run package` 能产出 vsix——需本地已有 `assets/tree-sitter/*.wasm`；若本地缺 wasm 无法验证，则在报告中说明，CI check job 已覆盖 compile 验证。

## 7. 已知不阻塞的不确定性

- ~~`lzma-native` 是否在依赖树~~ 已解决：执行中确认其离开依赖树，allowBuilds 条目已删；`keytar` 等其余条目保留。
- README 中可能还有本次 grep 未覆盖的 RAG 措辞：implementer 以全文 grep 兜底清理，措辞微调留给 implementer 判断。
