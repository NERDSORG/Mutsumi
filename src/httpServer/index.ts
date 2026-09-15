import * as vscode from 'vscode';
import * as net from 'net';
import * as crypto from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import { HeadlessAdapter } from '../adapters/headlessAdapter';
import { HttpServerOptions } from './types';
import { debugLogger } from '../debugLogger';

// Import endpoint handlers
import {
    createCreateAgentHandler,
    createListAgentsHandler
} from './agents';
import {
    handleGetAgent,
    handleDeleteAgent
} from './agent';
import { handleChat } from './chat';
import { createHandleSetModel } from './model';
import {
    handleGetReasoningEffort,
    handleSetReasoningEffort
} from './reasoningEffort';
import {
    handleListRules,
    handleGetRuleFile,
    handleSetRules
} from './rules';
import { handleStopAgent } from './stop';
import {
    handleApprove,
    handleReject,
    handleCustom,
    handleListPending
} from './approval';

export { HttpServerOptions } from './types';

export class HttpServer {
    private readonly app = express();
    private server?: ReturnType<typeof this.app.listen>;
    private actualPort?: number;
    private readonly adapter: HeadlessAdapter;
    private readonly abortControllers = new Map<string, AbortController>();
    private readonly extensionUri: vscode.Uri;
    private readonly host: string;
    private readonly startPort: number;
    private readonly maxPort: number;

    constructor(adapter: HeadlessAdapter, extensionUri: vscode.Uri, options?: HttpServerOptions) {
        this.adapter = adapter;
        this.extensionUri = extensionUri;
        this.host = options?.host ?? '127.0.0.1';
        this.startPort = options?.port ?? 3000;
        this.maxPort = this.startPort + 100; // Try up to 100 ports
    }

    /**
     * Find an available port starting from startPort.
     */
    private findAvailablePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const tryPort = (port: number) => {
                if (port > this.maxPort) {
                    reject(new Error(`No available ports found between ${this.startPort} and ${this.maxPort}`));
                    return;
                }

                const server = net.createServer();
                
                server.once('error', (err: any) => {
                    if (err.code === 'EADDRINUSE') {
                        // Port is in use, try next
                        tryPort(port + 1);
                    } else {
                        reject(err);
                    }
                });

                server.once('listening', () => {
                    server.close(() => {
                        resolve(port);
                    });
                });

                server.listen(port, this.host);
            };

            tryPort(this.startPort);
        });
    }

    async start(): Promise<void> {
        if (this.server) return;

        try {
            this.actualPort = await this.findAvailablePort();
            this.configureServer();
            this.server = this.app.listen(this.actualPort, this.host, () => {
                const message = `已于 http://${this.host}:${this.actualPort} 启动服务器`;
                debugLogger.log(message);
            });
        } catch (error) {
            debugLogger.log(`[HttpServer] Failed to start: ${error}`);
            throw error;
        }
    }

    stop(): void {
        if (!this.server) return;
        this.server.close();
        this.server = undefined;
        this.actualPort = undefined;
    }

    getPort(): number | undefined {
        return this.actualPort;
    }

    private configureServer(): void {
        // Bearer-token authentication, registered before ALL routes so it covers
        // every endpoint (including SSE streaming chat and approval endpoints).
        // The password is read from the live configuration on each request, so
        // changes to mutsumi.httpServer.password take effect without a restart.
        // Comparison uses SHA-256 digests + timingSafeEqual to avoid timing
        // side channels (timingSafeEqual requires equal-length buffers).
        this.app.use((req, res, next) => {
            const password = vscode.workspace
                .getConfiguration('mutsumi')
                .get<string>('httpServer.password', '');
            const header = req.headers.authorization;
            let authorized = false;
            if (password && header) {
                // Bearer scheme is case-insensitive per RFC 7235
                const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
                if (token) {
                    const tokenHash = crypto.createHash('sha256').update(token).digest();
                    const passwordHash = crypto.createHash('sha256').update(password).digest();
                    authorized = crypto.timingSafeEqual(tokenHash, passwordHash);
                }
            }
            if (!authorized) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="mutsumi"');
                res.status(401).json({ status: 'error', content: 'Unauthorized.' });
                return;
            }
            next();
        });

        this.app.use(bodyParser.json({ limit: '2mb' }));

        // Agents endpoints
        this.app.post('/agents', createCreateAgentHandler({ extensionUri: this.extensionUri }));
        this.app.get('/agents', createListAgentsHandler({}));

        // Agent endpoints
        this.app.get('/agent/:uuid', handleGetAgent);
        this.app.delete('/agent/:uuid', handleDeleteAgent);

        // Chat endpoint
        this.app.post('/agent/:uuid/chat', (req, res) =>
            handleChat(req, res, this.adapter, this.abortControllers, this.extensionUri)
        );

        // Model endpoint
        const handleSetModel = createHandleSetModel(this.adapter);
        this.app.put('/agent/:uuid/model', handleSetModel);

        // Reasoning effort endpoints
        this.app.get('/agent/:uuid/reasoning-effort', handleGetReasoningEffort);
        this.app.put('/agent/:uuid/reasoning-effort', handleSetReasoningEffort);

        // Rules endpoints
        this.app.get('/rules', handleListRules);
        this.app.get('/rules/:name', handleGetRuleFile);
        this.app.put('/agent/:uuid/rules', handleSetRules);

        // Stop endpoint
        this.app.post('/agent/:uuid/stop', (req, res) =>
            handleStopAgent(req, res, { adapter: this.adapter, abortControllers: this.abortControllers })
        );

        // Approval endpoints
        this.app.get('/approval/pending', handleListPending);
        this.app.post('/approval/:id/approve', handleApprove);
        this.app.post('/approval/:id/reject', handleReject);
        this.app.post('/approval/:id/custom', handleCustom);
    }
}
