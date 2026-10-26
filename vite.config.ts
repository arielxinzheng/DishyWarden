import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/core': path.resolve(__dirname, './src/core'),
      '@/renderer': path.resolve(__dirname, './src/renderer'),
      '@/collector': path.resolve(__dirname, './src/collector'),
    },
  },
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext', // 支持 top-level await
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext', // 支持 top-level await
    },
  },
})