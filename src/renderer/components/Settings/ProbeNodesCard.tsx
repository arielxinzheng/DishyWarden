/**
 * 探针节点管理卡片(设置页)
 *
 * 对应需求文档 2.1.3「网络连通性探测」—— 探测目标列表可自定义。
 *
 * 与路由跟踪目标放在一起, 因为两者本质都是"探测目标":
 * 节点列表用 ICMP/DNS/TLS 周期性探测, 路由跟踪用 traceroute 单次探测。
 *
 * ## 状态显示
 *
 * 每行的「状态」列显示最近一次探测结果:
 *   - 🟢 可达 + 延迟
 *   - 🔴 不可达 + 原因
 *   - ⚪ 未探测(刚加的节点还没轮到)
 *
 * 连续失败次数也显示出来 —— 需求文档 2.1.1 说"3次连续失败才确认故障",
 * 单次失败就报故障会造成误报。
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Plus, Trash2, Pencil, Save, X, Radar, RotateCw, CheckCircle,
} from 'lucide-react';
import type { ProbeNodeConfig, ProbeType } from '../../../config/manager';
import type { ProbeNodeState } from '../../../core/probeRunner';

interface ProbeNodesCardProps {
  /** 节点列表(受控) */
  nodes: ProbeNodeConfig[];
  /** 路由跟踪目标(受控) */
  traceTarget: string;
  /** 节点变化 */
  onNodesChange: (nodes: ProbeNodeConfig[]) => void;
  /** 路由跟踪目标变化 */
  onTraceTargetChange: (target: string) => void;
}

const TYPE_LABEL: Record<ProbeType, string> = {
  icmp: 'ICMP',
  dns: 'DNS',
  tls: 'TLS',
};

const TYPE_OPTIONS: { value: ProbeType; label: string }[] = [
  { value: 'icmp', label: 'ICMP' },
  { value: 'dns', label: 'DNS' },
  { value: 'tls', label: 'TLS' },
];

