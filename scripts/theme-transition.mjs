import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const args = process.argv.slice(2)
const round = args.find(a => !a.startsWith('--')) ?? 'theme01'
function flag(name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const skyWhen = flag('sky', '2026-06-21T12:00')
const from = flag('from', 'light')
const toList = flag('to', from === 'light' ? 'dark' : 'light').split(',')
const view = flag('view', '1440x900').split('x').map(Number)
const shots = flag('shots', '0') === '1'
const screencast = flag('screencast', '0') === '1'
const waitMs = Number(flag('wait', '6500'))
const settleMs = Number(flag('settle', '4000'))

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  viewport: { width: view[0], height: view[1] },
  deviceScaleFactor: 1,
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

async function waitForPainted() {
  await page.waitForSelector('[data-test="search-input"]')
  await page.waitForFunction(
    () => document.querySelector('canvas[class*="sky__canvas"]')?.classList.contains('is-painted'),
    null,
    { timeout: 20000 },
  ).catch(() => {})
  await page.waitForTimeout(settleMs)
}

async function installSampler() {
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas[class*="sky__canvas"]')
    if (!canvas)
      throw new Error('找不到天空画布')
    const c2 = document.createElement('canvas')
    c2.width = 160
    c2.height = 100
    const ctx = c2.getContext('2d', { willReadFrequently: true })
    const trace = []
    let frames = 0
    const DEBUG = !!window.__sky
    function tick() {
      if (frames >= 3000)
        return
      frames++
      const t = performance.now()
      ctx.drawImage(canvas, 0, 0, c2.width, c2.height)
      const d = ctx.getImageData(0, 0, c2.width, c2.height).data
      let sr = 0
      let sg = 0
      let sb = 0
      let sl = 0
      let min = 1
      let max = 0
      const lum = []
      const n = c2.width * c2.height
      for (let i = 0; i < n; i++) {
        const r = d[i * 4] / 255
        const g = d[i * 4 + 1] / 255
        const b = d[i * 4 + 2] / 255
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        sr += r
        sg += g
        sb += b
        sl += l
        lum.push(l)
        if (l < min)
          min = l
        if (l > max)
          max = l
      }
      lum.sort((a, b) => a - b)
      trace.push({
        t,
        r: sr / n,
        g: sg / n,
        b: sb / n,
        mean: sl / n,
        p10: lum[Math.floor(n * 0.1)],
        p90: lum[Math.floor(n * 0.9)],
        min,
        max,
        gain: DEBUG ? window.__sky?.probe?.gain ?? null : null,
        probeP50: DEBUG ? window.__sky?.probe?.p50 ?? null : null,
        probeTextP90: DEBUG ? window.__sky?.probe?.text?.p90 ?? null : null,
        veil: DEBUG ? window.__sky?.veil ?? null : null,
      })
      requestAnimationFrame(tick)
    }
    window.__trace = trace
    window.__traceStart = performance.now()
    requestAnimationFrame(tick)
  })
}

async function readTrace() {
  return page.evaluate(() => window.__trace ?? [])
}

