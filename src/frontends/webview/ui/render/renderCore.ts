/**
 * @fileoverview Render core for the Mutsumi chat webview: micromark (GFM)
 * markdown, lowlight syntax highlighting, committed-block DOM caching,
 * fingerprint-prefixed incremental active reconciliation, <pre> salvaging,
 * and details open-state inheritance.
 *
 * Packaged as a per-turn {@link TurnRenderer} class (one instance per agent
 * turn).
 *
 * @module frontends/webview/ui/render/renderCore
 */

import type { RenderBlock, RenderData } from '../../../../shared/renderTypes';

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { createLowlight, all } from 'lowlight';
import { toHtml } from 'hast-util-to-html';

interface PreFingerprint {
  language: string;
  text: string;
}

/** Parse markdown to HTML using micromark with GFM support. */
export function renderMarkdown(md: string): string {
  if (!md) return '';
  return micromark(md, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: true,
    allowDangerousProtocol: true,
  } as any);
}

// --- Syntax highlighting via lowlight (highlight.js) ---
const lowlight = createLowlight(all);

// Register aliases for file extensions not covered by highlight.js defaults.
lowlight.registerAlias({ xml: ['htm', 'vue', 'svelte', 'astro'] });
lowlight.registerAlias('scss', 'sass');
lowlight.registerAlias('bash', 'fish');

/** Resolve a file extension to a registered lowlight language identifier. */
function getLanguageIdentifier(ext: string): string {
  const id = ext.toLowerCase();
  return lowlight.registered(id) ? id : '';
}

/** Highlight a `<code>` element's text content using lowlight. */
function highlightElement(codeEl: HTMLElement, lang: string): void {
  if (!lang || !lowlight.registered(lang)) return;
  const text = codeEl.textContent || '';
  if (!text) return;
  try {
    const tree = lowlight.highlight(lang, text);
    codeEl.innerHTML = toHtml(tree);
    codeEl.classList.add('hljs');
  } catch {
    // Unknown language or parse failure: leave code as-is.
  }
}

/**
 * Highlight markdown SOURCE text (for the input box overlay: syntax
 * highlighting only, no rendering). Returns HTML.
 */
export function highlightMarkdownSource(text: string): string {
  if (!text) return '';
  try {
    return toHtml(lowlight.highlight('markdown', text));
  } catch {
    const span = document.createElement('span');
    span.textContent = text;
    return span.innerHTML;
  }
}

function getDirectCode(pre: HTMLPreElement): HTMLElement | null {
  for (const child of Array.from(pre.children)) {
    if (child.tagName === 'CODE') return child as HTMLElement;
  }
  return null;
}

function getCodeLanguage(code: HTMLElement): string {
  const match = code.className.match(/(?:^|\s)language-([^\s]+)/);
  return match ? match[1].toLowerCase() : '';
}

// Paths from the official microsoft/vscode-codicons copy.svg and check.svg.
const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z"/></svg>';

/** Add the toolbar control to a fresh block-level code element. */
function decorateCodeBlock(pre: HTMLPreElement): void {
  if (!getDirectCode(pre) || pre.querySelector(':scope > .mutsumi-copy-code')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mutsumi-copy-code';
  button.title = 'Copy code';
  button.setAttribute('aria-label', 'Copy code');
  button.innerHTML = COPY_ICON;
  pre.appendChild(button);
}

/** Highlight and decorate all fresh code blocks in a committed block. */
function prepareCodeBlocks(
  container: HTMLElement,
  skip?: ReadonlySet<HTMLPreElement>
): void {
  container.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement as HTMLPreElement;
    if (skip && skip.has(pre)) return;
    const el = code as HTMLElement;
    highlightElement(el, getCodeLanguage(el));
    decorateCodeBlock(pre);
  });
}

