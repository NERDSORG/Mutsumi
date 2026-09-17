# .mtm v1 → v2 迁移规范（供独立迁移器施工）

> 背景：kosong 接线（M1–M4.1）将消息模型从 OpenAI 形 `AgentMessage` 破坏性替换为 kosong `Message` 形。本仓库代码**不含任何兼容逻辑**（项目规则）；旧文件的兼容由独立迁移工具承担。
> 事实源：`docs/kosong-m1-m2-final-target_CN.md`（M2 模型切换契约）+ 本文件逐一核对的当前读取路径。
> 判别锚点：新格式文件带 `metadata.mtm_version: 2`；旧文件无此字段。**迁移器幂等性 = 跳过带标记的文件**。

## 1. 格式差异总览（v1 → v2）

`.mtm` 根结构不变：`{ metadata, context: AgentMessage[] }`。变化全部在 `context[]` 元素的消息形状：

| 字段 | v1（旧） | v2（新，kosong 形） | 不迁移的后果 |
|---|---|---|---|
| `content` | `string \| 蛇形part[] \| null` | 恒为 `ContentPart[]`（驼峰，可含 think） | **打开即崩溃**（见 §2-A） |
| `tool_calls` | 嵌套形 `{id, type:'function', function:{name, arguments}}`，可选 | `toolCalls` 平直形 `{type:'function', id, name, arguments}`，**必有**（可空数组） | **打开即崩溃**（见 §2-B） |
| `tool_call_id` | 蛇形，可选 | `toolCallId` 驼峰 | 工具结果消息失去关联 ID，发送时 provider 400 |
| `reasoning_content` | 字符串字段，可选 | 删除；思考进 `content` 的 `ThinkPart {type:'think', think}` | 思考链从上下文中静默丢失（不崩溃） |
| 图片 part | `{type:'image_url', image_url:{url, detail?}}` | `{type:'image_url', imageUrl:{url}}`（detail 删除） | 实际几乎不出现（见 §3-E） |
| `metadata` | 不变（`last_ghost_block` 等管线字段原样保留） | 同左 | 无需迁移 |
| `metadata.mtm_version` | 无 | `2` | 迁移器写入 |

## 2. 破坏点精确定位（旧文件在新代码下的死法）

### A. 打开/渲染路径（双击旧 .mtm 即触发）

`deserializeNotebook → messagesToGenericCells`：

1. `serializeContentToString(msg.content)` 对 string 型 content 调 `.map` → **TypeError**（user/system 消息首当其冲）。
2. user cell 带交互组时 `buildInteractionRenderBlocks(m)`：`m.content.filter(...)`（提取 think parts）对 string → **TypeError**；`for (const tc of m.toolCalls)` 对 undefined → **TypeError**。

即：**旧文件在新版本里连打开都做不到**，表现为反序列化异常。这是最硬的破坏点。

### B. 运行/发送路径（即使文件被某种方式打开）

1. `history.ts` 历史重放对 user 消息调 `extractText(msg)`（内部 `content.filter`）→ string 崩溃。
2. runner 发送边界对 system 消息调 `extractText` → 同上。
3. kosong 适配器 `convertMessage` 显式读 `content`（数组遍历）/`toolCalls.length`/`toolCallId` → 旧字段全部读不到：content 为 string 直接崩溃；`toolCalls` undefined 崩溃；`tool_call_id` 读不到导致 tool 消息上线缺 ID → provider 400（tool 交换邻接校验）。

### C. 不崩溃但语义降级

- `reasoning_content` 无读者（全库已删）→ 旧会话的思考内容不再回传，思考链断裂。kosong openai 线的"历史含 ThinkPart 自动补发 medium"不会触发（因为没有 ThinkPart），行为上等同 thinking 被关闭。
- `metadata.reasoning_effort: 'none'`（M4.1 改名前）：逐字透传为模型声明值，服务端大概率报错可见——可接受，但迁移器顺手映射为 `'off'` 更干净。

## 3. 迁移算法（逐消息映射规则）

对 `context[]` 每条消息，按 role 执行：

