import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const entry = decodeURIComponent(new URL('./src/index.ts', import.meta.url).pathname);

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