/** Build an unhighlighted RenderBlock DOM element. */
function renderBlock(block: RenderBlock): HTMLElement {
  const div = document.createElement('div');
  div.className = 'mutsumi-block';

  switch (block.type) {
    case 'content': {
      div.innerHTML = renderMarkdown(block.markdown);
      break;
    }
    case 'reasoning': {
      const details = document.createElement('details');
      if (!block.collapsed) details.setAttribute('open', '');
      const summary = document.createElement('summary');
      summary.textContent = '💭 Thinking Process';
      details.appendChild(summary);
      const content = document.createElement('div');
      content.className = 'mutsumi-reasoning-content';
      content.innerHTML = renderMarkdown(block.markdown);
      details.appendChild(content);
      div.appendChild(details);
      break;
    }
    case 'toolCall': {
      const details = document.createElement('details');
      if (block.isStreaming) details.setAttribute('open', '');
      const summary = document.createElement('summary');
      const prefix = block.isStreaming ? '⏳ ' : '';
      const suffix = block.isStreaming ? ' ...' : '';
      summary.textContent = `${prefix}${block.summary}${suffix}`;
      details.appendChild(summary);

      const argsDiv = document.createElement('div');
      argsDiv.className = 'mutsumi-tool-args';
      const argsTitle = document.createElement('strong');
      argsTitle.textContent = `Arguments${block.isStreaming ? ' (Streaming)' : ''}:`;
      argsDiv.appendChild(argsTitle);

      const codeBlockArgs = new Set(block.renderingConfig?.argsToCodeBlock ?? []);
      const regularArgs: Record<string, any> = {};
      const codeArgs: Record<string, any> = {};
      for (const [key, value] of Object.entries(block.args)) {
        if (codeBlockArgs.has(key)) {
          codeArgs[key] = value;
        } else {
          regularArgs[key] = value;
        }
      }

      if (Object.keys(regularArgs).length > 0) {
        const ul = document.createElement('ul');
        for (const [key, value] of Object.entries(regularArgs)) {
          const li = document.createElement('li');
          const code1 = document.createElement('code');
          code1.textContent = key;
          const code2 = document.createElement('code');
          code2.textContent = JSON.stringify(value);
          li.appendChild(code1);
          li.appendChild(document.createTextNode(': '));
          li.appendChild(code2);
          ul.appendChild(li);
        }
        argsDiv.appendChild(ul);
      }

      if (block.renderingConfig?.argsToCodeBlock) {
        for (let i = 0; i < block.renderingConfig.argsToCodeBlock.length; i++) {
          const argName = block.renderingConfig.argsToCodeBlock[i];
          const val = codeArgs[argName];
          if (val !== undefined && val !== null) {
            let lang = '';
            if (!block.isStreaming && block.renderingConfig.codeBlockFilePaths) {
              const pathArgName = block.renderingConfig.codeBlockFilePaths[i];
              if (pathArgName) {
                const pathVal = block.args[pathArgName];
                // If the named arg is not a string, treat the entry itself as a literal path
                const pathToUse = typeof pathVal === 'string' ? pathVal : pathArgName;
                const ext = pathToUse.split('.').pop() || '';
                lang = getLanguageIdentifier(ext);
              }
            }
            const label = document.createElement('div');
            label.innerHTML = `<strong>${argName}:</strong>`;
            argsDiv.appendChild(label);
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = lang ? `language-${lang}` : '';
            code.textContent =
              typeof val === 'string'
                ? val
                : typeof val === 'object' && val !== null
                  ? JSON.stringify(val, null, 2)
                  : String(val);
            pre.appendChild(code);
            argsDiv.appendChild(pre);
          }
        }
      }

      details.appendChild(argsDiv);

      if (block.result !== undefined) {
        const resultTitle = document.createElement('div');
        resultTitle.innerHTML = '<strong>Result:</strong>';
        details.appendChild(resultTitle);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = block.result;
        pre.appendChild(code);
        details.appendChild(pre);
      }

      div.appendChild(details);
      break;
    }
  }
  return div;
}

function listPreElements(root: HTMLElement): HTMLPreElement[] {
  const result: HTMLPreElement[] = [];
  if (root.tagName === 'PRE') result.push(root as HTMLPreElement);
  root.querySelectorAll('pre').forEach((pre) => result.push(pre as HTMLPreElement));
  return result;
}

