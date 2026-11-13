import { defineConfig } from 'vite';

// The client is a static site (dist/): three.js, the kit and your game. Top-level await in src/main.ts needs es2022.
export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
  worker: { format: 'es' },
});
