/**
 * 设置页面
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Save, RotateCcw, CheckCircle, AlertCircle, ExternalLink, Loader2, MapPin } from 'lucide-react';
import type { AppConfig } from '../../config/manager';
import { ProbeNodesCard } from '../components/Settings/ProbeNodesCard';
import {
  UpdateFeedbackCard,
  type UpdateFeedbackCardHandle,
} from '../components/Settings/UpdateFeedbackCard';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
// 共享常量：默认模板 + 变量清单（纯 TS，渲染层可安全引用）
import { DEFAULT_WEBHOOK_TEMPLATE } from '../../alerting/webhookTemplate';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TEMPLATE_VARIABLE_KEYS,
  formatWebhookHeaders,
  isValidWebhookTemplate,
  parseWebhookHeaders,
  parseWebhookTimeout,
} from '../lib/webhookTemplate';
import { dishLocationFailureText, geolocationFailureText } from '../lib/locationMessages';

export default function Settings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [grafanaChecking, setGrafanaChecking] = useState(false);
  const [grafanaProvisioning, setGrafanaProvisioning] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [dishLoading, setDishLoading] = useState(false);
  
  // 位置状态
  /** 升级与反馈卡片把自己的保存能力交出来，由页面底部的总保存按钮统一提交 */
  const feedbackRef = useRef<UpdateFeedbackCardHandle>(null);

  const [latitude, setLatitude] = useState<string>('');
  const [longitude, setLongitude] = useState<string>('');

  // ── Webhook 表单的「原文」状态 ────────────────────────────────────────────
  // 配置里存的是解析后的结果（headers 是对象），界面显示的是用户手写的原文。
  // 两者必须分开：用户正在写半截 JSON 时不能把他正在写的东西抹掉，
  // 但半截 JSON 绝不能落盘（否则会把坏数据发给主进程）。
  const [webhookHeadersText, setWebhookHeadersText] = useState<string>('');
  const [webhookPayloadText, setWebhookPayloadText] = useState<string>('');
  const [webhookTimeoutText, setWebhookTimeoutText] = useState<string>('');
  // 回填标记：配置被重新加载时清零，用来触发一次「表单原文 ← 配置」的同步
  const webhookFormSynced = useRef(false);

  useEffect(() => {
    loadConfig();
  }, []);

  // 配置到位后回填表单原文。
  // 只在「配置刚被重新加载」时回填一次（首次加载 / 点重置后），
  // 之后完全由用户输入驱动 —— 否则每敲一个字都会被回填写回去。
  useEffect(() => {
    if (!config || webhookFormSynced.current) return;
    webhookFormSynced.current = true;
    const webhook = config.notifications.webhook;
    setWebhookHeadersText(formatWebhookHeaders(webhook?.headers));
    setWebhookPayloadText(webhook?.payloadTemplate ?? DEFAULT_WEBHOOK_TEMPLATE);
    setWebhookTimeoutText(String(webhook?.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS));
  }, [config]);

  const loadConfig = async () => {
    if (window.electronAPI) {
      const cfg = await window.electronAPI.getConfig();
      // 新配置到位 → 表单原文回填一次（首次加载 / 点「重置」后）
      webhookFormSynced.current = false;
      setConfig(cfg);
      // 加载位置信息
      const savedLat = localStorage.getItem('terminal_latitude');
      const savedLon = localStorage.getItem('terminal_longitude');
      if (savedLat) setLatitude(savedLat);
      if (savedLon) setLongitude(savedLon);
    } else {
      // 开发模式下使用默认配置
      webhookFormSynced.current = false;
      setConfig({
        collector: {
          dishAddress: '192.168.100.1',
          dishPort: 9200,
          dishWebPort: 9201,
          routerAddress: '192.168.1.1',
          interval: 30000,
          bufferSize: 2880,
        },
        prometheus: {
          port: 9090,
          retentionTime: '90d',
          scrapeInterval: '30s',
        },
        notifications: {
          telegram: {
            enabled: false,
            botToken: '',
            chatId: '',
          },
          webhook: {
            enabled: false,
            url: '',
            method: 'POST',
          },
          email: {
            enabled: false,
            smtpHost: '',
            smtpPort: 587,
            username: '',
            password: '',
            to: [],
            useTLS: true,
          },
        },
        grafana: {
          enabled: false,
          url: 'http://localhost:3000',
          apiKey: '',
          username: '',
          password: '',
        },
        alertThresholds: {
          highLatencyMs: 100,
          highPacketLoss: 0.1,
        },
        probe: {
          traceTarget: 'example.com',
          nodes: [],
        },
        cloud: {
          endpoint: '',
          clientId: '',
          feedbackEnabled: false,
          updateFeedUrl: '',
          checkIntervalHours: 12,
        },
        version: '0.1.0',
      } as AppConfig);
    }
    setLoading(false);
  };

  const handleSave = async () => {
    if (!config || !window.electronAPI) return;

    setSaving(true);
    setMessage(null);

    try {
      // 保存通知配置
      await window.electronAPI.updateNotificationConfig(config.notifications);

      // 保存采集器配置
      await window.electronAPI.updateCollectorConfigSettings(config.collector);

      // 保存 Grafana 配置
      await window.electronAPI.updateGrafanaConfig(config.grafana);

      // 保存探针配置(节点列表 + 路由跟踪目标)
      await window.electronAPI.updateProbeConfig(config.probe);

      // 保存「升级与匿名反馈」段（以前这块自带一个保存按钮，和这里重复）
      await feedbackRef.current?.save();

      setMessage({ type: 'success', text: t('settings:save.success') });
    } catch (error) {
      setMessage({ type: 'error', text: t('settings:save.failed', { error: (error as Error).message }) });
    } finally {
      setSaving(false);
    }
  };

  const handleCheckGrafana = async () => {
    if (!window.electronAPI) return;

    setGrafanaChecking(true);
    try {
      const result = await window.electronAPI.checkGrafanaConnection();
      if (result.connected) {
        setMessage({ type: 'success', text: t('settings:grafana.check_success') });
      } else {
        setMessage({
          type: 'error',
          text: t('settings:grafana.check_failed', {
            error: result.error || t('settings:grafana.unknown_error'),
          }),
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: t('settings:grafana.check_error', { error: (error as Error).message }) });
    } finally {
      setGrafanaChecking(false);
    }
  };

  const handleProvisionGrafana = async () => {
    if (!window.electronAPI) return;

    setGrafanaProvisioning(true);
    setMessage(null);

    try {
      const result = await window.electronAPI.provisionGrafana();
      if (result.success) {
        setMessage({
          type: 'success',
          text: t('settings:grafana.provision_success', { url: result.dashboardUrl }),
        });
      } else {
        setMessage({
          type: 'error',
          text: t('settings:grafana.provision_failed', {
            error: result.error || t('settings:grafana.unknown_error'),
          }),
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: t('settings:grafana.provision_failed', { error: (error as Error).message }) });
    } finally {
      setGrafanaProvisioning(false);
    }
  };

  const handleReset = async () => {
    if (!window.electronAPI || !confirm(t('settings:save.reset_confirm'))) return;

    setSaving(true);
    try {
      const result = await window.electronAPI.resetConfig();
      if (result.requiresRestart) {
        setMessage({ type: 'success', text: t('settings:save.reset_success') });
      }
      await loadConfig();
    } catch (error) {
      setMessage({ type: 'error', text: t('settings:save.reset_failed', { error: (error as Error).message }) });
    } finally {
      setSaving(false);
    }
  };

  // 从星链终端读取位置（dish 自带 GPS，不依赖本机定位服务）
  const handleGetDishLocation = async () => {
    if (!window.electronAPI?.getDishLocation) {
      setMessage({ type: 'error', text: t('settings:location.dish_other') });
      return;
    }
    setDishLoading(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.getDishLocation();
      if (result.ok && result.location) {
        const lat = result.location.lat.toFixed(6);
        const lon = result.location.lon.toFixed(6);
        setLatitude(lat);
        setLongitude(lon);
        setMessage({ type: 'success', text: t('settings:location.got_dish_position', { lat, lon }) });
      } else {
        setMessage({ type: 'error', text: dishLocationFailureText(t, result) });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: dishLocationFailureText(t, { reason: 'other', error: (error as Error).message }),
      });
    } finally {
      setDishLoading(false);
    }
  };

  // 获取当前地理位置（浏览器定位 —— 远程桌面 / 系统定位服务关闭时不可用）
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      setMessage({ type: 'error', text: t('settings:location.not_supported') });
      return;
    }

    setGeoLoading(true);
    setMessage(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude.toFixed(6);
        const lon = position.coords.longitude.toFixed(6);
        setLatitude(lat);
        setLongitude(lon);
        setGeoLoading(false);
        setMessage({
          type: 'success',
          text: t('settings:location.got_position', { lat, lon }),
        });
      },
      (error) => {
        setGeoLoading(false);
        // 带上真实错误码 + Chromium 原文，用户/我们才分得清是哪一种失败
        console.warn('[Settings] geolocation failed', error.code, error.message);
        setMessage({ type: 'error', text: geolocationFailureText(t, error) });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  };

  // 保存位置信息
  const handleSaveLocation = () => {
    console.log('Save location clicked', { latitude, longitude });
    
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    console.log('Parsed values', { lat, lon });

    // 验证经纬度范围
    if (isNaN(lat) || lat < -90 || lat > 90) {
      const errorMsg = t('settings:location.lat_invalid', { value: latitude });
      console.error(errorMsg);
      setMessage({ type: 'error', text: errorMsg });
      return;
    }
    if (isNaN(lon) || lon < -180 || lon > 180) {
      const errorMsg = t('settings:location.lon_invalid', { value: longitude });
      console.error(errorMsg);
      setMessage({ type: 'error', text: errorMsg });
      return;
    }

    // 保存到 localStorage
    localStorage.setItem('terminal_latitude', latitude);
    localStorage.setItem('terminal_longitude', longitude);
    console.log('Saved to localStorage');
    
    // 触发自定义事件通知其他页面位置已更新
    window.dispatchEvent(new CustomEvent('terminal-location-updated'));
    
    setMessage({ type: 'success', text: t('settings:location.saved') });
  };

  // 清除位置信息
  const handleClearLocation = () => {
    setLatitude('');
    setLongitude('');
    localStorage.removeItem('terminal_latitude');
    localStorage.removeItem('terminal_longitude');
    setMessage({ type: 'success', text: t('settings:location.cleared') });
  };

  if (loading || !config) {
    return <div className="p-8">{t('common:loading')}</div>;
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('layout:nav_settings')}</h1>
          <p className="text-muted-foreground mt-1">{t('settings:subtitle')}</p>
        </div>
        {/* 全局语言切换（需求指定的「右上角」位置）。
            重置/保存按钮移到页面底部，更醒目，也不和滚动位置脱节。 */}
        <LanguageSwitcher variant="icon" />
      </div>

      {message && (
        <Alert className={message.type === 'error' ? 'border-red-500 bg-red-500/10' : 'border-green-500 bg-green-500/10'}>
          {message.type === 'success' ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <AlertDescription className="ml-7">{message.text}</AlertDescription>
        </Alert>
      )}

      {/* 通用 / 外观分区：语言切换器放在第一项 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:appearance.title')}</CardTitle>
          <CardDescription>{t('settings:appearance.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">{t('settings:appearance.language')}</div>
              <p className="text-xs text-muted-foreground">{t('settings:appearance.language_hint')}</p>
            </div>
            <LanguageSwitcher variant="label" />
          </div>
        </CardContent>
      </Card>

      {/* 数据采集配置 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:collector.title')}</CardTitle>
          <CardDescription>{t('settings:collector.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:collector.dish_address')}</label>
              <Input
                value={config.collector.dishAddress}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, dishAddress: e.target.value },
                  })
                }
                placeholder={t('settings:collector.dish_address_placeholder')}
              />
              <p className="text-xs text-muted-foreground">{t('settings:collector.dish_address_hint')}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:collector.dish_port')}</label>
              <Input
                type="number"
                value={config.collector.dishPort}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, dishPort: parseInt(e.target.value) },
                  })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:collector.router_address')}</label>
              <Input
                value={config.collector.routerAddress}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, routerAddress: e.target.value },
                  })
                }
                placeholder={t('settings:collector.router_address_placeholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings:collector.router_address_hint')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:collector.interval')}</label>
              <Input
                type="number"
                value={config.collector.interval / 1000}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: {
                      ...config.collector,
                      interval: parseInt(e.target.value) * 1000,
                    },
                  })
                }
                min="10"
                max="300"
              />
              <p className="text-xs text-muted-foreground">{t('settings:collector.interval_hint')}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:collector.buffer_size')}</label>
              <Input
                type="number"
                value={config.collector.bufferSize}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, bufferSize: parseInt(e.target.value) },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">{t('settings:collector.buffer_size_hint')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 终端位置配置 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            <div>
              <CardTitle>{t('settings:location.title')}</CardTitle>
              <CardDescription>{t('settings:location.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:location.latitude')}</label>
              <Input
                type="number"
                step="0.000001"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                min="-90"
                max="90"
              />
              <p className="text-xs text-muted-foreground">{t('settings:location.latitude_range')}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:location.longitude')}</label>
              <Input
                type="number"
                step="0.000001"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                min="-180"
                max="180"
              />
              <p className="text-xs text-muted-foreground">{t('settings:location.longitude_range')}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {/* dish 侧读取优先放在前面：真机远程桌面 / 系统定位服务关闭时浏览器定位必然失败，
                dish 自带 GNSS，不依赖用户机器，是更稳的数据源 */}
            <Button
              variant="default"
              onClick={handleGetDishLocation}
              disabled={dishLoading}
              className="flex-1"
              title={t('settings:location.dish_source_tooltip')}
            >
              {dishLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('settings:location.fetching')}
                </>
              ) : (
                <>
                  <MapPin className="w-4 h-4 mr-2" />
                  {t('settings:location.get_from_dish')}
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleGetCurrentLocation}
              disabled={geoLoading}
              className="flex-1"
            >
              {geoLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('settings:location.fetching')}
                </>
              ) : (
                <>
                  <MapPin className="w-4 h-4 mr-2" />
                  {t('settings:location.get_current')}
                </>
              )}
            </Button>
            <Button 
              onClick={handleSaveLocation} 
              disabled={!latitude || !longitude}
              title={!latitude || !longitude
                ? t('settings:location.save_disabled_hint')
                : t('settings:location.save_tooltip')}
            >
              <Save className="w-4 h-4 mr-2" />
              {t('settings:location.save')}
            </Button>
            <Button
              variant="outline"
              onClick={handleClearLocation}
              disabled={!latitude && !longitude}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              {t('settings:location.clear')}
            </Button>
          </div>

          {/* 常驻提示: 否则按钮灰着时用户不知道为什么要先填经纬度 */}
          {!latitude || !longitude ? (
            <p className="text-xs text-muted-foreground">
              {t('settings:location.need_coords')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('settings:location.saved_hint')}
            </p>
          )}

          <Alert className="border-blue-500/50 bg-blue-500/10">
            <AlertCircle className="h-4 w-4 text-blue-500" />
            <AlertDescription className="ml-7 text-sm">
              <strong>{t('settings:location.usage_title')}</strong>
              <br />
              1. {t('settings:location.usage_dish')}
              <br />
              2. {t('settings:location.usage_1')}
              <br />
              3. {t('settings:location.usage_2')}
              <br />
              4. {t('settings:location.usage_3')}
              <br />
              <span className="text-xs opacity-80">{t('settings:location.rdp_hint')}</span>
              <br />
              <br />
              <span className="text-xs opacity-80">{t('settings:location.privacy')}</span>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* 告警阈值 */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings:thresholds.title')}</CardTitle>
          <CardDescription>{t('settings:thresholds.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor="high-latency-threshold" className="block text-sm font-medium mb-2">
              {t('settings:thresholds.high_latency')}
            </label>
            <input
              type="number"
              id="high-latency-threshold"
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              value={config.alertThresholds?.highLatencyMs ?? 100}
              onChange={(e) =>
                setConfig({
                  ...config,
                  alertThresholds: {
                    ...config.alertThresholds,
                    highLatencyMs: Number(e.target.value),
                    highPacketLoss: config.alertThresholds?.highPacketLoss ?? 0.1,
                  },
                })
              }
              min="10"
              max="1000"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings:thresholds.high_latency_hint')}
            </p>
          </div>

          <div>
            <label htmlFor="high-packet-loss-threshold" className="block text-sm font-medium mb-2">
              {t('settings:thresholds.high_packet_loss')}
            </label>
            <input
              type="number"
              id="high-packet-loss-threshold"
              className="w-full px-3 py-2 bg-background border border-border rounded-md"
              value={((config.alertThresholds?.highPacketLoss ?? 0.1) * 100).toFixed(1)}
              onChange={(e) =>
                setConfig({
                  ...config,
                  alertThresholds: {
                    highLatencyMs: config.alertThresholds?.highLatencyMs ?? 100,
                    highPacketLoss: Number(e.target.value) / 100,
                  },
                })
              }
              min="0.1"
              max="50"
              step="0.1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings:thresholds.high_packet_loss_hint')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 探针节点管理(需求文档 2.1.3 网络连通性探测) */}
      {config && (
        <ProbeNodesCard
          nodes={config.probe?.nodes ?? []}
          traceTarget={config.probe?.traceTarget ?? 'example.com'}
          onNodesChange={(nodes) =>
            setConfig({ ...config, probe: { ...config.probe, nodes } })
          }
          onTraceTargetChange={(traceTarget) =>
            setConfig({ ...config, probe: { ...config.probe, traceTarget } })
          }
        />
      )}

      {/* 升级与匿名反馈(需求文档 2.8 自动检查升级更新) */}
      {config && <UpdateFeedbackCard ref={feedbackRef} cloud={config.cloud} />}

      {/* Telegram 通知 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('settings:notifications.telegram_title')}</CardTitle>
              <CardDescription>{t('settings:notifications.telegram_description')}</CardDescription>
            </div>
            <Badge variant={config.notifications.telegram?.enabled ? 'default' : 'secondary'}>
              {config.notifications.telegram?.enabled
                ? t('settings:status.enabled')
                : t('settings:status.disabled')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="telegram-enabled"
              checked={config.notifications.telegram?.enabled || false}
              onChange={(e) =>
                setConfig({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    telegram: {
                      ...config.notifications.telegram!,
                      enabled: e.target.checked,
                    },
                  },
                })
              }
              className="w-4 h-4"
            />
            <label htmlFor="telegram-enabled" className="text-sm font-medium">
              {t('settings:notifications.telegram_enable')}
            </label>
          </div>

          {config.notifications.telegram?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:notifications.bot_token')}</label>
                <Input
                  type="password"
                  value={config.notifications.telegram.botToken}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        telegram: {
                          ...config.notifications.telegram!,
                          botToken: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder={t('settings:notifications.bot_token_placeholder')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings:notifications.bot_token_hint')}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:notifications.chat_id')}</label>
                <Input
                  value={config.notifications.telegram.chatId}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        telegram: {
                          ...config.notifications.telegram!,
                          chatId: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder={t('settings:notifications.chat_id_placeholder')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings:notifications.chat_id_hint')}
                </p>
              </div>
            </>
          )}

          {/* 公网通道行为说明: 断网期间发不出去, 恢复后聚合补发, 避免用户误以为能实时收到 */}
          <p className="text-xs text-muted-foreground">
            {t('settings:notifications.public_channel_offline_hint')}
          </p>
        </CardContent>
      </Card>

      {/* Webhook 通知 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('settings:notifications.webhook_title')}</CardTitle>
              <CardDescription>{t('settings:notifications.webhook_description')}</CardDescription>
            </div>
            <Badge variant={config.notifications.webhook?.enabled ? 'default' : 'secondary'}>
              {config.notifications.webhook?.enabled
                ? t('settings:status.enabled')
                : t('settings:status.disabled')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="webhook-enabled"
              checked={config.notifications.webhook?.enabled || false}
              onChange={(e) =>
                setConfig({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    webhook: {
                      ...config.notifications.webhook!,
                      enabled: e.target.checked,
                    },
                  },
                })
              }
              className="w-4 h-4"
            />
            <label htmlFor="webhook-enabled" className="text-sm font-medium">
              {t('settings:notifications.webhook_enable')}
            </label>
          </div>

          {config.notifications.webhook?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:notifications.webhook_url')}</label>
                <Input
                  value={config.notifications.webhook.url}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          url: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder={t('settings:notifications.webhook_url_placeholder')}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:notifications.http_method')}</label>
                <select
                  value={config.notifications.webhook.method || 'POST'}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          method: e.target.value as 'GET' | 'POST',
                        },
                      },
                    })
                  }
                  className="w-full h-10 px-3 rounded-md border border-input bg-background"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>

              {/* 请求头：界面显示原文，落盘存解析后的对象 */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('settings:notifications.webhook_headers_label')}
                </label>
                <textarea
                  value={webhookHeadersText}
                  onChange={(e) => {
                    const text = e.target.value;
                    setWebhookHeadersText(text);
                    // 解析失败也照旧更新配置，但存的是空对象（坏数据不落盘）
                    const parsed = parseWebhookHeaders(text);
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          headers: parsed.value,
                        },
                      },
                    });
                  }}
                  placeholder={t('settings:notifications.webhook_headers_placeholder')}
                  rows={3}
                  spellCheck={false}
                  className="flex w-full min-h-[72px] rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings:notifications.webhook_headers_hint')}
                </p>
                {parseWebhookHeaders(webhookHeadersText).ok ? null : (
                  <p className="text-xs text-destructive">
                    {t('settings:notifications.webhook_headers_invalid')}
                  </p>
                )}
              </div>

              {/* 自定义请求体（Payload Template） */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-sm font-medium">
                    {t('settings:notifications.webhook_template_label')}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setWebhookPayloadText(DEFAULT_WEBHOOK_TEMPLATE);
                      setConfig({
                        ...config,
                        notifications: {
                          ...config.notifications,
                          webhook: {
                            ...config.notifications.webhook!,
                            payloadTemplate: DEFAULT_WEBHOOK_TEMPLATE,
                          },
                        },
                      });
                    }}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    {t('settings:notifications.webhook_template_reset')}
                  </Button>
                </div>
                <textarea
                  value={webhookPayloadText}
                  onChange={(e) => {
                    const text = e.target.value;
                    setWebhookPayloadText(text);
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          payloadTemplate: text,
                        },
                      },
                    });
                  }}
                  rows={10}
                  spellCheck={false}
                  className="flex w-full min-h-[180px] rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings:notifications.webhook_template_hint')}
                </p>
                {isValidWebhookTemplate(webhookPayloadText) ? null : (
                  <p className="text-xs text-destructive">
                    {t('settings:notifications.webhook_template_invalid')}
                  </p>
                )}
                {/* 可用变量：变量名是后端约定的英文标识符，语言中立，不翻译 */}
                <p className="text-xs text-muted-foreground">
                  {t('settings:notifications.webhook_vars_help')}
                </p>
                <div className="flex flex-wrap gap-1">
                  {WEBHOOK_TEMPLATE_VARIABLE_KEYS.map((key) => (
                    <code
                      key={key}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {`{{${key}}}`}
                    </code>
                  ))}
                </div>
              </div>

              {/* 请求超时 */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('settings:notifications.webhook_timeout_label')}
                </label>
                <Input
                  type="number"
                  min={1}
                  step={100}
                  value={webhookTimeoutText}
                  onChange={(e) => {
                    const text = e.target.value;
                    setWebhookTimeoutText(text);
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          timeoutMs: parseWebhookTimeout(text),
                        },
                      },
                    });
                  }}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Grafana 集成 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('settings:grafana.title')}</CardTitle>
              <CardDescription>{t('settings:grafana.description')}</CardDescription>
            </div>
            <Badge variant={config.grafana?.enabled ? 'default' : 'secondary'}>
              {config.grafana?.enabled
                ? t('settings:status.enabled')
                : t('settings:status.disabled')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="grafana-enabled"
              checked={config.grafana?.enabled || false}
              onChange={(e) =>
                setConfig({
                  ...config,
                  grafana: {
                    ...config.grafana!,
                    enabled: e.target.checked,
                  },
                })
              }
              className="w-4 h-4"
            />
            <label htmlFor="grafana-enabled" className="text-sm font-medium">
              {t('settings:grafana.enable')}
            </label>
          </div>

          {config.grafana?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('settings:grafana.url')}</label>
                <Input
                  value={config.grafana.url}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      grafana: {
                        ...config.grafana!,
                        url: e.target.value,
                      },
                    })
                  }
                  placeholder={t('settings:grafana.url_placeholder')}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('settings:grafana.username')}</label>
                  <Input
                    value={config.grafana.username}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        grafana: {
                          ...config.grafana!,
                          username: e.target.value,
                        },
                      })
                    }
                    placeholder={t('settings:grafana.username_placeholder')}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('settings:grafana.password')}</label>
                  <Input
                    type="password"
                    value={config.grafana.password}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        grafana: {
                          ...config.grafana!,
                          password: e.target.value,
                        },
                      })
                    }
                    placeholder={t('settings:grafana.password_placeholder')}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('settings:grafana.api_key')}
                </label>
                <Input
                  type="password"
                  value={config.grafana.apiKey}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      grafana: {
                        ...config.grafana!,
                        apiKey: e.target.value,
                      },
                    })
                  }
                  placeholder={t('settings:grafana.api_key_placeholder')}
                />
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={handleCheckGrafana}
                  disabled={grafanaChecking}
                >
                  {grafanaChecking ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('settings:grafana.checking')}
                    </>
                  ) : (
                    t('settings:grafana.test_connection')
                  )}
                </Button>

                <Button onClick={handleProvisionGrafana} disabled={grafanaProvisioning}>
                  {grafanaProvisioning ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      {t('settings:grafana.provisioning')}
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-4 h-4 mr-2" />
                      {t('settings:grafana.provision')}
                    </>
                  )}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('settings:grafana.provision_hint')}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* 底部固定操作条：重置 / 保存放在这里，更醒目 */}
      <div className="sticky bottom-0 z-20 -mx-8 px-8 py-4 bg-background/95 backdrop-blur border-t border-border">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">{t('settings:save.footer_hint')}</p>
          <div className="flex gap-3">
            <Button variant="outline" size="lg" onClick={handleReset} disabled={saving}>
              <RotateCcw className="w-4 h-4 mr-2" />
              {t('settings:save.reset')}
            </Button>
            <Button size="lg" onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? t('settings:save.saving') : t('settings:save.button')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}