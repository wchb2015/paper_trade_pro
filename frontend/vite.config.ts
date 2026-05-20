import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ports = require('../ports.cjs') as {
  BACKEND_PORT: number
  FRONTEND_DEV_PORT: number
  BACKEND_URL: string
  FRONTEND_DEV_URL: string
}
if (typeof ports.FRONTEND_DEV_PORT !== 'number') {
  throw new Error('FATAL: ports.cjs missing FRONTEND_DEV_PORT (number)')
}
if (typeof ports.BACKEND_URL !== 'string' || !ports.BACKEND_URL) {
  throw new Error('FATAL: ports.cjs missing BACKEND_URL (string)')
}

// https://vite.dev/config/
export default defineConfig({
  envDir: '..',
  plugins: [react()],
  server: {
    port: ports.FRONTEND_DEV_PORT,
    strictPort: true,
    // -----------------------------------------------------------------------
    // Same-origin in dev. Frontend client modules use relative URLs
    // (e.g. '/api/portfolio'); Vite forwards them to the backend on
    // ports.BACKEND_URL. This mirrors the prod nginx setup so OAuth
    // cookies and CORS behave the same in both environments.
    // -----------------------------------------------------------------------
    proxy: {
      '/api': { target: ports.BACKEND_URL, changeOrigin: true },
      '/socket.io': {
        target: ports.BACKEND_URL,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
