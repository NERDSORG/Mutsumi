/**
 * @fileoverview Context panel: a responsive popup anchored directly above the
 * toolbar's "context" button, rendering contextItems / rules / skills / MCP
 * tools as a collapsible tree with codicon state icons (TreeProvider style).
 * Data comes from the session snapshot plus `session.metadata` increments;
 * operations go out as FtB `context.*` events.
 * @module frontends/webview/ui/contextPanel
 */

import type { ChatState, ContextPanelData, UiContext } from './types';
import { AnchoredPopup } from './popup';

type McpServerData = ContextPanelData['mcpServers'][number];

/** A directory node in a path-based tree (rules, files). */
interface DirNode {
    name: string;
    path: string;
    dirs: Map<string, DirNode>;
    leaves: HTMLElement[];
    /** Full slash-paths of all leaves directly under this node. */
    leafPaths: string[];
}

/**
 * The context popup: a collapsible tree of contextItems / rules / skills /
 * MCP tools with codicon state icons, anchored above the toolbar button.
 */
export class ContextPanel extends AnchoredPopup {
    private state: ChatState | null = null;
    /** Expansion state by node id, preserved across re-renders. */
    private readonly expanded = new Set<string>();

    constructor(
        anchorButton: HTMLElement,
        private readonly ctx: UiContext,
    ) {
        super(anchorButton);
    }

