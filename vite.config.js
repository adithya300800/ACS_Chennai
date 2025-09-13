import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Use root base for dev, GH Pages base for builds
  base: command === 'build' ? '/ACS_Chennai/' : '/',
}))
