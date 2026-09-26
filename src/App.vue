<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import HtmlPreview from './HtmlPreview.vue';
import type { BrowserModelConfig, BrowserRun, ModelConfig, ModelInput, RunDetail, RunPage, RunStatus, RunSummary } from '../shared/types';
import { deleteLocalModel, MODEL_STORAGE_KEY, readLocalModels, saveLocalModel } from './localModels';

const configs = ref<BrowserModelConfig[]>([]);
const runs = ref<RunSummary[]>([]);
const details = ref<Record<string, RunDetail>>({});
const selectedConfigId = ref('');
const prompt = ref('创建一个HTML代码，内容是SVG绘制一个小火龙在导弹上骑自行车的2D动画，不能测试，不能使用sikll技能，不能搜索本地文件');
const activeRunId = ref<string | null>(null);
const selectedCardId = ref<string | null>(null);
const loading = ref(false);
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
const showSettings = ref(false);
const editingId = ref<string | null>(null);
const savingConfig = ref(false);
const ownRun = ref<BrowserRun | null>(null);
const ACTIVE_RUN_STORAGE_KEY = 'ai-zhili.active-run.v1';
const LEGACY_ACTIVE_RUN_STORAGE_KEY = 'html-workbench.active-run.v1';
let eventSource: EventSource | null = null;
let noticeTimer: number | undefined;

const configForm = ref<ModelInput>({ name: '', baseUrl: 'https://api.opens.chat/v1', model: 'gpt-6-astra', protocol: 'responses', stream: true, isDefault: true, apiKey: '' });
const selectedConfig = computed(() => configs.value.find(item => item.id === selectedConfigId.value) ?? configs.value[0]);
const activeRun = computed(() => activeRunId.value ? details.value[activeRunId.value] : undefined);
const isRunning = computed(() => activeRun.value?.status === 'running');

