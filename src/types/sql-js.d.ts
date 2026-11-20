/**
 * sql.js 的最小类型声明 —— 供 vitest 回归区间流量 SQL 使用。
 *
 * 背景：sql.js 运行时不带 .d.ts，测试里 `import initSqlJs from 'sql.js'`
 * 会让 tsc 报 TS7016（tsconfig 的 include 覆盖整个 src 目录，测试文件也参与类型检查，
 * 所以这个文件进了仓库就会让 CI 的 typecheck 变红）。
 *
 * 为什么不用 @types/sql.js：为了一个测试引入新的 devDependency 不划算，
 * 而且 sql.js 已在 dependencies 里，这里只补上实际用到的 API 面。
 *
 * 用法见 src/storage/summarySql.test.ts。
 */

declare module 'sql.js' {
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): boolean;
    reset(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }

  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
