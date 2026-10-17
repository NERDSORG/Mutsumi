# Mutsumi

[![License](https://img.shields.io/github/license/MalachiteN/Mutsumi)](LICENSE)
[![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.108.0-blue)](https://code.visualstudio.com/)

Mutsumi 是一个运行在 VS Code 主编辑器区域的多 Agent 对话环境。会话保存为纯文本文件，上下文由你显式组合，模型和 API 密钥由你自带。

它假设你知道自己要做什么。你的工作是把需求描述准确，而它负责让你精选和拼装上下文的过程更顺畅。

[English](README.md)

## 设计立场

### 会话即文件

每个 Agent 会话是一个 `.mtm` 文件（JSON 格式），放在工作区的 `.mutsumi/` 目录里。文件是会话的唯一权威状态，对话界面只是它的呈现：关掉编辑器会话不会结束，依然在后台运行，重新打开就恢复到原样，一个会话可以同时在多种不同的前端查看，状态都会是同步的。

因为就是普通文本文件，所以会话可以直接进 git，能 diff、能分享、能多机同步，不需要任何额外的同步功能。

### 上下文由你显式组合

Mutsumi 不做自动检索，没有 RAG，因此没有魔法。

上下文面板里是 rules、skills、宏、文件引用、MCP 工具，全部逐会话手动开关。`@[路径]` 引用的是文件的快照，直接放进消息里，带版本跟踪，过期了可以一键裁掉。

这块面板同时也是前缀缓存的控制台：不动它，会话前缀稳定，就能命中提供商的 KV 缓存（如果没过期）；动了它，缓存可能失效，但上下文可能变得更精巧紧凑。这个 tradeoff 是你自己选的。

### 人可以直接操作工具平面

工具不只是模型在用。用户在输入框里写 `@[shell{"cmd": "uname -a"}]`，这条命令就由你亲手决定预执行，结果注入进上下文，模型接着往下做。文件、目录、工具都有 `@` 自动补全，带参数的工具会弹出表单。

模型侧的写操作一律过审批卡。拒绝可以附理由，模型会看到理由再调整；编辑操作支持自定义动作；信任建立之后也有全局自动批准开关。

用户可以随时 steer 运行中的 Agent（在工具批次的边界注入，不打断当前输出），也可以 queue，把消息先发出去，等它这一轮次全部工具调用都做完再处理。

### 多 Agent 是一等会话

`dispatch_subagents` 把任务拆给多个子 Agent 并行做。每个子 Agent 都是真实会话：有自己的 `.mtm` 文件，出现在侧边栏的 Agent 树里，你可以打开看它在干什么，可以打断，可以注入消息。任务做完会话还在，想接着聊就接着聊。任意两个 Agent 之间也可以用 `communicate` 直接互发消息。

做多 Agent 最初的动机是缩短每个会话的上下文，让每个会话保持新鲜。后来才发现怎么还能并行加速。

### Token 经济是架构约束

模型调用的开销结构是：新建输入 > 输出 > 缓存命中输入。Mutsumi 的很多设计都在减少无谓的轮次，并让会话前缀保持稳定、保住缓存命中。

### 注意力非常重要

对于许多模型而言，还没到标称的最大上下文大小，智商就开始下降：无关内容一多，注意力就散了。上下文越贴近任务，模型越能保持状态。Mutsumi 的选择是：精选上下文这件事由人来做，工具负责让它顺手。

同样，对于人类而言，如果模型和 Agent Harness 输出的内容过于繁杂，自己就不知道究竟什么重要，也不知道项目中实际在发生什么，导致无法给出正确的指令。因此，Mutsumi 为许多参数复杂或包含对人类不可读的 UUID 的工具调用附带 brief 参数，让模型自己生成工具语义简述，使执行轨迹对人可读，扫一眼就知道它在干嘛。

### Prompt as Code

这是本项目的一个主张，是个立场，不是客观结论：

准确的上下文加上清晰的实现指令，效果好过让模型自己探索。这对你有要求——你得知道自己要做什么，并且能描述出来。描述软件行为，可能要枚举状态机的状态、happy path 和每个 corner case 的异常处理；描述 UI 结构，JSON 伪代码可能比几大段自然语言更精确。

只写一句 happy path 就想要个产品，换回来的只能是模型对未定义行为的幻觉补全，因为需求根本没有被定义。

## 让人少打点字

高质量上下文得人给，但不该全靠手敲。Mutsumi 里有一批功能专门降低这件事的成本：

- **递归引用**：把一个模块相关的文件引用收进一份文档，用的时候 `@` 这份文档，整组一次发出；
- **随处复制引用**：资源管理器右键文件，或者编辑器里拖选一段代码右键，直接复制引用格式；
- **`@` 自动补全和参数表单**：文件、目录、工具模糊匹配，工具参数有表单；
- **宏**：`<!-- @def KEY=VALUE -->` 定义，正文里按 preprocess 语法展开，同一份文档可以按宏的取值展开成不同内容；
- **文档即脚本**：文档里可以写 `@[工具名{"参数": "…"}]` 或 `@[path/to/file]`，`@` 这份文档时里面的工具会按顺序执行一遍，文档引用会递归解析，结果内联插入进文档一起递给模型。系统提示词里的一部分内容（可用的子 Agent 类型、系统信息等）就是这么来的；
- **插话或排队**：想到什么随时补，不用等它跑完。

## 功能速览

- 主编辑器区对话（Custom Editor），支持分屏多面板；流式渲染、Markdown 高亮、推理过程折叠
- 多提供商 BYOK，模型和思考强度逐会话可选；首轮后自动生成会话标题
- 写操作审批：附理由拒绝、自定义动作、全局自动批准；没打开面板的会话由侧边栏审批树兜底，另有系统通知
- 消息可撤回，轮次可重试、可继续
- 多 Agent：派发、代理间通信、任务回报；子代理可再派生
- MCP 宿主：只读工具自动执行，其余走审批
- Shell 任务可转后台，随时看输出或终止
- 图片粘贴、拖入
- Lite 适配器：无 UI 的程序化一次性运行

## 快速开始

1. 安装扩展（`.vsix`，或从源码 `pnpm run package` 构建）；
2. 设置里配置 `mutsumi.providers`（提供商、baseurl、API key）和 `mutsumi.defaultModel`；
3. 命令面板执行 `Mutsumi: New Agent`，会打开一个新的 `.mtm` 会话；
4. 输入框里 `@` 引用文件或预执行工具，或者直接开聊。

## 配置

- `mutsumi.providers` / `mutsumi.models` / `mutsumi.defaultModel` / `mutsumi.titleGeneratorModel`：提供商与模型；
- `mutsumi.agentConfig`：Agent 类型，每种类型的工具集、默认可派发的子类型、默认规则和技能；
- `mutsumi.mcpServers`：MCP 服务器；
- `mutsumi.autoApproveEnabled`、`mutsumi.shellSyncTimeout` 等行为开关。

完整结构见 `docs/mutsumi_config_structure.json`。

## 关于

名字来自《Ave Mujica》的若叶睦，多重人格，对应多 Agent。

自 2026 年 2 月起，Mutsumi 的绝大部分代码由 Mutsumi 自己生成（更早的引导阶段用的是 Continue.dev）。

## 致谢

Mutsumi 直接使用了以下开源项目：

| 项目 | 许可证 |
| --- | --- |
| [@moonshot-ai/kosong](https://github.com/MoonshotAI/kimi-code/tree/main/packages/kosong) | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [micromark](https://github.com/micromark/micromark) + [micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) | MIT |
| [lowlight](https://github.com/wooorm/lowlight) | MIT |
| [hast-util-to-html](https://github.com/syntax-tree/hast-util-to-html) | MIT |
| [diff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause |
| [partial-json](https://github.com/promplate/partial-json) | MIT |
| [preprocess](https://github.com/jsoverson/preprocess) | Apache-2.0 |
| [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT |
| [uuid](https://github.com/uuidjs/uuid) | MIT |
| [iconv-lite](https://github.com/pillarjs/iconv-lite) | MIT |
| [node-notifier](https://github.com/mikaelbr/node-notifier) | MIT |
| [@vscode/codicons](https://github.com/microsoft/vscode-codicons) | CC-BY-4.0 |

## 许可证

Apache License 2.0（见 `LICENSE`）。
