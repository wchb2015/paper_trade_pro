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
  },
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(ports.BACKEND_URL),
  },
})
