import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8033,
    proxy: {
      '/api': {
        target: 'http://localhost:8032',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:8032',
        changeOrigin: true,
      },
    },
  },
});
