import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base '/' is correct for the wizardchat.github.io user site.
// If you deploy as a project page (e.g. /repo-name/), change this.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: {
    port: 5173,
  },
  build: {
    sourcemap: false,
    target: 'es2022',
  },
});
