import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The API the dev server proxies to; override when it is not on :3000
// (e.g. `PEPPER_API=http://localhost:3004 npm run dev:web`).
const api = process.env.PEPPER_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // The server serves the SPA from server/public, so the build lands there
    // directly rather than being copied in a second step.
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:web` talks to the API server running on 3000, so the SPA
    // can be developed with hot reload against a real backend.
    proxy: {
      // `ws` so the live streams' WebSocket upgrades are proxied too.
      '/v1': { target: api, changeOrigin: true, ws: true },
      '/health': { target: api, changeOrigin: true },
    },
  },
});
