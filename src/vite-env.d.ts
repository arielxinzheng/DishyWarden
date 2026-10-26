/// <reference types="vite/client" />

// 让 tsc 识别 import.meta.env (如 import.meta.env.DEV)。
// tsconfig.json 里没有配 "types": ["vite/client"] —— 该文件含注释,
// 按 JSONC 解析, 常规编辑工具改不了, 所以用引用声明的方式引入。