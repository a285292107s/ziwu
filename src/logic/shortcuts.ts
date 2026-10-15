/**
 * 快捷方式（图标磁贴）的纯逻辑。
 *
 * 与 `searchEngines.ts` 一样，这里不依赖 Vue / storage / `browser`，
 * 只做数据变换，方便单元测试直接引入。
 */
import { DEFAULT_SITES } from './defaultSites'

export interface Shortcut {
  /** 稳定唯一标识 */
  id: string
  /** 磁贴上显示的名称 */
  name: string
  /** 目标地址，始终为绝对 URL */
  url: string
}

/** 生成 id：优先用 crypto.randomUUID，缺失时降级（非安全上下文/测试环境） */
export function createId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function')
    return c.randomUUID()

  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 把用户输入整理成绝对 URL。
 *
 * - `example.com` → `https://example.com`
 * - `localhost:3000` → `http://localhost:3000`（本地开发用 http 更符合直觉）
 * - 非法输入返回 `null`，由调用方给出校验提示
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw)
    return null

  // 判断用户是否写了协议。
  // 注意 `localhost:3000` / `example.com:8080` 里冒号后面只有端口号，
  // 那是 host:port 而不是协议，不能当成 `localhost:` 协议处理。
  const schemeMatch = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i.exec(raw)
  if (schemeMatch) {
    const [, scheme, rest] = schemeMatch
    const looksLikePort = /^\d+(?:\/|$)/.test(rest)

    if (!looksLikePort) {
      // 真协议：只放行 http/https，挡掉 javascript: / data: 之类的危险协议
      if (scheme.toLowerCase() !== 'http' && scheme.toLowerCase() !== 'https')
        return null

      try {
        return new URL(raw).href
      }
      catch {
        return null
      }
    }
  }

  // 没写协议（或只是 host:port）：本地地址用 http，其余默认 https
  const hostPart = raw.split('/')[0]
  const isLocal = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(hostPart)
  const candidate = `${isLocal ? 'http' : 'https'}://${raw}`

  try {
    const parsed = new URL(candidate)
    // 必须有主机名，且必须含点号或是本地地址（挡掉 "hello" 这类输入）
    if (!parsed.hostname)
      return null
    if (!isLocal && !parsed.hostname.includes('.'))
      return null

    return parsed.href
  }
  catch {
    return null
  }
}

/** 取域名用于展示，去掉 `www.` 前缀 */
export function shortcutDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  }
  catch {
    return url
  }
}

/**
 * 用浏览器内置的 favicon 取图标（MV3 的 `_favicon` 接口，需要 `favicon` 权限）。
 * 拿不到扩展上下文时返回 `null`，调用方回退到首字母磁贴。
 */
export function faviconUrl(pageUrl: string, size = 64): string | null {
  try {
    const api = (globalThis as {
      browser?: { runtime?: { getURL?: (path: string) => string } }
      chrome?: { runtime?: { getURL?: (path: string) => string } }
    }).browser ?? (globalThis as {
      chrome?: { runtime?: { getURL?: (path: string) => string } }
    }).chrome

    const getURL = api?.runtime?.getURL
    if (typeof getURL !== 'function')
      return null

    const target = new URL(pageUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:')
      return null

    return `${getURL('/_favicon/')}?pageUrl=${encodeURIComponent(target.href)}&size=${size}`
  }
  catch {
    return null
  }
}

/**
 * 一个保证不存在的域名，用来标定 `/_favicon/` 的通用占位图。
 * 详见 `composables/useFavicon.ts` 里对占位图问题的说明。
 */
export const FAVICON_PROBE_URL = 'https://meridiem-favicon-probe.invalid/'

/**
 * 首字母回退用的配色（浅色主题）。
 *
 * 选用原则：
 * 1. **明度锁在同一个窄区间**，全部配白字可达 WCAG AA，最低实测 4.53:1，
 *    高于正文门槛 4.5:1。单个色值逐个算过，不靠感觉。
 * 2. **饱和度比 Tailwind 默认色阶低一档**。这套色是站点识别线索，
 *    不是页面装饰：页面本身只有一个强调色（青），磁贴如果一排水彩，
 *    整页的调性会被这排小方块拖走。
 * 3. 数量要够多。只有 8 色时「知乎」和「哔哩哔哩」会撞成同一个粉色，
 *    一排磁贴里出现两个同色，看起来像重复项。16 色后撞色概率明显下降。
 *
 * 注意：颜色由域名哈希决定，所以同一个站点永远是同一个颜色
 * （排序、增删都不会变色）。这是刻意的：颜色是识别线索，不该随机跳。
 */
export const SHORTCUT_ACCENTS = [
  '#0f766e', // teal
  '#2563a8', // blue
  '#6d4bb5', // violet
  '#a83a74', // magenta
  '#b3392f', // red
  '#a55a26', // orange
  '#8d7318', // amber
  '#2d7a44', // green
  '#1e6a86', // cyan
  '#3f4fbb', // indigo
  '#8b3f9e', // purple
  '#b03a8f', // fuchsia
  '#a63a54', // rose
  '#8a5a3b', // brown
  '#196f56', // emerald
  '#465a73', // slate
] as const

/**
 * 首字母回退配色（深色主题）。
 *
 * 深色下不能直接用上面那套：颜色压在深背景上会糊成一团，
 * 而且白字压在深色底上会让整块磁贴「陷进去」。
 * 这里换成同色系的高明度版本，配深色文字（--text-on-accent），
 * 每一色对磁贴底色的对比度都 ≥ 6.0:1。
 *
 * **下标必须与 SHORTCUT_ACCENTS 一一对应**：同一个站点在切换主题时
 * 要留在同一个色系里，只是明暗翻转，而不是换一个颜色。
 */
export const SHORTCUT_ACCENTS_DARK = [
  '#2dd4bf', // teal
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#f472b6', // magenta
  '#f87171', // red
  '#fb923c', // orange
  '#fbbf24', // amber
  '#4ade80', // green
  '#38bdf8', // cyan
  '#818cf8', // indigo
  '#c084fc', // purple
  '#e879f9', // fuchsia
  '#fda4af', // rose
  '#c9a27a', // brown
  '#34d399', // emerald
  '#94a3b8', // slate
] as const

/** 由字符串稳定地派生一个下标（同一个域名永远同一个颜色） */
function hashSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0

  return hash
}

