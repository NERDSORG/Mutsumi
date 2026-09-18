/**
 * @fileoverview Pure interface contracts for the Lite adapter.
 * @module frontend/frontends/lite/interfaces
 */

/** Options for a one-shot Lite run. */
export interface LiteRunOptions {
    /** Model identifier (must be declared by the provider). */
    model: string;
    /** Provider name serving the model. */
    provider: string;
    maxLoops?: number;
}