// --- DOM cache for incremental rendering (per TurnRenderer instance) ---
interface OutputCache {
  committedContainer: HTMLElement;
  activeContainer: HTMLElement;
  lastCommittedLength: number;
  // These maps only describe nodes currently owned by the active tree. The
  // recorded top-level value is always captured before syntax highlighting.
  activeFingerprints: Map<HTMLElement, string>;
  activePreFingerprints: Map<HTMLPreElement, PreFingerprint>;
}

function readPreFingerprint(
  pre: HTMLPreElement,
  cache: OutputCache
): PreFingerprint | null {
  const recorded = cache.activePreFingerprints.get(pre);
  if (recorded) return recorded;
  const code = getDirectCode(pre);
  if (!code) return null;
  return {
    language: getCodeLanguage(code),
    text: code.textContent || '',
  };
}

function equalPreFingerprint(a: PreFingerprint, b: PreFingerprint): boolean {
  return a.language === b.language && a.text === b.text;
}

/** Preserve user-controlled details state when replacing an active block. */
function inheritDetailsOpenState(oldRoot: HTMLElement, newRoot: HTMLElement): void {
  const listDetails = (root: HTMLElement): HTMLDetailsElement[] => {
    const details = Array.from(root.querySelectorAll('details'));
    if (root.tagName === 'DETAILS') details.unshift(root as HTMLDetailsElement);
    return details;
  };
  const oldDetails = listDetails(oldRoot);
  const newDetails = listDetails(newRoot);
  const count = Math.min(oldDetails.length, newDetails.length);
  for (let i = 0; i < count; i++) {
    if (oldDetails[i].open !== newDetails[i].open) {
      newDetails[i].open = oldDetails[i].open;
    }
  }
}

/**
 * Move every unchanged old pre that can be found into the replacement tree.
 * Matching is not restricted to a particular container kind or pre position.
 */
function salvagePreElements(
  oldRoot: HTMLElement,
  newRoot: HTMLElement,
  cache: OutputCache
): void {
  const oldPres = listPreElements(oldRoot);
  const newPres = listPreElements(newRoot);
  const count = Math.min(oldPres.length, newPres.length);

  // The pre sequence is part of the parsed document structure, so salvage is
  // positional. This avoids moving a later duplicate block into an earlier
  // location when markdown restructuring changes the sequence.
  for (let i = 0; i < count; i++) {
    const oldPre = oldPres[i];
    const newPre = newPres[i];
    const oldFingerprint = readPreFingerprint(oldPre, cache);
    const newFingerprint = readPreFingerprint(newPre, cache);
    if (
      oldFingerprint &&
      newFingerprint &&
      equalPreFingerprint(oldFingerprint, newFingerprint)
    ) {
      newPre.replaceWith(oldPre);
    }
  }
}

/** Remove metadata for nodes that are about to leave the active DOM. */
function forgetActiveSubtree(root: HTMLElement, cache: OutputCache): void {
  cache.activeFingerprints.delete(root);
  for (const pre of listPreElements(root)) {
    cache.activePreFingerprints.delete(pre);
  }
}

/**
 * Move matching pre nodes from the active tree into a newly committed block,
 * preserving their completed highlighting. Matching is purely content-based:
 * highlighting is a deterministic function of (language, text), so any active
 * pre with an equal fingerprint is interchangeable, duplicates included.
 *
 * Only pre nodes migrate; block shells (e.g. collapsed committed reasoning vs
 * open active reasoning) are always rebuilt. Moved pres leave the active tree,
 * so their active-side fingerprint records are dropped; the committed tree
 * never participates in alignment, so no new records are registered.
 *
 * Must run before reconcileActive, while the active tree is still intact.
 * Candidates are limited to active nodes that will not survive the upcoming
 * prefix alignment against activeTarget: stealing a pre from a surviving node
 * would leave a visible hole in it. (Pending tools sit after content in the
 * active tree, so a completing toolCall could otherwise steal from content
 * that stays active.)
 *
 * Returns the pre nodes moved into newRoot (already highlighted).
 */
