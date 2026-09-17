/**
 * @fileoverview Layout styles for the Mutsumi chat webview (Kimi-style:
 * right-aligned user bubbles, full-width agent turns, fixed input area).
 * @module frontends/webview/ui/appCss
 */

export const APP_CSS = `
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
}

body {
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

#mutsumi-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* --- Main split --- */
.mutsumi-main {
  display: flex;
  flex: 1;
  min-height: 0;
}

.mutsumi-flow {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  min-width: 0;
}

/* --- Popups (anchored above their button) --- */
.mutsumi-popover-anchor {
  position: relative;
}

.mutsumi-popup {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 20;
  width: 320px;
  max-width: 80vw;
  max-height: 55vh;
  overflow-y: auto;
  padding: 6px 4px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
  border-radius: 8px;
  background: var(--vscode-editor-background);
  box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
}

.mutsumi-picker-popover {
  width: auto;
  min-width: 200px;
}

.mutsumi-picker-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  font-size: 0.85em;
  font-weight: 600;
  opacity: 0.75;
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
}

.mutsumi-picker-group-header:hover {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
}

.mutsumi-picker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.mutsumi-picker-row:hover {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
}

.mutsumi-picker-check {
  flex: none;
  width: 16px;
  text-align: center;
}

.mutsumi-picker-check.codicon-check {
  color: var(--vscode-charts-green, #89d185);
}

.mutsumi-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mutsumi-settings-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px;
  font-size: 0.85em;
  font-weight: 600;
  opacity: 0.75;
  user-select: none;
}

/* --- Tree rows --- */
.mutsumi-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 2px;
  min-height: 22px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.mutsumi-tree-row:hover {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
}

.mutsumi-tree-chevron {
  flex: none;
  width: 16px;
  text-align: center;
  opacity: 0.8;
}

.mutsumi-tree-spacer {
  visibility: hidden;
}

.mutsumi-tree-type-icon {
  flex: none;
  opacity: 0.9;
}

.mutsumi-tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mutsumi-tree-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.6;
  padding: 0;
}

.mutsumi-tree-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  opacity: 1;
}

.mutsumi-tree-toggle.is-on {
  color: var(--vscode-charts-green, #89d185);
  opacity: 1;
}

.mutsumi-tree-toggle.is-partial {
  color: var(--vscode-charts-yellow, #cca700);
  opacity: 1;
}

.mutsumi-tree-remove {
  flex: none;
  display: inline-flex;
  visibility: hidden;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
  padding: 0;
}

.mutsumi-tree-row:hover .mutsumi-tree-remove {
  visibility: visible;
}

.mutsumi-tree-remove:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  color: var(--vscode-errorForeground, #f48771);
  opacity: 1;
}

.mutsumi-tree-children {
  margin-left: 12px;
}

/* --- Turns --- */
.mutsumi-turn-row {
  margin-bottom: 16px;
}

.mutsumi-user-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.mutsumi-user-bubble {
  max-width: 70%;
  background: var(--vscode-chat-requestBubbleBackground, var(--vscode-editorWidget-background, rgba(128,128,128,0.15)));
  border: 1px solid var(--vscode-chat-requestBorder, transparent);
  color: var(--vscode-foreground);
  border-radius: 12px;
  padding: 8px 14px;
  white-space: normal;
  word-break: break-word;
}

.mutsumi-user-bubble img {
  max-width: 320px;
  max-height: 240px;
  display: block;
  margin: 4px 0;
}

.mutsumi-user-bubble p {
  margin: 4px 0;
}

.mutsumi-agent-turn {
  width: 100%;
  padding: 0 4px;
}

.mutsumi-menu-bar {
  display: flex;
  gap: 4px;
  margin: 4px 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.mutsumi-turn-row:hover .mutsumi-menu-bar,
.mutsumi-menu-bar:focus-within {
  opacity: 1;
}

.mutsumi-menu-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  opacity: 0.7;
  cursor: pointer;
  font-size: 0.85em;
  padding: 3px 4px;
  border-radius: 4px;
}

.mutsumi-menu-item:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  opacity: 1;
}

/* --- Approvals --- */
.mutsumi-approvals {
  flex: none;
  padding: 0 16px;
}

.mutsumi-approval-card {
  border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
  border-radius: 8px;
  padding: 10px 14px;
  margin: 8px 0;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
}

.mutsumi-approval-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.mutsumi-approval-target {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.85em;
  opacity: 0.8;
  word-break: break-all;
}

.mutsumi-approval-details {
  font-size: 0.85em;
  max-height: 120px;
  overflow: auto;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  padding: 8px;
  border-radius: 4px;
  white-space: pre-wrap;
}

.mutsumi-approval-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.mutsumi-approval-buttons button,
.mutsumi-reject-reason-row button {
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.mutsumi-approval-buttons button:hover,
.mutsumi-reject-reason-row button:hover {
  background: var(--vscode-button-hoverBackground);
}

.mutsumi-reject-button {
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.25)) !important;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)) !important;
}

.mutsumi-reject-reason-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.mutsumi-reject-reason-row input {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  padding: 4px 8px;
}

.mutsumi-dispatch-list {
  margin: 6px 0;
  padding-left: 20px;
  font-size: 0.9em;
}

/* --- Error banner --- */
.mutsumi-error-banner {
  border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 8px 0;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  word-break: break-word;
}

.mutsumi-banner-dismiss {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

/* --- Input area --- */
.mutsumi-input-container {
  flex: none;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  padding: 8px 16px 12px;
}

.mutsumi-queue-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.mutsumi-queue-chip {
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.15));
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.85em;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mutsumi-toolbar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.mutsumi-toolbar-buttons {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.mutsumi-toolbar-item {
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  opacity: 0.75;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.85em;
}

.mutsumi-toolbar-item:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
  opacity: 1;
}

body[data-auto-approve="true"] .mutsumi-toolbar-item[data-toolbar-id="autoApprove"] {
  background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.25));
  opacity: 1;
}

.mutsumi-rename-row {
  display: none;
  gap: 6px;
  margin-bottom: 6px;
}

.mutsumi-rename-row.is-open {
  display: flex;
}

.mutsumi-rename-row input {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  padding: 4px 8px;
}

.mutsumi-rename-row button {
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.mutsumi-attach-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.mutsumi-attach-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}

.mutsumi-input-wrap {
  position: relative;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
  border-radius: 8px;
  background: var(--vscode-input-background);
  min-height: 68px;
}

.mutsumi-input-highlight,
.mutsumi-input-textarea {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.mutsumi-input-highlight {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: var(--vscode-editor-foreground);
}

.mutsumi-input-textarea {
  position: relative;
  display: block;
  width: 100%;
  box-sizing: border-box;
  border: none;
  outline: none;
  resize: vertical;
  background: transparent;
  color: transparent;
  caret-color: var(--vscode-editor-foreground);
  min-height: 68px;
  max-height: 240px;
}

.mutsumi-input-textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.mutsumi-action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  justify-content: flex-end;
}

.mutsumi-mode-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  border-radius: 6px;
  padding: 4px 8px 4px 10px;
  font-size: 0.85em;
  line-height: 1.4;
  cursor: pointer;
}

.mutsumi-mode-button:hover {
  background: var(--vscode-dropdown-listBackground, var(--vscode-input-background));
  border-color: var(--vscode-focusBorder, transparent);
}

.mutsumi-mode-button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: -1px;
}

.mutsumi-mode-button .codicon {
  opacity: 0.7;
}

/* Tell Chromium which color scheme the page is in so UA-drawn surfaces
   (scrollbars, native controls) render dark/light consistently. */
body.vscode-dark {
  color-scheme: dark;
}

body.vscode-light {
  color-scheme: light;
}

.mutsumi-send-button,
.mutsumi-interrupt-button {
  border: none;
  border-radius: 4px;
  padding: 5px 16px;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.mutsumi-send-button:hover,
.mutsumi-interrupt-button:hover {
  background: var(--vscode-button-hoverBackground);
}

.mutsumi-interrupt-button {
  background: var(--vscode-inputValidation-errorBackground, #a1260d);
}

/* --- Debug overlay --- */
.mutsumi-debug-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 10;
}

.mutsumi-debug-overlay.is-open {
  display: flex;
  align-items: center;
  justify-content: center;
}

.mutsumi-debug-panel {
  width: 80%;
  max-height: 80%;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
  border-radius: 8px;
  padding: 12px;
}

.mutsumi-debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 8px;
}

.mutsumi-debug-header button {
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.mutsumi-debug-content {
  overflow: auto;
  flex: 1;
  font-size: 0.85em;
  white-space: pre-wrap;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  padding: 10px;
  border-radius: 6px;
}

/* --- Deleted notice --- */
.mutsumi-deleted-notice {
  text-align: center;
  opacity: 0.7;
  padding: 40px 0;
}
`;
