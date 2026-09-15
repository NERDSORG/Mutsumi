# Reasoning Effort 支持 — 最终目标状态文档

> 状态：**已冻结**（2026-09-16，v1.4）。本文档是 planner / implementer / reviewer 的唯一权威依据。
> 任何实现中暴露的偏差，必须先修订本文档，再调整实现。

---

## 1. 目标终态

Mutsumi 支持统一的 `reasoning_effort` 字段，覆盖全部 LLM 调用路径（notebook 执行、HTTP headless 执行），
并提供两层控制面：VSCode notebook 工具栏交互、HTTP 端点（D4 v1.1：无全局设置，全局行为固定为不发送）。
发送面（v1.3 起）统一经 kosong `withThinking` morph 下发：具体档位在 openai 线上等价于顶层
`reasoning_effort` 原样透传，在 kimi 线上编码为 `extra_body.thinking`；线间差异由 kosong 适配器吸收，
宿主不做 baseurl 启发式识别、不加 provider 级配置字段（唯一保留的宿主分流是 D3 的 default 分支，理由见 D3）。

## 2. 已冻结决策（用户拍板）

| # | 决策 |
|---|---|
| D1 | 取值集合暴露厂商超集 + `default`：`'default' \| 'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`。`default` = **根本不发送** `reasoning_effort` 字段（由服务器决定行为）。 |
| D2 | 不提供 thinking 开关（`thinking.type` 等布尔开关不进入配置面）。`off` 是唯一的"关闭思考"表达（v1.4 起与 kosong `withThinking` 保留字同名），经 kosong `withThinking('off')` 逐字下发，具体线编码由 kosong 适配器决定（openai 线未配置 `offEffort` 时不发字段；kimi 线发 `extra_body.thinking={type:'disabled'}`）；若 provider 实际无法关闭或报错，由用户改用其他值。 |
| D3 | 发送面统一走 kosong `withThinking` morph（v1.3 起，废除"仅顶层透传、零特化"；v1.4 起词表 `'none'` 更名 `'off'`，值翻译随之消失）。映射规则（写在 AgentRunner 构造器一处）：**任意具体值（含 `'off'`）原样 `withThinking(值)`，零值翻译**；`default`/缺省 + openai 线 → `withThinking('off')`；`default`/缺省 + 其他线 → 不调 morph。理由：① openai 适配器在历史含 ThinkPart 且未配置 effort 时会自动补发 `reasoning_effort='medium'`（One API 类校验兼容），不抑制则"default=不发送"契约在第二轮起被静默打破；`withThinking('off')` 在未配置 `offEffort` 时线上**不发任何字段**，与旧行为逐字节等价且恰好跳过自动启用分支。② kimi 线不能同样抑制：`withThinking('off')` 会主动发 `extra_body.thinking={type:'disabled'}`——那是"关闭"而非"默认"，破坏服务端默认行为；default 分支按线型分流是 withThinking 语义决定的**必要**特化，不是冗余。③ 具体值线结果：openai 线 = 顶层 `reasoning_effort` 原样（与旧行为等价；`'off'` 发 `offEffort`，未配置则不发字段）；kimi 线 = `extra_body.thinking={type:'enabled',effort}`（`'off'` 编码为 `{type:'disabled'}`）；anthropic/google 线 = kosong 原生映射。仍不做 baseurl 启发式识别，不加 provider 级配置字段。 |
| D4 | 配置层级只有一级：每 agent 覆盖（`notebook.metadata.reasoning_effort`，持久化于 `.mtm`）。**不提供全局档位设置——全局行为固定为 default（不发送字段）**。理由（用户拍板）：档位取值是模型相关的（GLM-5.2 无 `low`、DeepSeek 无 `off`、Kimi 强制思考），而各会话模型异构，任何全局具体档位都必然在某些会话变成非法值。**无** agent-type 级默认；**无**父子 agent 继承。 |
| D5 | title 生成 / 对话压缩等内部 runner **一律不发送**该字段（相当于强制 default），因为我们不知道用户的辅助模型支持哪些档位。推论：**reasoning_effort 的解析逻辑只能放在调用方（controller.ts / httpServer/chat.ts），AgentRunner 与 provider 构造层绝不自行读取与 reasoning effort 相关的任何配置**。（注：AgentRunner 中既有的 `titleGeneratorModel` 配置读取属本任务之前的存量行为，与 effort 无关，不在本禁令范围内。）withThinking 语义（v1.3）下的实现方式：内部 runner 本来就不传 `reasoningEffort`，自动落入 D3 的 default 分支（openai 线被 `withThinking('off')` 抑制为不发字段；kimi 线不 morph = 服务端默认）——不给内部 runner 开"例外通道"。 |
| D6 | 服务器 400（取值不被模型接受）→ 按现状错误路径直接弹出（通知 + error block），不自动剥离参数重试。 |
| D7 | HTTP server 新增取/改思考等级的端点，且**必须作用在 adapter 接口的抽象函数上**：headless adapter 直接读写裸 `.mtm` 文件；notebook adapter 在文档已打开时走 VSCode WorkspaceEdit（尊重脏缓冲区），未打开时回退为直接文件读写。 |
| D8 | **交互合并**：reasoning effort 选择并入既有 Select Model QuickPick（分节分隔线），**不新增命令/工具栏项**。点模型 item = 换模型 + 强制重置 effort 为 default；点 effort item = 只改 effort。"无覆盖"在 metadata 中的规范形态为 **key 缺席**；发送侧当值为 undefined 时，请求体中 `reasoning_effort` key 必须完全不存在。 |

