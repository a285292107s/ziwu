/**
 * 站点图标的持久化缓存。
 *
 * ## 为什么需要它
 *
 * 磁贴的图标来自 MV3 的 `/_favicon/` 接口，而那是**页面级**资源：
 * 每开一个新标签页就是一次全新的页面加载，浏览器要重新发一轮请求、
 * 图片要重新解码，`useFavicon.ts` 还要再跑一次 canvas 指纹判定。
 * 模块级 Map 缓存在这个场景里等于没有 —— 它随页面一起销毁。
 * 用户看到的就是「每次打开新标签页，图标都要重新加载」。
 *
 * ## 为什么是 localStorage，不是 chrome.storage.local
 *
 * 磁贴必须在**首帧**就拿到图标，晚一帧就会先闪一下首字母再跳成图标。
 * `chrome.storage.local` 是异步的（同一原因的详细说明见 `logic/themeBoot.ts`），
 * 而 localStorage 是同步的，在 chrome-extension:// 下四个页面共享同一份，
 * 而且跨浏览器重启还在。这里只需要一个「同步读得到的小字典」。
 *
 * ## 存什么
 *
 * 存**图标字节本身**（data: URL），而不是「这个站有没有图标」的布尔值：
 * 只存布尔值的话，显示时仍然得去 `/_favicon/` 取图，等于没缓存。
 *
 * 条目为 `{ data?, at }`：
 * - `data` 是 data: URL → 该站点有真实图标，直接显示，不发任何请求；
 * - `data` 缺省 → 已判定为占位图（灰地球），走首字母，连探针都不用发；
 * - `at` 是写入时间戳，超过保鲜期的条目先用旧结论、再在后台重新验证。
 *
 * ## 坏掉也要能用
 *
 * 隐私设置 / 企业策略下 localStorage 可能直接抛异常，配额也可能写满。
 * 这些情况一律**静默降级**：缓存是锦上添花，坏了不该让磁贴或页面报错。
 */

/**
 * localStorage 键名。
 * 改键名等于让所有已缓存图标失效一次（下次开新标签页会重新拉一轮），
 * 所以要动它就得当成一次数据迁移来对待。
 */
export const FAVICON_CACHE_KEY = 'meridiem-favicon-cache-v1'

/** 真图标的保鲜期：过期后先照显旧图，再在后台重新验证一次 */
export const FAVICON_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

/**
 * 「这个站点没有图标」这个**否定结论**的保鲜期，比真图标短得多。
 *
 * 否定的结论是**关于 Chrome 图标库当下状态**的猜测，而那个状态会变：
 * 用户去访问了站点、Chrome 后来自己抓到了图标，缓存的否定就过时了；
 * 刚装好扩展、图标库还是冷的时候更容易一次判错一大片。
 * 6 小时足够覆盖「连着开一堆新标签页」的真实场景（这段时间零请求），
 * 又不会把一个过期的否定压太久。
 */
export const FAVICON_MISS_TTL = 6 * 60 * 60 * 1000

/** 条目数上限，超出按时间淘汰最旧的 */
const MAX_ENTRIES = 200

/**
 * 单张图标的 data: URL 长度上限。
 * 正常 64px 图标是 1.6–2.5KB；异常大的直接不缓存，避免一条把整个缓存撑爆。
 */
const MAX_DATA_LENGTH = 64 * 1024

/**
 * 整份缓存的总字节预算。
 *
 * 只有条目数上限是不够的：200 × 64KB = 12.8MB，远超 localStorage 的 ~5MB 配额，
 * 真撞上去每次写入都会失败、再触发「砍一半重试」的同步序列化，磁贴会卡。
 * 这里按总字节数兜住，超了就从最旧的开始丢。
 * 真实占用是「十几个磁贴 × 2KB ≈ 几十 KB」，256KB 有足够余量。
 */
const MAX_TOTAL_BYTES = 256 * 1024

/** 一条缓存。`data` 缺省 = 该站点没有真实图标 */
export interface FaviconCacheEntry {
  data?: string
  at: number
}

export interface FaviconCacheHit {
  entry: FaviconCacheEntry
  /**
   * 是否还在保鲜期内。
   * false 表示调用方应当联网重验一次（但**不必**先清掉界面上的旧图）。
   */
  fresh: boolean
}

