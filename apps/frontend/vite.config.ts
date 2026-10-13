import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The API is proxied under /api so the auth cookie is same-origin for the browser.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';
const proxy = { '/api': { target: apiTarget, changeOrigin: true } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // @ugn/contracts is a CommonJS workspace package; let Vite convert it.
  optimizeDeps: { include: ['@ugn/contracts'] },
  build: { commonjsOptions: { include: [/contracts/, /node_modules/] } },
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 5173, proxy },
});
