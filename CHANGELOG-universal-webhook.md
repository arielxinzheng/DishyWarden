# 变更记录：通用 Webhook 告警通道

**日期**: 2026-11-10
**范围**: 后端 `src/alerting/webhookTemplate.ts`（新）+ `notifier.ts` + `src/config/manager.ts`；前端 `src/renderer/pages/Settings.tsx`
**状态**: 单测 27 文件 / 391 测试全过；tsc 双配置 0 错误；真机端到端验证通过

---

## 1. 为什么要模板，而不是给每家系统写适配

外部系统的告警载荷形状千差万别：

| 系统 | 需要的 JSON |
|---|---|
| Home Assistant | `{"text": "..."}` |
| Bark | `{"title": "...", "body": "..."}` |
| 飞书 | `{"msgtype": "text", "text": {"content": "..."}}` |
| n8n | 任意结构 |
| Bark / Pushover / Gotify / … | 数百种 |

原先 webhook 只能发一套固定 JSON（`alert_type` / `severity` / `summary` / …），
接非标准系统时用户只能自己再写一层中转。

**改法**：让用户自己写**载荷模板**，系统用 `{{变量}}` 插值。一个模板覆盖数百种系统，
后端不需要认识任何一家。

## 2. 配置项

`notifications.webhook`：

```ts
{
  enabled: boolean;
  url: string;
  method?: 'GET' | 'POST';          // 原本是 'POST' | 'PUT'
  headers?: Record<string, string>;  // 新增：JSON 对象，用于鉴权
  payloadTemplate?: string;          // 新增：用户自定义 JSON 模板
  timeoutMs?: number;                // 新增：默认 5000
}
```

设置页新增：请求方法下拉、请求头输入框、自定义请求体文本域（带变量说明 + 恢复默认）、
超时输入框。请求头与模板都做 JSON 合法性校验，**不合法只提示、不阻止输入**；
请求头解析失败时存 `{}`，避免把坏字符串发给后端。

## 3. 模板语法

变量插值按**所在位置**区分处理 —— 这是本设计的关键：

| 位置 | 行为 | 例子 |
|---|---|---|
| JSON 字符串内 | 转义后插入（引号/换行不会撑破 JSON） | `{"content": "告警：{{alert_title}}"}` |
| JSON 结构位置 | 插入原始 JSON 值 | `{"evidence": {{alert_evidence}}, "count": {{alert_count}}}` |
| 纯文本模板 | 裸文本插入（不会多出引号） | `hello {{alert_title}}` |

### 可用变量

| 变量 | 含义 |
|---|---|
| `{{alert_title}}` | 告警标题（规则名；无对应规则时为告警类型） |
| `{{alert_detail}}` | 告警详情（description） |
| `{{alert_summary}}` | 告警摘要（summary） |
| `{{alert_type}}` | 告警类型标识（如 `high_packet_loss`） |
| `{{alert_key}}` | 告警键（如 `high_packet_loss:starlink`） |
| `{{alert_severity}}` | 严重级别（info / warning / critical） |
| `{{alert_status}}` | 状态（firing / resolved） |
| `{{alert_time}}` | 最近一次时间（ISO 8601） |
| `{{alert_first_seen}}` | 首次出现时间（ISO 8601） |
| `{{alert_count}}` | 累计触发次数 |
| `{{alert_duration}}` | 持续时长（仅已恢复的告警有值） |
| `{{alert_recommendations}}` | 处理建议（数组） |
| `{{alert_evidence}}` | 告警证据（对象） |

未定义的变量会被替换为空并记进 `unknownVars`（并在日志里 warn 一条）——
宁可少一个字段，也不要往接收端发一个带 `{{xxx}}` 的半成品。

### 默认模板

保留旧版 webhook 的**全部字段名**（`alert_type` / `severity` / `status` /
`timestamp` / `summary` / `description` / `occurrence_count` / `first_seen` /
`last_seen` / `duration` / `recommendations` / `evidence`），老用户升级后
接收端不用改。

## 4. 发送逻辑

- **POST**：渲染结果作为请求体。内容能解析成 JSON ⇒ `Content-Type: application/json`；
  否则 `text/plain; charset=utf-8`（允许用户写纯文本负载）。
- **GET**：渲染结果若是 JSON ⇒ 摊平成查询参数追加到 URL
  （数组展开成重复参数 `k=1&k=2`，对象用 `a[b]` 形式），**URL 上原有的查询参数保留**；
  非 JSON ⇒ 整段作为一个 `payload` 参数。
- **超时**：`AbortController` + 定时器（不用 `AbortSignal.timeout`，兼容性更好），
  默认 5000ms，可配。
- **容错**：目标 4xx/5xx、连接被拒、超时 —— **全部只记日志，绝不抛异常**。
  webhook 挂了不能影响告警流程，更不能让主进程崩。
- **本地错误日志**：失败同时写 `userData/webhook-errors.log`（终端也留一份）。
  写文件本身失败也忽略 —— 记日志不能变成新的故障源。

## 5. 测试

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `src/alerting/webhookTemplate.test.ts` | 18 | 插值转义、结构位置、纯文本、未定义变量、GET/POST 构造、查询参数摊平、默认模板字段兼容 |
| `src/alerting/notifier.webhook.test.ts` | 9 | 按配置发送、GET 无 body、鉴权头、4xx/5xx/连接失败/超时都不抛、未定义变量只 warn、evidence/recs 以对象数组进入请求体 |

## 6. 真机端到端

把 SLMonitor 的 webhook 指向 DishyMock 自带的接收端（`127.0.0.1:9205`），
用 mock 场景触发真实告警，再从 mock 的 `GET /api/notify-mocks` 读回**实际收到的请求**，
逐字段核对插值结果与 HTTP 方法/路径/请求头。

## 7. 已知限制

- `{{alert_title}}` 用的是**主进程**能拿到的标题（规则中文名 / 告警类型），
  不是界面当前语言下的本地化标题 —— 主进程不知道用户选了哪种语言。
  需要本地化标题的接收端应改用 `{{alert_summary}}`（主进程原文，中文）。
- 载荷模板不支持条件/循环表达式（保持"极简"的取舍）；需要复杂逻辑时用 n8n 这类
  流程工具中转。
- `GET` 模式下若负载是 JSON，嵌套对象会摊平成 `a[b]=c` 形式（`URLSearchParams`
  的通用约定），接收端需按这个约定解析。
