import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [vue()],
    build: { outDir: 'dist/client' },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${env.PORT || '3200'}`, changeOrigin: false } },
    },
  };
});
