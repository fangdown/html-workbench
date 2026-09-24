import type { BrowserModelConfig, ModelInput } from '../shared/types';

export const MODEL_STORAGE_KEY = 'html-workbench.models.v1';

function read(storage: Pick<Storage, 'getItem'>): BrowserModelConfig[] {
  const raw = storage.getItem(MODEL_STORAGE_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(item => item && typeof item.id === 'string'
    && typeof item.name === 'string' && typeof item.baseUrl === 'string' && typeof item.model === 'string'
    && typeof item.apiKey === 'string' && typeof item.stream === 'boolean' && typeof item.isDefault === 'boolean'
    && ['chat-completions', 'responses'].includes(item.protocol))) {
    throw new Error('本地模型配置无法读取，未覆盖原数据。');
  }
  return value.map(item => ({ ...item, hasKey: Boolean(item.apiKey), keyMask: item.apiKey ? '••••••••' : '未设置' }));
}

export function readLocalModels(storage: Pick<Storage, 'getItem'> = localStorage) {
  try { return read(storage); }
  catch { throw new Error('无法读取当前浏览器的模型配置，请检查是否允许网站存储。'); }
}

export function saveLocalModel(input: ModelInput, id: string | null, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const configs = readLocalModels(storage);
  const existing = id ? configs.find(item => item.id === id) : undefined;
  if (id && !existing) throw new Error('本地模型配置不存在，请重新选择。');
  const name = input.name.trim();
  const model = input.model.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey?.trim() || existing?.apiKey || '';
  if (!name || name.length > 80) throw new Error('请输入配置名称，最多 80 个字符。');
  if (!model || model.length > 180) throw new Error('请输入模型名称，最多 180 个字符。');
  if (!apiKey || apiKey.length > 10_000 || /[\r\n]/.test(apiKey)) throw new Error('请输入有效的 API Key。');
  if (!['chat-completions', 'responses'].includes(input.protocol)) throw new Error('接口协议不受支持。');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 Base URL。'); }
  if (baseUrl.length > 500 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 仅填写 HTTP/HTTPS 接口地址，不包含凭证、查询参数或片段。');
  }
  const now = new Date().toISOString();
  const saved: BrowserModelConfig = {
    id: existing?.id ?? crypto.randomUUID(), name, baseUrl, model, apiKey,
    protocol: input.protocol, stream: input.stream, isDefault: input.isDefault || configs.length === 0,
    hasKey: true, keyMask: '••••••••', createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  let next = configs.filter(item => item.id !== saved.id).map(item => saved.isDefault ? { ...item, isDefault: false } : item);
  next = [...next, saved];
  if (!next.some(item => item.isDefault)) saved.isDefault = true;
  write(next, storage);
  return saved;
}

export function deleteLocalModel(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const next = readLocalModels(storage).filter(item => item.id !== id);
  if (next.length && !next.some(item => item.isDefault)) next[0].isDefault = true;
  write(next, storage);
}

function write(configs: BrowserModelConfig[], storage: Pick<Storage, 'setItem'>) {
  try { storage.setItem(MODEL_STORAGE_KEY, JSON.stringify(configs)); }
  catch { throw new Error('浏览器未能保存配置，请检查存储权限或可用空间。'); }
}