/** 生成一个短 id */
function newId(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ProbeNodesCard({
  nodes,
  traceTarget,
  onNodesChange,
  onTraceTargetChange,
}: ProbeNodesCardProps) {
  const [states, setStates] = useState<ProbeNodeState[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProbeNodeConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const loadStates = useCallback(async () => {
    if (!window.electronAPI?.getProbeStates) return;
    try {
      setStates(await window.electronAPI.getProbeStates());
    } catch {
      // 主进程还没起来, 忽略
    }
  }, []);

  useEffect(() => {
    loadStates();
    // 订阅实时探测结果 —— 主进程每探完一个节点就推一次
    if (!window.electronAPI?.onProbeResult) return;
    return window.electronAPI.onProbeResult(() => { loadStates(); });
  }, [loadStates]);

  // 节点列表变了(增删)⇒ 重新拉状态
  useEffect(() => {
    loadStates();
  }, [nodes.length, loadStates]);

  const startEdit = (node: ProbeNodeConfig) => {
    setEditingId(node.id);
    setDraft({ ...node });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const commitEdit = () => {
    if (!draft) return;
    // 校验: 名称和目标不能为空
    if (!draft.name.trim() || !draft.target.trim()) return;
    onNodesChange(
      nodes.map((n) => (n.id === draft.id ? { ...draft, name: draft.name.trim(), target: draft.target.trim() } : n))
    );
    cancelEdit();
  };

  const addNode = () => {
    const node: ProbeNodeConfig = {
      id: newId(),
      name: '新探针',
      target: '',
      type: 'icmp',
      intervalSec: 60,
      timeoutSec: 5,
      enabled: true,
    };
    onNodesChange([...nodes, node]);
    setEditingId(node.id);
    setDraft(node);
  };

  const removeNode = (id: string) => {
    onNodesChange(nodes.filter((n) => n.id !== id));
    if (editingId === id) cancelEdit();
  };

  const toggleEnabled = (id: string) => {
    onNodesChange(nodes.map((n) => (n.id === id ? { ...n, enabled: !n.enabled } : n)));
  };

  const testNode = async (id: string) => {
    if (!window.electronAPI?.probeNodeNow) return;
    setTestingId(id);
    try {
      await window.electronAPI.probeNodeNow(id);
      await loadStates();
    } finally {
      setTestingId(null);
    }
  };

  const stateOf = (id: string) => states.find((s) => s.nodeId === id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="w-4 h-4 text-accent-green" />
          探针节点管理 (Probe Node Management)
        </CardTitle>
        <CardDescription>
          配置网络连通性探测目标, 主动探测各层连通性, 辅助故障定位
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 路由跟踪目标 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">路由跟踪目标 (Traceroute Target)</label>
          <Input
            value={traceTarget}
            onChange={(e) => onTraceTargetChange(e.target.value)}
            placeholder="example.com"
          />
          <p className="text-xs text-muted-foreground">
            仪表盘「路由跟踪」卡追踪的目标。留空则使用 example.com。
          </p>
        </div>

        {/* 节点列表 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">探测节点列表</div>
            <Button variant="outline" size="sm" onClick={addNode}>
              <Plus className="w-4 h-4 mr-1" />
              新增探针
            </Button>
          </div>

          {nodes.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded-md">
              暂无探针节点, 点「新增探针」添加
            </div>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">节点名称</th>
                    <th className="text-left font-medium px-3 py-2">影响对象</th>
                    <th className="text-left font-medium px-3 py-2 w-16">类型</th>
                    <th className="text-left font-medium px-3 py-2 w-16">间隔</th>
                    <th className="text-left font-medium px-3 py-2 w-16">超时</th>
                    <th className="text-left font-medium px-3 py-2 w-28">状态</th>
                    <th className="text-right font-medium px-3 py-2 w-24">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => {
                    const editing = editingId === node.id;
                    const st = stateOf(node.id);

                    return (
                      <tr key={node.id} className="border-t border-border align-middle">
                        {/* 节点名称 */}
                        <td className="px-3 py-2">
                          {editing && draft ? (
                            <Input
                              value={draft.name}
                              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                              className="h-7 text-xs"
                            />
                          ) : (
                            <span className={node.enabled ? 'text-foreground' : 'text-muted-foreground line-through'}>
                              {node.name}
                            </span>
                          )}
                        </td>

                        {/* 影响对象 */}
                        <td className="px-3 py-2">
                          {editing && draft ? (
                            <Input
                              value={draft.target}
                              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                              placeholder="IP 或域名"
                              className="h-7 text-xs font-mono"
                            />
                          ) : (
                            <span className="font-mono text-slate-300">{node.target || '—'}</span>
                          )}
                        </td>

                        {/* 类型 */}
                        <td className="px-3 py-2">
                          {editing && draft ? (
                            <select
                              value={draft.type}
                              onChange={(e) => setDraft({ ...draft, type: e.target.value as ProbeType })}
                              className="bg-transparent border border-border rounded px-1.5 py-0.5 text-xs"
                            >
                              {TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-slate-400">{TYPE_LABEL[node.type]}</span>
                          )}
                        </td>

                        {/* 间隔 */}
                        <td className="px-3 py-2">
                          {editing && draft ? (
                            <Input
                              type="number"
                              value={draft.intervalSec}
                              onChange={(e) => setDraft({ ...draft, intervalSec: parseInt(e.target.value) || 5 })}
                              className="h-7 text-xs"
                            />
                          ) : (
                            <span className="text-slate-400">{node.intervalSec}s</span>
                          )}
                        </td>

                        {/* 超时 */}
                        <td className="px-3 py-2">
                          {editing && draft ? (
                            <Input
                              type="number"
                              value={draft.timeoutSec}
                              onChange={(e) => setDraft({ ...draft, timeoutSec: parseInt(e.target.value) || 5 })}
                              className="h-7 text-xs"
                            />
                          ) : (
                            <span className="text-slate-400">{node.timeoutSec}s</span>
                          )}
                        </td>

                        {/* 状态 */}
                        <td className="px-3 py-2">
                          {!node.enabled ? (
                            <span className="text-muted-foreground">停用</span>
                          ) : !st?.last ? (
                            <span className="text-muted-foreground">未探测</span>
                          ) : st.last.ok ? (
                            <span className="text-accent-green">
                              {st.last.rttMs !== null ? `${st.last.rttMs.toFixed(0)}ms` : '可达'}
                            </span>
                          ) : (
                            <span className="text-red-400" title={st.last.error}>
                              不可达{st.consecutiveFailures > 1 ? ` ×${st.consecutiveFailures}` : ''}
                            </span>
                          )}
                        </td>

                        {/* 操作 */}
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {editing && draft ? (
                              <>
                                <Button variant="ghost" size="sm" onClick={commitEdit} title="保存">
                                  <Save className="w-3.5 h-3.5" />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={cancelEdit} title="取消">
                                  <X className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => testNode(node.id)}
                                  disabled={testingId === node.id}
                                  title="立即测试"
                                >
                                  {testingId === node.id
                                    ? <RotateCw className="w-3.5 h-3.5 animate-spin" />
                                    : <CheckCircle className="w-3.5 h-3.5" />}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => startEdit(node)} title="编辑">
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleEnabled(node.id)}
                                  title={node.enabled ? '停用' : '启用'}
                                >
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                    node.enabled
                                      ? 'border-accent-green/40 text-accent-green'
                                      : 'border-border text-muted-foreground'
                                  }`}>
                                    {node.enabled ? '启用' : '停用'}
                                  </span>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeNode(node.id)}
                                  title="删除"
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-red-400/70 hover:text-red-400" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            ICMP 探测用 ping 命令; DNS 探测解析域名; TLS 探测握手并校验证书。
            改动后需点顶部「保存」才会生效。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