function salvageActivePreElements(
  newRoot: HTMLElement,
  cache: OutputCache,
  activeTarget: HTMLElement
): Set<HTMLPreElement> {
  const moved = new Set<HTMLPreElement>();
  const newPres = listPreElements(newRoot);
  if (newPres.length === 0) return moved;

  // Reproduce the prefix alignment reconcileActive will perform. It compares
  // stored (pre-highlight) fingerprints, which DOM mutations from salvaging do
  // not affect, so the result is identical to what reconcileActive computes.
  const oldNodes = Array.from(cache.activeContainer.children) as HTMLElement[];
  const newNodes = Array.from(activeTarget.children) as HTMLElement[];
  let prefixLength = 0;
  while (
    prefixLength < oldNodes.length &&
    prefixLength < newNodes.length &&
    cache.activeFingerprints.get(oldNodes[prefixLength]) ===
      newNodes[prefixLength].outerHTML
  ) {
    prefixLength++;
  }

  const candidates: Array<{ pre: HTMLPreElement; fingerprint: PreFingerprint }> = [];
  for (let i = prefixLength; i < oldNodes.length; i++) {
    for (const pre of listPreElements(oldNodes[i])) {
      const fingerprint = readPreFingerprint(pre, cache);
      if (fingerprint) candidates.push({ pre, fingerprint });
    }
  }

  for (const newPre of newPres) {
    const code = getDirectCode(newPre);
    if (!code) continue;
    const target: PreFingerprint = {
      language: getCodeLanguage(code),
      text: code.textContent || '',
    };
    let matched: { pre: HTMLPreElement; fingerprint: PreFingerprint } | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (candidate && equalPreFingerprint(candidate.fingerprint, target)) {
        matched = candidate;
        candidates.splice(i, 1);
        break;
      }
    }
    if (!matched) continue;
    newPre.replaceWith(matched.pre);
    cache.activePreFingerprints.delete(matched.pre);
    moved.add(matched.pre);
  }
  return moved;
}

/** Highlight and decorate only pre nodes that were not salvaged from the DOM. */
function prepareFreshPreElements(root: HTMLElement, cache: OutputCache): void {
  for (const pre of listPreElements(root)) {
    if (cache.activePreFingerprints.has(pre)) continue;
    const code = getDirectCode(pre);
    if (!code) continue;
    const fingerprint = {
      language: getCodeLanguage(code),
      text: code.textContent || '',
    };
    cache.activePreFingerprints.set(pre, fingerprint);
    highlightElement(code, fingerprint.language);
    decorateCodeBlock(pre);
  }
}

function clearActiveState(cache: OutputCache): void {
  cache.activeContainer.innerHTML = '';
  cache.activeFingerprints.clear();
  cache.activePreFingerprints.clear();
}

/**
 * Reconcile an unhighlighted active tree against the current highlighted DOM.
 * Prefix comparison always uses fingerprints captured before highlighting.
 */
function reconcileActive(cache: OutputCache, target: HTMLElement): void {
  const oldNodes = Array.from(cache.activeContainer.children) as HTMLElement[];
  const newNodes = Array.from(target.children) as HTMLElement[];
  const newFingerprints = newNodes.map((node) => node.outerHTML);

  let prefixLength = 0;
  while (
    prefixLength < oldNodes.length &&
    prefixLength < newNodes.length &&
    cache.activeFingerprints.get(oldNodes[prefixLength]) === newFingerprints[prefixLength]
  ) {
    prefixLength++;
  }

  for (let i = prefixLength; i < newNodes.length; i++) {
    const newNode = newNodes[i];
    const oldNode = oldNodes[i];

    if (oldNode) {
      inheritDetailsOpenState(oldNode, newNode);
      salvagePreElements(oldNode, newNode, cache);
      // Salvaged pre nodes have already moved out, so only discarded nodes are
      // forgotten here.
      forgetActiveSubtree(oldNode, cache);
      cache.activeContainer.replaceChild(newNode, oldNode);
    } else {
      cache.activeContainer.appendChild(newNode);
    }

    cache.activeFingerprints.set(newNode, newFingerprints[i]);
    prepareFreshPreElements(newNode, cache);
  }

  for (let i = newNodes.length; i < oldNodes.length; i++) {
    forgetActiveSubtree(oldNodes[i], cache);
    oldNodes[i].remove();
  }
}

