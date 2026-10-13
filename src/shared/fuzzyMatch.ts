/**
 * @fileoverview Case-insensitive subsequence matching with lightweight
 * ranking (subsequence, never substring or prefix). Pure and dependency-free:
 * shared by the extension host and the webview bundle.
 *
 * @module shared/fuzzyMatch
 */

/** Result of matching a query against one candidate string. */
export interface FuzzyResult {
    matched: boolean;
    /** Higher is better; only meaningful when `matched` is true. */
    score: number;
}

/**
 * Test whether every character of `query` appears in order in `candidate`
 * (case-insensitive subsequence). Scoring rewards consecutive runs, matches
 * at word boundaries (after `/ \ - _ .` or at camelCase humps) and, all else
 * equal, shorter candidates.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyResult {
    if (query.length === 0) {
        return { matched: true, score: 0 };
    }
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();
    let qi = 0;
    let score = 0;
    let run = 0;
    for (let ci = 0; ci < c.length && qi < q.length; ci++) {
        if (c[ci] !== q[qi]) {
            run = 0;
            continue;
        }
        run++;
        score += 1 + run * 2;
        if (ci === 0 || isWordBoundary(candidate, ci)) {
            score += 8;
        }
        qi++;
    }
    if (qi < q.length) {
        return { matched: false, score: 0 };
    }
    return { matched: true, score: score - candidate.length * 0.01 };
}

function isWordBoundary(candidate: string, index: number): boolean {
    const prev = candidate[index - 1];
    if ('/\\-_. '.includes(prev)) {
        return true;
    }
    const ch = candidate[index];
    return ch >= 'A' && ch <= 'Z' && !(prev >= 'A' && prev <= 'Z');
}

/**
 * Filter and rank `items` by subsequence-matching `query` against
 * `text(item)`. Returns the matching items, best first.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
    return items
        .map(item => ({ item, result: fuzzyMatch(query, text(item)) }))
        .filter(entry => entry.result.matched)
        .sort((a, b) => b.result.score - a.result.score || text(a.item).localeCompare(text(b.item)))
        .map(entry => entry.item);
}
