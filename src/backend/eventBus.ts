/**
 * @fileoverview In-process typed event bus with direction separation.
 *
 * Single global channel; routing happens via the `sessionId` carried in each
 * payload. FtB handlers are registered once by the AgentBackend through
 * {@link EventBus.registerBackendHandlers} (mapped type forces exhaustive
 * coverage); adapters subscribe to BtF facts via {@link EventBus.onBtF} or
 * {@link EventBus.subscribeAllBtF}.
 *
 * @module backend/eventBus
 */

import type { Disposable } from 'vscode';
import { BTF_EVENT_NAMES, FTB_EVENT_NAMES } from './events';
import type { BtFEventMap, FtBEventMap } from './events';

type Handler<P> = (payload: P) => void;

/**
 * Typed in-process event bus separating FtB (intent) and BtF (fact) traffic.
 */
export class EventBus {
    private readonly ftbHandlers = new Map<keyof FtBEventMap, Set<Handler<any>>>();
    private readonly btfHandlers = new Map<keyof BtFEventMap, Set<Handler<any>>>();
    private backendHandlersRegistered = false;

    /** Emit a frontend→backend intent. */
    emitFtB<K extends keyof FtBEventMap>(name: K, payload: FtBEventMap[K]): void {
        const handlers = this.ftbHandlers.get(name);
        if (!handlers) {
            return;
        }
        for (const handler of [...handlers]) {
            handler(payload);
        }
    }

    /** Subscribe to a frontend→backend intent. Intended for the backend only. */
    onFtB<K extends keyof FtBEventMap>(name: K, handler: Handler<FtBEventMap[K]>): Disposable {
        let handlers = this.ftbHandlers.get(name);
        if (!handlers) {
            handlers = new Set();
            this.ftbHandlers.set(name, handlers);
        }
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
    }

    /** Emit a backend→frontend fact. */
    emitBtF<K extends keyof BtFEventMap>(name: K, payload: BtFEventMap[K]): void {
        const handlers = this.btfHandlers.get(name);
        if (!handlers) {
            return;
        }
        for (const handler of [...handlers]) {
            handler(payload);
        }
    }

    /** Subscribe to a backend→frontend fact. Open to every frontend adapter. */
    onBtF<K extends keyof BtFEventMap>(name: K, handler: Handler<BtFEventMap[K]>): Disposable {
        let handlers = this.btfHandlers.get(name);
        if (!handlers) {
            handlers = new Set();
            this.btfHandlers.set(name, handlers);
        }
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
    }

    /**
     * Register the complete set of FtB handlers in one call. The mapped type
     * makes omitting any event a compile error. May only be called once per
     * bus (by the AgentBackend).
     */
    registerBackendHandlers(handlers: { [K in keyof FtBEventMap]: Handler<FtBEventMap[K]> }): Disposable {
        if (this.backendHandlersRegistered) {
            throw new Error('EventBus.registerBackendHandlers may only be called once');
        }
        this.backendHandlersRegistered = true;
        const disposables: Disposable[] = [];
        for (const name of FTB_EVENT_NAMES) {
            // Exhaustiveness is enforced by the mapped `handlers` parameter
            // type; the per-name narrowing is erased at the callsite.
            disposables.push(this.onFtB(name, handlers[name] as Handler<FtBEventMap[typeof name]>));
        }
        return { dispose: () => disposables.forEach(d => d.dispose()) };
    }

    /**
     * Subscribe to every BtF event at once (adapter bridge). The handler
     * receives the event name and an untyped payload.
     */
    subscribeAllBtF(handler: (name: string, payload: unknown) => void): Disposable {
        const disposables: Disposable[] = [];
        for (const name of BTF_EVENT_NAMES) {
            disposables.push(this.onBtF(name, payload => handler(name, payload)));
        }
        return { dispose: () => disposables.forEach(d => d.dispose()) };
    }
}
