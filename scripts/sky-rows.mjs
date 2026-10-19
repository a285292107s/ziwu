import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { measureRects, openPixelReader } from './lib/pixels.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const when = process.argv[2] ?? '2026-06-21T12:00'
const theme = process.argv[3] ?? 'light'
const round = process.argv[4] ?? 'sky04'

const VIEW = { width: 1440, height: 900 }
const ROWS = 8
const X0 = Math.round(VIEW.width * 0.1)
const XW = Math.round(VIEW.width * 0.8)

const rows = {}
for (let i = 0; i < ROWS; i++) {
  const h = VIEW.height / ROWS
  rows[`r${i}`] = { x: X0, y: Math.round(i * h), w: XW, h: Math.round(h) }
}

const browser = await chromium.launchPersistentContext('', {
  headless: true,
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
      rSpread: Math.round((s.max - s.min) * 255),
      n: s.n,
    }
  }
  return out
}

const final = await sample('final')

const veilTag = await page.addStyleTag({ content: '.sky__veil{opacity:0 !important}' })
await page.waitForTimeout(250)
const raw = await sample('raw')
await page.evaluate(el => el.remove(), veilTag)
await page.evaluate(el => el.remove(), hideUi)

const debug = await page.evaluate(() => window.__sky ?? null)

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
