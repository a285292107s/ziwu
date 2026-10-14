/**
 * 天光背景的逐行体检（开发用，不属于测试套件）。
 *
 * 为什么需要它：着色器里那些常数（散射强度、沙面光网增益、镜面亮度、光柱反差）
 * 是在一份把同一套数学重写一遍的台架上搜出来的。台架给的是**预测**，
 * 一旦着色器里的实现和台架有一点不一致，画面就会以「看着不对但说不清哪不对」的形式崩掉。
 *
 * 这个脚本量的是**真机画面的每一横行的平均 RGB 和横向色差**，和台架的输出一一对应。
 * 哪一行对不上，问题就锁死在哪一行 —— 是镜面那一行，还是沙面那一行，还是中间的纯水。
 *
 * 量的时候把前景 UI 全部隐藏（visibility 而不是 display，避免布局变化让暗角跟着动），
 * 拿到的就是纯背景。
 *
 * 用法：
 *   node --no-experimental-require-module scripts/sky-rows.mjs <时刻> [light|dark] [轮次]
 *   node --no-experimental-require-module scripts/sky-rows.mjs 2026-06-21T12:00 light sky04
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { measureRects, openPixelReader } from './lib/pixels.mjs'

/* global chrome -- 下面 page.evaluate 的回调在**页面**里执行，chrome 由扩展环境注入 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const when = process.argv[2] ?? '2026-06-21T12:00'
const theme = process.argv[3] ?? 'light'
const round = process.argv[4] ?? 'sky04'

const VIEW = { width: 1440, height: 900 }
const ROWS = 8
/** 横向只取中间 80%：两侧有暗角，量进去会把横向色差压低 */
const X0 = Math.round(VIEW.width * 0.1)
const XW = Math.round(VIEW.width * 0.8)

const rows = {}
for (let i = 0; i < ROWS; i++) {
  const h = VIEW.height / ROWS
  rows[`r${i}`] = { x: X0, y: Math.round(i * h), w: XW, h: Math.round(h) }
}

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  // 注意：viewport / deviceScaleFactor 必须给 launchPersistentContext，newPage() 会忽略
  viewport: VIEW,
  deviceScaleFactor: 2,
  args: [
    '--headless=new',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

let sw = browser.serviceWorkers()[0]
if (!sw)
  sw = await browser.waitForEvent('serviceworker')
const extensionId = sw.url().split('/')[2]

const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    errors.push(`${m.type()}: ${m.text()}`)
})

await page.goto(`chrome-extension://${extensionId}/dist/newtab/index.html?sky=${encodeURIComponent(when)}&skydebug=1`)
await page.waitForSelector('[data-test="search-input"]')
await page.evaluate(m => chrome.storage.local.set({ 'meridiem-theme': m }), theme)
await page.reload()
await page.waitForSelector('[data-test="search-input"]')
await page.waitForTimeout(3200)

// 只留天空层。visibility 不用 display：display:none 会改变滚动/布局，暗角跟着变。
const hideUi = await page.addStyleTag({
  content: 'body * { visibility: hidden !important } .sky, .sky * { visibility: visible !important }',
})
await page.waitForTimeout(200)

const reader = await openPixelReader(browser)

async function sample(tag) {
  const buf = await page.screenshot()
  fs.mkdirSync(path.join(__dirname, '..', 'docs', 'review', round), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'review', round, `rows-${theme}-${tag}.png`), buf)
  const raw = await measureRects(reader, buf, rows, 2)
  const out = {}
  for (const [name, s] of Object.entries(raw)) {
    out[name] = {
      rgb: s.rgb,
      lin: +s.mean.toFixed(4),
      p10: +s.p10.toFixed(4),
      p90: +s.p90.toFixed(4),
      // 横向色差：一行里 R 通道的 p90-p10。台架用它判断「这一行有没有信息」
      rSpread: Math.round((s.max - s.min) * 255),
      n: s.n,
    }
  }
  return out
}

const final = await sample('final')

// 关掉薄膜：拿到纯天空，和台架的预测直接对齐
const veilTag = await page.addStyleTag({ content: '.sky__veil{opacity:0 !important}' })
await page.waitForTimeout(250)
const raw = await sample('raw')
await page.evaluate(el => el.remove(), veilTag)
await page.evaluate(el => el.remove(), hideUi)

const debug = await page.evaluate(() => window.__sky ?? null)

/**
 * 参考剖面：**不是设计目标，是一条抓下来的基线**（sky09v 轮，浅色正午，遮罩关闭）。
 *
 * ⚠️ 这条基线已经过期：它抓在 MIRROR_BASE 从 0.55 提到 0.85 **之前**，
 * 也抓在 skyAbove 的路程指数从 2.0 改到 1.3 之前 —— 这两处都动了画面亮度。
 * 所以现在跑出来的偏差里，有真实的漂移，也有一条固定的旧基线偏移，两者混在一起。
 * 要用它做漂移检测，先重抓一次基线；在此之前只当「纵向三段结构还在不在」的粗看。
 *
 * 原来这里躺着一组从旧台架抄来的数（0.985 → 0.912 的单调递减），
 * 那套数字对应的是「顶部最亮、一路往下变暗」的画面 —— 而现在这个画面的纵向结构
 * 是**三段**：窗（最亮）→ 中段的镜面带（最暗）→ 沙面光网（次亮）。
 * 拿旧目标去比只会得到一片 -0.3 ~ -0.6 的「偏差」，看不出任何东西。
 * 换成基线之后，这个脚本的正经用法是**看漂移**：某一行相对这条线动了，
 * 就说明那次改动动了画面的纵向结构。
 *
 * 基线重抓于 sky13 轮（2026-06-21T12:00 light）。上一版 `[0.689, 0.490, 0.312,
 * 0.300, 0.360, 0.384, 0.362, 0.562]` 抓在 **`.sky` 还是 `position: absolute`** 的年代：
 * 那时文档比视口高 195px，着色器合成的是一张 1096 高的画，底部 18% 谁也看不见，
 * 于是每一行的采样位置对应的其实是画面里**更靠上**的地方。改成 `position: fixed`
 * 之后合成的是真正的 1440×900，同一批行号量到的是另一段画面 ——
 * 旧基线里那个 r6 的 0.362 会让现在跑出 +0.22 的「偏差」，
 * 而那不是漂移，是**基线本身量错了地方**。留在这里只为存档，不要拿它比。
 * 纵向三段结构（窗最亮 → 中段镜面带最暗 → 沙面次亮）在新基线里依然成立。
 */
const ROW_TARGET = [0.644, 0.429, 0.308, 0.357, 0.408, 0.416, 0.582, 0.635]

const table = Object.entries(raw).map(([name, s], i) => ({
  行: name,
  rgb: s.rgb.join(','),
  亮度: s.lin,
  目标: ROW_TARGET[i],
  偏差: +(s.lin - ROW_TARGET[i]).toFixed(3),
  R横向: s.rSpread,
  p10: s.p10,
  p90: s.p90,
}))

console.log(JSON.stringify({
  when,
  theme,
  errors,
  frame: debug?.frame ?? null,
  probe: debug?.probe ?? null,
  veil: debug?.veil ?? null,
  painted: debug?.painted ?? null,
  final: Object.fromEntries(Object.entries(final).map(([k, v]) => [k, v.rgb])),
  逐行: table,
}, null, 2))

await browser.close()