## 3. 值域与归一化（单一事实源）

抽象契约（具体落点文件由 implementer 决定，建议 `src/agent/types.ts` 或 `src/utils.ts`）：

```typescript
// 具体档位（会真实发送给服务器的值）
type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// 用户可配置的全集（含"不发送"语义）
type ReasoningEffortSetting = ReasoningEffort | 'default';
// 单一事实源常量，供 QuickPick / HTTP 校验 / package.json enum 对齐
const REASONING_EFFORT_SETTING_VALUES: readonly ReasoningEffortSetting[];

// 归一化规则：'default' | '' | undefined → undefined（不发送字段）
// 其余任何字符串**原样透传**（包括手改 .mtm 产生的未知值——配合 D6 让服务器报错可见）
function normalizeReasoningEffort(value: string | undefined | null): string | undefined;
```

运行时解析优先级（两条执行路径一致）：

```
HTTP chat 请求体覆盖（瞬态，不持久化）
  > notebook/agent metadata.reasoning_effort
  > normalize → undefined 时不发送（D4：无全局默认，全局行为固定为 default）
```

注意：HTTP chat 请求体的 `reasoning_effort` 是**瞬态逐请求覆盖，不写入 metadata**。
持久化只能走 D7 的 PUT 端点。这是与现有 `model` body 参数（会写回 metadata）的**有意不对称**，文档在此备查。

## 4. 接口契约（抽象，不含实现）

### 4.1 LLM 请求层（v1.3：kosong 接线后）

```typescript
// AgentRunOptions 携带调用方解析好的 effort（normalize 后，'default'/缺省 = undefined）；
// AgentRunner 绝不自行读取任何 reasoning-effort 配置（D5）。
interface AgentRunOptions { /* ... */ providerType: ProviderType; reasoningEffort?: string }

// AgentRunner 构造器：createProvider({ type: providerType, model, apiKey, baseUrl, ... })
// 之后按 D3 映射表 morph：
//   effort 为具体值（含 'off'）→ provider = provider.withThinking(值原样)  // 零值翻译（v1.4）
//   effort undefined 且 openai 线 → provider = provider.withThinking('off')  // 抑制自动启用，线上不发字段
//   effort undefined 且其他线   → 不调 withThinking（服务端默认）
// withThinking 返回浅拷贝，必须把返回值赋回去；禁止 deep clone（会断 _client / 方言共享）。
```

