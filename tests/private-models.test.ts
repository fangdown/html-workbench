import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteLocalModel, readLocalModels, saveLocalModel } from '../src/localModels.ts';
import { parseGenerationModel, publicModelSnapshot } from '../server/modelInput.ts';
import { Store } from '../server/db.ts';
import type { ModelInput } from '../shared/types.ts';

function browserStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const config: ModelInput = {
  name: '本机配置', baseUrl: 'https://provider.example/v1', model: 'example-model',
  protocol: 'chat-completions', stream: true, isDefault: true, apiKey: 'TEST_ONLY_FAKE_API_KEY',
};

test('不同浏览器的模型配置相互隔离，编辑留空保留 Key', () => {
  const first = browserStorage();
  const second = browserStorage();
  const saved = saveLocalModel(config, null, first);
  assert.equal(readLocalModels(first).length, 1);
  assert.deepEqual(readLocalModels(second), []);
  const edited = saveLocalModel({ ...config, name: '新名称', apiKey: '' }, saved.id, first);
  assert.equal(edited.apiKey, config.apiKey);
  saveLocalModel({ ...config, name: '另一浏览器' }, null, second);
  deleteLocalModel(saved.id, first);
  assert.deepEqual(readLocalModels(first), []);
  assert.equal(readLocalModels(second)[0].name, '另一浏览器');
});

test('改名后仍可读取旧浏览器模型配置', () => {
  const storage = browserStorage();
  storage.setItem('html-workbench.models.v1', JSON.stringify([{ ...config, id: 'legacy', hasKey: true, keyMask: '••••••••', createdAt: '2026-09-26', updatedAt: '2026-09-26' }]));
  assert.equal(readLocalModels(storage)[0].name, config.name);
});

test('缺少本次配置不能回退共享 Key，公开快照不包含私有配置', () => {
  assert.throws(() => parseGenerationModel(undefined));
  assert.throws(() => parseGenerationModel({ ...config, apiKey: '' }));
  assert.throws(() => parseGenerationModel({ ...config, baseUrl: 'https://provider.example/v1?key=TEST_ONLY_FAKE_API_KEY' }));
  const parsed = parseGenerationModel(config);
  const snapshot = publicModelSnapshot(parsed);
  assert.deepEqual(Object.keys(snapshot).sort(), ['model', 'protocol', 'stream', 'timeoutMs']);
  assert.equal(JSON.stringify(snapshot).includes(config.apiKey!), false);
  assert.equal(JSON.stringify(snapshot).includes(config.baseUrl), false);
});

test('迁移保留旧历史，新增记录无需共享模型且只保存公开快照', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-zhili-private-models-'));
  const path = join(directory, 'history.sqlite');
  let legacy: DatabaseSync | undefined;
  let store: Store | undefined;
  try {
    legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE model_configs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
        model TEXT NOT NULL, protocol TEXT NOT NULL, stream INTEGER NOT NULL, is_default INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, config_id TEXT NOT NULL,
        prompt TEXT NOT NULL, constraint_text TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, raw_output TEXT NOT NULL DEFAULT '', html TEXT,
        created_at TEXT NOT NULL, completed_at TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT, error TEXT, source_run_id TEXT,
        FOREIGN KEY(config_id) REFERENCES model_configs(id)
      );
    `);
    legacy.prepare('INSERT INTO model_configs VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-config', '旧私有名称', config.baseUrl, 'LEGACY_ENCRYPTED_KEY', config.model, config.protocol, 1, 1, '2026-09-24', '2026-09-24');
    const html = '<!DOCTYPE html><html><body>历史画面</body></html>';
    const oldSnapshot = JSON.stringify({ configId: 'legacy-config', name: '旧私有名称', baseUrl: config.baseUrl, ...publicModelSnapshot(parseGenerationModel(config)) });
    legacy.prepare('INSERT INTO runs(id,request_id,config_id,prompt,constraint_text,snapshot_json,status,raw_output,html,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-run', 'legacy-request', 'legacy-config', '旧提示词', '旧约束', oldSnapshot, 'succeeded', html, html, '2026-09-24');
    const original = legacy.prepare('SELECT * FROM runs').all();
    legacy.close(); legacy = undefined;

    store = new Store(path);
    assert.deepEqual(store.db.prepare('SELECT * FROM runs').all(), original);
    assert.equal(store.getRun('legacy-run')?.html, html);
    assert.equal('baseUrl' in store.getRun('legacy-run')!.snapshot, false);
    assert.equal('name' in store.getRun('legacy-run')!.snapshot, false);
    const input = { requestId: 'browser-request', prompt: '新提示词', constraintText: '新约束', snapshot: publicModelSnapshot(parseGenerationModel(config)) };
    const run = store.createRun(input);
    assert.equal(store.createRun(input).id, run.id);
    assert.equal(store.ownsRun(run.id, input.requestId), true);
    assert.equal(store.ownsRun(run.id, 'another-browser'), false);
    const row = store.db.prepare('SELECT config_id, snapshot_json FROM runs WHERE id = ?').get(run.id)!;
    assert.equal(row.config_id, null);
    assert.deepEqual(JSON.parse(String(row.snapshot_json)), input.snapshot);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM model_configs').get()!.count, 1);
    store.close(); store = new Store(path);
    assert.equal(store.getRun('legacy-run')?.html, html);
    assert.equal(store.getRun(run.id)?.status, 'interrupted');
  } finally {
    legacy?.close(); store?.close();
    rmSync(directory, { recursive: true });
  }
});