type CacheRecord = Record<string, FaviconCacheEntry>

/**
 * 解析后的镜像。
 * localStorage 只在首次用到时同步读一次，之后全走内存，
 * 否则一屏 12 个磁贴就要把同一份 JSON 解析 12 遍。
 *
 * 本页面自己写缓存时会同步更新它，所以同一次页面加载内不会读到脏数据。
 * 别的页面（设置页 / 侧边栏）改了缓存对本页不可见 —— 无妨，本页只在
 * 加载那一刻读缓存，之后图标就不再依赖它了。
 */
let mirror: CacheRecord | null = null

/** 取 localStorage；不可用时返回 null（隐私模式 / 非页面上下文） */
function faviconStore(): Storage | null {
  try {
    if (typeof localStorage === 'undefined')
      return null
    return localStorage
  }
  catch {
    // 某些隐私设置下**访问** localStorage 这个属性本身就会抛
    return null
  }
}

/**
 * 校验单条缓存。
 * storage 可能被手改、也可能写到一半崩掉，脏数据一律当不存在，
 * 让下一次写入把它覆盖掉。
 */
function sanitizeEntry(value: unknown): FaviconCacheEntry | null {
  if (!value || typeof value !== 'object')
    return null

  const { data, at } = value as { data?: unknown, at?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at))
    return null

  // 缺 data = 「该站点没有图标」的结论，合法
  if (data === undefined)
    return { at }

  if (typeof data !== 'string' || !isUsableIconData(data))
    return null

  return { data, at }
}

/** 能不能拿这个字符串当图标用（也是入库前的把关） */
function isUsableIconData(data: string): boolean {
  return data.startsWith('data:image/') && data.length <= MAX_DATA_LENGTH
}

/**
 * 站点地址 → 缓存键。
 *
 * 用**站点源**（scheme://host:port）而不是完整地址：`/_favicon/` 自己就是
 * 按站点解析图标的，同一站点下不同路径拿到的是同一张图。
 * 不这么做的话，`github.com` 和 `github.com/issues` 会各存一份同样的字节。
 */
function faviconCacheKey(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    return url.origin
  }
  catch {
    return null
  }
}

/** 解析一份原始 JSON；脏数据一律过滤掉（storage 可能被手改、也可能写到一半崩掉） */
function parseRecord(raw: string | null): CacheRecord {
  const out: CacheRecord = {}

  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = sanitizeEntry(value)
        if (entry)
          out[key] = entry
      }
    }
  }
  catch {
    // 非法 JSON：当作空缓存，下一次写入会把它覆盖掉
  }

  return out
}

function loadMirror(): CacheRecord {
  if (mirror)
    return mirror

  const store = faviconStore()
  mirror = store ? parseRecord(store.getItem(FAVICON_CACHE_KEY)) : {}

  return mirror
}

/** 按「条目数 + 总字节」双重上限淘汰：先丢最旧的 */
function trim(record: CacheRecord): CacheRecord {
  const entries = Object.entries(record)
    .sort((a, b) => b[1].at - a[1].at)

  const kept: CacheRecord = {}
  let bytes = 2 // JSON 里的 "{}"
  let count = 0

  for (const [key, entry] of entries) {
    if (count >= MAX_ENTRIES)
      break

    // 估算这条在 JSON 里占多少：键 + data + 引号/花括号/at 的固定开销
    const size = key.length + (entry.data?.length ?? 0) + 32
    // 至少保住一条：哪怕单条就超预算，也不该把缓存清成空的
    if (count > 0 && bytes + size > MAX_TOTAL_BYTES)
      break

    kept[key] = entry
    bytes += size
    count++
  }

  return kept
}

function storeRecord(store: Storage, record: CacheRecord): boolean {
  try {
    store.setItem(FAVICON_CACHE_KEY, JSON.stringify(record))
    return true
  }
  catch {
    // QuotaExceededError / 隐私模式：写不进去不算错误，只是这次没缓存成
    return false
  }
}

/**
 * 落盘。写不进去时砍掉最旧的一半再试一次；仍然失败就只留在内存里 ——
 * 图标本身照常显示，只是这次没能缓存下来，下次开新标签页再试。
 */