const report = []
let current = from
for (const to of toList) {
  await page.goto(`${baseUrl}?sky=${encodeURIComponent(skyWhen)}&skydebug=1`)
  await setTheme(current)
  await page.reload()
  await waitForPainted()

  await installSampler()
  await page.waitForTimeout(350)
  const t0 = Date.now()
  await setTheme(to)
  const changeAt = await page.evaluate(() => performance.now())
  await page.waitForTimeout(Math.max(0, waitMs - (Date.now() - t0)))
  const trace = await readTrace()
  const probe = await page.evaluate(() => {
    const q = window.__sky?.probe
    return q
      ? {
          gain: q.gain,
          scale: q.scale,
          p50: q.p50,
          textP90: q.text?.p90,
          veil: window.__sky?.veil,
        }
      : null
  })
  fs.writeFileSync(
    path.join(outDir, `trace-${current}-to-${to}.json`),
    JSON.stringify({ from: current, to, skyWhen, changeAt, trace }, null, 2),
  )
  report.push({ from: current, to, probe, shotPaths: [] })
  console.log(`  ${current} → ${to}  采样 ${trace.length} 帧`)

  if (shots || screencast) {
    const shotPaths = []
    await setTheme(current)
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      if (window.__trace)
        window.__trace.length = 0
      window.__traceStart = performance.now()
    })

    if (screencast) {
      const cdp = await browser.newCDPSession(page)
      const captured = []
      cdp.on('Page.screencastFrame', (ev) => {
        captured.push({ ts: ev.metadata.timestamp * 1000, data: ev.data })
        void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
      })
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 88,
        maxWidth: view[0],
        maxHeight: view[1],
        everyNthFrame: 1,
      })
      const wallChange = Date.now()
      await setTheme(to)
      await page.waitForTimeout(2400)
      await cdp.send('Page.stopScreencast').catch(() => {})
      await cdp.detach().catch(() => {})
      for (const f of captured) {
        const at = f.ts - wallChange
        if (at < -120 || at > 1800)
          continue
        const name = `${current}-to-${to}-${String(Math.round(at)).padStart(4, '0')}ms.jpg`
        fs.writeFileSync(path.join(outDir, name), Buffer.from(f.data, 'base64'))
        shotPaths.push(path.basename(name))
      }
    }
    else {
      const shotPlan = [0, 120, 240, 400, 560, 760, 980, 1240, 1520, 1900]
      const t1 = Date.now()
      await setTheme(to)
      for (const at of shotPlan) {
        const wait = at - (Date.now() - t1)
        if (wait > 0)
          await page.waitForTimeout(wait)
        const name = `${current}-to-${to}-${String(at).padStart(4, '0')}ms.png`
        const file = path.join(outDir, name)
        await page.screenshot({ path: file })
        shotPaths.push(path.basename(file))
      }
    }
    report[report.length - 1].shotPaths = shotPaths
    await page.waitForTimeout(1500)
    console.log(`  ${current} → ${to}  画面 ${shotPaths.length} 张`)
  }
  current = to
}

await browser.close()

const summary = report.map(({ from, to, probe }) => {
  const file = path.join(outDir, `trace-${from}-to-${to}.json`)
  const { trace, changeAt } = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!trace.length)
    return { from, to, error: '没有采样到帧' }
  const rel = trace.map(f => ({ ...f, dt: f.t - changeAt }))
  const base = rel.filter(f => f.dt < -0.2)
  const baseMean = base.length ? base.reduce((a, f) => a + f.mean, 0) / base.length : rel[0].mean
  const last = rel[rel.length - 1]
  const endMean = last.mean
  const total = endMean - baseMean
  let maxStep = 0
  let maxStepAt = 0
  for (let i = 1; i < rel.length; i++) {
    if (rel[i].dt - rel[i - 1].dt > 100)
      continue
    const step = Math.abs(rel[i].mean - rel[i - 1].mean)
    if (step > maxStep) {
      maxStep = step
      maxStepAt = rel[i].dt
    }
  }
  const crossed = rel.filter(f => f.dt > 0 && Math.abs(f.mean - baseMean) >= Math.abs(total) * 0.95)
  return {
    from,
    to,
    baseMean: +baseMean.toFixed(4),
    endMean: +endMean.toFixed(4),
    delta: +total.toFixed(4),
    maxStepPct: total ? +((maxStep / Math.abs(total)) * 100).toFixed(1) : null,
    maxStepAtMs: +maxStepAt.toFixed(0),
    t95Ms: crossed.length ? +crossed[0].dt.toFixed(0) : null,
    frames: rel.length,
    probe,
  }
})

console.log(JSON.stringify({ round, skyWhen, view, report: summary, errors }, null, 2))

if (errors.length)
  process.exit(1)
