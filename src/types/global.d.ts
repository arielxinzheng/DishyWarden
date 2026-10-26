/**
 * 全局类型声明
 */

import type { ElectronAPI } from '../main/preload';

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};