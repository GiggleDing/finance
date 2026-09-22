import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages 部署：用相对路径，避免仓库名 / 自定义域名导致资源 404
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600,
  },
})