    /** Feed the latest state; re-renders only while open. */
    update(state: ChatState): void {
        this.state = state;
        this.refreshIfOpen();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    protected render(): void {
        this.rootEl.innerHTML = '';
        const panel = this.state?.contextPanel;
        if (!panel) {
            return;
        }

        // Agent type (read-only)
        const agentType = this.state?.metadata?.agentType;
        if (agentType) {
            this.rootEl.appendChild(this.leafRow({
                icon: 'robot',
                label: agentType,
                readOnly: true,
            }));
        }

        this.rootEl.appendChild(this.buildRulesSection(panel));
        this.rootEl.appendChild(this.buildSkillsSection(panel));
        this.rootEl.appendChild(this.buildFilesSection(panel));
        this.rootEl.appendChild(this.buildMacrosSection(panel));
        this.rootEl.appendChild(this.buildMcpSection(panel));
    }

    private buildRulesSection(panel: ContextPanelData): HTMLElement {
        const activeRules = this.state?.metadata?.activeRules;
        const isActive = (name: string) =>
            activeRules === undefined || activeRules === null || activeRules.includes(name);

        const dirTree = this.buildDirTree(
            panel.rules.map(rule => rule.name),
            (fullPath, name) => this.leafRow({
                icon: 'file',
                label: name,
                toggled: isActive(fullPath),
                onToggle: (active) => {
                    this.ctx.sendFtB('context.toggleRule', { rule: fullPath, active });
                },
            }),
        );

        const toggleDir = (node: DirNode, active: boolean) => {
            for (const ruleName of collectRulePaths(node)) {
                this.ctx.sendFtB('context.toggleRule', { rule: ruleName, active });
            }
        };

        return this.category('cat:rules', 'book', this.ctx.label('chat.context.rules'), dirTree, {
            dirToggle: (node) => {
                const paths = collectRulePaths(node);
                const allActive = paths.length > 0 && paths.every(isActive);
                const someActive = paths.some(isActive);
                return {
                    state: allActive ? 'on' : someActive ? 'partial' : 'off',
                    toggle: () => toggleDir(node, !allActive),
                };
            },
        });
    }

    private buildSkillsSection(panel: ContextPanelData): HTMLElement {
        const rows = panel.skills.map(skill => this.leafRow({
            icon: 'zap',
            label: skill.name,

            title: skill.description,
            toggled: skill.active,
            onToggle: (active) => {
                skill.active = active;
                this.ctx.sendFtB('context.toggleSkill', { skill: skill.name, active });
            },
        }));
        return this.category('cat:skills', 'zap', this.ctx.label('chat.context.skills'), rows);
    }

    private buildFilesSection(panel: ContextPanelData): HTMLElement {
        const files = panel.contextItems.filter(i => i.type === 'file');
        const versionByKey = new Map(files.map(f => [f.key, f.version] as const));
        const dirTree = this.buildDirTree(
            files.map(f => f.key),
            (fullPath, name) => this.leafRow({
                icon: 'file',
                label: versionByKey.get(fullPath) ? `${name}: v${versionByKey.get(fullPath)}` : name,
                readOnly: true,
                onRemove: () => {
                    this.ctx.sendFtB('context.removeFile', { key: fullPath });
                },
            }),
        );
        return this.category('cat:files', 'folder', this.ctx.label('chat.context.files'), dirTree);
    }

    private buildMacrosSection(panel: ContextPanelData): HTMLElement {
        const macros = panel.contextItems.filter(i => i.type === 'macro');
        const rows = macros.map(item => this.leafRow({
            icon: 'key',
            label: `${item.key}: ${item.content}`,

            readOnly: true,
            onRemove: () => {
                this.ctx.sendFtB('context.removeMacro', { key: item.key });
            },
        }));
        return this.category('cat:macros', 'key', this.ctx.label('chat.context.macros'), rows);
    }

    private buildMcpSection(panel: ContextPanelData): HTMLElement {
        const serverRows = panel.mcpServers.map(server => {
            const available = server.tools.filter(t => t.schemaValid).length;
            const enabled = server.tools.filter(t => t.enabled).length;
            const toolRows = server.tools.map(tool => this.leafRow({
                icon: 'package',
                label: tool.name,
                toggled: tool.enabled,
                onToggle: (active) => {
                    this.ctx.sendFtB('context.setMcpTools', {
                        selection: computeSelection(panel.mcpServers, server.serverId, tool.name, active),
                    });
                },
            }));
            return this.treeNode({
                id: `mcp:${server.serverId}`,
                icon: 'server',
                label: `${server.serverId} · ${enabled}/${available} (${server.status})`,
                title: server.error,
                children: toolRows,
                toggleState: enabled === 0 ? 'off' : enabled === available ? 'on' : 'partial',
                onToggle: () => {
                    this.ctx.sendFtB('context.setMcpTools', {
                        selection: computeSelection(panel.mcpServers, server.serverId, undefined, enabled === 0),
                    });
                },
            });
        });
        return this.category('cat:mcps', 'server', this.ctx.label('chat.context.mcps'), serverRows);
    }

    // ------------------------------------------------------------------
    // Tree primitives
    // ------------------------------------------------------------------

    /** A collapsible category node. */
    private category(
        id: string,
        iconName: string,
        label: string,
        children: HTMLElement[] | DirNode,
        options?: { dirToggle?: (node: DirNode) => { state: Toggle3; toggle: () => void } },
    ): HTMLElement {
        const childEls = Array.isArray(children)
            ? children
            : this.renderDirTree(children, `${id}:`, options?.dirToggle);
        return this.treeNode({ id, icon: iconName, label, children: childEls });
    }

    private treeNode(args: {
        id: string;
        icon: string;
        label: string;
        title?: string;
        children: HTMLElement[];
        toggleState?: Toggle3;
        onToggle?: () => void;
    }): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'mutsumi-tree-node';

        const row = document.createElement('div');
        row.className = 'mutsumi-tree-row';
        if (args.title) {
            row.title = args.title;
        }

        const expanded = this.expanded.has(args.id);
        const chevron = document.createElement('span');
        chevron.className = 'mutsumi-tree-chevron codicon';
        chevron.classList.add(expanded ? 'codicon-chevron-down' : 'codicon-chevron-right');
        chevron.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.expanded.has(args.id)) {
                this.expanded.delete(args.id);
            } else {
                this.expanded.add(args.id);
            }
            this.render();
        });
        row.appendChild(chevron);

        row.appendChild(codiconEl(args.icon, 'mutsumi-tree-type-icon'));

        const label = document.createElement('span');
        label.className = 'mutsumi-tree-label';
        label.textContent = args.label;
        row.appendChild(label);

        if (args.toggleState !== undefined && args.onToggle) {
            row.appendChild(stateIcon(args.toggleState, args.onToggle));
        }

        // Click on the row body also expands/collapses.
        row.addEventListener('click', () => {
            if (this.expanded.has(args.id)) {
                this.expanded.delete(args.id);
            } else {
                this.expanded.add(args.id);
            }
            this.render();
        });

        wrap.appendChild(row);

        if (expanded && args.children.length > 0) {
            const childWrap = document.createElement('div');
            childWrap.className = 'mutsumi-tree-children';
            for (const child of args.children) {
                childWrap.appendChild(child);
            }
            wrap.appendChild(childWrap);
        }
        return wrap;
    }

    private leafRow(args: {
        icon: string;
        label: string;
        title?: string;
        readOnly?: boolean;
        toggled?: boolean;
        onToggle?: (active: boolean) => void;
        onRemove?: () => void;
    }): HTMLElement {
        const row = document.createElement('div');
        row.className = 'mutsumi-tree-row mutsumi-tree-leaf';
        if (args.title) {
            row.title = args.title;
        }

        // Indentation spacer aligned with chevrons of parent rows.
        const spacer = document.createElement('span');
        spacer.className = 'mutsumi-tree-chevron mutsumi-tree-spacer';
        row.appendChild(spacer);

        row.appendChild(codiconEl(args.icon, 'mutsumi-tree-type-icon'));

        const label = document.createElement('span');
        label.className = 'mutsumi-tree-label';
        label.textContent = args.label;
        row.appendChild(label);

        if (args.onRemove) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'mutsumi-tree-remove';
            removeBtn.appendChild(codiconEl('close'));
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                args.onRemove!();
            });
            row.appendChild(removeBtn);
        }

        if (!args.readOnly && args.onToggle) {
            row.appendChild(stateIcon(args.toggled ? 'on' : 'off', () => args.onToggle!(!args.toggled)));
        }
        return row;
    }

    /** Build a directory tree from slash-separated paths. */
    private buildDirTree(
        paths: string[],
        makeLeaf: (fullPath: string, name: string) => HTMLElement,
    ): DirNode {
        const root: DirNode = { name: '', path: '', dirs: new Map(), leaves: [], leafPaths: [] };
        for (const fullPath of [...paths].sort()) {
            const segments = fullPath.split('/');
            let node = root;
            for (let i = 0; i < segments.length - 1; i++) {
                const seg = segments[i];
                const segPath = segments.slice(0, i + 1).join('/');
                let child = node.dirs.get(seg);
                if (!child) {
                    child = { name: seg, path: segPath, dirs: new Map(), leaves: [], leafPaths: [] };
                    node.dirs.set(seg, child);
                }
                node = child;
            }
            node.leaves.push(makeLeaf(fullPath, segments[segments.length - 1]));
            node.leafPaths.push(fullPath);
        }
        return root;
    }

    private renderDirTree(
        node: DirNode,
        idPrefix: string,
        dirToggle?: (node: DirNode) => { state: Toggle3; toggle: () => void },
    ): HTMLElement[] {
        const rows: HTMLElement[] = [];
        for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
            const toggle = dirToggle?.(dir);
            rows.push(this.treeNode({
                id: `${idPrefix}dir:${dir.path}`,
                icon: 'folder',
                label: dir.name,
                children: this.renderDirTree(dir, `${idPrefix}dir:${dir.path}:`, dirToggle),
                toggleState: toggle?.state,
                onToggle: toggle?.toggle,
            }));
        }
        for (const leaf of node.leaves) {
            rows.push(leaf);
        }
        return rows;
    }
}