### 4.2 元数据持久层

```typescript
// src/types.ts
interface AgentMetadata { /* ... */ reasoning_effort?: string }
```

### 4.3 Adapter 抽象（D7 核心）

```typescript
// adapters/interfaces.ts — IAgentAdapter 增加可选方法：
interface IAgentAdapter {
    // ...现有成员
    /** 读取某 agent 文件当前 reasoning_effort 覆盖值；未设置返回 undefined */
    getReasoningEffort?(fileUri: vscode.Uri): Promise<string | undefined>;
    /** 写入覆盖值；传入 undefined / 'default' 时移除该 key（恢复继承全局） */
    setReasoningEffort?(fileUri: vscode.Uri, effort: string | undefined): Promise<void>;
}
```

实现矩阵：

| Adapter | 行为 |
|---|---|
| `NotebookAdapter` | 若该 uri 对应已打开的 NotebookDocument → `WorkspaceEdit` + `NotebookEdit.updateNotebookMetadata`（以内存 metadata 为基准，保留未保存改动，镜像 `selectModel.ts` 现有写法）；若未打开 → 回退为直接读写 `.mtm` JSON |
| `HeadlessAdapter` | 直接读写 `.mtm` JSON（`metadata.reasoning_effort`） |
| `LiteAdapter` | **不实现，有意省略**。可选方法缺席即合法（该接口已有 `activate?`/`getSession?`/`dispose?` 等可选先例）。理由：Lite 会话临时、无持久目标、无 fileUri、不入 agent registry——HTTP 端点与 QuickPick 两条调用路径对它均不可达；D5 亦保证其 runner 从不携带 effort，无值可读可写。**明确否决"空实现返回 undefined"**——那会把"本操作对此 adapter 不适用"伪装成"未设置覆盖"，语义失真 |

另需一个**解析器**（实现形式不限）：给定 fileUri，若其已作为 notebook 打开则返回 notebook 侧实现，否则返回 headless 侧实现。HTTP 端点使用此解析路径（VSCode 命令不走此路径，见第 5 节）。
（`NotebookAdapter` 当前按执行临时构造且构造函数依赖 controller，元数据读写不应依赖 controller——构造细节由 implementer 解决。）

### 4.4 HTTP 端点

```
GET /agent/:uuid/reasoning-effort
→ 200: { status: 'ok', agent: { uuid, override: string|null, effective: string } }
   override = metadata 中的原始覆盖值（未设置=null）
   effective= normalize(override)；为 undefined（不发送）时返回字符串 'default'

PUT /agent/:uuid/reasoning-effort
body: { reasoning_effort: <REASONING_EFFORT_SETTING_VALUES 之一> }
→ 校验失败 400（列出合法值）；'default' 语义 = 清除覆盖
→ 200: { status: 'updated', agent: { uuid, override: string|null, effective: string } }

POST /agent/:uuid/chat  （既有端点扩展）
body 新增可选 reasoning_effort：同一值域校验，瞬态覆盖本次请求，不持久化
```

## 5. 交互层（VSCode）— 按 D8 合并进既有命令

- **不新增命令、不新增工具栏项**（工具栏已过长）。将 reasoning effort 选择并入既有
  `mutsumi.selectModel` 命令的 QuickPick（`src/notebook/commands/selectModel.ts`）：
  - QuickPick 结构（利用 `vscode.QuickPickItemKind.Separator`）：
    `Model:` 分隔线 → 模型 items → `Reasoning effort:` 分隔线 → effort items；
  - effort items = 8 个值域值；`default` 项标注其语义为"不发送该字段，由服务器决定"
    （D4 修订后：无全局继承可言，default 即缺省不发送）；
  - Current 标注规则（冻结）：模型区段照旧；effort 区段的 Current 落在**生效值**上——
    `effective = normalizeReasoningEffort(metadata.reasoning_effort)`；
    effective 为具体档位 → 该档位项标 Current；effective 为 undefined → `default` 项标 Current；
