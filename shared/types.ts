export type Protocol = 'chat-completions' | 'responses';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export const MODEL_GROUPS = ['GRT-PRO稳定', 'GPT-企业级', 'GPT-官key', 'GPT-福利'] as const;
export type ModelGroup = typeof MODEL_GROUPS[number];

export interface ModelInput {
  name: string;
  group: ModelGroup;
  baseUrl: string;
  model: string;
  protocol: Protocol;
  stream: boolean;
  isDefault: boolean;
  apiKey?: string;
}

export interface ModelConfig extends Omit<ModelInput, 'apiKey'> {
  id: string;
  hasKey: boolean;
  keyMask: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserModelConfig extends ModelConfig {
  apiKey: string;
}

export interface GenerationModel {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: Protocol;
  stream: boolean;
}

export interface ModelSnapshot {
  model: string;
  protocol: Protocol;
  stream: boolean;
  timeoutMs: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunSummary {
  id: string;
  prompt: string;
  snapshot: ModelSnapshot;
  status: RunStatus;
  createdAt: string;
  completedAt: string | null;
  elapsedMs: number;
  usage: Usage | null;
  error: string | null;
  hasHtml: boolean;
}

export interface RunDetail extends RunSummary {
  constraint: string;
  rawOutput: string;
  html: string | null;
}

export interface RunPage {
  items: RunSummary[];
  total: number;
  activeRun: RunSummary | null;
}

export interface CreateRunInput {
  requestId: string;
  modelConfig: GenerationModel;
  prompt: string;
  sourceRunId?: string;
}

export interface BrowserRun {
  id: string;
  requestId: string;
}

export interface DeltaEvent {
  offset: number;
  text: string;
  elapsedMs: number;
}

export const OUTPUT_CONSTRAINT = `生成一个可直接在浏览器打开的完整单文件 HTML。
必须包含 <!DOCTYPE html>、<html>、<head> 和 <body>，正确闭合 HTML 标签。
所有 CSS 和 JavaScript 内嵌在这个文件中；图形使用内嵌 SVG、CSS 或 Canvas。
不引用外部脚本、样式、字体、图片或其他网络资源，不发送网络请求，不注册 Service Worker。
只输出一份完整 HTML 源码，不要 Markdown 代码围栏，不要解释，不要多个候选文件。
只呈现用户要求的动画或插画主体，自动播放并持续循环；不要页面标题、副标题、说明、页眉页脚、暂停/播放/重播按钮、进度条、计时器或参数面板。
将完整画面放在唯一的 data-preview-scene 元素内（优先标记最外层 SVG 或 Canvas），画面内保留必要的图形元素，不添加界面控件。
画面等比适配视口、无滚动条，移除多余外边距，让动画主体完整可见；在桌面和手机上保持画面比例。`;

export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
