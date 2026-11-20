import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

/**
 * 版本号唯一来源：package.json。
 *
 * 之前左下角写死 `'0.1.0'`，而 package.json 早已是另一个数字 —— 升版本时
 * 没人会记得回来改页面，界面上显示的版本自然永远是旧的。这里在构建时读一次，
 * 以字面量注入渲染层（见下方 define），升版本只需改 package.json 一处：
 *
 *   package.json 的 version → electron-builder 的安装包名 → 界面显示
 *
 * 注意直接读文件而不是 `import pkg from './package.json'`：tsconfig 没开
 * resolveJsonModule，配置文件的静默报错比读文件更难排查。
 */
const { version: APP_VERSION } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
) as { version: string }

export default defineConfig({
  plugins: [react()],
  define: {
    // 渲染层以 `__APP_VERSION__` 读取；类型声明见 src/vite-env.d.ts
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
      // 排除文档、测试产物、构建产物、以及主进程专属目录。
      //
      // ⚠️ 漏掉构建产物目录会有实际代价: electron-builder 往 release/ 下写
      // 几百个文件(LICENSES.*.html、asar 等), 每写一个文件 Vite 就整页
      // reload 一次 —— 实测打包一次能触发 4 次以上无谓的页面刷新。
      ignored: [
        '**/*.md',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/blob-report/**',
        '**/coverage/**',
        // 构建产物目录
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
        '**/out/**',
        '**/.vite/**',
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