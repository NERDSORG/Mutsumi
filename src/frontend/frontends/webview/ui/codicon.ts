/**
 * @fileoverview Codicon helpers for the webview: the single factory for icon
 * elements plus the one string token the display layer parses.
 *
 * Structural icons are always built with {@link codicon}. Content icons may
 * only ride in as a **leading** `$(name) ` token, and only in labels the
 * backend authors (tool `prettyPrint` strings); markdown bodies and every
 * verbatim sink (diffs, tool args/results, URIs, user text) never reach
 * {@link extractLeadingIcon}.
 *
 * The loaded codicon.css is the authority on which names exist. Failed lookups
 * leave the string untouched, so a typo costs an icon — never text.
 *
 * @module frontend/frontends/webview/ui/codicon
 */

/** Leading icon token plus the single separator space. */
const LEADING_ICON = /^\$\(([a-z0-9-]+)\) ?/;

/** name → renderable? Probed once per name, then cached. */
const renderableIcons = new Map<string, boolean>();

/**
 * Probe whether the shipped codicon.css defines a glyph for `name`, by reading
 * the computed `::before` content. Unlike walking `document.styleSheets` this
 * needs no same-origin access to the stylesheet, and it answers the question
 * that actually matters: can this name render?
 *
 * Nothing is probed (or cached) while the document is still loading, so a
 * probe that races the stylesheets cannot poison the cache.
 */
function canRenderIcon(name: string): boolean {
    const cached = renderableIcons.get(name);
    if (cached !== undefined) {
        return cached;
    }
    if (document.readyState === 'loading') {
        return false;
    }
    const probe = document.createElement('span');
    probe.className = `codicon codicon-${name}`;
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    document.body.appendChild(probe);
    const content = getComputedStyle(probe, '::before').content;
    probe.remove();
    const renderable = !!content && content !== 'none' && content !== 'normal';
    renderableIcons.set(name, renderable);
    return renderable;
}

/** Build an icon element. Decorative, so hidden from assistive technology. */
export function codicon(name: string, className = ''): HTMLElement {
    const el = document.createElement('span');
    el.className = className
        ? `codicon codicon-${name} ${className}`
        : `codicon codicon-${name}`;
    el.setAttribute('aria-hidden', 'true');
    return el;
}

/**
 * Split a leading `$(name)` token off a label. Returns null when the string
 * carries no usable leading token — the safe outcome, since an unknown name
 * then renders as literal text rather than an invisible glyph.
 */
export function extractLeadingIcon(text: string): { name: string; rest: string } | null {
    if (!text.startsWith('$(')) {
        return null;
    }
    const match = LEADING_ICON.exec(text);
    if (!match || !canRenderIcon(match[1])) {
        return null;
    }
    return { name: match[1], rest: text.slice(match[0].length) };
}
