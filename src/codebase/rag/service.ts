import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  ChunkResult,
  ChunkInfo,
  FileRow,
  ChunkRow,
  VecMatchRow,
  ChunkDetailRow
} from "./interfaces"
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { TaskQueue } from "./taskQueue";
import { sha256, f32buf, mkChunk, lineChunks } from "./utils";
import { debugLogger } from "../../debugLogger";
import { getBetterSqlite3NativeBinding } from "../../utils";
import { CodebaseService, type OutlineNode } from "../service";

/**
 * OpenAI 兼容的 embedding API 响应格式
 */
interface EmbeddingResponse {
  object?: string;
  data: Array<{
    object?: string;
    embedding: number[];
    index?: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  RagService - 支持远程工作区的内存型 RAG 服务
//  使用外部 OpenAI 兼容 embedding 端点
// ════════════════════════════════════════════════════════════════════════════

interface WorkspaceDbEntry {
  db: Database.Database;       // 内存数据库
  remoteDbUri: vscode.Uri;         // 远程数据库文件位置
  isDirty: boolean;                // 是否有未保存的更改
  dirtyVersion: number;  
  saving?: Promise<void>;  
}

type LeafNode = {
  name: string;
  startLine: number;
  endLine: number;
}

export class RagService implements vscode.Disposable {
  // ── singleton ──────────────────────────────────────────────────────────
  private static instance: RagService | null = null;

  static async getInstance(
    ctx?: vscode.ExtensionContext
  ): Promise<RagService> {
    if (!RagService.instance) {
      if (!ctx) {
        throw new Error('RagService.getInstance() requires ExtensionContext for first initialization');
      }
      const svc = new RagService(ctx);
      await svc.boot();
      RagService.instance = svc;
    }
    return RagService.instance;
  }

  // ── properties ─────────────────────────────────────────────────────────

  /**
   * workspaceUri.toString() → 内存中的 SQLite 数据库
   * 所有数据库都在内存中操作，定期/按需序列化写回远程工作区
   */
  public readonly workspaceDbMap = new Map<string, WorkspaceDbEntry>();

  private readonly extCtx: vscode.ExtensionContext;
  private readonly queue = new TaskQueue(5);
  private readonly subs: vscode.Disposable[] = [];

  private embeddingEndpoint: string = "";
  private dim = 0; // embedding 维度 (从配置获取或探测)

  // 定期保存的间隔（30秒）
  private readonly SAVE_INTERVAL = 30000;
  private saveTimer?: NodeJS.Timeout;

  // ── constructor (private) ──────────────────────────────────────────────

  private constructor(ctx: vscode.ExtensionContext) {
    this.extCtx = ctx;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  I.  启动流程
  // ════════════════════════════════════════════════════════════════════════

  private async boot(): Promise<void> {
    this.log("Booting…");

    // 1. 读取 embedding 端点配置
    const config = vscode.workspace.getConfiguration("mutsumi");
    this.embeddingEndpoint = config.get<string>("embeddingEndpoint") ?? "";

    if (!this.embeddingEndpoint || this.embeddingEndpoint.trim() === "") {
      this.log("No embedding endpoint configured. RAG features are disabled.");
      return;
    }

    this.log(`Using embedding endpoint: ${this.embeddingEndpoint}`);
    // 探测嵌入维度
    this.dim = await this.detectEmbeddingDimension();
    this.log(`Embedding dimension = ${this.dim}`);

    // 2. 为每个工作区加载数据库（从远程读到内存）
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      await this.loadDb(wf.uri);
    }

    // 3. 监听工作区变化
    this.subs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        for (const a of e.added) await this.loadDb(a.uri);
        for (const r of e.removed) await this.unloadDb(r.uri);
      })
    );

    // 4. 启动定期保存定时器
    this.startPeriodicSave();

    // 5. 注册进程退出前保存
    this.subs.push({
      dispose: () => {
        this.stopPeriodicSave();
        this.saveAllDatabases();
      }
    });

