/**
 * @fileoverview Tool-parameter form popup: the second step of accepting a
 * tool row in the `@` completion menu. One <input> per parameter; Tab /
 * Shift+Tab cycle a wrapping focus ring; Enter submits (empty fields fall
 * back to schema defaults); Esc or an outside click cancels without
 * inserting and restores the textarea selection.
 *
 * @module frontend/frontends/webview/ui/toolParamsForm
 */

import { PopupBase } from './popup';
import { codicon } from './codicon';
import type { CompletionToolInfo } from '../interfaces';

interface ParamField {
    name: string;
    schema: any;
    input: HTMLInputElement;
}

export interface ToolParamsFormCallbacks {
    applyInsertion(text: string, start: number, end: number): void;
    label(key: string): string;
}

export class ToolParamsForm extends PopupBase {
    private tool: CompletionToolInfo | null = null;
    private range = { start: 0, end: 0 };
    /** Textarea selection when the tool was picked; restored on cancel. */
    private savedSelection = { start: 0, end: 0 };
    private fields: ParamField[] = [];

    constructor(
        composerEl: HTMLElement,
        private readonly textarea: HTMLTextAreaElement,
        private readonly callbacks: ToolParamsFormCallbacks,
    ) {
        super();
        this.rootEl.classList.add('mutsumi-toolform-popover');
        composerEl.appendChild(this.rootEl);
    }

    /** Open the form for `tool`; on submit, `[start, end)` is replaced. */
    openFor(tool: CompletionToolInfo, range: { start: number; end: number }): void {
        this.tool = tool;
        this.range = range;
        this.savedSelection = { start: range.end, end: range.end };
        this.open();
        this.fields[0]?.input.focus();
    }

    override close(): void {
        const wasOpen = this.isOpen();
        super.close();
        if (wasOpen) {
            this.tool = null;
            // Restores focus and the saved selection; on submit,
            // applyInsertion runs afterwards and moves the caret.
            this.textarea.focus();
            this.textarea.setSelectionRange(this.savedSelection.start, this.savedSelection.end);
        }
    }

    private submit(): void {
        const tool = this.tool;
        if (!tool) {
            return;
        }
        const args: Record<string, unknown> = {};
        for (const field of this.fields) {
            args[field.name] = coerceValue(field.input.value, field.schema);
        }
        const text = `@[${tool.name}${JSON.stringify(args)}]`;
        const { start, end } = this.range;
        this.close();
        this.callbacks.applyInsertion(text, start, end);
    }

    private onFieldKeydown(e: KeyboardEvent): void {
        if (e.isComposing) {
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            this.submit();
            return;
        }
        if (e.key === 'Tab') {
            // Tab wraps (Shift+Tab reverses): last → first, first → last.
            e.preventDefault();
            const current = this.fields.findIndex(f => f.input === e.target);
            const delta = e.shiftKey ? -1 : 1;
            const next = (current + delta + this.fields.length) % this.fields.length;
            this.fields[next]?.input.focus();
        }
        // Esc: PopupBase closes, close() restores focus and selection.
    }

    protected render(): void {
        this.rootEl.innerHTML = '';
        this.fields = [];
        const tool = this.tool;
        if (!tool) {
            return;
        }

        const header = document.createElement('div');
        header.className = 'mutsumi-toolform-header';
        header.appendChild(codicon(tool.serverId ? 'server-environment' : 'tools'));
        const title = document.createElement('span');
        title.className = 'mutsumi-toolform-title';
        title.textContent = tool.displayName;
        header.appendChild(title);
        if (tool.description) {
            header.title = tool.description;
        }
        this.rootEl.appendChild(header);

        const required = new Set(tool.parameters?.required ?? []);
        const grid = document.createElement('div');
        grid.className = 'mutsumi-toolform-grid';
        for (const [name, schema] of Object.entries(tool.parameters?.properties ?? {})) {
            const label = document.createElement('span');
            label.className = 'mutsumi-toolform-label';
            label.textContent = required.has(name) ? `${name} *` : name;
            const description = (schema as any)?.description;
            if (typeof description === 'string' && description) {
                label.title = description;
            }
            grid.appendChild(label);

            const input = document.createElement('input');
            input.className = 'mutsumi-toolform-input';
            input.type = 'text';
            input.spellcheck = false;
            // Placeholder = what an empty field submits as.
            input.placeholder = JSON.stringify(defaultValueFor(schema));
            input.addEventListener('keydown', e => this.onFieldKeydown(e));
            grid.appendChild(input);
            this.fields.push({ name, schema, input });
        }
        this.rootEl.appendChild(grid);

        const hint = document.createElement('div');
        hint.className = 'mutsumi-toolform-hint';
        hint.textContent = this.callbacks.label('chat.completion.toolFormHint');
        this.rootEl.appendChild(hint);
    }
}

/**
 * Schema-derived default for an empty field: first enum value, true, 0, "",
 * one item per array, all properties per object.
 */
function defaultValueFor(schema: any): unknown {
    if (!schema || typeof schema !== 'object') {
        return '';
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum[0];
    }
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    switch (type) {
        case 'boolean':
            return true;
        case 'number':
        case 'integer':
            return 0;
        case 'array': {
            const item = schema.items;
            return item && typeof item === 'object' ? [defaultValueFor(item)] : [];
        }
        case 'object': {
            const out: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(schema.properties ?? {})) {
                out[key] = defaultValueFor(value);
            }
            return out;
        }
        case 'string':
        default:
            return '';
    }
}

/**
 * Coerce one field's raw text into a JSON value: empty → schema default;
 * string-typed → the raw text as-is; everything else tries JSON.parse first
 * (`[1,2]`, `{"a":1}`, `false`…) and falls back to the raw string.
 */
function coerceValue(raw: string, schema: any): unknown {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return defaultValueFor(schema);
    }
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    if (type === 'string' || (type === undefined && Array.isArray(schema?.enum))) {
        return trimmed;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}
