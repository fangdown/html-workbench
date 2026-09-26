import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MODEL_GROUPS, type ModelSnapshot, type RunDetail, type RunPage, type RunStatus, type RunSummary, type Usage } from '../shared/types.js';

type DbRow = Record<string, unknown>;

function jsonParse<T>(value: unknown, fallback: T): T {
  try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
    this.db = new DatabaseSync(resolve(filePath));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
        model TEXT NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('chat-completions','responses')),
        stream INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, config_id TEXT,
        prompt TEXT NOT NULL, constraint_text TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, raw_output TEXT NOT NULL DEFAULT '', html TEXT,
        created_at TEXT NOT NULL, completed_at TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT, error TEXT, source_run_id TEXT,
        FOREIGN KEY(config_id) REFERENCES model_configs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const configColumn = (this.db.prepare('PRAGMA table_info(runs)').all() as DbRow[]).find(column => column.name === 'config_id');
    if (configColumn?.notnull) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE runs_browser_configs (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, config_id TEXT,
            prompt TEXT NOT NULL, constraint_text TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            status TEXT NOT NULL, raw_output TEXT NOT NULL DEFAULT '', html TEXT,
            created_at TEXT NOT NULL, completed_at TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0,
            usage_json TEXT, error TEXT, source_run_id TEXT,
            FOREIGN KEY(config_id) REFERENCES model_configs(id)
          );
          INSERT INTO runs_browser_configs (id,request_id,config_id,prompt,constraint_text,snapshot_json,status,raw_output,html,created_at,completed_at,elapsed_ms,usage_json,error,source_run_id)
          SELECT id,request_id,config_id,prompt,constraint_text,snapshot_json,status,raw_output,html,created_at,completed_at,elapsed_ms,usage_json,error,source_run_id FROM runs;
          DROP TABLE runs;
          ALTER TABLE runs_browser_configs RENAME TO runs;
          CREATE INDEX idx_runs_created_at ON runs(created_at DESC);
          INSERT OR REPLACE INTO schema_meta(key,value) VALUES('browser_model_configs','1');
          COMMIT;
        `);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db.prepare("UPDATE runs SET status = 'interrupted', completed_at = COALESCE(completed_at, ?), error = COALESCE(error, '服务重启，中断了未完成任务。') WHERE status = 'running'").run(new Date().toISOString());
  }

  close() { this.db.close(); }

  private now() { return new Date().toISOString(); }

  createRun(input: { requestId: string; prompt: string; constraintText: string; snapshot: ModelSnapshot; sourceRunId?: string }) {
    const existing = this.db.prepare('SELECT id FROM runs WHERE request_id = ?').get(input.requestId) as DbRow | undefined;
    if (existing) return this.getRun(String(existing.id))!;
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO runs(id,request_id,config_id,prompt,constraint_text,snapshot_json,status,created_at,source_run_id)
      VALUES(?,?,?,?,?,?,?, ?,?)`).run(id, input.requestId, null, input.prompt, input.constraintText, JSON.stringify(input.snapshot), 'running', this.now(), input.sourceRunId ?? null);
    return this.getRun(id)!;
  }

  ownsRun(id: string, requestId: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM runs WHERE id = ? AND request_id = ?').get(id, requestId));
  }

  getRun(id: string): RunDetail | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as DbRow | undefined;
    return row ? this.toRun(row, true) : null;
  }

  updateRunOutput(id: string, output: string) { this.db.prepare('UPDATE runs SET raw_output = ? WHERE id = ?').run(output, id); }

  finishRun(id: string, result: { status: Exclude<RunStatus, 'running' | 'interrupted'>; rawOutput: string; html: string | null; elapsedMs: number; usage: Usage | null; error: string | null }) {
    this.db.prepare('UPDATE runs SET status=?,raw_output=?,html=?,elapsed_ms=?,usage_json=?,error=?,completed_at=? WHERE id=?').run(
      result.status, result.rawOutput, result.html, result.elapsedMs, result.usage ? JSON.stringify(result.usage) : null, result.error, this.now(), id,
    );
  }

  listRuns(limit = 50, offset = 0): RunPage {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as DbRow[];
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM runs').get() as DbRow).count);
    const active = this.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1").get() as DbRow | undefined;
    return { items: rows.map(row => this.toRun(row, false)), total, activeRun: active ? this.toRun(active, false) : null };
  }

  deleteRun(id: string) {
    return this.db.prepare("DELETE FROM runs WHERE id = ? AND status != 'running'").run(id).changes > 0;
  }

  private toRun(row: DbRow, detail: true): RunDetail;
  private toRun(row: DbRow, detail: false): RunSummary;
  private toRun(row: DbRow, detail: boolean): RunDetail | RunSummary {
    const saved = jsonParse<ModelSnapshot>(row.snapshot_json, {} as ModelSnapshot);
    const snapshot: ModelSnapshot = { group: saved.group ?? MODEL_GROUPS[0], model: saved.model, protocol: saved.protocol, stream: saved.stream, timeoutMs: saved.timeoutMs };
    const base = {
      id: String(row.id), prompt: String(row.prompt), snapshot, status: row.status as RunStatus,
      createdAt: String(row.created_at), completedAt: row.completed_at ? String(row.completed_at) : null,
      elapsedMs: Number(row.elapsed_ms) || 0, usage: jsonParse<Usage | null>(row.usage_json, null), error: row.error ? String(row.error) : null,
      hasHtml: Boolean(row.html),
    } satisfies RunSummary;
    return detail ? { ...base, constraint: String(row.constraint_text), rawOutput: String(row.raw_output), html: row.html ? String(row.html) : null } : base;
  }
}
