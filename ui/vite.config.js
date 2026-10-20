import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  // `npm run dev:ui` for working on the dashboard; the API stays on :4400.
  server: { port: 4399, proxy: { '/api': 'http://127.0.0.1:4400', '/reports': 'http://127.0.0.1:4400' } },
});
