// The app with a stand-in for Privy (scripts/privy-mock), to check the email and social sign-in in a browser without
// Privy's servers. Never used for a real build.
//   VITE_PRIVY_APP_ID=cm1mockprivyappid0000000 bunx vite --config scripts/vite.privy-mock.config.ts
import path from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config'

export default mergeConfig(base, defineConfig({
  resolve: {
    alias: [
      { find: /^@privy-io\/react-auth\/solana$/, replacement: path.resolve(__dirname, 'privy-mock/solana.ts') },
      { find: /^@privy-io\/react-auth$/, replacement: path.resolve(__dirname, 'privy-mock/react-auth.tsx') },
    ],
  },
}))
