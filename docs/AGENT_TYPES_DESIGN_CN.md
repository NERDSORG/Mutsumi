# Mutsumi Agent Type 设计

本文档描述的是 Mutsumi 当前已经落地的 Agent Type 系统。

它不是未来架构的 RFC，也不是一个待实现方案，而是对当前系统状态的记录。在这套设计里，早期把 adapter 放进 AgentType 的方案已经被明确放弃。

## 设计目标

Mutsumi 使用 Agent Type 来显式定义角色行为，但不会把整个系统做成一个隐藏自治逻辑的黑箱框架。

这套系统建立在以下原则上：

- 显式优于隐式
- 可检查优于魔法行为
- 用户治理优于完全自治
- 在 notebook 语义重要的地方坚持 notebook-first
- 用工具定义能力边界

Agent Type 主要回答这样的问题：

- 这个角色默认使用什么模型？
- 它默认加载哪些 rules 和 skills？
- 它实际能调用哪些工具？
- 它可以指派哪些子角色去完成任务？
- 用户能否直接创建这个角色？

Agent Type 不负责回答的问题包括：

- 它运行在什么传输层或 UI 载体上？
- 用户是否能够中途观察、打断、纠正它？

这些问题属于系统架构的其他层次。

## Agent Type 是什么

`AgentType` 是从 `.mutsumi/config.json` 中加载出来的声明式角色定义。

每个类型当前定义的字段包括：

- `toolSets`
- `defaultModel`
- `defaultRules`
- `defaultSkills`
- `allowedChildTypes`
- `isEntry`

这些定义最终会通过以下模块参与解析与装配：

- `src/config/interfaces.ts`
- `src/config/types.ts`
- `src/config/loader.ts`
- `src/config/resolver.ts`
- `src/registry/agentTypeRegistry.ts`
- `src/registry/toolSetRegistry.ts`

## Agent Type 不是什么

### 不是 Adapter

`AgentType` 不包含 adapter 字段。这是一个有意为之的架构设计。

在 Mutsumi 中，adapter 解决的是“这个 session 由什么执行载体承载”，而不是“这个角色是什么身份”。

当前 adapter 的语义如下：

- `NotebookAdapter`：面向用户的 notebook session，与 VS Code buffer 语义绑定
- `HeadlessAdapter`：面向 HTTP / 远程控制的持久化文件型 session
- `LiteAdapter`：无 UI、无持久化产物的内存 utility session

它们回答的问题是“这个会话如何被承载”，而不是“这是什么角色”。

当前 adapter 的实际分流规则是：

- notebook 执行使用 `NotebookAdapter`
- HTTP 执行使用 `HeadlessAdapter`
- 派出的 agent 在实践中沿用父流程所在的执行载体
- `LiteAdapter` 仅用于 title generation、context compression 等内部 utility 工作

`LiteAdapter` 被明确放在用户可见的 Agent Type 系统之外。它不能像 notebook/headless session 那样被用户审计，也不能在运行中被用户及时纠正，因此不能承担 Mutsumi 的一等协作角色。

### 不是通用继承系统

Agent Type 不实现通用继承。

这一点对于 `contextItems` 尤其重要。

`contextItems` 并不是自洽快照，它依赖 notebook/session 历史、前序 cell 结构以及 ghost block 关系。把它们粗暴复制给子 agent，只会制造一种虚假的连续性，好像子 agent 理应继承这些语义背景，但实际上它并没有形成这些上下文的过程。

因此：

- 子角色的 rules、skills、model 来自子角色自己的 `AgentType` 默认值，除非显式 override
- `allowed_uris` 在 dispatch 时指定
- `contextItems` 不被当作可泛化继承的角色状态

## 能力模型

在 Mutsumi 中，能力边界由工具定义，而不是由一堆重复布尔值定义。

关键原则是：

- 如果某个工具存在于该 agent 解析后的 tool set 中，那么它就能用
- 如果该工具不存在，那么它就不能用

这样可以避免 `readOnly`、`canShell`、`canFork` 之类的平行真相系统与真实工具层产生漂移。

例如：

- 一个只读角色，本质上只是没有写工具和 shell 工具
- 一个 orchestrator 可以拥有 dispatch 工具，但不拥有文件编辑工具
- 一个 child agent 获得 `task_finish`，是因为它是 child session，而不是因为角色定义里额外写了某个布尔位

## 两个控制平面

当前架构中有一个容易被误解但非常重要的事实：Mutsumi 现在存在两个相关但不同的工具平面。

### Agent Runtime Plane

这是执行中的 agent 所使用的工具面。

解析流程为：

1. 读取 `metadata.agentType`
2. 通过 `AgentTypeRegistry` 解析角色
3. 通过 `ToolSetRegistry` 展开命名的 `toolSets`
4. 构建每个 agent 自己的 `ToolSet`
5. 如果该 agent 是 child agent，则运行时注入 `task_finish`

这个路径同时用于：

- `src/controller.ts`
- `src/httpServer/chat.ts`