    this.log("Boot complete.");
  }

  /**
   * 探测 embedding 维度
   * 发送一个测试请求来获取向量的维度
   */
  private async detectEmbeddingDimension(): Promise<number> {
    try {
      const response = await fetch(this.embeddingEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: "dimension test",
          model: "embedding-model" // 某些端点需要 model 参数
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as EmbeddingResponse;
      // OpenAI 兼容格式: data[0].embedding
      if (data.data && data.data[0] && Array.isArray(data.data[0].embedding)) {
        return data.data[0].embedding.length;
      }
      throw new Error("Unexpected response format from embedding endpoint");
    } catch (err: any) {
      this.log(`Failed to detect embedding dimension: ${err.message}`);
      throw new Error(
        `无法从 embedding 端点探测向量维度。请检查 mutsumi.embeddingEndpoint 配置是否正确。`
      );
    }
  }

  /**
   * 检查 RAG 服务是否启用了 embedding 功能
   */
  public isEmbeddingEnabled(): boolean {
    return !!this.embeddingEndpoint && this.embeddingEndpoint.trim() !== "" && this.dim > 0;
  }

  // ── 数据库生命周期 ────────────────────────────────────────────────────

  /**
   * 从远程工作区加载数据库到内存
   * 如果远程不存在，则创建新的内存数据库
   */
  private async loadDb(wsUri: vscode.Uri): Promise<Database.Database> {
    const key = wsUri.toString();
    if (this.workspaceDbMap.has(key)) {
      return this.workspaceDbMap.get(key)!.db;
    }

    // 计算 better-sqlite3 native 二进制路径（universal 包时使用）
    const nativeBinding = getBetterSqlite3NativeBinding(this.extCtx.extensionPath);
    const dbOptions = nativeBinding ? { nativeBinding } : undefined;

    // 远程数据库文件位置：工作区/.mutsumi/cache/rag.db
    const remoteDbUri = vscode.Uri.joinPath(wsUri, ".mutsumi", "cache", "rag.db");

    // 尝试从远程加载已有数据
    let db: Database.Database;
    try {
      const data = await vscode.workspace.fs.readFile(remoteDbUri);
      if (data && data.length > 0) {
        // 从序列化数据创建内存数据库
        db = new Database(Buffer.from(data), dbOptions);
        this.log(`Loaded existing DB from ${remoteDbUri.toString()}`);
      } else {
        db = new Database(":memory:", dbOptions);
      }
    } catch {
      // 文件不存在或读取失败，创建新内存数据库
      db = new Database(":memory:", dbOptions);
      this.log(`Creating new DB for ${wsUri.toString()}`);
    }

    // 初始化数据库结构（幂等）
    this.initDbSchema(db);

    this.workspaceDbMap.set(key, {
      db,
      remoteDbUri,
      isDirty: false,
      dirtyVersion: 0
    });

    return db;
  }

  /**
   * 初始化数据库表结构
   */
  private initDbSchema(db: Database.Database): void {
    try {
      // 加载 sqlite-vec 扩展
      sqliteVec.load(db);
      this.log(`[InitDb] sqlite-vec extension loaded`);
    } catch (err: any) {
      this.log(`[InitDb] ERROR loading sqlite-vec: ${err.message}`);
      throw err;
    }

    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");

      // 关系表
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          relative_path TEXT    UNIQUE NOT NULL,
          file_hash     TEXT    NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id     INTEGER NOT NULL,
          chunk_hash  TEXT    NOT NULL,
          chunk_text  TEXT    NOT NULL,
          symbol_name TEXT,
          start_line  INTEGER NOT NULL,
          end_line    INTEGER NOT NULL,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
      `);
      this.log(`[InitDb] Tables created/verified`);
    } catch (err: any) {
      this.log(`[InitDb] ERROR creating tables: ${err.message}`);
      throw err;
    }

    // vec0 向量虚拟表 - 使用探测到的维度
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
           embedding float[${this.dim}] distance_metric=cosine
         )`
      );
      this.log(`[InitDb] vec_chunks virtual table created/verified (dim=${this.dim})`);
    } catch (err: any) {
      this.log(`[InitDb] ERROR creating vec_chunks: ${err.message}`);
      // 尝试查询表是否已存在
      try {
        const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get();
        if (result) {
          this.log(`[InitDb] vec_chunks table exists, continuing...`);
        } else {
          throw err;
        }
      } catch {
        throw err;
      }
    }
  }

  private async unloadDb(wsUri: vscode.Uri): Promise<void> {  
    const key = wsUri.toString();  
    const entry = this.workspaceDbMap.get(key);  
    if (entry) {  
      await this.saveDatabase(entry);  
      entry.db.close();  
      this.workspaceDbMap.delete(key);  
      this.log(`Unloaded DB for ${wsUri.toString()}`);  
    }  
  }  

  /**
   * 将内存数据库序列化并写回远程工作区
   * 使用临时文件 + 重命名策略，防止写入过程中断导致数据库损坏
   */
  private async saveDatabase(entry: WorkspaceDbEntry): Promise<void> {  
    if (!entry.isDirty) return;  

    if (entry.saving) {  
      await entry.saving;  
      return;  
    }  

    const versionAtStart = entry.dirtyVersion;  

    entry.saving = (async () => {  
      try {  
        const dirUri = vscode.Uri.joinPath(entry.remoteDbUri, "..");  
        try {  
          await vscode.workspace.fs.createDirectory(dirUri);  
        } catch {}  
      
        const data = entry.db.serialize();  
      
        const tempUri = vscode.Uri.joinPath(dirUri, "rag.db.tmp");  
        await vscode.workspace.fs.writeFile(tempUri, data);  
        await vscode.workspace.fs.rename(tempUri, entry.remoteDbUri, { overwrite: true });  
      
        // 只有保存期间没有新修改，才能清掉脏标记  
        if (entry.dirtyVersion === versionAtStart) {  
          entry.isDirty = false;  
        }  
      
        this.log(`Saved DB to ${entry.remoteDbUri.toString()}`);  
      } catch (err) {  
        this.log(`Failed to save DB: ${err}`);  
      } finally {  
        entry.saving = undefined;  
      }  
    })();  

    await entry.saving;  
  }  

  /**
   * 保存所有工作区的数据库
   */
  private async saveAllDatabases(): Promise<void> {
    await Promise.all(
      [...this.workspaceDbMap.values()]
        .filter(entry => entry.isDirty)
        .map(entry => this.saveDatabase(entry))
    );
  }

  /**
   * 标记数据库为脏（需要保存）
   */
  private markDirty(wsUri: vscode.Uri): void {  
    const key = wsUri.toString();  
    const entry = this.workspaceDbMap.get(key);  
    if (entry) {  
      entry.isDirty = true;  
      entry.dirtyVersion++;  
    }  
  }  

  /**
   * 启动定期保存定时器
   */
  private startPeriodicSave(): void {
    this.saveTimer = setInterval(async () => {
      await this.saveAllDatabases();
    }, this.SAVE_INTERVAL);
  }

  private stopPeriodicSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = undefined;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  II.  增量更新流程
  // ════════════════════════════════════════════════════════════════════════

  async updateWorkspace(wsUri: vscode.Uri): Promise<void> {
    // 如果没有配置 embedding 端点，跳过整个更新流程
    if (!this.isEmbeddingEnabled()) {
      this.log(`Skipping workspace update - no embedding endpoint configured`);
      return;
    }

    const entry = this.workspaceDbMap.get(wsUri.toString());
    if (!entry) {
      throw new Error(`Database not loaded for workspace ${wsUri.toString()}`);
    }
    const db = entry.db;

    this.log(`Updating workspace ${wsUri.toString()} …`);

    // 发现所有文件
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(wsUri, "**/*"),
      "{**/node_modules/**,**/.git/**,**/.mutsumi/**,**/.continue/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/*.lock,**/*.tsbuildinfo,**/.DS_Store}"
    );

    const seen = new Set<string>();

    const tasks = uris.map((uri) =>
      this.queue.add(() => this.processFile(db, wsUri, uri, seen))
    );
    await Promise.allSettled(tasks);

    // 清理已删除文件
    const allFiles = db
      .prepare("SELECT id, relative_path FROM files")
      .all() as FileRow[];

    db.transaction(() => {
      for (const f of allFiles) {
        if (!seen.has(f.relative_path)) {
          this.removeFileChunks(db, f.id);
          db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
        }
      }
    })();

    // 标记为脏，需要保存
    this.markDirty(wsUri);

    this.log(`Workspace ${wsUri.toString()} update done.`);
  }

  // ── 单文件处理 ────────────────────────────────────────────────────────

  private async processFile(
    db: Database.Database,
    wsUri: vscode.Uri,
    uri: vscode.Uri,
    seen: Set<string>
  ): Promise<void> {
    const rel = this.getRelativePath(wsUri, uri);
    seen.add(rel);

    this.log(`[ProcessFile] Starting: ${rel}`);

    // 读取文件 - 使用 vscode.workspace.fs 支持远程文件系统
    let content: string;
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      if (buf.subarray(0, 8192).includes(0)) {
        this.log(`[ProcessFile] Skipping binary file: ${rel}`);
        return;
      }
      content = new TextDecoder("utf-8").decode(buf);
      this.log(`[ProcessFile] Read ${content.length} chars from: ${rel}`);
    } catch (err) {
      this.log(`[ProcessFile] Failed to read ${rel}: ${err}`);
      return;
    }
    if (content.length === 0) {
      this.log(`[ProcessFile] Empty file, skipping: ${rel}`);
      return;
    }
    if (content.length > 1_048_576) {
      this.log(`[ProcessFile] File too large (>1MB), skipping: ${rel}`);
      return;
    }

    const fileHash = sha256(content);
    this.log(`[ProcessFile] File hash: ${fileHash.slice(0, 16)}... for ${rel}`);

    const existing = db
      .prepare("SELECT id, file_hash FROM files WHERE relative_path = ?")
      .get(rel) as FileRow | undefined;

    if (existing?.file_hash === fileHash) {
      this.log(`[ProcessFile] File unchanged, skipping: ${rel}`);
      return;
    }

    this.log(`[ProcessFile] Chunking: ${rel}`);
    const newChunks = await this.chunkFile(uri, content);
    this.log(`[ProcessFile] Generated ${newChunks.length} chunks for: ${rel}`);

    if (newChunks.length === 0) {
      this.log(`[ProcessFile] No chunks generated for: ${rel}`);
      return;
    }

    let fileId: number;
    if (existing) {
      db.prepare(
        "UPDATE files SET file_hash = ?, updated_at = ? WHERE id = ?"
      ).run(fileHash, Date.now(), existing.id);
      fileId = existing.id;
      this.log(`[ProcessFile] Updated existing file record, id=${fileId}: ${rel}`);
    } else {
      const info = db
        .prepare(
          "INSERT INTO files (relative_path, file_hash, updated_at) VALUES (?,?,?)"
        )
        .run(rel, fileHash, Date.now());
      fileId = Number(info.lastInsertRowid);
      this.log(`[ProcessFile] Created new file record, id=${fileId}: ${rel}`);
    }

    const oldChunks = db
      .prepare("SELECT id, chunk_hash FROM chunks WHERE file_id = ?")
      .all(fileId) as ChunkRow[];
    this.log(`[ProcessFile] Found ${oldChunks.length} existing chunks for file_id=${fileId}`);

    const pool = new Map<string, number[]>();
    for (const oc of oldChunks) {
      let ids = pool.get(oc.chunk_hash);
      if (!ids) {
        ids = [];
        pool.set(oc.chunk_hash, ids);
      }
      ids.push(oc.id);
    }

    const reusedIds = new Set<number>();
    const toEmbed: ChunkInfo[] = [];

    for (const nc of newChunks) {
      const avail = pool.get(nc.hash);
      if (avail && avail.length > 0) {
        const oldId = avail.shift()!;
        reusedIds.add(oldId);
        db.prepare(
          "UPDATE chunks SET start_line=?, end_line=?, symbol_name=?, chunk_text=? WHERE id=?"
        ).run(nc.startLine, nc.endLine, nc.symbolName, nc.text, oldId);
      } else {
        toEmbed.push(nc);
      }
    }

    this.log(`[ProcessFile] Reused ${reusedIds.size} chunks, need to embed ${toEmbed.length} new chunks for: ${rel}`);

    db.transaction(() => {
      for (const oc of oldChunks) {
        if (!reusedIds.has(oc.id)) {
          db.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(oc.id);
          db.prepare("DELETE FROM chunks WHERE id = ?").run(oc.id);
        }
      }
    })();

    // 检查 embedding 是否可用
    if (!this.isEmbeddingEnabled()) {
      this.log(`[ProcessFile] Embedding disabled, skipping ${toEmbed.length} embeddings for: ${rel}`);
      return;
    }

    const embeddings: { chunk: ChunkInfo; vec: readonly number[] }[] = [];
    for (let i = 0; i < toEmbed.length; i++) {
      const c = toEmbed[i];
      const prefix = c.symbolName ? `${rel} - ${c.symbolName}\n` : `${rel}\n`;
      const textWithPath = prefix + c.text;
      this.log(`[ProcessFile] Embedding chunk ${i+1}/${toEmbed.length} (${textWithPath.length} chars) for: ${rel}`);
      const vec = await this.embed(textWithPath);
      embeddings.push({ chunk: c, vec });
    }

    this.log(`[ProcessFile] Writing ${embeddings.length} embeddings to DB for: ${rel}`);

    try {
      // 显式事务，带错误捕获
      const insertChunk = db.prepare(`
        INSERT INTO chunks (file_id, chunk_hash, chunk_text, symbol_name, start_line, end_line)
        VALUES (?,?,?,?,?,?)
      `);
      const insertVec = db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?,?)');

      db.transaction(() => {
        for (const { chunk, vec } of embeddings) {
          let chunkId: number;
          try {
            const info = insertChunk.run(
              fileId,
              chunk.hash,
              chunk.text,
              chunk.symbolName,
              chunk.startLine,
              chunk.endLine
            );
            // 强制转换为标准 JavaScript number
            chunkId = Number(info.lastInsertRowid);
            this.log(`[ProcessFile] Inserted chunks row, id=${chunkId} (raw=${info.lastInsertRowid}, type=${typeof info.lastInsertRowid})`);
          } catch (err: any) {
            this.log(`[ProcessFile] ERROR inserting chunks row: ${err.message}`);
            throw err;
          }

          try {
            // sqlite-vec 对整数类型很严格，使用 parseInt 确保是标准整数
            const safeChunkId = parseInt(String(chunkId), 10);
            if (!Number.isInteger(safeChunkId) || safeChunkId <= 0) {
              throw new Error(`chunkId ${safeChunkId} (from ${chunkId}) is not a valid positive integer`);
            }
            this.log(`[ProcessFile] About to insert vec_chunks with rowid=${safeChunkId}`);

            // 使用 exec 直接执行 SQL 避免参数绑定类型问题
            const vecBuffer = f32buf(vec);
            const hexVec = vecBuffer.toString('hex');
            db.exec(`INSERT INTO vec_chunks(rowid, embedding) VALUES (${safeChunkId}, x'${hexVec}')`);

            this.log(`[ProcessFile] Inserted vec_chunks row for chunkId=${safeChunkId}`);
          } catch (err: any) {
            this.log(`[ProcessFile] ERROR inserting vec_chunks row for chunkId=${chunkId}: ${err.message}`);
            throw err;
          }
        }
      })();

      this.log(`[ProcessFile] Transaction committed successfully for: ${rel}`);
    } catch (err: any) {
      this.log(`[ProcessFile] TRANSACTION FAILED for ${rel}: ${err.message}`);
      this.log(`[ProcessFile] Stack: ${err.stack}`);
    }

    this.log(`[ProcessFile] Completed: ${rel} (${newChunks.length} chunks total)`);
  }

  private getRelativePath(wsUri: vscode.Uri, fileUri: vscode.Uri): string {
    const wsPath = wsUri.path;
    const filePath = fileUri.path;

    if (!filePath.startsWith(wsPath)) {
      return filePath;
    }

    let rel = filePath.slice(wsPath.length);
    if (rel.startsWith("/")) {
      rel = rel.slice(1);
    }
    return rel;
  }

  private removeFileChunks(db: Database.Database, fileId: number): void {
    const cids = (
      db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId) as {
        id: number;
      }[]
    ).map((r) => r.id);
    for (const cid of cids) {
      db.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(cid);
    }
    db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Chunking（切块策略）
  // ════════════════════════════════════════════════════════════════════════

  private async chunkFile(
    uri: vscode.Uri,
    content: string
  ): Promise<ChunkInfo[]> {
    const lines = content.split("\n");
    this.log(`[ChunkFile] File has ${lines.length} lines: ${uri.toString()}`);

    if (lines.length === 0) {
      this.log(`[ChunkFile] Empty file, returning 0 chunks`);
      return [];
    }

    // 尝试使用 Tree-sitter 进行语义切块
    try {
      this.log(`[ChunkFile] Trying Tree-sitter based chunking...`);
      const codebaseService = CodebaseService.getInstance();
      const outline = await codebaseService.getFileOutline(uri, content);

      if (outline && outline.length > 0) {
        this.log(`[ChunkFile] Got ${outline.length} outline nodes from Tree-sitter`);
        const chunks = this.outlineToChunks(lines, outline);
        this.log(`[ChunkFile] Tree-sitter chunking produced ${chunks.length} chunks`);
        return chunks;
      } else {
        this.log(`[ChunkFile] Tree-sitter returned no outline nodes`);
      }
    } catch (err) {
      this.log(`[ChunkFile] Tree-sitter chunking failed: ${err}`);
    }

    // 回退到行切块
    this.log(`[ChunkFile] Falling back to line-based chunking`);
    const chunks = lineChunks(lines);
    this.log(`[ChunkFile] Line chunking produced ${chunks.length} chunks`);
    return chunks;
  }

  private collectLeafNodes(
    nodes: OutlineNode[],
    prefix?: string
  ): LeafNode[] {
    const leaves: LeafNode[] = [];

    for (const node of nodes) {
      const fullName = prefix ? `${prefix}.${node.name}` : node.name;

      if (node.children && node.children.length > 0) {
        leaves.push(...this.collectLeafNodes(node.children, fullName));
      } else {
        leaves.push({
          name: fullName,
          startLine: node.startLine,
          endLine: node.endLine,
        });
      }
    }

    return leaves;
  }

  private shouldKeepChunkText(text: string): boolean {
    const t = text.trim();
    if (!t) return false;

    // 太短直接丢
    if (t.length < 3) return false;

    // 至少要有"字母 / 数字 / 下划线 / CJK"
    return /[\p{L}\p{N}_$]/u.test(t);
  }

  /**
   * 将 Tree-sitter outline 转换为 chunks
   */
  private outlineToChunks(
    lines: string[],
    outline: OutlineNode[]
  ): ChunkInfo[] {
    if (!outline || outline.length === 0) return [];

    // 1. 只收集叶子节点
    const leaves = this.collectLeafNodes(outline);

    if (leaves.length === 0) return [];

    // 2. 按起始行排序
    leaves.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.endLine - b.endLine;
    });

    const chunks: ChunkInfo[] = [];
    let cursor = 0;

    for (const leaf of leaves) {
      // 跳过非法节点
      if (leaf.endLine < leaf.startLine) {
        this.log(
          `[OutlineToChunks] Skip invalid leaf: ${leaf.name} (${leaf.startLine}-${leaf.endLine})`
        );
        continue;
      }

      // 如果出现重叠/倒退，做保护
      if (leaf.endLine < cursor) {
        this.log(
          `[OutlineToChunks] Skip overlapped leaf: ${leaf.name} (${leaf.startLine}-${leaf.endLine}), cursor=${cursor}`
        );
        continue;
      }

      // 3. 叶子节点前的 gap：只切"cursor 到 leaf.startLine-1"
      if (leaf.startLine > cursor) {
        const gapText = lines.slice(cursor, leaf.startLine).join("\n");
        if (this.shouldKeepChunkText(gapText)) {
          chunks.push(mkChunk(gapText.trim(), null, cursor, leaf.startLine - 1));
        }
      }

      // 4. 当前叶子节点本身
      const bodyStart = Math.max(cursor, leaf.startLine);
      const bodyText = lines.slice(bodyStart, leaf.endLine + 1).join("\n");
      if (this.shouldKeepChunkText(bodyText)) {
        chunks.push(mkChunk(bodyText.trim(), leaf.name, bodyStart, leaf.endLine));
      }

      // 5. cursor 推进到当前叶子之后
      cursor = leaf.endLine + 1;
    }

    // 6. 最后一个叶子之后的尾部 gap
    if (cursor < lines.length) {
      const tailText = lines.slice(cursor).join("\n");
      if (this.shouldKeepChunkText(tailText)) {
        chunks.push(mkChunk(tailText.trim(), null, cursor, lines.length - 1));
      }
    }

    return chunks;
  }


  // ════════════════════════════════════════════════════════════════════════
  //  Embedding 辅助 - 使用外部 OpenAI 兼容端点
  // ════════════════════════════════════════════════════════════════════════

  private async embed(text: string): Promise<readonly number[]> {
    if (!this.isEmbeddingEnabled()) {
      throw new Error("[RAG] Embedding service is not configured");
    }

    try {
      const response = await fetch(this.embeddingEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: text,
          model: "embedding-model" // 某些端点需要 model 参数，但通常会被忽略
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as EmbeddingResponse;
      
      // OpenAI 兼容格式: data[0].embedding
      if (!data.data || !data.data[0] || !Array.isArray(data.data[0].embedding)) {
        throw new Error("Unexpected response format from embedding endpoint");
      }

      const vec = data.data[0].embedding as number[];

      // 验证嵌入向量有效性
      if (!vec || vec.length === 0) {
        throw new Error(`[RAG] 嵌入失败: 返回空向量`);
      }

      // 验证维度匹配
      if (vec.length !== this.dim) {
        throw new Error(
          `[RAG] 嵌入失败: 维度不匹配, got=${vec.length}, expected=${this.dim}`
        );
      }

      const hasInvalid = vec.some(v => !Number.isFinite(v));
      if (hasInvalid) {
        const nanCount = vec.filter(v => Number.isNaN(v)).length;
        const infCount = vec.filter(v => !Number.isFinite(v) && !Number.isNaN(v)).length;
        throw new Error(
          `[RAG] 嵌入失败: 包含无效数值 (NaN: ${nanCount}, Inf: ${infCount}/${vec.length})`
        );
      }

      let norm2 = 0;
      for (const v of vec) {
        norm2 += v * v;
      }
      if (!Number.isFinite(norm2) || norm2 <= 1e-20) {
        throw new Error(`[RAG] 嵌入失败: 向量范数异常 (${norm2})`);
      }

      return vec;
    } catch (err: any) {
      throw new Error(`[RAG] Embedding request failed: ${err.message}`);
    }
  }


  // ════════════════════════════════════════════════════════════════════════
  //  III.  检索
  // ════════════════════════════════════════════════════════════════════════

  async search(
    wsUri: vscode.Uri,
    query: string,
    topK = 10
  ): Promise<ChunkResult[]> {
    // 检查 embedding 是否可用
    if (!this.isEmbeddingEnabled()) {
      throw new Error("RAG embedding service is not configured. Please set mutsumi.embeddingEndpoint in settings.");
    }

    const entry = this.workspaceDbMap.get(wsUri.toString());
    if (!entry) {
      throw new Error(`Database not loaded for workspace ${wsUri.toString()}`);
    }
    const db = entry.db;

    const qvec = await this.embed(query);

    const rows = db
      .prepare(
        `SELECT rowid, distance
         FROM   vec_chunks
         WHERE  embedding MATCH ?
           AND  k = ?`
      )
      .all(f32buf(qvec), topK) as VecMatchRow[];

    const results: ChunkResult[] = [];

    for (const row of rows) {
      const detail = db
        .prepare(
          `SELECT c.chunk_text,  c.symbol_name,
                  c.start_line,  c.end_line,
                  f.relative_path
           FROM   chunks c
           JOIN   files  f ON f.id = c.file_id
           WHERE  c.id = ?`
        )
        .get(row.rowid) as ChunkDetailRow | undefined;

      if (detail) {
        results.push({
          filePath: detail.relative_path,
          symbolName: detail.symbol_name,
          startLine: detail.start_line,
          endLine: detail.end_line,
          text: detail.chunk_text,
          distance: row.distance,
        });
      }
    }

    return results;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Dispose
  // ════════════════════════════════════════════════════════════════════════

  dispose(): void {
    this.stopPeriodicSave();

    // 保存所有数据库
    for (const entry of this.workspaceDbMap.values()) {
      this.saveDatabase(entry);
      entry.db.close();
    }
    this.workspaceDbMap.clear();

    for (const d of this.subs) d.dispose();

    RagService.instance = null;
  }

  private log(msg: string): void {
    debugLogger.log(`[RAG] ${msg}`);
  }
}
