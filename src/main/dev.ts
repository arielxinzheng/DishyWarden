import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

// Build main process with esbuild first
async function buildMain() {
  const commonConfig = {
    bundle: true,
    platform: 'node' as const,
    format: 'esm' as const,
    target: 'node18' as const,
    // 注意: 不能把 node 内建模块列为 external。
    // ESM 输出下 esbuild 会把它们降级成动态 require(), 在 Electron 里直接抛
    // "Dynamic require of \"util\" is not supported"。
    external: [
      'electron',
      'better-sqlite3',
      'ssh2',
    ],
    sourcemap: true,
  };

  // esbuild 以 ESM 输出时, 被打包的 CJS 依赖仍会调用 __require(),
  // 而 ESM 里没有 require。注入 createRequire 让它能真正加载 node 内建模块。
  const requireBanner = `import { createRequire as __cr } from 'module';
const require = __cr(import.meta.url);`;

  await esbuild.build({
    ...commonConfig,
    banner: { js: requireBanner },
    entryPoints: [path.join(__dirname, 'index.ts')],
    outfile: path.join(__dirname, '../../dist-electron/main/index.js'),
  });

  // Preload 必须打包成 CommonJS: Electron sandbox 环境不支持 ESM
  await esbuild.build({
    ...commonConfig,
    format: 'cjs',
    entryPoints: [path.join(__dirname, 'preload.ts')],
    outfile: path.join(__dirname, '../../dist-electron/main/preload.cjs'),
  });
}

// Get electron path
const electronPath = require('electron') as string;

// Set environment variable for dev server
process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';

// Build and start electron
buildMain().then(() => {
  const electronProcess = spawn(
    electronPath,
    ['--inspect=5858', path.join(__dirname, '../../dist-electron/main/index.js')],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    }
  );

  electronProcess.on('close', (code) => {
    process.exit(code || 0);
  });

  process.on('SIGTERM', () => {
    electronProcess.kill();
  });

  process.on('SIGINT', () => {
    electronProcess.kill();
  });
}).catch(err => {
  console.error('Failed to build main process:', err);
  process.exit(1);
});