这两个执行路径现在都依赖 `src/tools.d/toolManager.ts` 中的 `createToolSetForAgent()`。

### User / Context Management Plane

这是面向用户和上下文系统的全局工具面。

它故意不绑定到单一 `AgentType`。

典型例子包括：

- 工具引用的语法补全
- `@[tool{...}]` 这类上下文预执行
- notebook/context 基础设施依赖的全局工具 pretty-print 与渲染支持

这部分行为保留在 `ToolManager` 中，属于 `ContextManagement` 一侧，而不属于某个具体的运行时角色。

这是一种有意的架构区分。在 Mutsumi 中，用户并不是站在系统外部的管理员，而是多 Agent 工作流中的最高权限协作者。因此，上下文系统需要为用户的编排、检查、预执行提供全局工具访问，而运行中的 agent 仍然受各自 `AgentType` 所解析出的工具边界约束。

## 配置文件

项目级 Agent Type 配置位于：

- `.mutsumi/config.json`

如果该文件不存在，Mutsumi 会从 `src/config/types.ts` 加载内建默认值，并在工作区中初始化默认配置文件。

## 当前配置结构

```json
{
    "version": 1,
    "toolSets": {
        "read": [
            "read",
            "glob",
            "grep",
            "find_filename",
            "get_env_var",
            "system_info",
            "project_outline",
            "diagnostics",
            "query_codebase"
        ],
        "deliver": [
            "shell",
            "write",
            "edit",
            "mkdir"
        ],
        "dispatch": [
            "dispatch_subagents",
            "get_agent_types"
        ],
        "communicate": [
            "communicate"
        ]
    },
    "agentTypes": {
        "chat": {
            "toolSets": ["read", "communicate"],
            "defaultModel": { "model": "kimi-for-coding", "provider": "kimi-for-coding" },
            "defaultRules": ["default/chat.md"],
            "defaultSkills": [],
            "allowedChildTypes": [],
            "isEntry": true
        },
        "implementer": {
            "toolSets": ["read", "deliver", "dispatch", "communicate"],
            "defaultModel": { "model": "kimi-for-coding", "provider": "kimi-for-coding" },
            "defaultRules": ["default/implementer.md"],
            "defaultSkills": [],
            "allowedChildTypes": ["implementer", "reviewer"],
            "isEntry": true
        },
        "orchestrator": {
            "toolSets": ["read", "deliver", "dispatch", "communicate"],
            "defaultModel": { "model": "kimi-for-coding", "provider": "kimi-for-coding" },
            "defaultRules": ["default/orchestrator.md"],
            "defaultSkills": [],
            "allowedChildTypes": ["implementer", "reviewer"],
            "isEntry": true
        },
        "reviewer": {
            "toolSets": ["read", "communicate"],
            "defaultModel": { "model": "kimi-for-coding", "provider": "kimi-for-coding" },
            "defaultRules": ["default/reviewer.md"],
            "defaultSkills": [],
            "allowedChildTypes": [],
            "isEntry": true
        }
    }
}
```

## 字段语义

### Root

- `version`：配置结构版本
- `toolSets`：命名的工具集定义
- `agentTypes`：命名的角色定义

### `toolSets.<name>`

每个 tool set 都是一个已注册工具名数组。

Tool set 是可组合的构件，不一定本身就是一个完整角色。一个角色可以组合多个 tool set，其最终能力面是这些工具的并集。

### `agentTypes.<name>`

- `toolSets`：需要组合的命名工具集列表
- `defaultModel`：该角色默认使用的 `{ model, provider }` 模型对；省略时回退到 `mutsumi.defaultModel`
- `defaultRules`：默认规则文件，位于 `.mutsumi/rules/` 下
- `defaultSkills`：默认启用的 skills
- `allowedChildTypes`：通过 `dispatch_subagents` 可创建的子角色类型
- `isEntry`：该角色是否出现在用户可见的创建入口中

这里刻意不存在：

- `adapter`
- `inherits`
- `readOnly` / `canShell` / `canFork` 这类能力布尔值

## 运行时流程

### 扩展启动

扩展激活时，Mutsumi 会：

1. 初始化 `ToolRegistry`
2. 加载 `.mutsumi/config.json`，并与内建默认配置合并
3. 初始化 `ToolSetRegistry`
4. 初始化 `AgentTypeRegistry`
5. 初始化 skills 与其他运行时服务

相关文件：

- `src/extension.ts`
- `src/config/loader.ts`
- `src/config/types.ts`
- `src/registry/toolSetRegistry.ts`
- `src/registry/agentTypeRegistry.ts`

### 从 VS Code 创建新 Agent

`Mutsumi: New Agent` 当前流程如下：

1. 从 `AgentTypeRegistry` 读取所有 entry types
2. QuickPick 只展示 `isEntry: true` 的角色
3. 通过 `resolveAgentDefaults()` 解析角色默认值
4. 生成 notebook 内容，其中包含 `agentType`、`model`、`activeRules`、`activeSkills`

相关文件：

- `src/extension.ts`
- `src/config/resolver.ts`
- `src/notebook/serializer.ts`

