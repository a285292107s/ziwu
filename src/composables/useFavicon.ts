import { ref } from 'vue'
import { dropFaviconCache, readFaviconCache, writeFaviconCache } from '~/logic/faviconCache'
import { FAVICON_PROBE_URL, faviconUrl } from '~/logic/shortcuts'

/**
 * 站点图标解析（带持久缓存）。
 *
 * ## 为什么要这么麻烦
 *
 * MV3 提供了 `chrome://favicon` 的替代品 `/_favicon/`，但它有个坑：
 * **对「Chrome 缓存里没有图标的站点」，它返回的是一张通用的灰色地球占位图，
 * 而不是 404**。于是 <img> 的 onerror 永远不触发，
 * 用户会看到一排一模一样的地球，比首字母磁贴难看得多。
 *
 * 做法：用一个肯定不存在的域名去要一次图标，拿到那张占位图的像素指纹；
 * 之后每个站点都算一次指纹跟它比对，相同就判定为占位图 → 回退到首字母。
 * 指纹是运行时标定的，所以换了 Chrome 版本 / 平台也不会失效。
 *
 * canvas 能读像素是因为 `/_favicon/` 与扩展页面同源；一旦被跨域污染（理论上不会），
 * 这里会捕获异常并按「不可信」处理，直接走首字母回退。
 *
 * ## 缓存（为什么以前每次开新标签页都要重来）
 *
 * `/_favicon/` 是**页面级**资源：每开一个新标签页就是一次全新的页面加载，
 * 上面那套「发请求 → 解码 → 算指纹」就要从头再跑一遍。模块级 Map 随页面销毁，
 * 所以它在真实场景里什么都没缓存住。
 *
 * 现在判定结果连同**图标字节本身**一起落到 `logic/faviconCache.ts`：
 *
 * - 命中且没过保鲜期 → 同步用缓存里的 data: URL，**零请求**，首帧就是真图标；
 * - 命中但过期 → 先用旧图立刻显示，再在后台重新验证（过期不影响观感）；
 * - 没命中 → 走上面的探针判定，判定完写缓存（第一次打开还是老样子）。
 */

/** 占位图的像素指纹；null 表示尚未标定或标定失败 */
let placeholderHash: string | null = null
let calibrating: Promise<string | null> | null = null

/**
 * 同一次页面加载内正在进行的图标加载，按图标地址去重。
 * 两个磁贴指向同一站点、或者地址被编辑后立刻重新解析时，
 * 不该把同一张图加载两遍。
 */
const inFlight = new Map<string, Promise<LoadResult>>()

/** 一次判定的结论 */
type LoadResult =
  /** 有真实图标；`data` 为 null 表示这次没能转成 data: URL（照常显示，只是不缓存） */
  | { kind: 'icon', data: string | null }
  /** 没有真实图标（取不到 / 几乎全透明 / 就是占位图）→ 首字母 */
  | { kind: 'monogram' }

interface Fingerprint {
  hash: string
  /** 不透明像素占比 0~1，用来识别「几乎空白」的图 */
  opaque: number
  /** 图标字节本身，判定通过后直接进缓存 */
  dataUrl: string | null
}

/**
 * 把加载好的图标重新编码成 data: URL。
 * 缓存里存的是这张图 —— 下次开新标签页直接用它，不用再问 `/_favicon/` 要。
 */
function toDataUrl(img: HTMLImageElement): string | null {
  try {
    // 按原尺寸存（接口要的是 64，取不到时会退回更小的尺寸）
    const size = Math.max(1, Math.min(64, img.naturalWidth || 64))
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx)
      return null

    ctx.drawImage(img, 0, 0, size, size)
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}

/**
 * 取一张图片的 32x32 像素指纹。
 * 同时返回非透明像素比例，用来识别「几乎空白」的图。
 */
