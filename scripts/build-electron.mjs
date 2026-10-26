import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

const commonConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['electron', 'better-sqlite3', 'ssh2'],
  sourcemap: true,
};

// esbuild ESM 输出下, 打包进来的 CJS 依赖会调用 __require(),
// 而 ESM 没有 require —— 注入 createRequire 让 node 内建模块可被加载。
const requireBanner = `import { createRequire as __cr } from 'module';
const require = __cr(import.meta.url);`;

async function build() {
  try {
    // 构建主进程
    const mainContext = await esbuild.context({
      ...commonConfig,
      banner: { js: requireBanner },
      entryPoints: ['src/main/index.ts'],
      outfile: 'dist-electron/main/index.js',
    });

    // preload 必须是 CommonJS (Electron sandbox 不支持 ESM)
    const preloadContext = await esbuild.context({
      ...commonConfig,
      format: 'cjs',
      entryPoints: ['src/main/preload.ts'],
      outfile: 'dist-electron/main/preload.cjs',
    });

    if (isWatch) {
      console.log('[esbuild] Watching for changes...');
      await Promise.all([
        mainContext.watch(),
        preloadContext.watch(),
      ]);
    } else {
      await Promise.all([
        mainContext.rebuild(),
        preloadContext.rebuild(),
      ]);
      await mainContext.dispose();
      await preloadContext.dispose();
      console.log('[esbuild] Build complete');
    }
  } catch (error) {
    console.error('[esbuild] Build failed:', error);
    process.exit(1);
  }
}

build();