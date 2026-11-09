import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
// ⚠️ 必须在使用任何 t() 之前导入：它会注册实例并启动语言包加载
import { i18nReady } from './i18n';

// 应用 dark mode
document.documentElement.classList.add('dark');

/**
 * 等语言包首帧加载完再渲染。
 *
 * 否则命名空间还没到位，React 会先用键名占位（`alerts.title`），
 * 违反"绝不把未解析键名暴露到页面"的约定。初始化只加载**当前语言**的字典，
 * 其余语言在切换时才按需异步加载。
 */
void i18nReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
});
