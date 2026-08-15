import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

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
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
