# Mutsumi

[![License](https://img.shields.io/github/license/MalachiteN/Mutsumi)](LICENSE)
[![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.108.0-blue)](https://code.visualstudio.com/)

Mutsumi is a multi-agent conversation environment that lives in VS Code's main editor area. Sessions are plain text files, context is composed explicitly by you, and you bring your own models and API keys.

It assumes you know what you are building. Your job is to describe it precisely; its job is to make selecting and assembling context smooth.

[中文版](README_zh.md)

## Design Positions

### Sessions are files

Every agent session is a `.mtm` file (JSON) in the workspace's `.mutsumi/` directory. The file is the session's single source of truth, and the conversation UI is just a rendering of it: closing the editor doesn't end the session — it keeps running in the background — reopening restores it as it was, and one session can be viewed from several different frontends at once, all in sync.

Because a session is an ordinary text file, it goes straight into git: diffable, shareable, synchronizable across machines. No extra sync machinery needed.

### Context is composed by you, explicitly

Mutsumi does no automatic retrieval — no RAG, no magic.

The context panel holds rules, skills, macros, file references, and MCP tools, all toggled per session by hand. `@[path]` references a snapshot of the content placed directly into the message, with version tracking, prunable with one click once outdated.

This panel doubles as the prefix-cache console: leave it alone and the session prefix stays stable, hitting the provider's KV cache (until it expires); change something and the cache may be invalidated, but the context may become leaner and sharper. That tradeoff is yours to make.

### Humans can operate the tool plane directly

Tools are not just for the model. Type `@[shell{"cmd": "uname -a"}]` in the input box and you execute the command yourself, injecting the result into the context for the model to continue from. Files, directories, and tools all have `@` autocompletion, and tools with parameters pop up a form.

On the model's side, every write goes through an approval card. Rejections can carry a reason, which the model sees and adjusts to; edit operations support custom actions; and once trust is established there is a global auto-approve switch.

You can steer a running agent at any time (injected at tool-batch boundaries, without interrupting the current output), or queue a message to be handled once the current turn's tool calls are done.

### Sub-agents are first-class sessions

`dispatch_subagents` splits work across child agents in parallel. Each child is a real session: its own `.mtm` file, a node in the sidebar agent tree, openable so you can watch it work, interruptible, and injectable with messages. When the task ends the session stays — you can keep talking to it. Any two agents can also message each other directly with `communicate`.

The original motive for multi-agent was to keep each session's context short and fresh. The parallel speedup was discovered later.

### Token economy is an architectural constraint

The cost structure of model calls: fresh input > output > cached input. Much of Mutsumi's design points at reducing unnecessary rounds and keeping the session prefix stable so cache hits hold.

### Attention matters

Many models start losing quality before their nominal context limit: the more irrelevant content, the more the attention scatters. The closer the context sits to the task, the better the model holds up. Mutsumi's answer: curating context is the human's job, and the tooling makes it easy.

The same holds for humans. When the model and the agent harness spew too much, you can no longer tell what matters or what is actually happening in the project — and your instructions degrade. So tool calls whose parameters are complex or contain human-unreadable UUIDs carry a `brief` parameter: the model writes a one-line intent summary, and the execution trace becomes something you can scan at a glance.

### Prompt as Code

This is a position of the project — a stance, not an objective fact:

Accurate context plus precise implementation instructions reliably beats letting the model explore on its own. It demands something of you: you must know what you want, and be able to describe it. Describing software behavior may mean enumerating a state machine, the happy paths, and how every corner case fails; describing UI structure may be shorter in JSON pseudocode than in paragraphs of natural language.

Ask for a product with one happy-path sentence, and what comes back is the model hallucinating the undefined behavior — because the requirements were never defined.

## Type Less

Good context comes from you, but it shouldn't all be typed. Mutsumi lowers the cost of injecting it:

- **Recursive references**: collect a module's related file references into one document; `@` that document and the whole set goes out at once;
- **Copy a reference from anywhere**: right-click a file in the Explorer, or select code in the editor and right-click, to copy the reference format;
- **`@` autocompletion and parameter forms**: fuzzy matching for files, directories, and tools; a form for tool parameters;
- **Macros**: define with `<!-- @def KEY=VALUE -->`, expand with preprocess syntax — one document expands to different content depending on macro values;
- **Documents as scripts**: a document may contain `@[toolName{"arg": "…"}]` or `@[path/to/file]`; `@`-ing it runs those tools in order, resolves references recursively, and hands the results, inlined, to the model. Parts of the system prompt itself (available sub-agent types, system information) are produced exactly this way;
- **Steer or queue**: add things whenever you think of them, without waiting for the run to finish.

## Features at a Glance

- Chat in the main editor area (Custom Editor), with splits and multiple panels; streaming render, Markdown highlighting, collapsible reasoning
- Multi-provider BYOK; model and reasoning effort selectable per session; session titles auto-generated after the first turn
- Approvals for writes: reject with a reason, custom actions, global auto-approve; sessions without an open panel fall back to the sidebar approval tree, plus system notifications
- Messages can be withdrawn; turns can be retried or continued
- Multi-agent: dispatch, inter-agent messaging, task-finish reporting; sub-agents can dispatch further
- MCP host: read-only tools run automatically, the rest go through approval
- Shell tasks can move to the background; inspect output or kill anytime
- Image paste and drag-and-drop
- Lite adapter: one-shot programmatic runs with no UI

## Quick Start

1. Install the extension (a `.vsix`, or build from source with `pnpm run package`);
2. In settings, configure `mutsumi.providers` (provider, baseurl, API key) and `mutsumi.defaultModel`;
3. Run `Mutsumi: New Agent` from the command palette — a new `.mtm` session opens;
4. `@` a file reference or pre-execute a tool in the input box, or just start talking.

## Configuration

- `mutsumi.providers` / `mutsumi.models` / `mutsumi.defaultModel` / `mutsumi.titleGeneratorModel`: providers and models;
- `mutsumi.agentConfig`: agent types — each type's tool sets, default dispatchable child types, default rules and skills;
- `mutsumi.mcpServers`: MCP servers;
- `mutsumi.autoApproveEnabled`, `mutsumi.shellSyncTimeout`, and other behavior switches.

The full structure is documented in `docs/mutsumi_config_structure.json`.

## About

Named after Mutsumi Wakaba from *Ave Mujica* — a character of many personalities, much like many agents.

Since February 2026, the vast majority of Mutsumi's code has been written by Mutsumi itself (the earlier bootstrap phase used Continue.dev).

## Acknowledgments

Mutsumi directly builds on these open-source projects:

| Project | License |
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

## License

Apache License 2.0 (see `LICENSE`).
