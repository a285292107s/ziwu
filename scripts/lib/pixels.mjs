export async function openPixelReader(browser) {
  const page = await browser.newPage()
  await page.goto('about:blank')
  return page
}

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

export function luminance(r, g, b) {
  return 0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255)
}

export function contrast(l1, l2) {
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}
