import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev server on 8033 (the app's usual URL). Safe now that Docker isn't using
    // this port; the API is proxied to the backend on 8032 below. If you ever run
    // the Docker container again (also 8033), stop one before starting the other.
    port: 8033,
    strictPort: true,
    // Never let the browser cache dev assets — this is what caused "my CSS/JS
    // changes don't show up" repeatedly. With no-store, every reload is fresh.
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
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