```
通用：
  toolCalls := (msg.tool_calls ?? []).map(tc => ({
    type: 'function', id: tc.id, name: tc.function.name,
    arguments: tc.function.arguments ?? null }))
  删除 tool_calls；若存在 tool_call_id → 改名 toolCallId
  metadata 原样保留；最终对象必须恒有 toolCalls（可空数组）

role=system / user：
  content: string → [{type:'text', text}]；数组 → 逐 part 转换（见下）

role=assistant：
  content: null → []；string → [text part]；数组 → 逐 part 转换
  reasoning_content 存在 → 在 content 头部插入 {type:'think', think: 值}
    （与 M2 装配顺序一致：think part 先于 text part）
  删除 reasoning_content

role=tool：
  content: string → [text part]

part 转换（v1 数组中的元素，仅 text/image 两种）：
  {type:'text', text} → 原样
  {type:'image_url', image_url:{url, detail?}} → {type:'image_url', imageUrl:{url}}（detail 丢弃）

根级：
  metadata.mtm_version := 2
  metadata.reasoning_effort === 'none' → 'off'（M4.1 词表对齐）
```

## 4. 边界情况与注意事项

- **A. 幽灵块零迁移**：`metadata.last_ghost_block` 的 GhostBlock 结构本次未变，`decodeGhostBlock` 照常吃。
- **B. 空数组 content 的合法性**：`content: []` 在 v2 是合法的（assistant 纯工具调用），迁移器不要"好心"补空 text part。
- **C. 图片 part 几乎不会出现**：v1 的 user 多模态内容以原始 markdown 持久化（图片在发送时才解析），content 数组形态在 v1 文件中基本不存在——但按规则处理成本为零，写上无妨。
- **D. 明确不防御的情况**：手工编辑出的 `mutsumi_interaction`、手工篡改的 `mtm_version`、部分迁移过的半成品——**一律视为文件损坏**，走损坏报错路径，不做任何猜测性修复。
- **E. orphan assistant 消息不存在**：assistant/tool 消息只可能存在于 user cell 的输出区（`mutsumi_interaction`），删除 user prompt 会连 cell 一起删除——v1 文件中不可能出现无前置 user 的 assistant 组。迁移器无需处理该形态（serializer 里的 orphan 分支是运行时保险丝，不是格式事实）。
- **F. 验证方式**：迁移后用新版本扩展打开文件 + 跑一轮对话（发送路径会立刻检验 content/toolCalls/toolCallId 的完整性）；迁移器自带 fixture 测试（v1 样本 → 期望 v2 输出逐字段比对）。

## 5. 架构：git submodule 迁移器 + 插件侧版本调度器

### 5.1 分工

- **`mtm-migrator/`（git submodule，本仓库子目录）**：唯一的迁移知识所在地。对外契约只有两个导出：`CURRENT_STEPS`（`Map<number, (doc: unknown) => unknown>`，键 = 源版本号，值 = 到下一版本的纯 JSON→JSON 迁移函数）和 `migrateFile(doc)`（对一个文件的 JSON 对象顺序执行从 n 到 n+1 …直到当前版本的完整链）。迁移器只为迁移**单个文件**而存在。
- **插件侧（本仓库 src/，版本无关的薄调度器，一处）**：只在 `.mtm` 被打开时介入。**它不持有任何逐版本兼容逻辑**，只依赖两个符号：当前写入版本号常量与 `migrateFile`。

### 5.2 打开时的判定流程（`deserializeNotebook` 预检）

```
读文件 bytes → JSON.parse
  ├─ parse 失败                → 损坏：报错，不打开
  ├─ metadata.mtm_version === 当前版本（2）
  │    → 正常转换路径；若此处崩溃 = 文件损坏（含手改版本号），报错，不迁移
  ├─ version 缺失（视为 1）或 < 当前版本
  │    → migrateFile(doc)：顺序执行 STEPS[v]→v+1 …→当前版本
  │    → 迁移结果写回文件（workspace.fs 直写）→ 以迁移后数据继续打开
  └─ version > 当前版本        → "文件来自更新版本的 Mutsumi"报错，不打开
```

设计要点：**用版本预检而不是依赖崩溃现场**——v1 文件在新代码下的崩溃位置是偶然的（随实现漂移），版本号才是稳定契约；catch 只作为损坏文件的报错兜底。旧格式文件本来就打不开，所以"迁移后写回再打开"不存在与编辑器内存态的冲突。

### 5.3 工程注意

- esbuild 会把 submodule 的源码直接 bundle 进 extension.js；tsconfig 的 include 需覆盖子目录。
- 未来格式 v3 落地时：本仓库只需把当前版本常量改为 3 并向 submodule 更新一步 `STEPS[2]`——插件侧调度器零改动，这就是"解耦"二字的兑现。
- 插件侧调度器是唯一的例外代码（版本检测 + 顺序执行 + 损坏报错），它是版本无关的基础设施，不是兼容层。
