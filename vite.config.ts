import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
