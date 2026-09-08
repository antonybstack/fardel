import { defineConfig } from 'vite';

const seatPort = Number(process.env.FARDEL_VITE_PORT || 0);

export default defineConfig({
  server: {
    port: seatPort > 0 ? seatPort : 5173,
    host: '127.0.0.1',
    strictPort: seatPort > 0,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
