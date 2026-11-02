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
    // 只监听渲染层真正会变的文件。
    // 默认行为是监听项目根目录 ⇒ 改任何 .md 文档、改 src/core/ 下的主进程代码
    // 都会触发整页 reload(用户看到的是"页面莫名其妙闪一下")。
    watch: {
      // 排除文档、测试产物、以及主进程专属目录
      ignored: [
        '**/*.md',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/coverage/**',
        // src/core 下的主进程模块: 渲染层只在 import type 时引用它们,
        // 改动不会影响渲染结果, 不该触发 reload
        '**/src/core/probeRunner.ts',
        '**/src/core/routerProbe.ts',
        '**/src/core/dishClient.ts',
        '**/src/core/dishGrpc.ts',
        '**/src/collector/**',
        '**/src/alerting/**',
        '**/src/storage/**',
        '**/src/main/**',
        '**/src/config/**',
      ],
    },
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