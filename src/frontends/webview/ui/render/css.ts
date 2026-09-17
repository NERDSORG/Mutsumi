/**
 * @fileoverview CSS styles for the Mutsumi chat renderer.
 * Imported by the webview bundle and injected as a <style> element.
 * @module frontends/webview/ui/render/css
 */

export const RENDERER_CSS = `
/* Mutsumi Agent Chat Renderer Styles */

.mutsumi-committed, .mutsumi-active {
  width: 100%;
}

.mutsumi-block {
  margin: 4px 0;
}

/* Themed container replacement for tool calls and reasoning */
.mutsumi-block > details {
  background-color: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.15));
  padding: 12px 16px;
  border-radius: 8px;
  margin: 8px 0;
  width: fit-content;
  max-width: 90%;
}

.mutsumi-block > details > summary {
  cursor: pointer;
  font-weight: 500;
  user-select: none;
}

.mutsumi-tool-args {
  margin-top: 8px;
}

.mutsumi-tool-args ul {
  list-style: none;
  padding-left: 0;
}

.mutsumi-tool-args li {
  margin: 2px 0;
}

/* Code block background: one rule that matches every <pre> in the renderer, */
/* including markdown code blocks that are DIRECT children of .mutsumi-block */
/* (micromark output has no intermediate wrapper, so a selector requiring */
/* ".mutsumi-block > :not(details) pre" would never match them). */
.mutsumi-block pre {
  position: relative;
  background-color: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
}

/* VS Code-style toolbar action for block code only. */
.mutsumi-block pre > .mutsumi-copy-code {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, transparent);
  opacity: 0.62;
  cursor: pointer;
  z-index: 1;
}

.mutsumi-block pre > .mutsumi-copy-code:hover {
  color: var(--vscode-toolbar-hoverForeground, var(--vscode-foreground));
  background-color: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
  opacity: 1;
}

.mutsumi-block pre > .mutsumi-copy-code:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: -1px;
  opacity: 1;
}

.mutsumi-block pre > .mutsumi-copy-code.is-copied {
  color: var(--vscode-testing-iconPassed, var(--vscode-foreground));
  opacity: 1;
}

.mutsumi-copy-code > svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
  pointer-events: none;
}

body.vscode-high-contrast .mutsumi-block pre > .mutsumi-copy-code,
body.vscode-high-contrast-light .mutsumi-block pre > .mutsumi-copy-code {
  border-color: var(--vscode-contrastBorder, transparent);
}

/* Tighter padding for code blocks nested inside tool-call/reasoning details */
.mutsumi-tool-args pre,
.mutsumi-block > details > pre {
  padding: 8px 12px;
  border-radius: 4px;
  margin: 8px 0;
}

/* Monospace font for every <code> in the renderer: content code blocks, */
/* inline code, reasoning content (nested under details > .mutsumi-reasoning-content), */
/* and tool call args/results. A single shallow selector is required because */
/* ".mutsumi-block > details > pre code" misses reasoning's code blocks, */
/* which live one level deeper inside .mutsumi-reasoning-content. */
.mutsumi-block code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}

.mutsumi-reasoning-content {
  margin-top: 8px;
  opacity: 0.85;
}

/* Content blocks: render markdown output */
.mutsumi-block > :not(details) p {
  margin: 8px 0;
}

/* Reset VS Code's inline-code styling inside fenced code blocks. */
/* VS Code webview defaults give <code> a background + padding + radius; */
/* with display:inline that paints a per-line "text highlight" instead of */
/* the block background owned by <pre>. */
.mutsumi-block pre code {
  display: block;
  padding: 0;
  background: none;
  background-color: transparent;
  border-radius: 0;
  white-space: pre;
}

.mutsumi-block > :not(details) table {
  border-collapse: collapse;
  width: 100%;
}

.mutsumi-block > :not(details) th,
.mutsumi-block > :not(details) td {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  padding: 6px 12px;
}

/* Syntax highlighting token colors (lowlight / highlight.js) */
/* Two themes via VS Code's data-vscode-theme-kind attribute on <body> */

/* --- Default: Dark+ theme colors --- */
.hljs { color: var(--vscode-editor-foreground, #d4d4d4); }
.hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-name, .hljs-tag { color: #569cd6; }
.hljs-string, .hljs-regexp, .hljs-template-tag, .hljs-addition { color: #ce9178; }
.hljs-title, .hljs-section, .hljs-selector-id, .hljs-selector-class { color: #dcdcaa; }
.hljs-built_in, .hljs-type { color: #4ec9b0; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-meta, .hljs-link { color: #b5cea8; }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable, .hljs-property { color: #9cdcfe; }
.hljs-deletion { color: #f48771; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }

/* --- Light+ / HC Light theme overrides --- */
/* VS Code webview sets body classes: vscode-light, vscode-dark, */
/* vscode-high-contrast (dark HC), vscode-high-contrast-light (light HC) */
body.vscode-light .hljs,
body.vscode-high-contrast-light .hljs { color: var(--vscode-editor-foreground, #000000); }
body.vscode-light .hljs-comment,
body.vscode-light .hljs-quote,
body.vscode-high-contrast-light .hljs-comment,
body.vscode-high-contrast-light .hljs-quote { color: #008000; font-style: italic; }
body.vscode-light .hljs-keyword,
body.vscode-light .hljs-selector-tag,
body.vscode-light .hljs-literal,
body.vscode-light .hljs-name,
body.vscode-light .hljs-tag,
body.vscode-high-contrast-light .hljs-keyword,
body.vscode-high-contrast-light .hljs-selector-tag,
body.vscode-high-contrast-light .hljs-literal,
body.vscode-high-contrast-light .hljs-name,
body.vscode-high-contrast-light .hljs-tag { color: #0000ff; }
body.vscode-light .hljs-string,
body.vscode-light .hljs-regexp,
body.vscode-light .hljs-template-tag,
body.vscode-light .hljs-addition,
body.vscode-high-contrast-light .hljs-string,
body.vscode-high-contrast-light .hljs-regexp,
body.vscode-high-contrast-light .hljs-template-tag,
body.vscode-high-contrast-light .hljs-addition { color: #a31515; }
body.vscode-light .hljs-title,
body.vscode-light .hljs-section,
body.vscode-light .hljs-selector-id,
body.vscode-light .hljs-selector-class,
body.vscode-high-contrast-light .hljs-title,
body.vscode-high-contrast-light .hljs-section,
body.vscode-high-contrast-light .hljs-selector-id,
body.vscode-high-contrast-light .hljs-selector-class { color: #795e26; }
body.vscode-light .hljs-built_in,
body.vscode-light .hljs-type,
body.vscode-high-contrast-light .hljs-built_in,
body.vscode-high-contrast-light .hljs-type { color: #267f99; }
body.vscode-light .hljs-number,
body.vscode-light .hljs-symbol,
body.vscode-light .hljs-bullet,
body.vscode-light .hljs-meta,
body.vscode-light .hljs-link,
body.vscode-high-contrast-light .hljs-number,
body.vscode-high-contrast-light .hljs-symbol,
body.vscode-high-contrast-light .hljs-bullet,
body.vscode-high-contrast-light .hljs-meta,
body.vscode-high-contrast-light .hljs-link { color: #098658; }
body.vscode-light .hljs-attr,
body.vscode-light .hljs-attribute,
body.vscode-light .hljs-variable,
body.vscode-light .hljs-template-variable,
body.vscode-light .hljs-property,
body.vscode-high-contrast-light .hljs-attr,
body.vscode-high-contrast-light .hljs-attribute,
body.vscode-high-contrast-light .hljs-variable,
body.vscode-high-contrast-light .hljs-template-variable,
body.vscode-high-contrast-light .hljs-property { color: #001080; }
body.vscode-light .hljs-deletion,
body.vscode-high-contrast-light .hljs-deletion { color: #a31515; }
`;