function buildActiveTarget(data: RenderData['active']): HTMLElement {
  const target = document.createElement('div');
  if (!data) return target;

  if (data.reasoning) {
    target.appendChild(renderBlock({
      type: 'reasoning',
      markdown: data.reasoning,
      collapsed: false,
    }));
  }
  if (data.content) {
    target.appendChild(renderBlock({
      type: 'content',
      markdown: data.content,
    }));
  }
  for (const pendingTool of data.pendingTools) {
    target.appendChild(renderBlock(pendingTool));
  }
  return target;
}

/**
 * Per-turn incremental renderer. Owns a committed container (DOM-cached,
 * rendered once) and an active container (reconciled per update) inside a
 * host element provided by the chat view.
 */
export class TurnRenderer {
  private cache: OutputCache;

  constructor(hostElement: HTMLElement) {
    const committedContainer = document.createElement('div');
    committedContainer.className = 'mutsumi-committed';
    const activeContainer = document.createElement('div');
    activeContainer.className = 'mutsumi-active';
    hostElement.appendChild(committedContainer);
    hostElement.appendChild(activeContainer);

    this.cache = {
      committedContainer,
      activeContainer,
      lastCommittedLength: 0,
      activeFingerprints: new Map(),
      activePreFingerprints: new Map(),
    };
  }

  /** Apply a full RenderData IR snapshot (committed + active). */
  update(data: RenderData): void {
    const cache = this.cache;
    const committed = data.committed || [];

    if (committed.length < cache.lastCommittedLength) {
      cache.committedContainer.innerHTML = '';
      cache.lastCommittedLength = 0;
      // A committed shrink denotes a replacement/new round. Active node
      // identity and all fingerprints must start from a clean state too.
      clearActiveState(cache);
    }

    // Build the active target up front: committed-block pre salvaging needs
    // it to tell which current active nodes will survive reconciliation.
    const activeTarget = buildActiveTarget(data.active);

    for (let i = cache.lastCommittedLength; i < committed.length; i++) {
      const blockEl = renderBlock(committed[i]);
      // Locked blocks usually just left the active tree, whose pres carry
      // completed highlighting. Reuse them and highlight only the remainder.
      const salvaged = salvageActivePreElements(blockEl, cache, activeTarget);
      prepareCodeBlocks(blockEl, salvaged);
      cache.committedContainer.appendChild(blockEl);
    }
    cache.lastCommittedLength = committed.length;

    reconcileActive(cache, activeTarget);
  }

  dispose(): void {
    this.cache.activeFingerprints.clear();
    this.cache.activePreFingerprints.clear();
  }
}

/**
 * One listener serves every copy-code button, including salvaged pres.
 * Install once at bundle startup.
 */
export function installCopyCodeHandler(): void {
  const clickHandler = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('.mutsumi-copy-code');
    if (!button) return;
    const pre = button.parentElement;
    if (!(pre instanceof HTMLPreElement) || !pre.closest('.mutsumi-block')) return;
    const code = getDirectCode(pre);
    if (!code) return;

    void navigator.clipboard.writeText(code.textContent || '').then(() => {
      if (!button.isConnected) return;
      button.classList.add('is-copied');
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Copied');
      button.innerHTML = CHECK_ICON;
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.classList.remove('is-copied');
        button.title = 'Copy code';
        button.setAttribute('aria-label', 'Copy code');
        button.innerHTML = COPY_ICON;
      }, 1500);
    }).catch(() => {
      // Clipboard access can be denied by the webview/browser; rendering stays intact.
    });
  };
  document.addEventListener('click', clickHandler);
}
