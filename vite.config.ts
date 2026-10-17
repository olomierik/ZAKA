import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/** /rpc/<chain> to Alchemy with the key from the local environment (dev only; Netlify serves it in production). */
function alchemyDevProxy(): Record<string, ProxyOptions> {
  const key = loadEnv('development', process.cwd(), '').ALCHEMY_API_KEY?.trim()
  if (!key) return {}
  const nets: Record<string, string> = { arc: 'arc-mainnet', hood: 'robinhood-mainnet', bnb: 'bnb-mainnet', sol: 'solana-mainnet', starknet: 'starknet-mainnet' }
  return Object.fromEntries(Object.entries(nets).map(([chain, host]) => [`/rpc/${chain}`, {
    target: `https://${host}.g.alchemy.com`,
    changeOrigin: true,
    rewrite: () => (chain === 'starknet' ? `/starknet/version/rpc/v0_10/${key}` : `/v2/${key}`),
  }]))
}

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  build: {
    // The gzip size of every file in the build log: ~465 files since Privy's SDK (2026-10-16), and memory the build
    // needs elsewhere (netlify.toml's note on the build's heap).
    reportCompressedSize: false,
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
      // ARCDEX's Alchemy nodes in local dev, as netlify/edge-functions/rpc.ts serves them in production: the key comes
      // from ALCHEMY_API_KEY in .env.development.local (never a VITE_ variable, so it never reaches the page) and the
      // page uses them with VITE_ALCHEMY=on there.
      ...alchemyDevProxy(),
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