- **交互语义（冻结）**：
  - 点击**模型** item → 更新 `metadata.model`，并**在同一次 metadata 更新中强制重置**
    reasoning effort 为 default（移除 metadata key）；
  - 点击 **effort** item → 仅写 `metadata.reasoning_effort`（选 `default` = 移除 key），不触碰模型。
- **持久化表示（冻结）**：metadata 中"无覆盖"的规范形态 = **key 缺席**。所有写路径必须
  `delete` 该 key，不得写入 `null` 或 `'default'` 字面值，保证 `.mtm` 经 JSON round-trip 后干净。
- 命令直接在编辑器上下文内写 metadata（沿用 `selectModel.ts` 现有 WorkspaceEdit 模式，含 delete-key 语义）；4.3 的 adapter 抽象服务于 HTTP / 文件路径（需要处理"文档未打开"回退）。两者入口上下文不同（活动编辑器 vs fileUri），接受少量重复以换取里程碑 M2/M3 解耦——**不再要求命令走 adapter 实现的单一代码路径**。
- `package.json`：**零净改动**（D4 修订：无全局设置；`commands` / `menus` 亦不动）。

## 6. 受影响文件全清单

**修改：**
- `src/agent/types.ts` — `AgentRunOptions`（+ 值域常量/归一化函数的推荐落点）
- `src/agent/llmClient.ts` — `LLMClientConfig` + 两处 `completions.create` 注入（**v1.3 注：该文件已在 kosong 接线 M3 中整体删除；请求组装的现行契约见 §4.1**）
- `src/agent/agentRunner.ts` — 构造函数透传（仅此一处，**不得新增配置读取**）（**v1.3：透传目标由 LLMClient 变为 `createProvider` + `withThinking` morph，见 §4.1**）
- `src/types.ts` — `AgentMetadata.reasoning_effort`
- `src/adapters/interfaces.ts` — `IAgentAdapter` 抽象方法
- `src/adapters/notebookAdapter.ts` — notebook 侧实现
- `src/adapters/headlessAdapter.ts` — headless 侧实现
- `src/controller.ts` — notebook 执行路径的解析与注入
- `src/httpServer/chat.ts` — headless 执行路径的解析与注入 + body 校验
- `src/httpServer/index.ts` — 注册两个新端点
- `src/notebook/commands/selectModel.ts` — QuickPick 重构（D8：分节、双语义、强制重置）
- `package.json` — 净零改动（M2 曾加入的全局设置已按 D4 修订移除）

**新增：**
- `src/httpServer/reasoningEffort.ts`（GET/PUT handler，命名可调整）

**确认无需改动（已核实）：**
- `src/agent/llmStream.ts`（只消费 stream，不组请求）（**v1.3 注：该文件已在 kosong 接线 M3 中整体删除，由 `generateStream.ts`（流式泵）替代**）
- 渲染/序列化链路（`uiRenderer.ts` / `renderer.ts` / `serializer.ts`）：reasoning 的流式渲染、提交、`.mtm` round-trip 已完整存在
- `src/agent/fileOps.ts`（`sanitizeAgentFile` 保留未知 metadata key；新建 agent 无覆盖即不发送，符合 D4）
- `src/agent/titleGenerator.ts`、`src/notebook/commands/compressConversation.ts`（D5：不传即默认，**零改动**——这是设计要求而非遗漏）
- `src/notebook/commands/index.ts`、`src/notebook/toolbar.ts`（D8：无新命令，注册链不变）
- Preserved Thinking 回传：assistant 消息的思考内容写回 messages（v1.3：经 kosong 装配的 `result.message` 中 ThinkPart 原样入史），天然满足 Kimi/DeepSeek 要求

## 7. 边界与异常

