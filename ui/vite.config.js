import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // The dev proxy follows the API's own PORT from the repo-root .env, so the two
  // never drift apart. VITE_API_PROXY_TARGET (ui/.env*) overrides it outright.
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const uiEnv = loadEnv(mode, __dirname, 'VITE_');
  const apiTarget = uiEnv.VITE_API_PROXY_TARGET || `http://localhost:${rootEnv.PORT || 3000}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
