import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

if (process.env.VITE_BASE_PATH && process.env.VITE_BASE_PATH !== '/' && !process.env.VITE_API_URL?.startsWith('https://')) {
  throw new Error('La build Pages richiede VITE_API_URL con il backend HTTPS configurato.')
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