### 从 HTTP 创建新 Agent

HTTP 创建 Agent 也遵循同一套角色模型：

1. 从请求体接受 `agentType`，默认值为 `implementer`
2. 校验该角色是否是 entry type
3. 解析默认 model/rules/skills
4. 写入 `.mtm` 文件，并在 metadata 中预先写入 `agentType`

相关文件：

- `src/httpServer/agents.ts`

### Notebook 与 HTTP 执行

当前执行路径有一个严格要求：每一个真实 agent 都必须带有合法的 `metadata.agentType`。

Notebook 路径：

- `src/controller.ts`

HTTP 路径：

- `src/httpServer/chat.ts`

这两条路径都会：

- 拒绝 `agentType` 缺失的 agent
- 调用 `createToolSetForAgent(agentType, uuid, parent_agent_id)`
- 通过 registry 解析角色的 tool sets
- 仅在 child agent 的情况下运行时注入 `task_finish`

相比过去的 main/sub 分裂入口，这已经明显简化。

### Forking

Fork 仍然是显式、受角色约束的。

父 agent 只能创建那些出现在 `allowedChildTypes` 中的子角色。

子 agent：

- 有自己的 `agentType`
- 有自己解析出的默认 rules、skills、model
- 从 dispatch payload 中拿到自己的 `allowed_uris`
- 不继承通用的 `contextItems`

相关文件：

- `src/tools.d/tools/agent_control.ts`
- `src/agent/agentOrchestrator.ts`
- `src/agent/fileOps.ts`

## Metadata 契约

Agent notebook metadata 将 `agentType` 视为角色行为的运行时身份锚点。

重要的持久化字段包括：

- `uuid`
- `name`
- `created_at`
- `parent_agent_id`
- `allowed_uris`
- `model`
- `contextItems`
- `activeRules`
- `activeSkills`
- `agentType`

`agentType` 是序列化 session 工件与声明式角色 registry 之间的连接点。

相关文件：

- `src/types.ts`
- `src/notebook/serializer.ts`
- `src/agent/fileOps.ts`

## 为什么 `task_finish` 仍然是运行时注入

`task_finish` 不被建模为常规角色默认能力。

这是有意为之的。

这个工具并不代表一种稳定人格能力，如 read、write 或 fork。它代表的是 parent/child 生命周期义务。只有在一个角色真实地作为 child agent 执行时，它才需要承担 `task_finish` 的责任。

因此，`createToolSetForAgent()` 会根据 `parent_agent_id` 注入 `task_finish`，而不是把它写进常规 `toolSets`。

## 为什么 `ToolManager` 仍然存在

`ToolManager` 在 Agent Type 迁移之后仍然保留，是因为它服务的是 user/context 控制平面，而不是 runtime agent 平面。

它负责的基础设施问题包括：

- 工具引用补全
- 上下文展开中的工具预执行
- 全局 pretty-print 与渲染支持

这不是绕开 Agent Type 的后门，而是用户与上下文系统在单个运行时 agent 之外使用工具的控制面。

相关文件：

- `src/tools.d/toolManager.ts`
- `src/notebook/completionProvider.ts`
- `src/contextManagement/utils.ts`
- `src/notebook/serializer.ts`

## LiteAdapter 的状态

`LiteAdapter` 仍然存在于代码库中，但它已经不属于 Agent Type 的设计面。

它的职责被刻意限制为：

- title generation
- context compression
- 不需要持久化、不可审计、不可被用户中断的内部 utility 工作

它不应被视作面向用户的一等角色执行载体。

## 当前真正相关的模块

当前 Agent Type 系统的核心模块如下。

### Configuration and Resolution

- `src/config/interfaces.ts`
- `src/config/types.ts`
- `src/config/loader.ts`
- `src/config/utils.ts`
- `src/config/resolver.ts`

### Registries

- `src/registry/agentTypeRegistry.ts`
- `src/registry/toolSetRegistry.ts`

### Execution

- `src/tools.d/toolManager.ts`
- `src/controller.ts`
- `src/httpServer/chat.ts`
- `src/agent/agentRunner.ts`

### Creation and Serialization

- `src/notebook/serializer.ts`
- `src/agent/fileOps.ts`
- `src/httpServer/agents.ts`
- `src/extension.ts`

### Fork and Orchestration

- `src/tools.d/tools/agent_control.ts`
- `src/agent/agentOrchestrator.ts`

### Context / User Control Plane

- `src/contextManagement/utils.ts`
- `src/notebook/completionProvider.ts`

## 实际总结

Mutsumi 当前模型可以概括为：

- `AgentType` 定义角色默认值与能力组合
- `ToolSet` 定义运行时能力边界
- adapter 定义 session 载体，而不是角色身份
- child completion 语义属于运行时生命周期行为，而不是角色元数据
- `ToolManager` 属于 user/context 控制平面，而不属于某个单独 runtime agent

这保留了 Mutsumi 的核心理念：

- 显式角色身份
- 显式能力边界
- 可审计的一等 agent session
- 强用户治理
- 没有隐藏继承魔法
