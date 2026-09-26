import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import type { GenerationModel, Protocol, Usage } from '../shared/types.js';
import { AppError } from './errors.js';

export interface ProviderResult {
  output: string;
  usage: Usage | null;
}

export interface ProviderOptions {
  modelConfig: GenerationModel;
  prompt: string;
  constraint: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

function privateAddress(address: string) {
  try {
    const parsed = ipaddr.parse(address);
    return ['private', 'loopback', 'linkLocal', 'uniqueLocal', 'unspecified', 'multicast', 'reserved'].includes(parsed.range());
  } catch { return true; }
}

export async function validateEndpoint(baseUrl: string) {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('Base URL 不是有效地址。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Base URL 只支持 HTTP 或 HTTPS。');
  if (url.username || url.password) throw new Error('Base URL 不能包含用户名或密码。');
  const localAllowed = process.env.ALLOW_LOCAL_MODEL === 'true';
  if (url.protocol === 'http:' && !localAllowed) throw new Error('模型地址必须使用 HTTPS；本机调试可设置 ALLOW_LOCAL_MODEL=true。');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
    if (!localAllowed) throw new Error('不允许访问本地模型地址。');
  } else {
    const records = await lookup(url.hostname, { all: true });
    if (!records.length || records.some(record => privateAddress(record.address))) throw new Error('模型地址解析到了私有或保留网络地址。');
  }
  url.hash = '';
  return url;
}

function endpoint(base: URL, protocol: Protocol) {
  const suffix = protocol === 'responses' ? '/responses' : protocol === 'anthropic-messages' ? '/messages' : '/chat/completions';
  const path = base.pathname.replace(/\/+$/, '');
  if (path.endsWith(suffix)) return base;
  base.pathname = `${path}${suffix}`;
  return base;
}

function parseUsage(value: any): Usage | null {
  const usage = value?.usage ?? value?.response?.usage;
  if (!usage) return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  const totalTokens = usage.total_tokens ?? (typeof inputTokens === 'number' && typeof outputTokens === 'number' ? inputTokens + outputTokens : undefined);
  return { inputTokens, outputTokens, totalTokens };
}

function mergeUsage(current: Usage | null, next: Usage | null) {
  if (!next) return current;
  return { inputTokens: next.inputTokens ?? current?.inputTokens, outputTokens: next.outputTokens ?? current?.outputTokens, totalTokens: next.totalTokens ?? current?.totalTokens };
}

function responseText(value: any, protocol: Protocol) {
  if (protocol === 'anthropic-messages') {
    return Array.isArray(value?.content) ? value.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join('') : '';
  }
  if (protocol === 'responses') {
    if (typeof value?.output_text === 'string') return value.output_text;
    const output = value?.output;
    return Array.isArray(output) ? output.flatMap(item => item.content ?? []).map((part: any) => part.text ?? '').join('') : '';
  }
  return value?.choices?.[0]?.message?.content ?? '';
}

async function readSse(response: Response, protocol: Protocol, onDelta: (text: string) => void): Promise<ProviderResult> {
  if (!response.body) throw new Error('模型没有返回可读取的响应流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let usage: Usage | null = null;
  const consume = (data: string) => {
    if (!data || data === '[DONE]') return;
    let value: any;
    try { value = JSON.parse(data); } catch { return; }
    usage = mergeUsage(usage, parseUsage(value));
    const delta = protocol === 'responses'
      ? (value.type === 'response.output_text.delta' ? value.delta : '')
      : protocol === 'anthropic-messages'
        ? (value.type === 'content_block_delta' && value.delta?.type === 'text_delta' ? value.delta.text : '')
        : (value.choices?.[0]?.delta?.content ?? '');
    if (typeof delta === 'string' && delta) { output += delta; onDelta(delta); }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    if (done) { buffer += '\n'; }
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      consume(data);
    }
    if (done) break;
  }
  return { output, usage };
}

export async function generate(options: ProviderOptions): Promise<ProviderResult> {
  const config = options.modelConfig;
  const base = await validateEndpoint(config.baseUrl);
  const url = endpoint(base, config.protocol);
  const headers: Record<string, string> = config.protocol === 'anthropic-messages'
    ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: config.stream ? 'text/event-stream' : 'application/json' }
    : { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: config.stream ? 'text/event-stream' : 'application/json' };
  const body = config.protocol === 'anthropic-messages' ? {
    model: config.model,
    max_tokens: 32_768,
    system: options.constraint,
    messages: [{ role: 'user', content: options.prompt }],
    stream: config.stream,
  } : config.protocol === 'responses' ? {
    model: config.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: options.constraint }] },
      { role: 'user', content: [{ type: 'input_text', text: options.prompt }] },
    ],
    stream: config.stream,
  } : {
    model: config.model,
    messages: [{ role: 'system', content: options.constraint }, { role: 'user', content: options.prompt }],
    stream: config.stream,
    ...(config.stream ? { stream_options: { include_usage: true } } : {}),
  };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: options.signal });
  if (response.status >= 300 && response.status < 400) throw new Error('模型地址发生了重定向，已拒绝跟随。');
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(502, `模型请求失败（${response.status}），请检查自己的模型配置。`);
  }
  if (config.stream) return readSse(response, config.protocol, options.onDelta);
  const value = await response.json() as any;
  return { output: responseText(value, config.protocol), usage: parseUsage(value) };
}
