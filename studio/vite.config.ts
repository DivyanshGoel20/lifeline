import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Public values only. Everything secret stays on Lifeline's server, behind /api.
const PUBLIC_ENV: Record<string, string> = {
  NEXT_PUBLIC_WORLD_APP_ID: 'app_6ad9b6ef952f1c2a9a70a58e05aa9878',
  NEXT_PUBLIC_WORLD_RP_ID: 'rp_62d19ed87590c550',
  NEXT_PUBLIC_WORLD_ACTION: 'lifeline-mumbai',
  NEXT_PUBLIC_WORLD_ENVIRONMENT: 'production',
  NEXT_PUBLIC_LIFELINE_TREASURY_ADDRESS: '0x5233E4253bC38e8CF517c0768dbC8aCC886F32B3',
  NEXT_PUBLIC_LIFELINE_CREDIT_FACILITY_ADDRESS: '0xd25Fd339E08aad2534dA99B3A02dEec6EC1A818f',
  NEXT_PUBLIC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
}

const BACKEND = 'https://lifeline-arc.vercel.app'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  define: Object.fromEntries(Object.entries(PUBLIC_ENV).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
  resolve: {
    alias: {
      'next/dynamic': path.resolve(__dirname, './src/shims/next-dynamic.tsx'),
      'next/navigation': path.resolve(__dirname, './src/shims/next-navigation.ts'),
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    allowedHosts: true,
    cors: true,
    // Vercel's rewrites do this once hosted (vercel.json). This is the same, for the preview.
    proxy: { '/api': { target: BACKEND, changeOrigin: true, secure: true } },
  },
  preview: {
    proxy: { '/api': { target: BACKEND, changeOrigin: true, secure: true } },
  },
})
