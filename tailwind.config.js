/**
 * ⚠️⚠️ **这个文件已经失效, 不会再被 Tailwind 读取** ⚠️⚠️
 *
 * ## 为什么
 *
 * 本项目用的是 **Tailwind CSS v4**。v4 改用 CSS 里的 `@theme` 作为
 * **唯一的**配置入口, **不会自动加载 `tailwind.config.js`** ——
 * 除非在 CSS 里写 `@config "./tailwind.config.js";`, 而本项目没有写。
 *
 * 实测(v4 的 dev 输出):
 *   - `extend.colors` 里定义的自定义色 → **不生成任何 CSS 规则**
 *   - `darkMode: ['class']` → 不生效(项目里也没用过 `dark:` 变体)
 *   - `content` → v4 自动扫描, 不需要配
 *
 * ## 已踩过的坑
 *
 * `warning.orange` 与 `sky.blue` 定义在这里, 于是全项目
 * **23 处 `warning-orange` + 9 处 `sky-blue`** 全都是**无效样式** ——
 * 类名不报错、元素照常渲染, 只是颜色静默退回继承值。
 * 实测 `text-warning-orange` 的 computed color 是 `rgb(248, 250, 252)`(近白),
 * 而不是橙色。排查时极难发现: 看代码觉得"有颜色",
 * 看渲染也"有东西", 但那个颜色是继承来的。
 *
 * ## 要加自定义色怎么办
 *
 * 加到 **`src/renderer/index.css` 的 `@theme` 里**, 不是这里:
 *
 * ```css
 * @theme {
 *   --color-warning-orange: #f97316;
 * }
 * ```
 *
 * 之后就能用 `text-warning-orange` / `bg-warning-orange/15` 等。
 *
 * ## 当前状态
 *
 * 常用的自定义色已在 `index.css` 的 `@theme` 里声明:
 * `accent-green` / `accent-blue` / `accent-yellow` / `danger-red` /
 * `warning-orange` / `sky-blue` / `ink-950..700`。
 *
 * ⚠️ **本文件保留下来只是历史参考** —— 改它不会有任何效果。
 * 真正的配置在 `src/renderer/index.css`。
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 基于 dishylink 的深色主题配色
        'ink': {
          950: '#0a0a0a',
          900: '#131313',
          800: '#1a1a1a',
          700: '#242424',
        },
        'accent': {
          green: '#10b981',
          blue: '#3b82f6',
          yellow: '#f59e0b',
        },
        'warning': {
          orange: '#f97316',
        },
        'sky': {
          blue: '#38bdf8',
        },
        'danger': {
          red: '#ef4444',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};