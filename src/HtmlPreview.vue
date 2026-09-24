<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { createPreviewDocument } from './previewDocument';

const props = defineProps<{ html: string }>();
const viewport = { width: 1200, height: 900 };
const container = ref<HTMLDivElement | null>(null);
const frame = ref<HTMLIFrameElement | null>(null);
const size = ref({ width: 0, height: 0 });
const scene = ref({ x: 0, y: 0, ...viewport });
const channel = ref(crypto.randomUUID());
let observer: ResizeObserver | undefined;

watch(() => props.html, () => {
  scene.value = { x: 0, y: 0, ...viewport };
  channel.value = crypto.randomUUID();
});
const documentHtml = computed(() => createPreviewDocument(props.html, channel.value));

const frameStyle = computed(() => {
  const bounds = scene.value;
  const scale = Math.min(size.value.width / bounds.width, size.value.height / bounds.height);
  return {
    width: `${viewport.width}px`,
    height: `${viewport.height}px`,
    left: `${(size.value.width - bounds.width * scale) / 2 - bounds.x * scale}px`,
    top: `${(size.value.height - bounds.height * scale) / 2 - bounds.y * scale}px`,
    transform: `scale(${scale})`,
    clipPath: `inset(${bounds.y}px ${viewport.width - bounds.x - bounds.width}px ${viewport.height - bounds.y - bounds.height}px ${bounds.x}px)`,
  };
});

function receiveScene(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow) return;
  const data = event.data;
  if (!data || data.type !== 'workbench:scene' || data.channel !== channel.value) return;
  if (![data.x, data.y, data.width, data.height].every(value => typeof value === 'number' && Number.isFinite(value))) return;
  if (data.x < 0 || data.y < 0 || data.width < 1 || data.height < 1) return;
  if (data.x + data.width > viewport.width + 1 || data.y + data.height > viewport.height + 1) return;
  scene.value = { x: data.x, y: data.y, width: data.width, height: data.height };
}

onMounted(() => {
  window.addEventListener('message', receiveScene);
  observer = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect;
    if (box) size.value = { width: box.width, height: box.height };
  });
  if (container.value) observer.observe(container.value);
});
onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener('message', receiveScene);
});
</script>

<template>
  <div ref="container" class="html-preview">
    <iframe ref="frame" :srcdoc="documentHtml" :style="frameStyle" sandbox="allow-scripts" scrolling="no" tabindex="-1" title="动画画面预览"></iframe>
  </div>
</template>

<style scoped>
.html-preview { position: absolute; inset: 0; overflow: hidden; }
.html-preview iframe { position: absolute; display: block; border: 0; transform-origin: 0 0; pointer-events: none; }
</style>