| 场景 | 行为 |
|---|---|
| 手改 `.mtm` 写入非法值 | 原样透传 → 服务器 400 → 按 D6 弹出，用户自行修正（归一化函数不得静默丢弃未知值） |
| 旧版 `.mtm` 持久化的 `reasoning_effort: 'none'`（v1.4 前词表） | **有意不兼容**：`'none'` 已非合法档位；归一化不丢弃未知值 → 经 `withThinking('none')` 逐字透传，kosong 将其视作模型声明值原样发出 → 服务端校验报错按 D6 弹出，用户在 QuickPick 重选 `off` 即恢复。不提供代码内迁移或兼容映射 |
| HTTP PUT 时 notebook 已打开且有未保存改动 | notebook 侧 WorkspaceEdit 修改内存 metadata，脏状态语义由 VSCode 管理 |
| HTTP PUT 时 notebook 未打开 | 回退直接写 `.mtm` 文件 |
| 执行中（run 进行中）修改 effort | 仅影响**下一次**执行；当前 run 的 provider 已构造，不热更新（与 model 现状一致） |
| ~~`temperature: 1` 与思考模式共存~~（v1.3 起失效） | kosong 接线 M3 起 Mutsumi 不再发送任何 sampling 参数（temperature/tool_choice 均不发，服务端默认即正确） |
| 请求头 `User-Agent: KimiCLI/1.30.0` | 与本次改动无关，保持现状 |

## 8. 明确不做（Out of Scope）

- thinking 开关（`thinking.type`）及 D3 映射表之外的一切宿主侧 provider 特化（线编码差异由 kosong 适配器吸收）
- `offEffort` 配置（openai 线"关闭"的显式值；未来若有 xai 类默认推理端点需要，再走设置 schema 演进）
- agent-type 级默认、父子 agent 继承
- 400 自动降级重试
- 将既有 `PUT /agent/:uuid/model` 重构到新的 adapter 抽象上（可作后续跟进项，本次不动）
- 侧边栏 / `agent_control` 工具中展示当前 effort
- OpenAI Responses API 的 `reasoning.summary`（Mutsumi 走 Chat Completions）

## 9. 已知不确定性（不阻塞）

- `openai` npm 包 v6 的 ChatCompletion 参数类型是否已原生包含 `reasoning_effort`；若无，implementer 自行处理类型层面的透传（运行时字段必须发出）。
- `REASONING_EFFORT_SETTING_VALUES` 的消费方（QuickPick、HTTP 校验）均直接 import 该常量，无跨文件同步负担。（v1.1：package.json enum 已随全局设置一并废止。）

## 10. 里程碑

- **M1 — 核心透传**：值域常量 + 归一化、`AgentRunOptions`/`LLMClientConfig`/请求注入、`controller.ts` 与 `httpServer/chat.ts` 解析链。验收（v1.1 措辞）：metadata 写入覆盖后抓包/日志可见字段；无覆盖或 `default` 时字段缺席。
- **M2 — VSCode 交互**：`selectModel.ts` QuickPick 重构（分节、双语义、强制重置）。验收：工具栏既有按钮 → 分节 QuickPick → 点模型换模型且 effort 回 default、点 effort 只改 effort → `.mtm` 中 key 出席/缺席正确 → 下次执行生效。（v1.1：无 package.json 改动）
- **M3 — Adapter 抽象 + HTTP 端点**：`IAgentAdapter` 方法、双实现、解析器、GET/PUT、chat body 瞬态覆盖。验收：curl 对打开/未打开 agent 分别 GET/PUT 均正确；PUT 非法值 400。
- **M4 — 审查与构建**：reviewer 审计 + `npm run check-types` 通过。

依赖关系：M1 先行；M2 与 M3 在 M1 完成后可并行；M4 收尾。

---

## 变更记录

