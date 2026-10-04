import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  build: {
    rollupOptions: {
      input: {
        main:   path.resolve(__dirname, 'index.html'),
        arcdex: path.resolve(__dirname, 'arcdex.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
    proxy: {
      // Local dev against the live market engine (it only answers ARCSENSE's own origins): set
      // VITE_ARCDEX_WS_URL=ws://localhost:5173/__engine/ws in .env.development.local.
      '/__engine': {
        target: 'https://arcdex-engine-production.up.railway.app',
        changeOrigin: true,
        ws: true,
        headers: { origin: 'https://arcsense.site' },
        rewrite: (path) => path.replace(/^\/__engine/, ''),
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // api/_*.ts are shared modules the frontend also imports (e.g.
        // _argusCore.ts) — let Vite serve those source files itself instead
        // of forwarding them to the local API server.
        bypass: (req) => (/^\/api\/_[\w-]+\.ts(\?|$)/.test(req.url ?? '') ? req.url : undefined),
      },
    },
  },
})
