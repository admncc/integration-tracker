import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

export default defineConfig({
  root: resolve(root, 'client'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: { '@shared': resolve(root, 'shared') },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? 4000}`, changeOrigin: true } },
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
  },
});
