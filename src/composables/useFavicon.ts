import { ref } from 'vue'
import { FAVICON_PROBE_URL, faviconUrl } from '~/logic/shortcuts'

/**
 * 站点图标解析。
 *
 * ## 为什么要这么麻烦
 *
 * MV3 提供了 `chrome://favicon` 的替代品 `/_favicon/`，但它有个坑：
 * **对「Chrome 缓存里没有图标的站点」，它返回的是一张通用的灰色地球占位图，
 * 而不是 404**。于是 <img> 的 onerror 永远不触发，
 * 用户会看到一排一模一样的地球，比首字母磁贴难看得多。
 *
 * ## 做法
 *
 * 用一个肯定不存在的域名去要一次图标，拿到那张占位图的像素指纹；
 * 之后每个站点都算一次指纹跟它比对，相同就判定为占位图 → 回退到首字母。
 * 指纹是运行时标定的，所以换了 Chrome 版本 / 平台也不会失效。
 *
 * canvas 能读像素是因为 `/_favicon/` 与扩展页面同源；一旦被跨域污染（理论上不会），
 * 这里会捕获异常并按「不可信」处理，直接走首字母回退。
 */

/** 占位图的像素指纹；null 表示尚未标定或标定失败 */
let placeholderHash: string | null = null
let calibrating: Promise<string | null> | null = null

/** 每个 URL 的解析结果缓存，避免同一站点重复做 canvas 计算 */
const cache = new Map<string, 'icon' | 'monogram'>()

/**
 * 取一张图片的 32x32 像素指纹。
 * 同时返回非透明像素比例，用来识别「几乎空白」的图。
 */
function fingerprint(url: string): Promise<{ hash: string, opaque: number } | null> {
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
        resolve({ hash: (hash >>> 0).toString(16), opaque: opaque / 1024 })
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
 * 判断某个站点的图标是否为「真实图标」。
 * 两个参数都必须是**已经拼好的 `/_favicon/` 图标地址**（用 `faviconUrl()` 生成）。
 * 返回 false 表示应当回退到首字母磁贴。
 */
export async function hasRealFavicon(iconUrl: string, probeIconUrl: string): Promise<boolean> {
  const cached = cache.get(iconUrl)
  if (cached)
    return cached === 'icon'

  const [probe, actual] = await Promise.all([
    calibrate(probeIconUrl),
    fingerprint(iconUrl),
  ])

  // 图加载不出来 → 用首字母
  if (!actual) {
    cache.set(iconUrl, 'monogram')
    return false
  }

  // 几乎全透明 → 用首字母
  if (actual.opaque < 0.02) {
    cache.set(iconUrl, 'monogram')
    return false
  }

  // 与占位图指纹相同 → 用首字母
  if (probe && actual.hash === probe) {
    cache.set(iconUrl, 'monogram')
    return false
  }

  cache.set(iconUrl, 'icon')
  return true
}

/** 仅供测试：重置模块级缓存 */
export function __resetFaviconCache() {
  placeholderHash = null
  calibrating = null
  cache.clear()
}

/**
 * 组件用的封装：给一个**站点地址**，返回「是否显示真实图标」。
 *
 * 刻意只收站点地址、由内部去拼 `/_favicon/` 地址：
 * 之前把「站点地址」和「图标地址」两个参数并排放，结果标定探针时误传了站点地址，
 * 标定静默失败、检测形同虚设（占位地球照旧显示）。收窄成单一入参就不会再错。
 *
 * 初始值给 false：宁可先显示首字母，也不要先闪一下灰色地球。
 */
export function useRealFavicon(pageUrl: () => string | null) {
  const showIcon = ref(false)

  async function resolve() {
    const target = pageUrl()
    const probeIcon = faviconUrl(FAVICON_PROBE_URL, 64)

    if (!target || !probeIcon) {
      showIcon.value = false
      return
    }

    const icon = faviconUrl(target, 64)
    showIcon.value = icon ? await hasRealFavicon(icon, probeIcon) : false
  }

  resolve()

  return { showIcon, resolve }
}
