import { alphaTab } from '@coderline/alphatab-vite';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo>/. Set BASE_PATH (e.g. "/staff-lens/") at build time;
// the default "./" keeps the build relocatable.
const base = process.env.BASE_PATH || './';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base,
  plugins: [alphaTab()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Cross-origin isolation enables multi-threaded WASM for recognition (on GitHub Pages the
  // service worker adds the same headers).
  server: { headers: ISOLATION },
  preview: { headers: ISOLATION },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
