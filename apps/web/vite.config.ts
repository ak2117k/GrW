import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Standalone production SaaS app (GrW). Runs on its own ports (web 4100 -> api
// 4101) so it never collides with the original TD_Automation app (4000/4001).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@td/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 4100,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4101',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://127.0.0.1:4101',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'ws://127.0.0.1:4101',
        changeOrigin: true,
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
