/**
 * 截图取像素的小工具（开发用，不属于测试套件）。
 *
 * Playwright 只能给出 PNG 字节，Node 侧没有解码器；但浏览器里有。
 * 所以开一个 about:blank 的旁路页面，把 PNG 用 data URL 塞进去，
 * 画到 2D canvas 上再 getImageData —— 这样拿到的是**真正合成后的像素**，
 * 包含 WebGL 天空、CSS 薄膜、暗角、玻璃模糊，也就是用户眼睛看到的那一层。
 *
 * 这一点很关键：contrast-audit.mjs 只能读 computed style，看不见 canvas。
 * 天空背景的对比度必须从像素上量。
 *
 * 注意：**统计必须在页面里算完再回传**。一张 2880×1800 的图有 2000 万个分量，
 * 塞进 evaluate 的返回值里会大到传不回来（表现为统计恒为 0）。
 */

/** 旁路页面：只用来解码 PNG，不进扩展上下文 */
export async function openPixelReader(browser) {
  const page = await browser.newPage()
  await page.goto('about:blank')
  return page
}

/**
 * 一次解码，量多块矩形。
 * @param reader openPixelReader() 的返回值
 * @param buffer PNG 字节
 * @param rects  { [名字]: {x,y,w,h} } —— CSS 像素
 * @param ratio  deviceScaleFactor
 * @returns { [名字]: {mean,min,max,p10,p90,rgb} } —— 线性亮度与平均 RGB，按名字索引
 */
export async function measureRects(reader, buffer, rects, ratio = 1) {
  return reader.evaluate(async ({ dataUrl, rects, ratio }) => {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data

    const linearize = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    const lumOf = (r, g, b) =>
      0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255)

    const out = {}
    for (const [name, rect] of Object.entries(rects)) {
      const x0 = Math.max(0, Math.floor(rect.x * ratio))
      const y0 = Math.max(0, Math.floor(rect.y * ratio))
      const x1 = Math.min(c.width, Math.ceil((rect.x + rect.w) * ratio))
      const y1 = Math.min(c.height, Math.ceil((rect.y + rect.h) * ratio))
      const lum = []
      let r = 0
      let g = 0
      let b = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * c.width + x) * 4
          r += px[i]
          g += px[i + 1]
          b += px[i + 2]
          lum.push(lumOf(px[i], px[i + 1], px[i + 2]))
        }
      }
      if (!lum.length) {
        out[name] = { mean: -1, min: -1, max: -1, p10: -1, p90: -1, rgb: [0, 0, 0], n: 0 }
        continue
      }
      const n = lum.length
      lum.sort((a, b2) => a - b2)
      const at = q => lum[Math.min(n - 1, Math.max(0, Math.floor(n * q)))]
      out[name] = {
        mean: lum.reduce((s, v) => s + v, 0) / n,
        min: lum[0],
        max: lum[n - 1],
        p10: at(0.1),
        p90: at(0.9),
        rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        n,
      }
    }
    return out
  }, { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, rects, ratio })
}

const linearize = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

/** WCAG 相对亮度（RGB 0-255） */
export function luminance(r, g, b) {
  return 0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255)
}

/** WCAG 对比度 */
export function contrast(l1, l2) {
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}
