import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = process.env.API_PROXY || process.env.VITE_API_PROXY || 'http://127.0.0.1:8787';

const publicHosts = ['vectoree.net', 'www.vectoree.net', 'vectoree.ai', 'www.vectoree.ai'];

const starterApi = {
  '/starter/api': {
    target: apiProxy,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/starter/, ''),
  },
};

export default defineConfig({
  base: '/starter/',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    origin: 'https://vectoree.net',
    allowedHosts: publicHosts,
    hmr: {
      protocol: 'wss',
      host: 'vectoree.net',
      clientPort: 443,
    },
    proxy: starterApi,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: publicHosts,
    proxy: starterApi,
  },
});