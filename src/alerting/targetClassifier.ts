/**
 * 外发目标分类：这条通知走**内网通道**还是**公网通道**。
 *
 * ## 为什么必须分类
 *
 * 星链本身可能断网 —— 但家里的局域网往往还通着（本地 webhook、
 * Home Assistant 都在内网）。断网时把"发不出去"的消息丢掉是错的；
 * 反过来，把公网通道也当成内网硬发，会让用户长时间等一个永远发不出去的请求。
 *
 * 所以：
 * - **内网目标**（192.168.x.x / 10.x.x.x / 172.16-31.x.x / localhost / *.local /
 *   无点的裸主机名）⇒ **无视公网连通性，立刻全速发**，不做任何网络前置校验。
 * - **公网目标**（Telegram、Email 的公网 SMTP、公网 webhook）⇒ 发送前要探测
 *   底层网络：没外网就直接进离线队列，不做无谓的尝试。
 */

/** 通道种类 */
export type ChannelKind = 'telegram' | 'email' | 'webhook';

/** 目标的可达域 */
export type TargetScope = 'lan' | 'public';

/** 一个外发目标的分类结果 */
export interface ClassifiedTarget {
  kind: ChannelKind;
  /** 目标主机（URL 主机名 / SMTP 主机） */
  host: string;
  scope: TargetScope;
  /** 判定依据（便于排查与日志） */
  reason: string;
}

/** RFC1918 私有网段（IPv4） */
const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^10\./, // 10.0.0.0/8
  /^192\.168\./, // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
];

/** 明确属于本机 / 内网的其它情形 */
const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

/**
 * 判断一个主机名是否属于内网。
 *
 * @param host 主机名或 IP（不带协议、不带端口、不带路径）
 */
export function isLanHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;

  // IPv6 本机回环
  if (h === '::1') return true;
  // IPv6 唯一本地地址 fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;

  // 本机回环
  if (h === '127.0.0.1' || h.startsWith('127.')) return true;

  // 明确列出的本机名
  if (LOCAL_HOSTNAMES.has(h)) return true;

  // RFC1918 私有网段
  if (PRIVATE_IPV4_PATTERNS.some((re) => re.test(h))) return true;

  // mDNS 名字
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;

  // 裸主机名（没有点）几乎一定是内网服务：homeassistant、nas、ha 等
  // 带点的才是公网域名（example.com）
  if (!h.includes('.')) return true;

  return false;
}

/**
 * 从 URL 里取出主机名。
 *
 * 解析失败就退回"取 // 后面的 host:port"这一层手工解析 —— 配置里的 URL
 * 是用户手写的，可能不合法，但**不能因为解析失败就当成公网**（那会让内网
 * webhook 在断网时被错误地丢进队列）。
 */
export function hostFromUrl(url: string): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (m?.[1]) {
      const authority = m[1];
      // 去掉用户信息与端口
      const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
      return hostPort.replace(/:\d+$/, '');
    }
    // 没有协议头的写法（'192.168.1.10:8123/hook'）—— 同样要能取出主机名
    const bare = raw.match(/^([^/?#]+)/);
    if (bare?.[1]) {
      const authority = bare[1].includes('@')
        ? bare[1].slice(bare[1].lastIndexOf('@') + 1)
        : bare[1];
      // 'host:port' 里的冒号后面必须是端口数字；否则说明这是协议头残骸
      // （如 'http://'），返回空而不是把 'http:' 当成主机名
      const portMatch = authority.match(/^(.*):(\d+)$/);
      if (!portMatch && authority.includes(':')) return '';
      return (portMatch ? portMatch[1] : authority).replace(/:\d+$/, '');
    }
    return '';
  }
}

/** 从 "user:pass@host:port" 里取主机名 */
export function hostFromSmtpAddress(address: string): string {
  const raw = (address ?? '').trim();
  if (!raw) return '';
  const withoutUser = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw;
  return withoutUser.replace(/:\d+$/, '');
}

/**
 * 分类一个外发目标。
 *
 * @param kind 通道种类
 * @param host 目标主机（webhook 用 URL 解析，email 用 SMTP 主机）
 */
export function classifyTarget(kind: ChannelKind, host: string): ClassifiedTarget {
  const h = (host ?? '').trim().toLowerCase();

  // Telegram 的 API 永远是公网，没有例外
  if (kind === 'telegram') {
    return { kind, host: h, scope: 'public', reason: 'telegram-api-恒为公网' };
  }

  if (!h) {
    // 没填地址：按公网处理（发送必然失败，交给队列兜住）
    return { kind, host: h, scope: 'public', reason: '未配置目标地址' };
  }

  if (isLanHost(h)) {
    return { kind, host: h, scope: 'lan', reason: `内网地址 ${h}` };
  }
  return { kind, host: h, scope: 'public', reason: `公网地址 ${h}` };
}
