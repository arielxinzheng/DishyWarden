/**
 * 设置页面
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Save, RotateCcw, CheckCircle, AlertCircle, ExternalLink, Loader2, MapPin } from 'lucide-react';
import type { AppConfig } from '../../config/manager';

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [grafanaChecking, setGrafanaChecking] = useState(false);
  const [grafanaProvisioning, setGrafanaProvisioning] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  
  // 位置状态
  const [latitude, setLatitude] = useState<string>('');
  const [longitude, setLongitude] = useState<string>('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    if (window.electronAPI) {
      const cfg = await window.electronAPI.getConfig();
      setConfig(cfg);
      // 加载位置信息
      const savedLat = localStorage.getItem('terminal_latitude');
      const savedLon = localStorage.getItem('terminal_longitude');
      if (savedLat) setLatitude(savedLat);
      if (savedLon) setLongitude(savedLon);
    } else {
      // 开发模式下使用默认配置
      setConfig({
        collector: {
          dishAddress: '127.0.0.1',
          dishPort: 9200,
          routerAddress: '192.168.100.1',
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

      setMessage({ type: 'success', text: '配置已保存' });
    } catch (error) {
      setMessage({ type: 'error', text: '保存失败: ' + (error as Error).message });
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
        setMessage({ type: 'success', text: 'Grafana 连接成功' });
      } else {
        setMessage({ type: 'error', text: 'Grafana 连接失败: ' + (result.error || '未知错误') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: '检查失败: ' + (error as Error).message });
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
          text: `Grafana 配置成功! Dashboard URL: ${result.dashboardUrl}`,
        });
      } else {
        setMessage({ type: 'error', text: '配置失败: ' + (result.error || '未知错误') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: '配置失败: ' + (error as Error).message });
    } finally {
      setGrafanaProvisioning(false);
    }
  };

  const handleReset = async () => {
    if (!window.electronAPI || !confirm('确定要重置所有配置为默认值吗?')) return;

    setSaving(true);
    try {
      const result = await window.electronAPI.resetConfig();
      if (result.requiresRestart) {
        setMessage({ type: 'success', text: '配置已重置,请重启应用生效' });
      }
      await loadConfig();
    } catch (error) {
      setMessage({ type: 'error', text: '重置失败: ' + (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  // 获取当前地理位置
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      setMessage({ type: 'error', text: '您的浏览器不支持地理定位功能,请手动输入经纬度' });
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
        setMessage({ type: 'success', text: `已获取当前位置: ${lat}, ${lon}。请点击"保存位置"按钮保存。` });
      },
      (error) => {
        setGeoLoading(false);
        let errorMsg = '获取位置失败';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMsg = '用户拒绝了地理定位请求。请手动输入经纬度或在浏览器设置中允许定位权限后重试。';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMsg = '位置信息不可用,请手动输入经纬度';
            break;
          case error.TIMEOUT:
            errorMsg = '获取位置超时,请重试或手动输入经纬度';
            break;
        }
        setMessage({ type: 'error', text: errorMsg });
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
    console.log('保存位置被点击', { latitude, longitude });
    
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    console.log('解析后的值', { lat, lon });

    // 验证经纬度范围
    if (isNaN(lat) || lat < -90 || lat > 90) {
      const errorMsg = `纬度必须在 -90 到 90 之间 (当前值: ${latitude})`;
      console.error(errorMsg);
      setMessage({ type: 'error', text: errorMsg });
      return;
    }
    if (isNaN(lon) || lon < -180 || lon > 180) {
      const errorMsg = `经度必须在 -180 到 180 之间 (当前值: ${longitude})`;
      console.error(errorMsg);
      setMessage({ type: 'error', text: errorMsg });
      return;
    }

    // 保存到 localStorage
    localStorage.setItem('terminal_latitude', latitude);
    localStorage.setItem('terminal_longitude', longitude);
    console.log('保存成功到localStorage');
    
    // 触发自定义事件通知其他页面位置已更新
    window.dispatchEvent(new CustomEvent('terminal-location-updated'));
    
    setMessage({ type: 'success', text: '终端位置已保存' });
  };

  // 清除位置信息
  const handleClearLocation = () => {
    setLatitude('');
    setLongitude('');
    localStorage.removeItem('terminal_latitude');
    localStorage.removeItem('terminal_longitude');
    setMessage({ type: 'success', text: '终端位置已清除' });
  };

  if (loading || !config) {
    return <div className="p-8">加载中...</div>;
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">设置</h1>
          <p className="text-muted-foreground mt-1">配置数据采集和告警通知</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={saving}>
            <RotateCcw className="w-4 h-4 mr-2" />
            重置
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4 mr-2" />
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
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

      {/* 数据采集配置 */}
      <Card>
        <CardHeader>
          <CardTitle>数据采集</CardTitle>
          <CardDescription>配置 Starlink 设备连接和采集参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Dish 地址</label>
              <Input
                value={config.collector.dishAddress}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, dishAddress: e.target.value },
                  })
                }
                placeholder="192.168.100.1"
              />
              <p className="text-xs text-muted-foreground">Starlink 终端设备地址</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Dish gRPC 端口</label>
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
              <label className="text-sm font-medium">Router 地址</label>
              <Input
                value={config.collector.routerAddress}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    collector: { ...config.collector, routerAddress: e.target.value },
                  })
                }
                placeholder="192.168.100.1"
              />
              <p className="text-xs text-muted-foreground">
                路由器地址（用于 ICMP Ping 探测）
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">采集间隔(秒)</label>
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
              <p className="text-xs text-muted-foreground">推荐 30 秒</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">历史缓冲大小</label>
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
              <p className="text-xs text-muted-foreground">保留的历史数据点数</p>
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
              <CardTitle>终端位置 (Terminal Location)</CardTitle>
              <CardDescription>设置终端设备的地理位置,用于计算卫星仰角和方位角</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">纬度 Latitude</label>
              <Input
                type="number"
                step="0.000001"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="40.050835"
                min="-90"
                max="90"
              />
              <p className="text-xs text-muted-foreground">范围: -90° 到 +90° (北纬为正)</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">经度 Longitude</label>
              <Input
                type="number"
                step="0.000001"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="116.296371"
                min="-180"
                max="180"
              />
              <p className="text-xs text-muted-foreground">范围: -180° 到 +180° (东经为正)</p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleGetCurrentLocation}
              disabled={geoLoading}
              className="flex-1"
            >
              {geoLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  获取中...
                </>
              ) : (
                <>
                  <MapPin className="w-4 h-4 mr-2" />
                  获取当前位置
                </>
              )}
            </Button>
            <Button 
              onClick={handleSaveLocation} 
              disabled={!latitude || !longitude}
              title={!latitude || !longitude ? '请先输入经纬度或获取当前位置' : '保存终端位置到本地存储'}
            >
              <Save className="w-4 h-4 mr-2" />
              保存位置
            </Button>
            <Button
              variant="outline"
              onClick={handleClearLocation}
              disabled={!latitude && !longitude}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              清除
            </Button>
          </div>

          {/* 常驻提示: 否则按钮灰着时用户不知道为什么要先填经纬度 */}
          {!latitude || !longitude ? (
            <p className="text-xs text-muted-foreground">
              请先填写上面的纬度和经度, 或点「获取当前位置」自动填充, 然后才能保存。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              保存后「卫星雷达」页面会立即按该位置重新计算卫星仰角。
            </p>
          )}

          <Alert className="border-blue-500/50 bg-blue-500/10">
            <AlertCircle className="h-4 w-4 text-blue-500" />
            <AlertDescription className="ml-7 text-sm">
              <strong>使用说明:</strong>
              <br />
              1. 点击"获取当前位置"自动填充经纬度(需要浏览器定位权限)
              <br />
              2. 或者手动输入经纬度坐标
              <br />
              3. 填写完成后点击"保存位置"按钮保存到本地
              <br />
              <span className="text-xs opacity-80">数据仅保存在本地浏览器中,不会上传到服务器</span>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Telegram 通知 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Telegram 通知</CardTitle>
              <CardDescription>通过 Telegram Bot 接收告警通知</CardDescription>
            </div>
            <Badge variant={config.notifications.telegram?.enabled ? 'default' : 'secondary'}>
              {config.notifications.telegram?.enabled ? '已启用' : '未启用'}
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
              启用 Telegram 通知
            </label>
          </div>

          {config.notifications.telegram?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Bot Token</label>
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
                  placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                />
                <p className="text-xs text-muted-foreground">
                  从 @BotFather 获取
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Chat ID</label>
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
                  placeholder="123456789"
                />
                <p className="text-xs text-muted-foreground">
                  发送 /start 给 @userinfobot 获取
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Webhook 通知 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Webhook 通知</CardTitle>
              <CardDescription>发送告警到自定义 HTTP 端点</CardDescription>
            </div>
            <Badge variant={config.notifications.webhook?.enabled ? 'default' : 'secondary'}>
              {config.notifications.webhook?.enabled ? '已启用' : '未启用'}
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
              启用 Webhook 通知
            </label>
          </div>

          {config.notifications.webhook?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Webhook URL</label>
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
                  placeholder="https://example.com/webhook"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">HTTP 方法</label>
                <select
                  value={config.notifications.webhook.method || 'POST'}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      notifications: {
                        ...config.notifications,
                        webhook: {
                          ...config.notifications.webhook!,
                          method: e.target.value as 'POST' | 'PUT',
                        },
                      },
                    })
                  }
                  className="w-full h-10 px-3 rounded-md border border-input bg-background"
                >
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
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
              <CardTitle>Grafana 集成</CardTitle>
              <CardDescription>自动配置 Prometheus 数据源和 Dashboard</CardDescription>
            </div>
            <Badge variant={config.grafana?.enabled ? 'default' : 'secondary'}>
              {config.grafana?.enabled ? '已启用' : '未启用'}
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
              启用 Grafana 集成
            </label>
          </div>

          {config.grafana?.enabled && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Grafana URL</label>
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
                  placeholder="http://localhost:3000"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">用户名</label>
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
                    placeholder="admin"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">密码</label>
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
                    placeholder="admin"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  API Key (可选,优先于用户名密码)
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
                  placeholder="留空使用用户名密码认证"
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
                      检查中...
                    </>
                  ) : (
                    '测试连接'
                  )}
                </Button>

                <Button onClick={handleProvisionGrafana} disabled={grafanaProvisioning}>
                  {grafanaProvisioning ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      配置中...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-4 h-4 mr-2" />
                      一键配置
                    </>
                  )}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                点击"一键配置"将自动在 Grafana 中创建 Prometheus 数据源和 Starlink 监控
                Dashboard
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}