- **v1.1（2026-07-26，M4 审计后用户决策）**：
  - **D4 修订**：移除全局档位设置（`mutsumi.defaultReasoningEffort` 废止，package.json 净零改动）。
    全局行为固定为 default（不发送）。理由：档位取值模型相关 + 各会话模型异构 → 全局具体档位必然在部分会话非法。
    连带：解析链去除全局层；GET 响应移除 `global_default` 字段；QuickPick `default` 项语义改为"不发送，服务器决定"；
    Current 标注简化为 `normalize(metadata.reasoning_effort)`。
  - **D5 措辞收窄**：配置读取禁令明确限定为 reasoning-effort 相关配置；
    AgentRunner 既有的 `titleGeneratorModel` 读取为存量行为，予以豁免（M4 审计 Major-1 裁决）。
  - **Current 标注规则明确**（M4 审计 Major-2）：标注落在生效值而非存储状态；D4 修订后二者天然重合。
- **v1.2（2026-07-26，第二轮审计后）**：
  - **归一化函数去 trim**（审计 Major-1）：`normalizeReasoningEffort` 改为严格相等判断——仅 `null`/`undefined`/`''`/`'default'`
    精确匹配时返回 undefined；其余任何字符串（含带空白、未知值）**原样透传**，与第 3 节冻结语义及 D6"错误可见"对齐。
    （根因：M1 派发提示词与文档第 3 节不一致，orchestrator 失误，文档本身无需改。）
  - **v1.1 残留文本清扫**（审计 Major-2）：§1 控制面描述、§6 fileOps 行、§9 同步负担、M1/M2 验收措辞改为现行语义；
    `interfaces.ts` JSDoc 中 "inherits the global setting" 改为"不发送字段，由服务器决定"。
- **v1.3（2026-09-15，kosong 接线 M4）**：
  - **D2/D3 修订**：发送面由"所有 provider 只透传顶层 `reasoning_effort`、零特化"改为 kosong `withThinking` morph。
    映射规则与理由见 D3（`'none'→withThinking('off')`；具体值原样；default+openai 线→`withThinking('off')`
    抑制该线 thinking 自动启用，否则第二轮起"default=不发送"被静默打破；default+其他线→不 morph，
    因 kimi 线 `withThinking('off')` 会主动发 disabled，是"关闭"非"默认"）。
    D2 同步改为经 `withThinking('off')` 表达"关闭思考"，线编码由 kosong 适配器决定。
  - **D5 保留**：内部 runner（title/compress）不发送该字段的语义不变；withThinking 下由 D3 default 分支自然实现，无例外通道。
  - **连带清扫**（随 kosong M3 删除手搓 LLM 层而失效的文本）：§1 发送面描述、§4.1 请求层契约（LLMClient→createProvider+withThinking）、
    §6 llmClient/llmStream 行加失效标注、§6"Preserved Thinking 回传"机制措辞、§7 `temperature` 行（M3 起不再发送任何 sampling 参数）、
    §7 "LLMClient 已构造"措辞、§8 "一切 provider 特化映射"收窄为"D3 映射表之外的宿主侧特化"并新增 `offEffort` 不引入条目。
  - **不变面确认**：UI 档位列表（QuickPick）、`normalizeReasoningEffort`、metadata `reasoning_effort` 字段、
    HTTP GET/PUT 端点签名、i18n、package.json——全部不动。
- **v1.4（2026-09-16，M4.1 词表统一）**：
  - **D1/D2/D3 词表修订**：具体档位 `'none'` 更名为 `'off'`，与 kosong `withThinking` 保留字对齐
    （界面档位顺序：`default, off, minimal, low, medium, high, xhigh, max`）。
    runner 映射随之塌缩为"具体值逐字透传 + default 分支按线型分流"，`'none' → withThinking('off')`
    值翻译分支删除。
  - **旧值 `'none'` 有意不兼容**：旧 `.mtm` 持久化的 `reasoning_effort: 'none'` 将被逐字透传
    （kosong 视作模型声明值，§7 新增边界行），服务端报错可见、用户重选 `off` 即可；
    不提供迁移器或兼容映射。
  - 连带：QuickPick 描述 key `selectModel.effort.none` → `selectModel.effort.off`（picker label
    直接显示原始值 `off`）；HTTP 校验消费 `REASONING_EFFORT_SETTING_VALUES` 常量数组自动跟随，端点零改动。