function flush(record: CacheRecord): void {
  const store = faviconStore()
  let next = trim(record)

  if (store && !storeRecord(store, next)) {
    const sorted = Object.entries(next).sort((a, b) => b[1].at - a[1].at)
    next = Object.fromEntries(sorted.slice(0, Math.max(1, sorted.length >> 1)))
    storeRecord(store, next)
  }

  mirror = next
}

/**
 * 把一次改动**合并**进缓存并落盘。
 *
 * 关键是每次写入前都重新从 storage 读一遍，而不是拿本页加载时那份内存镜像
 * 整份覆盖：每开一个新标签页就是一个独立的扩展页面（newtab / 侧边栏 / 设置页
 * 都会渲染磁贴），各有各的镜像。两个页面同时判定图标时，后写的那个若拿旧镜像
 * 覆盖，就会把另一个页面刚写进去的真图标抹掉 —— 和「否定覆盖真图标」是同一类
 * 事故，只是发生在页面之间。多开几个新标签页（或会话恢复一次拉起好几个）就能碰上。
 *
 * 重读 + 同步写把竞态窗口从「整个页面生命周期」缩到「一次同步读写的间隙」。
 */
function commit(mutate: (record: CacheRecord) => void): void {
  const store = faviconStore()
  const base = store ? parseRecord(store.getItem(FAVICON_CACHE_KEY)) : { ...loadMirror() }
  mutate(base)
  flush(base)
}

/**
 * 读一条缓存，没命中返回 null。
 *
 * **同步**返回 —— 这正是整个缓存存在的意义：磁贴要在首帧就拿到图标，
 * 不能等异步 storage。
 */
export function readFaviconCache(pageUrl: string): FaviconCacheHit | null {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return null

  const entry = loadMirror()[key]
  if (!entry)
    return null

  const ttl = entry.data ? FAVICON_CACHE_TTL : FAVICON_MISS_TTL
  const age = Date.now() - entry.at

  // age < 0（系统时钟被往回调过）也当过期：否则这条会「永远新鲜」，再也不会被重验
  return { entry, fresh: age >= 0 && age < ttl }
}

/**
 * 丢掉一条缓存。
 *
 * 用在「缓存里那条图标实际上显示不出来」的时候（见 `ShortcutTile` 的 `<img>` 兜底）：
 * 只有把它删掉，页面才能立刻退回首字母，并且下次打开会重新判定一次。
 *
 * 不能靠 `writeFaviconCache(url)` 达成同样效果 —— 那条路径刻意不允许
 * 「没图标」覆盖已有图标（见那里的说明），而这里要丢掉的恰恰是一条带 data 的坏条目。
 */
export function dropFaviconCache(pageUrl: string): void {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return

  commit((record) => {
    delete record[key]
  })
}

/**
 * 写入一条缓存。
 *
 * `data` 传 undefined 表示「这个站点没有真实图标」：下次直接走首字母，
 * 连占位图探针都不用发。
 */
export function writeFaviconCache(pageUrl: string, data?: string): void {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return

  // 超长 / 非图片的 data: URL 不缓存，免得一条脏数据毁掉整份缓存
  if (data !== undefined && !isUsableIconData(data))
    return

  const at = Date.now()

  commit((record) => {
    // 「没图标」的结论**不能覆盖已经拿到的真图标**。
    //
    // 缓存键是站点源，而 Chrome 是按**具体页面地址**解析图标的：同一个 origin 下
    // `https://github.com/` 有图标，`https://github.com/explore` 却可能返回占位图。
    // 让后者把前者覆盖掉，用户会看到本来好好的图标退成首字母，而且要等否定结论
    // 过期（6 小时）才可能恢复。两个方向都收敛到「有图标」这一边：
    // 先写否定、后写真图标时，真图标照常覆盖；先写真图标、后写否定时，否定被丢掉。
    //
    // 这条判断必须落在**刚重读出来的最新状态**上，否则另一个页面刚写进去的
    // 真图标会被本页的旧认知当成「没有」。
    if (data === undefined && record[key]?.data)
      return

    record[key] = data === undefined ? { at } : { data, at }
  })
}
