import { MODEL_GROUPS, type GenerationModel, type ModelSnapshot } from '../shared/types.js';
import { RUN_TIMEOUT_MS } from '../shared/types.js';
import { AppError } from './errors.js';

export function parseGenerationModel(value: unknown): GenerationModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '请提交当前浏览器的模型配置。');
  const input = value as Record<string, unknown>;
  function text(field: string, label: string, limit: number) {
    const entry = input[field];
    if (typeof entry !== 'string' || !entry.trim() || entry.length > limit) throw new AppError(400, `${label}无效。`);
    return entry.trim();
  }
  const baseUrl = text('baseUrl', 'Base URL', 500);
  const apiKey = text('apiKey', 'API Key', 10_000);
  const model = text('model', '模型名称', 180);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AppError(400, 'Base URL 不是有效地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'Base URL 不能包含凭证、查询参数或片段。');
  }
  if (url.protocol === 'http:' && process.env.ALLOW_LOCAL_MODEL !== 'true') throw new AppError(400, '模型地址必须使用 HTTPS。');
  if (/[\r\n]/.test(apiKey)) throw new AppError(400, 'API Key 无效。');
  if (input.protocol !== 'chat-completions' && input.protocol !== 'responses' && input.protocol !== 'anthropic-messages') throw new AppError(400, '接口协议不受支持。');
  if (!MODEL_GROUPS.includes(input.group as typeof MODEL_GROUPS[number])) throw new AppError(400, '模型分组不受支持。');
  if (typeof input.stream !== 'boolean') throw new AppError(400, '流式输出选项无效。');
  return { group: input.group as typeof MODEL_GROUPS[number], baseUrl, apiKey, model, protocol: input.protocol, stream: input.stream };
}

export function publicModelSnapshot(config: GenerationModel): ModelSnapshot {
  return { group: config.group, model: config.model, protocol: config.protocol, stream: config.stream, timeoutMs: RUN_TIMEOUT_MS };
}