type Toggle3 = 'on' | 'off' | 'partial';

/** Toggle state icon (TreeProvider style: check / dash / circle-outline). */
function stateIcon(state: Toggle3, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mutsumi-tree-toggle is-${state}`;
    button.appendChild(codiconEl(
        state === 'on' ? 'check' : state === 'partial' ? 'dash' : 'circle-outline',
    ));
    button.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });
    return button;
}

function codiconEl(name: string, cls = ''): HTMLElement {
    const el = document.createElement('span');
    el.className = `codicon codicon-${name}${cls ? ' ' + cls : ''}`;
    return el;
}

/** Collect all leaf full-paths under a directory node. */
function collectRulePaths(node: DirNode): string[] {
    const paths: string[] = [...node.leafPaths];
    for (const dir of node.dirs.values()) {
        paths.push(...collectRulePaths(dir));
    }
    return paths;
}

/**
 * Compute the next enabledMcpTools selection after toggling one tool (or a
 * whole server when toolName is undefined).
 */
function computeSelection(
    servers: { serverId: string; tools: { name: string; schemaValid: boolean; enabled: boolean }[] }[],
    serverId: string,
    toolName: string | undefined,
    enable: boolean,
): { serverId: string; toolNames: string[] }[] {
    const selectionMap = new Map<string, Set<string>>();
    for (const server of servers) {
        const enabled = new Set(server.tools.filter(t => t.enabled).map(t => t.name));
        if (enabled.size > 0) {
            selectionMap.set(server.serverId, enabled);
        }
    }
    const server = servers.find(s => s.serverId === serverId);
    const current = selectionMap.get(serverId) ?? new Set<string>();
    if (toolName) {
        if (enable) {
            current.add(toolName);
        } else {
            current.delete(toolName);
        }
    } else if (enable) {
        for (const tool of server?.tools ?? []) {
            if (tool.schemaValid) {
                current.add(tool.name);
            }
        }
    } else {
        current.clear();
    }
    if (current.size > 0) {
        selectionMap.set(serverId, current);
    } else {
        selectionMap.delete(serverId);
    }
    return [...selectionMap.entries()].map(([id, toolNames]) => ({
        serverId: id,
        toolNames: [...toolNames],
    }));
}
