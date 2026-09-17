/**
 * @fileoverview Adapter registry — the dependency-injection container for
 * frontend adapters. Deliberately minimal: register, disposeAll.
 * @module frontend/registry
 */

import type { AdapterContext, IFrontendAdapter } from './interfaces';

/**
 * Holds the registered frontend adapters. `activate` is invoked by the
 * assembler (extension.ts) per adapter with the shared AdapterContext.
 */
export class AdapterRegistry {
    private readonly adapters: IFrontendAdapter[] = [];

    register(adapter: IFrontendAdapter): void {
        this.adapters.push(adapter);
    }

    async activateAll(ctx: AdapterContext): Promise<void> {
        for (const adapter of this.adapters) {
            await adapter.activate(ctx);
        }
    }

    disposeAll(): void {
        for (const adapter of this.adapters) {
            try {
                adapter.dispose();
            } catch (e) {
                console.error(`[AdapterRegistry] dispose failed for ${adapter.id}:`, e);
            }
        }
        this.adapters.length = 0;
    }
}
