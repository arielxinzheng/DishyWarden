/// <reference types="vite/client" />

// 让 tsc 识别 import.meta.env (如 import.meta.env.DEV)。
// tsconfig.json 里没有配 "types": ["vite/client"] —— 该文件含注释,
// 按 JSONC 解析, 常规编辑工具改不了, 所以用引用声明的方式引入。

/**
 * 应用版本号，构建时由 vite.config.ts 从 package.json 注入（define）。
 *
 * 运行时不存在这个变量 —— 源码里出现的地方都会被替换成字符串字面量，
 * 所以不要在非 Vite 构建的环境（如直接用 esbuild 打包的脚本）里引用它。
 */
declare const __APP_VERSION__: string;