/** 取磁贴回退配色：优先按域名，域名缺失时按名称 */
export function shortcutAccent(seed: string): string {
  return SHORTCUT_ACCENTS[hashSeed(seed) % SHORTCUT_ACCENTS.length]
}

/**
 * 为一组磁贴分配配色，保证**同一屏内不撞色**。
 *
 * 单看哈希会撞色（实测「知乎」和「哔哩哔哩」都落到同一个粉色，
 * 4 个磁贴里有 2 个同色，看起来像重复项）。这里按列表顺序做线性探测：
 * 从哈希位置开始往后找第一个没用过的颜色。
 *
 * 代价要说清楚：**没有撞色的磁贴颜色永远稳定**（比如 GitHub 一直是同一个色），
 * 只有发生撞色的那个才会被顺延到下一个颜色。所以增删/排序可能让
 * 「撞色过的那一个」变色。这个取舍是有意的：一屏内出现两个同色磁贴，
 * 比偶尔换一次颜色更像 bug。
 *
 * 颜色数不够时（磁贴数 > 调色板）允许绕回重复。
 */
export function assignShortcutAccents(seeds: string[], dark = false): string[] {
  const palette: readonly string[] = dark ? SHORTCUT_ACCENTS_DARK : SHORTCUT_ACCENTS
  const size = palette.length
  const used = new Set<number>()
  const out: string[] = []

  for (const seed of seeds) {
    let index = hashSeed(seed) % size

    // 最多绕一圈找空位；全被占满就接受重复
    for (let step = 0; step < size; step++) {
      const candidate = (index + step) % size
      if (!used.has(candidate)) {
        index = candidate
        break
      }
    }

    used.add(index)
    out.push(palette[index])
  }

  return out
}

/** 回退磁贴上显示的字：取名称首个「有意义的」字符（跳过 emoji 与空白） */
export function shortcutInitial(name: string, url: string): string {
  const source = (name || shortcutDomain(url) || '?').trim()
  if (!source)
    return '?'

  // 用 Array.from 按码点切，避免把 emoji 切成半个字符
  const chars = Array.from(source)
  const first = chars.find(char => /[\p{L}\p{N}]/u.test(char))

  return (first ?? chars[0] ?? '?').toUpperCase()
}

/** 依据名称与地址生成一条新记录 */
export function createShortcut(name: string, rawUrl: string): Shortcut | null {
  const url = normalizeUrl(rawUrl)
  if (!url)
    return null

  return {
    id: createId(),
    name: name.trim() || shortcutDomain(url),
    url,
  }
}

/**
 * 校验从 storage 读回的数据。
 * 用户可能手改过 storage，或旧版本留下脏数据，这里全部过滤掉。
 */
export function sanitizeShortcuts(raw: unknown): Shortcut[] {
  if (!Array.isArray(raw))
    return []

  const out: Shortcut[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (!item || typeof item !== 'object')
      continue

    const { id, name, url } = item as Partial<Shortcut>
    if (typeof url !== 'string')
      continue

    const safeUrl = normalizeUrl(url)
    if (!safeUrl)
      continue

    // 地址去重，避免同一站点出现两次
    const dedupeKey = safeUrl.replace(/\/$/, '')
    if (seen.has(dedupeKey))
      continue
    seen.add(dedupeKey)

    out.push({
      id: typeof id === 'string' && id ? id : createId(),
      name: typeof name === 'string' && name.trim() ? name.trim() : shortcutDomain(safeUrl),
      url: safeUrl,
    })
  }

  return out
}

/** 把 `from` 位置的元素移动到 `to` 位置，返回新数组（不修改入参） */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length)
    return next

  const clamped = Math.max(0, Math.min(next.length - 1, to))
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)

  return next
}

/**
 * 首次使用时预置的站点。
 *
 * 清单来自 `defaultSites.ts`，只有与个人无关的公共站点，顺序就是磁贴顺序。
 *
 * 注意这个函数**只在 storage 里没有 `meridiem-shortcuts` 键时生效一次**
 * （见 `storage.ts` 里的 `mergeDefaults: false`）：
 * 已经装过、storage 里有值的实例永远读不到这里，也不会被它覆盖。
 * 个人站点通过设置页的「粘贴配置导入」写进 storage，不经过这个函数。
 */
export function defaultShortcuts(): Shortcut[] {
  return DEFAULT_SITES
    .map(site => createShortcut(site.name, site.url))
    .filter((item): item is Shortcut => item !== null)
}
