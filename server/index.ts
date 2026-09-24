import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { generate } from './provider.js';
import { MAX_OUTPUT_BYTES, OUTPUT_CONSTRAINT, RUN_TIMEOUT_MS, type CreateRunInput, type GenerationModel } from '../shared/types.js';
import { parseGenerationModel, publicModelSnapshot } from './modelInput.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR ? resolve(process.cwd(), process.env.DATA_DIR) : join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, 'workbench.sqlite'));
const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
const tasks = new Map<string, { controller: AbortController; subscribers: Set<(event: string, data: unknown) => void> }>();

function fail(statusCode: number, message: string): never { throw new AppError(statusCode, message); }
function requireString(value: unknown, label: string, max = 100_000) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `${label}不能为空。`);
  if (value.length > max) fail(400, `${label}过长。`);
  return value;
}
function extractHtml(output: string) {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}
function validHtml(value: string) { return /<!doctype\s+html/i.test(value) && /<html[\s>]/i.test(value) && /<body[\s>]/i.test(value); }
function publish(taskId: string, event: string, data: unknown) { tasks.get(taskId)?.subscribers.forEach(send => send(event, data)); }
function finishTask(taskId: string) { const task = tasks.get(taskId); if (!task) return; task.subscribers.forEach(send => send('close', {})); task.subscribers.clear(); }

async function runTask(runId: string, modelConfig: GenerationModel) {
  const run = store.getRun(runId);
  if (!run) return;
  const task = tasks.get(runId);
  if (!task) return;
  const started = Date.now();
  let output = run.rawOutput;
  const timer = setTimeout(() => task.controller.abort(new Error('请求超过 10 分钟，已超时。')), RUN_TIMEOUT_MS);
  try {
    const result = await generate({ modelConfig, prompt: run.prompt, constraint: run.constraint, signal: task.controller.signal, onDelta: delta => {
      output += delta;
      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) { task.controller.abort(new Error('输出超过 5 MB 限制。')); return; }
      store.updateRunOutput(runId, output);
      publish(runId, 'delta', { offset: output.length - delta.length, text: delta, elapsedMs: Date.now() - started });
    }});
    output = result.output;
    const html = extractHtml(output);
    const documentCount = (html.match(/<!doctype\s+html/gi) ?? []).length;
    const invalid = !html || !validHtml(html) || documentCount > 1 || !/<\/html>\s*$/i.test(html);
    const status = invalid ? 'failed' : 'succeeded';
    const error = invalid ? (html ? '响应没有返回完整 HTML 文档。' : '模型返回了空内容。') : null;
    store.finishRun(runId, { status, rawOutput: output, html: invalid ? null : html, elapsedMs: Date.now() - started, usage: result.usage, error });
    publish(runId, 'done', { status, elapsedMs: Date.now() - started, error, usage: result.usage });
  } catch (error: any) {
    const aborted = task.controller.signal.aborted;
    const message = task.controller.signal.reason instanceof Error ? task.controller.signal.reason.message : (error instanceof AppError ? error.message : '模型请求失败，请检查自己的模型配置。');
    const status = aborted && message.includes('停止') ? 'cancelled' : 'failed';
    store.finishRun(runId, { status, rawOutput: output, html: null, elapsedMs: Date.now() - started, usage: null, error: message });
    publish(runId, 'done', { status, elapsedMs: Date.now() - started, error: message, usage: null });
  } finally {
    modelConfig.apiKey = '';
    modelConfig.baseUrl = '';
    clearTimeout(timer); finishTask(runId); tasks.delete(runId);
  }
}

app.setErrorHandler((error, _request, reply) => {
  const status = error instanceof AppError ? error.statusCode : 500;
  reply.code(status).send({ error: error instanceof AppError ? error.message : '服务器错误。' });
});
app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'self' https://api.opens.chat; object-src 'none'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
});

app.route({ method: ['GET', 'POST', 'PATCH', 'DELETE'], url: '/api/model-configs', handler: async () => fail(410, '模型配置仅保存在各自浏览器中。') });
app.route({ method: ['GET', 'POST', 'PATCH', 'DELETE'], url: '/api/model-configs/:id', handler: async () => fail(410, '模型配置仅保存在各自浏览器中。') });

app.get('/api/runs', async request => {
  const query = request.query as any;
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return store.listRuns(limit, offset);
});
app.get('/api/runs/:id', async request => {
  const run = store.getRun(String((request.params as any).id));
  if (!run) fail(404, '生成记录不存在。');
  return run;
});
app.delete('/api/runs/:id', async () => {
  fail(403, '历史记录暂不允许删除。');
});
app.get('/api/runs/:id/download', async (request, reply) => {
  const run = store.getRun(String((request.params as any).id));
  if (!run?.html) fail(404, '该记录没有可下载的 HTML。');
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="html-run-${run.id}.html"`);
  return run.html;
});

app.post('/api/runs', async (request, reply) => {
  const body = (request.body ?? {}) as Partial<CreateRunInput>;
  const requestId = requireString(body.requestId, '请求 ID', 100);
  const prompt = requireString(body.prompt, '提示词', 100_000);
  const modelConfig = parseGenerationModel(body.modelConfig);
  delete body.modelConfig;
  const snapshot = publicModelSnapshot(modelConfig);
  const run = store.createRun({ requestId, prompt, constraintText: OUTPUT_CONSTRAINT, snapshot, sourceRunId: body.sourceRunId });
  if (!tasks.has(run.id) && run.status === 'running') {
    tasks.set(run.id, { controller: new AbortController(), subscribers: new Set() });
    runTask(run.id, modelConfig).catch(() => undefined);
  }
  reply.code(202).send({ id: run.id });
});
app.post('/api/runs/:id/cancel', async request => {
  const id = String((request.params as any).id);
  const requestId = requireString((request.body as { requestId?: unknown } | null)?.requestId, '请求凭证', 100);
  if (!store.ownsRun(id, requestId)) fail(403, '只能停止自己发起的生成任务。');
  const task = tasks.get(id);
  if (task) { task.controller.abort(new Error('用户点击了停止。')); return { ok: true }; }
  return { ok: false };
});
app.get('/api/runs/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
  const id = String((request.params as any).id);
  const run = store.getRun(id);
  if (!run) return reply.code(404).send({ error: '生成记录不存在。' });
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', { rawOutput: run.rawOutput, status: run.status, elapsedMs: run.elapsedMs, error: run.error });
  const task = tasks.get(id);
  if (!task || run.status !== 'running') { send('close', {}); reply.raw.end(); return; }
  task.subscribers.add(send);
  const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
  request.raw.on('close', () => { clearInterval(keepAlive); task.subscribers.delete(send); });
});

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: join(root, 'client'), prefix: '/' });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在。' }) : reply.sendFile('index.html'));
}

const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
console.log(`HTML 工作台后端已启动：http://${host}:${port}`);

process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.close(); process.exit(0); });