function fingerprint(url: string): Promise<Fingerprint | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }

        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        let hash = 2166136261
        let opaque = 0
        for (let i = 0; i < data.length; i++) {
          hash ^= data[i]
          hash = Math.imul(hash, 16777619)
          if (i % 4 === 3 && data[i] > 10)
            opaque++
        }
        resolve({
          hash: (hash >>> 0).toString(16),
          opaque: opaque / 1024,
          dataUrl: toDataUrl(img),
        })
      }
      catch {
        // canvas 被污染或读取失败 → 视为不可信
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** 标定占位图指纹（整个页面生命周期只做一次） */
function calibrate(probeUrl: string): Promise<string | null> {
  if (placeholderHash !== null)
    return Promise.resolve(placeholderHash)
  if (calibrating)
    return calibrating

  calibrating = fingerprint(probeUrl).then((result) => {
    placeholderHash = result?.hash ?? null
    return placeholderHash
  })

  return calibrating
}

/**
 * 加载并判定某个站点的图标。
 * 两个参数都必须是**已经拼好的 `/_favicon/` 图标地址**（用 `faviconUrl()` 生成）。
 */
function loadFavicon(iconUrl: string, probeIconUrl: string): Promise<LoadResult> {
  const running = inFlight.get(iconUrl)
  if (running)
    return running

  const task = (async (): Promise<LoadResult> => {
    const [probe, actual] = await Promise.all([
      calibrate(probeIconUrl),
      fingerprint(iconUrl),
    ])

    // 图加载不出来 → 用首字母
    if (!actual)
      return { kind: 'monogram' }

    // 几乎全透明 → 用首字母
    if (actual.opaque < 0.02)
      return { kind: 'monogram' }

    // 与占位图指纹相同 → 用首字母
    if (probe && actual.hash === probe)
      return { kind: 'monogram' }

    return { kind: 'icon', data: actual.dataUrl }
  })().finally(() => {
    inFlight.delete(iconUrl)
  })

  inFlight.set(iconUrl, task)

  return task
}

/**
 * 组件用的封装：给一个**站点地址**，返回图标状态。
 *
 * 刻意只收站点地址、由内部去拼 `/_favicon/` 地址：
 * 之前把「站点地址」和「图标地址」两个参数并排放，结果标定探针时误传了站点地址，
 * 标定静默失败、检测形同虚设（占位地球照旧显示）。收窄成单一入参就不会再错。
 *
 * `iconSrc` 可能是 `data:`（来自缓存或刚算出）或 `/_favicon/` 地址（没缓存住的兜底）。
 * 初始值是 false + null：宁可先显示首字母，也不要先闪一下灰色地球 ——
 * 但**命中缓存时 `resolve()` 会在 setup 里同步把它改掉**，所以首帧就是真图标。
 */
export function useRealFavicon(pageUrl: () => string | null) {
  const showIcon = ref(false)
  const iconSrc = ref<string | null>(null)

  /**
   * 用持久缓存同步定下状态；只有需要联网重验时才返回一个真有工作的 promise。
   *
   * 同步这一下很关键：Vue 的首次渲染发生在本 tick 之后，所以在这里同步读缓存，
   * 首帧拿到的就是图标，不会出现「先首字母、再跳成图标」。
   */
  function resolve(): Promise<void> {
    const target = pageUrl()

    if (!target) {
      showIcon.value = false
      iconSrc.value = null
      return Promise.resolve()
    }

    const hit = readFaviconCache(target)
    if (hit) {
      // 过期的也照显：旧图比首字母更接近真相，联网重验在后台做
      showIcon.value = !!hit.entry.data
      iconSrc.value = hit.entry.data ?? null
      if (hit.fresh)
        return Promise.resolve()
    }
    else {
      // 从没缓存过：先首字母，等判定结果
      showIcon.value = false
      iconSrc.value = null
    }

    return load(target)
  }

  /** 联网重验 / 首次判定 */
  async function load(target: string): Promise<void> {
    const probeIcon = faviconUrl(FAVICON_PROBE_URL, 64)
    const icon = faviconUrl(target, 64)
    if (!probeIcon || !icon)
      return

    const result = await loadFavicon(icon, probeIcon)

    // 等结果的这段时间里地址被改过（设置页里编辑磁贴）→ 丢弃，
    // 否则会把上一个站点的图标贴到新地址上。
    if (pageUrl() !== target)
      return

    if (result.kind === 'icon') {
      showIcon.value = true
      // 转不成 data: URL 时退回直连地址：能显示，只是这次没缓存住
      iconSrc.value = result.data ?? icon
      if (result.data)
        writeFaviconCache(target, result.data)
      return
    }

    // 判定为「没图标」时，先看站点源上有没有**已经确认过的**真图标。
    //
    // 缓存键是站点源，而 Chrome 按具体页面地址解析图标：同一个 origin 下
    // `/` 有图标，`/explore` 却可能返回占位图。这种时候保留原来那张图，
    // 比把它降级成首字母更接近用户预期（也是缓存写入侧那条规则的 UI 侧一半）。
    const known = readFaviconCache(target)
    if (known?.entry.data) {
      showIcon.value = true
      iconSrc.value = known.entry.data
      // 既然继续用它，就顺手刷新时间戳 —— 否则每次打开都要再验一遍
      writeFaviconCache(target, known.entry.data)
      return
    }

    showIcon.value = false
    iconSrc.value = null
    // 记下「这站没图标」，下次连探针都不用发
    writeFaviconCache(target)
  }

  /**
   * 显示用的图标实际解不开时的兜底（接 `<img>` 的 error 事件）。
   *
   * 为什么需要它：`sanitizeEntry` 只能拦住「前缀不对 / 太大」的脏数据，
   * 拦不住 `data:image/png;base64,AAAA` 这种**前缀合法、内容解不开**的串。
   * 那种情况下浏览器只给一个空白 `<img>`（`naturalWidth = 0`），
   * 既没有报错也没有首字母兜底 —— 比一排首字母难看得多，而且会一直卡到 TTL 过期。
   *
   * 所以这里退回首字母，并**丢掉那条缓存**：下次打开重新判定一次就能自愈。
   * 正常路径（`toDataUrl()` 现算的 PNG）不会产出解不开的串，
   * 走到这里说明缓存被外力改坏了；即使误触发，代价也只是重新判定一次。
   */
  function onIconError() {
    const target = pageUrl()
    showIcon.value = false
    iconSrc.value = null
    if (target)
      dropFaviconCache(target)
  }

  resolve()

  return { showIcon, iconSrc, resolve, onIconError }
}
