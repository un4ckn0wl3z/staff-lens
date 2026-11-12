import { alphaTab } from '@coderline/alphatab-vite';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo>/. Set BASE_PATH (e.g. "/staff-lens/") at build time;
// the default "./" keeps the build relocatable.
const base = process.env.BASE_PATH || './';

export default defineConfig({
  base,
  plugins: [alphaTab()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
