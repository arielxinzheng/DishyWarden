/**
 * 「升级与匿名反馈」卡片（设置页）
 *
 * 对应需求文档 2.8.1–2.8.3（自动检查升级更新）。
 *
 * ## 设计要点
 *
 * - **云端地址与更新源由后台固定**（`config/manager.ts` 的 CLOUD_ENDPOINT /
 *   UPDATE_FEED_URL），界面不暴露 —— 用户填错一个字符上报就会静默全失败，
 *   而且这两个地址本来就只有"部署事实"一个正确答案。
 *   卡片只留用户真正能决定的东西：是否上报告警误报样本、以及升级动作。
 * - **失败静默**：检查更新失败只在卡片里显示一行文字，不弹窗、不打扰
 *   （升级嗅探绝不能影响 7×24 监控主职）。
 * - **用户确认后才下载**（需求 2.8.2）：发现新版本只提示，
 *   点「立即下载」才开始下载，下载完再点「重启并安装」。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription } from '../ui/alert';
import { Download, RefreshCw, Save, ShieldCheck, Upload } from 'lucide-react';
import type { UpdateState, UpdateStatus } from '../../../core/updater';
import type { CloudConfig } from '../../../config/manager';

interface UpdateFeedbackCardProps {
  /** 云端配置（只读入参：卡片自己保存，不走设置页的总保存按钮） */
  cloud: CloudConfig;
}

/** 状态 → 语义色 */
function statusVariant(status: UpdateStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'available':
    case 'downloaded':
      return 'default';
    case 'error':
      return 'destructive';
    case 'checking':
    case 'downloading':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function UpdateFeedbackCard({ cloud }: UpdateFeedbackCardProps) {
  const { t } = useTranslation();
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 表单本地状态：设置页的总保存按钮是分段保存（不含 cloud 段），
  // 所以这块自己管一份，保存走独立的 update-cloud-config。
  // 端点/更新源不在表单里（后台固定），这里只管用户意愿。
  const [feedbackEnabled, setFeedbackEnabled] = useState(cloud?.feedbackEnabled ?? false);

  // 配置被重新加载（首次加载 / 点重置）时同步一次
  useEffect(() => {
    setFeedbackEnabled(cloud?.feedbackEnabled ?? false);
  }, [cloud?.feedbackEnabled]);

  // 拉一次初始状态 + 订阅后续变化
  useEffect(() => {
    let cancelled = false;

    const api = window.electronAPI;
    if (!api?.getUpdateState) return undefined;

    void api.getUpdateState().then((state) => {
      if (!cancelled && state) setUpdateState(state);
    });

    const unsubscribe = api.onUpdateState?.((state) => {
      if (!cancelled) setUpdateState(state);
    });

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const handleCheck = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdate || checking) return;
    setChecking(true);
    try {
      const state = await api.checkForUpdate();
      if (state) setUpdateState(state);
    } finally {
      setChecking(false);
    }
  }, [checking]);

  const handleDownload = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.downloadUpdate) return;
    await api.downloadUpdate();
  }, []);

  const handleInstall = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.installUpdate) return;
    await api.installUpdate({ toVersion: updateState?.availableVersion });
  }, [updateState]);

  const handleSave = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.updateCloudConfig) return;
    setSaving(true);
    setSaveError(null);
    try {
      // 只送用户意愿字段 —— endpoint / updateFeedUrl 由后台常量固定，
      // 主进程与 ConfigManager 都只接受这三个
      const result = await api.updateCloudConfig({ feedbackEnabled });
      if (result?.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setSaveError(result?.error ?? t('settings:cloud.save_failed', { error: '' }));
      }
    } finally {
      setSaving(false);
    }
  }, [feedbackEnabled, t]);

  const status = updateState?.status ?? 'idle';
  const statusKey: Record<UpdateStatus, string> = {
    disabled: 'settings:cloud.status_disabled',
    idle: 'settings:cloud.status_idle',
    checking: 'settings:cloud.status_checking',
    available: 'settings:cloud.status_available',
    'up-to-date': 'settings:cloud.status_up_to_date',
    downloading: 'settings:cloud.status_downloading',
    downloaded: 'settings:cloud.status_downloaded',
    error: 'settings:cloud.status_error',
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          {t('settings:cloud.title')}
        </CardTitle>
        <CardDescription>{t('settings:cloud.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 版本与状态 */}
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <span className="opacity-70">{t('settings:cloud.current_version')}: </span>
            <span className="font-mono">{updateState?.currentVersion ?? '-'}</span>
            {updateState?.availableVersion && (
              <>
                <span className="opacity-70"> → </span>
                <span className="font-mono text-primary">{updateState.availableVersion}</span>
              </>
            )}
          </div>
          <Badge variant={statusVariant(status)}>{t(statusKey[status])}</Badge>
        </div>

        {status === 'downloading' && typeof updateState?.percent === 'number' && (
          <div className="w-full bg-secondary rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{ width: `${Math.max(0, Math.min(100, updateState.percent))}%` }}
            />
          </div>
        )}

        {updateState?.releaseNotes && (
          <div className="text-xs opacity-70 whitespace-pre-wrap break-words">
            {updateState.releaseNotes}
          </div>
        )}

        {status === 'error' && updateState?.error && (
          <Alert className="border-destructive/50 text-destructive">
            <AlertDescription className="text-xs">{updateState.error}</AlertDescription>
          </Alert>
        )}

        {status === 'disabled' && updateState?.error && (
          <p className="text-xs opacity-70">
            {updateState.error === 'dev_mode'
              ? t('settings:cloud.hint_dev_mode')
              : t('settings:cloud.hint_updater_unavailable')}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleCheck} disabled={checking}>
            <RefreshCw className={checking ? 'animate-spin' : ''} />
            {checking ? t('settings:cloud.checking') : t('settings:cloud.check_update')}
          </Button>
          {status === 'available' && (
            <Button onClick={handleDownload}>
              <Download />
              {t('settings:cloud.download_now')}
            </Button>
          )}
          {status === 'downloaded' && (
            <Button onClick={handleInstall}>
              <RefreshCw />
              {t('settings:cloud.install_restart')}
            </Button>
          )}
        </div>

        {/* 匿名反馈开关 */}
        <div className="flex items-start gap-3 p-3 rounded-lg border border-border">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={feedbackEnabled}
                onChange={(e) => setFeedbackEnabled(e.target.checked)}
              />
              <Upload className="w-3.5 h-3.5" />
              {t('settings:cloud.feedback_enable')}
            </label>
            <p className="text-xs opacity-70">{t('settings:cloud.feedback_desc')}</p>
          </div>
        </div>

        {/* 保存 */}
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            <Save />
            {saving ? t('settings:save.saving') : t('settings:cloud.save')}
          </Button>
          {saved && <span className="text-xs text-green-600">{t('settings:cloud.saved')}</span>}
          {saveError && <span className="text-xs text-destructive">{saveError}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
