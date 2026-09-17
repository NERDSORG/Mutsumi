/**
 * @fileoverview Lite adapter — programmatic, non-interactive one-shot runs.
 *
 * No UI, no tools (empty tool set), no persistence: `runOnce` creates an
 * ephemeral session, enqueues a single prompt, converges the final text from
 * `session.output` events and resolves when the run goes idle. Approvals for
 * its own sessions are auto-answered (there is nothing to approve anyway —
 * the tool set is empty).
 *
 * Uses: external scripts / commands needing "send one prompt, get one
 * answer", and backend smoke-test drivers.
 *
 * @module frontends/lite/liteAdapter
 */

import type { Disposable } from 'vscode';
import type { RenderData } from '../../shared/renderTypes';
import type { AdapterContext, IFrontendAdapter } from '../../frontend/interfaces';
import type { LiteRunOptions } from './interfaces';

/** Extract plain text from a RenderData IR (committed content + active tail). */
function renderDataToText(renderData: RenderData): string {
    let text = '';
    for (const block of renderData.committed) {
        if (block.type === 'content') {
            text += block.markdown;
        }
    }
    if (renderData.active) {
        text += renderData.active.content;
    }
    return text;
}

export class LiteAdapter implements IFrontendAdapter {
    readonly id = 'lite';
    readonly capabilities = { interactive: false };

    private ctx: AdapterContext | undefined;

    activate(ctx: AdapterContext): void {
        this.ctx = ctx;
    }

    dispose(): void {
        this.ctx = undefined;
    }

    /**
     * Send one prompt through the real backend pipeline (ephemeral session,
     * empty tool set) and resolve with the final assistant text.
     */
    async runOnce(prompt: string, opts: LiteRunOptions): Promise<string> {
        if (!this.ctx) {
            throw new Error('LiteAdapter is not activated');
        }
        const { bus, backend } = this.ctx;

        const session = backend.createEphemeralSession({
            emptyToolSet: true,
            maxLoops: opts.maxLoops ?? 1,
            metadata: { model: opts.model, provider: opts.provider },
        });
        const sessionId = session.sessionId;

        let lastText = '';
        let errorMessage: string | null = null;
        const disposables: Disposable[] = [];

        const done = new Promise<void>(resolve => {
            disposables.push(
                bus.onBtF('session.output', payload => {
                    if (payload.sessionId === sessionId) {
                        lastText = renderDataToText(payload.renderData);
                    }
                }),
                bus.onBtF('session.error', payload => {
                    if (payload.sessionId === sessionId) {
                        errorMessage = payload.message;
                    }
                }),
                // Lite sessions are non-interactive: auto-answer their own
                // approvals (the empty tool set never produces any).
                bus.onBtF('approval.requested', payload => {
                    if (payload.sessionId === sessionId) {
                        bus.emitFtB('approval.respond', {
                            sessionId,
                            requestId: payload.request.id,
                            outcome: 'approve',
                            origin: 'lite',
                        });
                    }
                }),
                bus.onBtF('session.status', payload => {
                    if (payload.sessionId === sessionId && payload.status === 'idle') {
                        resolve();
                    }
                }),
            );
        });

        session.enqueueUserMessage(prompt, 'queue');
        await done;

        for (const d of disposables) {
            d.dispose();
        }
        if (errorMessage && !lastText) {
            throw new Error(errorMessage);
        }
        return lastText;
    }
}
