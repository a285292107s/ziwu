/**
 * 天光背景的分层拆解（开发用，不属于测试套件）。
 *
 * 视觉出问题时，最怕的是「看着不对但不知道是哪一层不对」。这个脚本把背景拆开拍：
 *   -final  用户真正看到的样子
 *   -raw    关掉可读性薄膜之后的纯天空（判断问题出在着色器还是薄膜）
 *   -nogl   关掉 WebGL 之后的 CSS 兜底（判断降级路径本身好不好看）
 *
 * 用法：
 *   node --no-experimental-require-module scripts/sky-layers.mjs <轮次> <时刻> [light|dark]
 *   node --no-experimental-require-module scripts/sky-layers.mjs sky01 2026-06-21T12:00 dark
 */
/* global chrome -- 注入到页面上下文里执行，本身不是 Node 全局 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { measureRects, openPixelReader } from './lib/pixels.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const round = process.argv[2] ?? 'sky01'
const when = process.argv[3] ?? '2026-06-21T12:00'
const theme = process.argv[4] ?? 'light'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  // 注意：viewport / deviceScaleFactor 必须给 launchPersistentContext。
  // 持久化上下文里 newPage() 会忽略这两个参数（拿到的是 1280x720 @1x），
  // 于是所有按 1440x900@2x 算的采样矩形全部错位。
  viewport: { width: 1440, height: 900 },
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
await page.waitForTimeout(3000)

const stamp = `${theme}-${when.replace(/[:T]/g, '')}`
const reader = await openPixelReader(browser)

/** 天空在不同高度分别是什么颜色 */
const BANDS = {
  'top(y4-10%)': { x: 100, y: 36, w: 1240, h: 54 },
  'clock(y12-24%)': { x: 100, y: 108, w: 1240, h: 108 },
  'mid(y42-52%)': { x: 610, y: 378, w: 220, h: 90 },
  'bottom(y88-96%)': { x: 100, y: 792, w: 1240, h: 72 },
}

let imgW = 0

async function measure(tag) {
  const buf = await page.screenshot()
  fs.writeFileSync(path.join(outDir, `${stamp}-${tag}.png`), buf)
  const raw = await measureRects(reader, buf, BANDS, 2)
  if (!imgW)
    imgW = Math.round((BANDS['mid(y42-52%)'].x + BANDS['mid(y42-52%)'].w) / 1)
  const out = {}
  for (const [name, s] of Object.entries(raw)) {
    out[name] = {
      rgb: s.rgb,
      lin: +s.mean.toFixed(4),
      min: +s.min.toFixed(4),
      max: +s.max.toFixed(4),
      n: s.n,
    }
  }
  return out
}

const measured = {
  final: await measure('final'),
  raw: null,
  nogl: null,
}

// 关掉薄膜：留下纯天空
const veilTag = await page.addStyleTag({ content: '.sky__veil{opacity:0 !important}' })
await page.waitForTimeout(250)
measured.raw = await measure('raw')
await page.evaluate(el => el.remove(), veilTag)

// 关掉 WebGL：留下 CSS 兜底
await page.evaluate(() => {
  const c = document.querySelector('canvas[class*="sky__canvas"]')
  if (c)
    c.style.display = 'none'
})
await page.waitForTimeout(250)
measured.nogl = await measure('nogl')

const debug = await page.evaluate(() => window.__sky ?? null)

console.log(JSON.stringify({ round, when, theme, stamp, debug, errors, measured }, null, 2))
await browser.close()
