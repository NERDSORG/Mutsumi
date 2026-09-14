<!-- LOGO & HEADER SECTION -->
<div align="center">

  <h1>🥳 Mutsumi</h1>
  
  <p><strong>Multi-Agent Notebook Environment for VS Code</strong></p>
  
  <!-- TODO: Add Shields.io badges here -->
  <!--
  [![Version](https://img.shields.io/visual-studio-marketplace/v/MalachiteN.mutsumi)](https://marketplace.visualstudio.com/items?itemName=MalachiteN.mutsumi)
  -->
  [![License](https://img.shields.io/github/license/MalachiteN/Mutsumi)](LICENSE)
  [![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.108.0-blue)](https://code.visualstudio.com/)
</div>

[中文版](README_zh.md)

Mutsumi is a VS Code LLM multi-Agent extension that emphasizes user in the loop, with Agents that can collaborate, be observed, interrupted, and corrected. It is committed to complete control over the context space, keeping LLM attention always focused on what matters to prevent generation quality degradation. It is also designed with consideration for minimizing API call counts and Token consumption. All Agent sessions are transparent plain-text documents, version-controllable and auditable.

<img width="1000" alt="Image" src="assets/Notebook.png" />

---

## ✨ Core Features

### 📝 Native Notebook Experience

Say goodbye to traditional sidebar conversations. Mutsumi leverages **NotebookSerializer**:

<img width="1000" alt="Image" src="assets/Multiwindow.png" />

- **VS Code Editor Panes** — Agent conversation pages as Notebook Editors for `.mtm` files, opening side-by-side with other files
- **Flexible Window Layouts** — Supports split-screen and multiple windows for free workspace organization
- **Persistent Sessions** — Conversation history persisted to Notebook data, manageable with git, shareable, and allowing state restoration anytime

### Tool Invocation and File Reference Pre-execution

When the user knows the LLM will inevitably need certain file content or tool execution results, tools can be pre-executed or files referenced, inserting results into ghost blocks in the context. This saves the LLM from wasting precious context budget reasoning about needed tool calls, and wasting valuable API quota repeatedly sending conversation history.

<img width="1000" alt="Image" src="assets/Generate.gif" />

```markdown
@[src/main.ts]                      ← Reference file
@[src/utils.ts:10:20]               ← Reference specific line range
@[read{"uri": "path/to/file"}] ← Pre-execute tool
```

Context middleware tracks the latest version and hash of referenced files. If the hash is unchanged from the latest version, a command is injected for the Agent to trace back through historical records; if the hash changes, the latest file content is injected and version bumped.

Tracked files can be managed from the **Context sidebar** with an inline action on each file item:

- **Remove File** — Drops version tracking entirely and retroactively strips every ghost-block entry of that file from all cells, so the file disappears from the assembled context completely.

For a session-wide cleanup, the notebook toolbar provides a one-click **Prune Outdated References** action that prunes every tracked file to its latest version at once.

Both actions genuinely shorten the context, at the cost of invalidating the LLM prefix cache from the earliest modified cell onward; conversely, leaving the sidebar untouched preserves cache hits across turns.

Rules or referenced files can also recursively insert files or pre-execute tools using the `@[]` schema. For example, [our default Rules file](assets/default/implementer.md).

### 🛠️ Preprocessor and Macro Support

Referenced files and Rules support **preprocessor commands**.

Users define macros using statements like `@{define macro_name, value}`, and can then invoke files containing preprocessor commands:

```markdown
<!-- @ifdef xxx -->
If macro xxx is defined, this line will be visible to the Agent
<!-- @endif -->
```

This project uses the [`preprocess`](https://github.com/jsoverson/preprocess) library for powerful preprocessing capabilities.

### 🔍 Observability

Before sending conversation history to OpenAI Compatible endpoints, you can preview the assembled content in advance—no need to wait until Tokens have been spent generating low-quality content before discovering context assembly errors.

<img width="1000" alt="Image" src="assets/DebugContext.gif" />

Similarly, you can also preview RAG search results in advance.

### 🌘 Multi-Theme Compatibility

Compatible with both dark and light themes, with bubble background colors changing automatically:

<img width="1000" alt="Image" src="assets/Themes.gif" />

### 🌐 Native Multi-Workspace Support

Almost all tool operations natively support **multi-workspace**:

<img width="1000" alt="Image" src="assets/Multiroot.png" />

Compatible workspace types include but are not limited to:

- Multi-root workspaces
- Special schemas from other extensions' `FileSystemProvider`
- Any virtual file system supporting read/write

### 🔓 Unlock Unlimited Capabilities

Compatible with Anthropic's proposed Skills mechanism, and beyond.

<img width="1000" alt="Image" src="assets/Skills.png" />

It automatically reads:

- `SKILL.md` files under `~/.agents/skills/*/` in your **home directory**
- `SKILL.md` files under `.agents/skills/*/` in **each** workspace root of the current multi-root workspace

to register Skills.

### 🥳 Parent-Child Agent Paradigm

Unlike traditional single-conversation long-dialogue modes, Mutsumi implements a **multi-Agent collaboration** system:

<img width="1000" alt="Image" src="assets/Fork.gif" />

- **Task Decomposition Capability** — Break complex tasks into multiple sub-tasks, processed in parallel by sub-Agents
- **Prevent Attention Dilution** — Avoid generation quality degradation caused by Softmax over long context in single sessions
- **Sidebar Dispatch Center** — Centralized management of all Agent sessions through the sidebar
- **Controllability and Auditability** — Requires approval to start, editable Prompts, can be interrupted, can be corrected through conversation

### 🤖 AgentType Role System

Mutsumi includes four default roles with clear responsibility boundaries:

| Role | Responsibility | Forkable Sub-roles |
|------|----------------|--------------------|
| **chat** | Pure chat entry point, does not enter the engineering execution tree, supports read-only queries when explicitly asked | — |
| **orchestrator** | Global task convergence and dispatch center, interviews users, produces final state documents, plans milestones, and dispatches execution | implementer / reviewer |
| **implementer** | Concrete engineering implementer, writes code, validates implementations, and integrates sub-results | implementer / reviewer |
| **reviewer** | Pure auditor, read-only review of outputs, adopts pass/conditional pass/fail three-state conclusion | — |

**Collaboration Topology:** Each preset role has decision-making and task advancement capabilities, avoiding information compression loss in hierarchical tree reporting structures.

**Custom Workflows:** Define role toolsets, default rules, default skills, and default MCP servers through the `mutsumi.agentConfig` VS Code setting, and customize role Prompts through `.mutsumi/rules/default/*.md`, fully controlling multi-Agent collaboration behavior.

> Detailed design is shown in [Agent Type System Design](docs/AGENT_TYPES_DESIGN.md), [Prompt Engineering Design](docs/PROMPT_ENGINEERING_DESIGN.md), and [MCP Host Design](docs/mcp-host-final-target.md)

### 🔌 MCP (Model Context Protocol) Support

Mutsumi works as its own MCP client: define MCP servers in the `mutsumi.mcpServers` VS Code setting, and their tools are discovered at extension startup and injected into Agents as first-class tools alongside the built-ins.

```jsonc
// settings.json
"mutsumi.mcpServers": {
    "playwright": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@playwright/mcp"]
    },
    "context7": {
        "type": "http",
        "url": "https://mcp.context7.com/mcp"
    }
}
```

- **Per-Role Defaults** — Declare which servers new Agents should use via `AgentType.defaultMcpServers` (e.g. `"implementer": { "defaultMcpServers": ["playwright"] }`)
- **Frozen Per-Session Snapshots** — When an Agent is created, the currently discovered tools are frozen into the session file; later server/tool changes never silently widen an existing Agent's capabilities
- **Context Sidebar Control** — The `MCPS` category in the Context sidebar shows connection status per server and lets you toggle entire servers or individual tools for the active Agent
- **Approval** — MCP tools declared `readOnlyHint: true` run automatically; all other tools go through the existing approval system (or AutoApprove when enabled)
- **Graceful Degradation** — A server that fails to connect only disables its own tools; Mutsumi and all other servers keep working. Refresh from the sidebar (or reload the window) to reconnect

---

## 👤 Typical User Journeys

### Small Task Direct Implementation

For requirements with minimal changes and clear goals, users can directly create an `implementer`:

```mermaid
flowchart LR
    U[👤 User] -->|Create + Requirement Description| I[🛠️ implementer]
    I -->|"Reference @[Code File]"| C[Read Context]
    C --> I
    I -->|Direct Implementation| D[✅ Complete]
    I -.->|Unclear Requirements| U
```

**Interaction Details:**
- Use `@[src/main.ts]` to pre-insert code references, reducing LLM reasoning calls
- Use `@[grep{"keyword": "xxx"}]` to pre-execute searches, quickly locating relevant code
- Use the **Copy Mutsumi Reference** context menu to quickly copy file/symbol references

If the requirement is clearly too large or uncertain, `implementer` should suggest the user switch to the `orchestrator` workflow.

### Large Task Convergence Before Execution

For complex feature development, refactoring, or design tasks:

```mermaid
flowchart TD
    U[👤 User] -->|Create| O[🎯 orchestrator]
    O -->|Read Project| C[📁 Context Analysis]
    C --> O
    O <-->|Interview Clarification| U
    O -->|Produce| ESD[📄 Final State Document]
    
    ESD -.->|Optional| R1[🔍 reviewer Review]
    R1 --> ESD
    
    O -->|Plan Itself| MP[🗓️ Milestone Plan]
    
    MP -.->|Optional| R2[🔍 reviewer Review]
    R2 --> MP
    
    MP --> O
    O -->|Phased Dispatch| I1[🛠️ implementer]
    O -->|Parallel Execution| I2[🛠️ implementer]
    O -->|...| I3[🛠️ implementer]
    
    I1 --> R[📊 Result Aggregation]
    I2 --> R
    I3 --> R
    R --> O
    
    O -.->|Final Review| R3[🔍 reviewer]
    R3 --> O
    
    O -->|Integration Report| U
```

`orchestrator` is responsible for interviewing users, converging requirements, producing final state documents, planning milestones itself, and then phased dispatching of `implementer` execution.

### Execution Failure Feedback Loop

When sub-Agents encounter blocking points they cannot continue:

```mermaid
flowchart TD
    I[🛠️ implementer] -->|Confusion/Failure| TF[task_finish Report]
    TF --> P[👤 Parent Agent]
    P <-->|Joint Arbitration| U[👤 User]
    
    U -.->|Final State Unclear| R1[📝 Return to Interview Revision]
    R1 --> O[🎯 orchestrator]
    
    U -.->|Local Issue| R2[🔧 Open Separate Patch Task]
    R2 --> I2[🛠️ New implementer]
    I2 -->|Resolve and Continue| P
```

- Sub-Agents report confusion or failure reasons via `task_finish`
- Parent Agent and user jointly arbitrate the root cause
- If the final state document is insufficient, return to the interview revision stage
- If it's just a local implementation issue, open a narrower task to patch and continue

### Key Interaction Mechanisms

| Mechanism | Usage | Effect |
|-----------|-------|--------|
| **@ Schema Reference** | `@[src/main.ts:10:50]` | Precisely reference code snippets |
| **Tool Pre-execution** | `@[grep{"keyword": "xxx"}]` | Pre-execute search, inject results into context |
| **Copy Mutsumi Reference** | Context Menu | Quickly copy file/symbol @ reference format |
| **Dynamic Context Tracking** | Automatic version hash | Reference history when files unchanged, inject new version when changed |
| **Context Sidebar File Actions** | Inline button on file items | Fully remove a file from all history |

---

## 🚀 Quick Start

### Installation

```bash
# Build from source (Node.js ≥ 24)
corepack enable   # one-time: installs the pnpm shim; the exact pnpm version is pinned by package.json's "packageManager" field
pnpm install
pnpm run package  # 类型检查 + 打包 + 产出 mutsumi-[version].vsix

# Install locally to VS Code
code --install-extension mutsumi-[version].vsix
```

### Configuration

Mutsumi defaults to the `kimi-for-coding` model. To get started, simply add your API key in VS Code: settings.

Open your `settings.json` and add:

```json
"mutsumi.providers": [
    {
        "name": "kimi-for-coding",
        "baseurl": "https://api.kimi.com/coding/v1",
        "api_key": "sk-kimi-XXXXXXXXXXXXXXXXXXXXXX"
    }
]
```

If you want to use a different model or provider, configure `mutsumi.providers` and `mutsumi.models` accordingly. See the setting descriptions in VS Code: for examples.

> **Note:** This Agent framework is specifically designed and optimized around the Kimi base model family. Using `kimi-for-coding` is highly recommended.

### Create Your First Agent

1. Press Ctrl+Shift+P to open the Command Palette
2. Click **Mutsumi: New Agent** to create a new session
3. Start the conversation in the `.mtm` notebook file
4. Use the `@[file_path]` syntax to reference code files

---

## 🛠️ Built-in Tools

Mutsumi provides rich built-in tools for intelligent task execution:

- **File Operations** — `read`, `glob`
- **Code Search** — `grep`, `find_filename`, `project_outline`, `query_codebase`
- **Execution Control** — `shell`, `get_env_var`, `system_info`
- **File Editing** — `write`, `edit`
- **Agent Orchestration** — `dispatch_subagents`, `get_agent_types`, `task_finish`
- **MCP Extension** — Any tools discovered from your `mutsumi.mcpServers`, exposed as `mcp__<server>__<tool>` and managed per Agent in the Context sidebar

---

## 📝 Dynamic Context Technology Deep Dive

Mutsumi adopts a six-phase dynamic context management architecture:

1. Environment and Macro Initialization — Load persisted context state and macro definitions
2. System Prompt Construction — Integrate Rules and runtime environment
3. User Input Parsing — TemplateEngine recursively processes file references
4. Incremental Snapshots and Version Control — Intelligent change detection to save Tokens
5. Persistence and Metadata Update — Persist ghost blocks to Cell Metadata as structured objects, projected to the same markdown before sending
6. Final Message Assembly — Consistent prefix to maximize LLM KV Cache utilization

### Recursive File Reference and Tool Pre-execution Parsing

Using the `@[path]` syntax, the TemplateEngine recursively parses nested references and pre-executes tool calls:

```
User Input: "Read @[doc/main.md]"
    ↓
Discover @[doc/main.md] → Read file, run preprocessor
    ↓
Discover internal reference @[doc/utils.md] → Recursively parse
    ↓
Return expanded complete content (main.md already contains utils.md)
    ↓
Discover included @[glob{"uri": "path/to/codebase"}] → Pre-execute tool
```

**APPEND Mode** (top-level): Content collected into ghost blocks  
**INLINE Mode** (recursive layers): Content directly replaces original tags and embeds into parent file

### Ghost Block Structure

````markdown
<content_reference>
The following are files referenced by the user via @ (or their latest version status):

# Source: src/utils.ts (v1)
> Content unchanged. See previous version (v1).

# Source: src/new-feature.ts (v2)
```typescript
... (complete new content) ...
```
</content_reference>
````

### Macro Lifecycle

- **Definition**: `@{define KEY, VALUE}`
- **Scope**: Affects Prompts, file paths, file content, and tool parameters spatially
- **Persistence**: Written to Notebook Metadata, permanently effective across rounds

---

## 🙏 Credits

This project uses the following open source projects and their license declarations:

### Core Dependencies

| Project | Version | License | Purpose |
|---------|---------|---------|---------|
| [openai](https://github.com/openai/openai-node) | ^6.17.0 | Apache-2.0 | OpenAI API client |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | ^12.8.0 | MIT | SQLite database engine |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | ^0.1.7-alpha.2 | MIT | SQLite vector extension for RAG |
| [diff](https://github.com/kpdecker/jsdiff) | ^8.0.3 | BSD-3-Clause | Text diff comparison |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) | ^4.0.3 | MIT | Markdown metadata parsing |
| [preprocess](https://github.com/jsoverson/preprocess) | ^3.2.0 | Apache-2.0 | File preprocessor macros |
| [uuid](https://github.com/uuidjs/uuid) | ^9.0.1 | MIT | UUID generation |
| [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | ^0.22.2 | MIT | Syntax tree parsing |
| [node-notifier](https://github.com/mikaelbr/node-notifier) | ^10.0.1 | MIT | Native desktop notifications |
| [partial-json](https://github.com/promplate/partial-json-parser-js) | ^0.1.7 | MIT | Parse partial JSON generated by LLM |
| [iconv-lite](https://github.com/ashtuchkov/iconv-lite) | ^0.6.3 | MIT | Character encoding conversion |
| [express](https://github.com/expressjs/express) | ^5.2.1 | MIT | HTTP server framework |
| [body-parser](https://github.com/expressjs/body-parser) | ^2.2.2 | MIT | HTTP request body parsing |
| [micromark](https://github.com/micromark/micromark) | ^4.0.0 | MIT | CommonMark-compliant Markdown parser for custom notebook renderer |
| [micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) | ^2.0.0 | MIT | GFM extensions (tables, strikethrough, etc.) for micromark |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | ^1.30.0 | MIT | MCP protocol client (stdio / Streamable HTTP) |

Thanks to all open source contributors! 🙏

---

## 📄 License

This project is licensed under [Apache License 2.0](LICENSE).

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/MalachiteN">MalachiteN</a>
</p>
