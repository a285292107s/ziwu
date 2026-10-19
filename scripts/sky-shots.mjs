import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const args = process.argv.slice(2)
const round = args.find(a => !a.startsWith('--')) ?? 'sky01'
function flag(name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const SUMMER = [
  ['0450-first-light', '2026-06-21T04:48', '太阳在 0° 上下，地平线只剩一条冷光'],
  ['0560-low-sun', '2026-06-21T05:36', '太阳 8.6°，低角度暖光斜射'],
  ['1200-noon', '2026-06-21T12:00', '太阳 78.5°，正午高白'],
  ['1900-sunset', '2026-06-21T19:00', '太阳 1.9°，日落临界'],
  ['1936-blue-hour', '2026-06-21T19:36', '太阳 -3.4°，蓝调时刻'],
  ['2020-civil-dusk', '2026-06-21T20:18', '太阳 -10.4°，暮光将尽'],
  ['2200-night', '2026-06-21T22:00', '太阳 -25°，只剩气辉与星野'],
]

const WINTER = [
  ['0730-sunrise', '2026-12-21T07:18', '太阳 1.3°，冬季低日照'],
  ['1200-noon-winter', '2026-12-21T12:00', '太阳 31.6°，全年最低的正午'],
  ['1654-sunset', '2026-12-21T16:54', '太阳 -0.8°，日落'],
  ['1740-dusk', '2026-12-21T17:36', '太阳 -7.5°，冬季蓝调'],
]

const season = flag('season', 'summer')
const times = season === 'winter' ? WINTER : season === 'all' ? [...SUMMER, ...WINTER] : SUMMER
const themes = flag('themes', 'light,dark').split(',')
const only = flag('only', '')
const [vw, vh] = flag('view', '1440x900').split('x').map(Number)

const picked = only
  ? times.filter(([label]) => only.split(',').some(o => label.includes(o)))
  : times
if (!picked.length)
  throw new Error(`--only=${only} 没匹配到任何时刻`)

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  viewport: { width: vw, height: vh },
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
const baseUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

const page = await browser.newPage()

const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    errors.push(`console.error: ${m.text()}`)
})

async function setTheme(mode) {
  await page.evaluate(m => chrome.storage.local.set({ 'meridiem-theme': m }), mode)
}

async function waitForSky() {
  await page.waitForFunction(
    () => !!document.querySelector('canvas[class*="sky__canvas"]'),
    null,
    { timeout: 5000 },
  )
  const painted = await page
    .waitForFunction(
      () => document.querySelector('canvas[class*="sky__canvas"]')?.classList.contains('is-painted'),
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)

  const deadline = Date.now() + 180000
  const hist = []
  let last = null
  let settled = false
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const q = window.__sky?.probe
      if (!q || !q.perf)
        return null
      return { scale: q.scale, adapt: q.perf.adapt, fps: q.perf.fps, gain: q.gain }
    })
    if (last && (last.adapt === 'hold:max' || last.adapt === 'hold:band')) {
      hist.push(last.scale)
      if (hist.length > 3)
        hist.shift()
      if (hist.length === 3 && hist.every(v => v === hist[0])) {
        settled = true
        break
      }
    }
    else {
      hist.length = 0
    }
    await page.waitForTimeout(1000)
  }
  if (!settled && last)
    console.log(`    ! 未收敛：scale=${last.scale.toFixed(4)} adapt=${last.adapt} fps=${last.fps?.toFixed(1)}`)

  await page.waitForTimeout(4000)
  const probe = await page.evaluate(() => {
    const q = window.__sky?.probe
    if (!q)
      return null
    return {
      scale: q.scale,
      gain: q.gain,
      p10: q.p10,
      p50: q.p50,
      p90: q.p90,
      textP90: q.text?.p90,
      adapt: q.perf?.adapt,
      fps: q.perf?.fps,
      ocean: q.ocean,
      elements: q.elements
        ? { count: q.elements.count, worstLow: q.elements.worstLow, worstHigh: q.elements.worstHigh }
        : null,
    }
  })
  return { painted, settled, probe }
}

const report = []

for (const theme of themes) {
  for (const [label, when, note] of picked) {
    await page.goto(`${baseUrl}?sky=${encodeURIComponent(when)}&skydebug=1`)
    await page.waitForSelector('[data-test="search-input"]')
    await setTheme(theme)
    await page.reload()
    await page.waitForSelector('[data-test="search-input"]')
    const sky = await waitForSky()

    const name = `${theme}-${label}`
    await page.screenshot({ path: path.join(outDir, `${name}.png`) })

    report.push({
      shot: name,
      sky: when,
      note,
      webgl: sky.painted,
      settled: sky.settled,
      probe: sky.probe,
      clock: await page.locator('[data-test="clock"]').textContent().catch(() => null),
      phase: await page.locator('main').getAttribute('data-phase').catch(() => null),
    })
    console.log(`  ${sky.painted ? 'gl' : 'CSS'}  ${sky.settled ? '稳' : '未稳'}  scale=${sky.probe?.scale ?? '-'}  gain=${sky.probe?.gain?.toFixed(3) ?? '-'}  ${name}`)
  }
}

const fellBack = report.filter(r => !r.webgl).map(r => r.shot)
const unsettled = report.filter(r => r.webgl && !r.settled).map(r => r.shot)
console.log(JSON.stringify({
  round,
  season,
  themes,
  view: `${vw}x${vh}`,
  fellBack,
  unsettled,
  errors,
  report,
}, null, 2))

await browser.close()

if (errors.length || fellBack.length || unsettled.length)
  process.exit(1)