function showNotice(text: string, type: 'success' | 'error' | 'info' = 'info') { notice.value = { text, type }; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => notice.value = null, 3600); }
function formatTime(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function statusLabel(status: RunStatus) { return ({ running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status]; }
function statusClass(status: RunStatus) { return `status-${status}`; }
function promptPreview(value: string) { return value.replace(/\s+/g, ' ').trim().slice(0, 66) || '未命名生成'; }
function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (typeof options?.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(url, { ...options, headers }).then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`); return data as T; });
}
async function hydrateDetails(items: RunSummary[]) { const results = await Promise.allSettled(items.map(item => api<RunDetail>(`/api/runs/${item.id}`))); results.forEach((result, index) => { if (result.status === 'fulfilled') details.value[items[index].id] = result.value; }); }
async function loadRuns() {
  const page = await api<RunPage>('/api/runs?limit=24');
  runs.value = page.items;
  await hydrateDetails(page.items);
  if (ownRun.value) await openRun(ownRun.value.id);
}
async function loadRunsOnly() { const page = await api<RunPage>('/api/runs?limit=24'); runs.value = page.items; await hydrateDetails(page.items); }
function loadConfigs() {
  configs.value = readLocalModels();
  const preferred = configs.value.find(item => item.isDefault) ?? configs.value[0];
  if (!configs.value.some(item => item.id === selectedConfigId.value)) selectedConfigId.value = preferred?.id ?? '';
}
function rememberRun(run: BrowserRun | null) {
  ownRun.value = run;
  try {
    if (run) localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(run));
    else {
      localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      localStorage.removeItem(LEGACY_ACTIVE_RUN_STORAGE_KEY);
    }
  } catch { showNotice('浏览器未能保存任务状态，刷新后请在历史记录中查看结果。', 'info'); }
}
function restoreOwnRun() {
  try {
    const current = localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    const raw = current ?? localStorage.getItem(LEGACY_ACTIVE_RUN_STORAGE_KEY);
    const saved = JSON.parse(raw ?? 'null');
    if (saved && typeof saved.id === 'string' && typeof saved.requestId === 'string') {
      ownRun.value = saved;
      if (current === null) {
        try { localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(saved)); } catch { /* Keep using the legacy value. */ }
      }
    }
  } catch { ownRun.value = null; }
}
async function openRun(id: string) {
  try {
    const detail = await api<RunDetail>(`/api/runs/${id}`);
    details.value[id] = detail;
    selectedCardId.value = id;
    if (ownRun.value?.id === id) {
      if (detail.status === 'running') { activeRunId.value = id; subscribe(id); }
      else { activeRunId.value = null; rememberRun(null); }
    }
  } catch (error: any) { showNotice(error.message, 'error'); }
}
function subscribe(id: string) {
  eventSource?.close();
  const source = new EventSource(`/api/runs/${id}/events`);
  eventSource = source;
  source.addEventListener('snapshot', event => {
    const data = JSON.parse((event as MessageEvent).data);
    const detail = details.value[id];
    if (detail) { detail.rawOutput = data.rawOutput; detail.status = data.status; detail.elapsedMs = data.elapsedMs ?? detail.elapsedMs; }
  });
  source.addEventListener('delta', event => {
    const data = JSON.parse((event as MessageEvent).data);
    const detail = details.value[id];
    if (detail) { detail.rawOutput += data.text; detail.elapsedMs = data.elapsedMs; }
  });
  let completed = false;
  const complete = async () => {
    if (completed) return;
    completed = true;
    source.close();
    if (eventSource === source) eventSource = null;
    if (ownRun.value?.id === id) { activeRunId.value = null; rememberRun(null); }
    try { await openRun(id); await loadRunsOnly(); }
    catch (error: any) { showNotice(error.message, 'error'); }
  };
  source.addEventListener('done', complete);
  source.addEventListener('close', complete);
  source.onerror = () => { if (activeRunId.value === id) showNotice('生成连接暂时断开，刷新后可继续查看。', 'info'); };
}
async function startGeneration() {
  if (!selectedConfig.value) return showNotice('请先在设置中添加自己的模型配置。', 'error');
  if (!prompt.value.trim()) return showNotice('请先输入提示词。', 'error');
  if (loading.value || isRunning.value) return;
  loading.value = true;
  try {
    const config = selectedConfig.value;
    const requestId = crypto.randomUUID();
    const modelConfig = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, protocol: config.protocol, stream: config.stream };
    const result = await api<{ id: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ requestId, modelConfig, prompt: prompt.value }) });
    rememberRun({ id: result.id, requestId });
    await openRun(result.id);
    await loadRunsOnly();
    showNotice('已开始生成。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
  finally { loading.value = false; }
}
async function stopGeneration() {
  if (!activeRunId.value || ownRun.value?.id !== activeRunId.value) return;
  try {
    await api(`/api/runs/${activeRunId.value}/cancel`, { method: 'POST', body: JSON.stringify({ requestId: ownRun.value.requestId }) });
    showNotice('已发送停止请求。', 'info');
  } catch (error: any) { showNotice(error.message, 'error'); }
}
function editConfig(config?: ModelConfig) { editingId.value = config?.id ?? null; configForm.value = config ? { name: config.name, baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, stream: config.stream, isDefault: config.isDefault, apiKey: '' } : { name: '', baseUrl: 'https://api.opens.chat/v1', model: 'gpt-6-astra', protocol: 'responses', stream: true, isDefault: configs.value.length === 0, apiKey: '' }; showSettings.value = true; }
function saveConfig() {
  savingConfig.value = true;
  try {
    const saved = saveLocalModel(configForm.value, editingId.value);
    loadConfigs();
    selectedConfigId.value = saved.id;
    configForm.value.apiKey = '';
    showSettings.value = false;
    showNotice('模型配置已保存到当前浏览器。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
  finally { savingConfig.value = false; }
}
function removeConfig(config: ModelConfig) {
  if (!window.confirm(`删除本机的「${config.name}」？`)) return;
  try {
    deleteLocalModel(config.id);
    loadConfigs();
    if (editingId.value === config.id) editConfig();
    showNotice('本地配置已删除。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
}
function syncLocalModels(event: StorageEvent) {
  if (event.key === MODEL_STORAGE_KEY || event.key === null) {
    try { loadConfigs(); } catch (error: any) { showNotice(error.message, 'error'); }
  }
}
onMounted(async () => {
  window.addEventListener('storage', syncLocalModels);
  try { loadConfigs(); } catch (error: any) { showNotice(error.message, 'error'); }
  restoreOwnRun();
  try { await loadRuns(); } catch (error: any) { showNotice(error.message, 'error'); }
});
onUnmounted(() => { eventSource?.close(); window.clearTimeout(noticeTimer); window.removeEventListener('storage', syncLocalModels); });
</script>

<template>
  <div class="app-shell">
    <main class="content">
      <section class="composer card"><div class="composer-grid"><div class="model-field"><div class="field-label"><label for="model">使用模型</label><button class="small-link" @click="editConfig()">管理模型 ↗</button></div><div class="model-select-row"><select id="model" v-model="selectedConfigId" :disabled="!configs.length"><option value="" disabled>{{ configs.length ? '选择模型' : '请先添加模型' }}</option><option v-for="config in configs" :key="config.id" :value="config.id">{{ config.name }} · {{ config.model }}</option></select><button class="select-settings" aria-label="编辑当前模型" @click="editConfig(selectedConfig)">⚙</button></div></div><div class="prompt-field"><div class="field-label"><label for="prompt">你的提示词</label><span class="prompt-hint">描述页面、风格和交互</span></div><textarea id="prompt" v-model="prompt" rows="3" placeholder="例如：做一个小火龙在导弹上骑自行车的 2D SVG 动画，要有云朵、火焰和可以暂停的按钮。"></textarea></div><div class="composer-action"><button v-if="isRunning" class="stop-button" @click="stopGeneration">■ 停止</button><button v-else class="primary-button" :disabled="loading || !selectedConfig" @click="startGeneration"><span>{{ loading ? '准备中…' : '开始生成' }}</span><b>↗</b></button></div></div></section>
      <section class="gallery-section"><div class="gallery-heading"><div><h1>历史记录</h1></div><span class="gallery-count">{{ runs.length }} 个页面</span><button class="refresh-button" @click="loadRunsOnly">刷新 ↻</button></div><div v-if="!runs.length" class="empty-gallery card"><div class="empty-icon">◎</div><h2>还没有生成记录</h2><p>完成第一次生成后，页面预览会出现在这里。</p></div><div v-else class="gallery-grid"><article v-for="run in runs" :key="run.id" class="preview-card" :class="{ selected: selectedCardId === run.id }" @click="openRun(run.id)"><div class="preview-frame"><HtmlPreview v-if="details[run.id]?.html" :html="details[run.id].html!" /><div v-else-if="run.status === 'running'" class="card-loading"><div class="loader"></div><span>正在生成…</span></div><div v-else class="card-failed"><span>◌</span><small>暂无可用预览</small></div><span class="status-ribbon" :class="statusClass(run.status)"><i></i>{{ statusLabel(run.status) }}</span></div><div class="card-info"><div class="card-title">{{ promptPreview(run.prompt) }}</div><div class="card-meta"><span>{{ run.snapshot.model }}</span></div><div class="card-time">{{ formatTime(run.createdAt) }}</div></div></article></div></section>
    </main>
    <div v-if="notice" class="toast" :class="`toast-${notice.type}`">{{ notice.text }}</div>
    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false"><section class="settings-modal card"><div class="modal-heading"><div><span class="eyebrow">仅保存在当前浏览器 · 不共享</span><h2>{{ editingId ? '编辑模型' : '添加模型' }}</h2></div><button class="modal-close" @click="showSettings = false">×</button></div><div class="settings-form"><label>配置名称<input v-model="configForm.name" placeholder="例如：OpenAI 主账号" /></label><label>Base URL<input v-model="configForm.baseUrl" placeholder="https://api.opens.chat/v1" /></label><label>模型名称<input v-model="configForm.model" placeholder="gpt-6-astra" /></label><label>API Key <small v-if="editingId">留空以保留当前 Key</small><input v-model="configForm.apiKey" type="password" autocomplete="new-password" placeholder="不会回显已保存的 Key" /></label><label>接口协议<select v-model="configForm.protocol"><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label><div class="toggle-row"><label class="check-label"><input v-model="configForm.stream" type="checkbox" /> 流式输出</label><label class="check-label"><input v-model="configForm.isDefault" type="checkbox" /> 设为默认模型</label></div></div><div class="modal-footer"><p class="local-config-note">地址、Key 和模型配置仅保存在当前浏览器；生成时临时发送至后端调用，作品保存在服务器并共享。换浏览器或清除网站数据后需重新配置。</p><div class="config-list"><div v-for="config in configs" :key="config.id" class="config-line"><span>{{ config.name }} <small>{{ config.hasKey ? config.keyMask : 'Key 不可用' }}</small></span><span><button @click="editConfig(config)">编辑</button><button @click="removeConfig(config)">删除</button></span></div></div><div class="modal-actions"><button class="outline-button" @click="showSettings = false">取消</button><button class="primary-button" :disabled="savingConfig" @click="saveConfig">{{ savingConfig ? '保存中…' : '保存配置' }} <b>↗</b></button></div></div></section></div>
  </div>
</template>
