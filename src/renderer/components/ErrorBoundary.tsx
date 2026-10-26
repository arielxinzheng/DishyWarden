/**
 * 错误边界
 *
 * React 默认会把整个组件树卸载, 任何渲染期异常都会导致整页白屏 ——
 * 而且没有任何提示。之前 Dashboard 因为 timestamp 类型问题崩溃时就是全黑一片,
 * 只能靠翻控制台才知道原因。
 *
 * 这里捕获异常, 保住布局和应用外壳, 只替换出错的那块区域。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 出错时显示的区域标题 */
  label?: string;
  /** 自定义降级 UI */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 捕获到渲染异常:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    const { children, label, fallback } = this.props;

    if (!error) return children;

    if (fallback) return fallback(error, this.reset);

    return (
      <div className="m-4 rounded-lg border border-red-500/50 bg-red-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />

          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-sm font-medium text-red-400">
              {label ? `${label} 渲染出错` : '页面渲染出错'}
            </div>

            <div className="font-mono text-xs text-red-300/90 break-words">
              {error.message}
            </div>

            {error.stack && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">调用栈</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2">
                  {error.stack}
                </pre>
              </details>
            )}

            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/15"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}