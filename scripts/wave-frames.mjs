import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const extensionPath = path.join(root, 'extension')

const args = process.argv.slice(2)
const positional = args.filter(a => !a.startsWith('--'))
function flag(name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const round = positional[0] ?? 'wave'
const theme = flag('theme', 'light')
const [vpW, vpH] = flag('viewport', '1440x900').split('x').map(Number)
const from = Number(flag('from', 0))
const to = Number(flag('to', 1100))
const step = Number(flag('step', 50))
const iconTo = Number(flag('icon-to', 1000))
const iconStep = Number(flag('icon-step', 25))
const label = flag('label', '')
const dirOverride = flag('dir', '')
const faviconMode = flag('favicon', 'cold')
const siteSet = flag('sites', 'review')
const visitSites = !args.includes('--no-visit-sites')
const withFrames = !args.includes('--no-frames')
const withFreeze = !args.includes('--no-freeze')
const withLiveTrace = !args.includes('--no-live-trace')
const withReducedMotion = args.includes('--reduced-motion')
const withZoom = args.includes('--zoom')
const zoomTile = Number(flag('zoom-tile', 2))
const zoomFrom = Number(flag('zoom-from', 0))
const zoomTo = Number(flag('zoom-to', 900))
const zoomStep = Number(flag('zoom-step', 25))
const dsf = Number(flag('dsf', withZoom ? 2 : 1))
const settleMs = Number(flag('settle', 1200))

if (!['light', 'dark'].includes(theme))
  throw new Error(`--theme 只支持 light|dark，收到 ${theme}`)
if (!Number.isFinite(vpW) || !Number.isFinite(vpH) || vpW <= 0 || vpH <= 0)
  throw new Error(`--viewport 形如 1440x900，收到 ${vpW}x${vpH}`)
if (!(step > 0) || to < from)
  throw new Error(`--from/--to/--step 不合法：${from}/${to}/${step}`)
if ((to - from) / step > 300 || iconTo / iconStep > 400)
  throw new Error('采样点过多，调大 --step / --icon-step')
if (!['cold', 'warm', 'swap'].includes(faviconMode))
  throw new Error(`--favicon 只支持 cold|warm|swap，收到 ${faviconMode}`)
if (!['review', 'fixture'].includes(siteSet))
  throw new Error(`--sites 只支持 review|fixture，收到 ${siteSet}`)
if (!Number.isFinite(dsf) || dsf <= 0)
  throw new Error(`--dsf 必须为正数，收到 ${dsf}`)
if (withZoom && (!(zoomStep > 0) || zoomTo < zoomFrom))
  throw new Error(`--zoom-from/--zoom-to/--zoom-step 不合法：${zoomFrom}/${zoomTo}/${zoomStep}`)

const vpLabel = `${vpW}x${vpH}`
const outDir = dirOverride
  ? path.join(root, 'docs', 'review', round, dirOverride)
  : path.join(root, 'docs', 'review', round, `${theme}-${vpLabel}-${faviconMode}${label ? `-${label}` : ''}`)
fs.mkdirSync(outDir, { recursive: true })

const REVIEW_SHORTCUTS = [
  { id: 'p1', name: 'GitHub', url: 'https://github.com' },
  { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  { id: 'p3', name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 'p4', name: 'MDN', url: 'https://developer.mozilla.org' },
  { id: 'p5', name: 'Figma', url: 'https://www.figma.com' },
  { id: 'p6', name: 'Linear', url: 'https://linear.app' },
  { id: 'p7', name: '内部看板', url: 'https://meridiem-dashboard.invalid' },
  { id: 'p8', name: 'arXiv', url: 'https://arxiv.org' },
  { id: 'p9', name: 'Hacker News', url: 'https://news.ycombinator.com' },
]
const REVIEW_ADDED = { id: 'p10', name: '维基百科', url: 'https://zh.wikipedia.org' }

const FAVICON_CACHE_KEY = 'meridiem-favicon-cache-v1'
const PLACEHOLDER_PROBE_URL = 'https://meridiem-favicon-probe.invalid/'

const FIXTURE_TILES = [
  { key: 'a', name: '样例甲', rgb: [214, 40, 40] },
  { key: 'b', name: '样例乙', rgb: [231, 111, 81] },
  { key: 'c', name: '样例丙', rgb: [233, 196, 106] },
  { key: 'd', name: '样例丁', rgb: [42, 157, 143] },
  { key: 'e', name: '样例戊', rgb: [38, 70, 83] },
  { key: 'f', name: '样例己', rgb: [94, 84, 142] },
  { key: 'g', name: '样例庚', rgb: [144, 190, 109] },
  { key: 'h', name: '样例辛', rgb: [255, 183, 3] },
  { key: 'z', name: '无图标站', rgb: null },
]

function solidPng(w, h, [r, g, b]) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (const byte of typed)
      crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0)
    return Buffer.concat([len, typed, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function startFixtureSites() {
  const servers = []
  const shortcuts = []
  const added = { id: 'fx-added', name: '样例新增', url: null }
  const specs = [...FIXTURE_TILES, { key: 'added', name: added.name, rgb: [20, 20, 20] }]

  for (const spec of specs) {
    const icon = spec.rgb ? solidPng(32, 32, spec.rgb) : null
    const srv = http.createServer((req, res) => {
      if (icon && req.url.startsWith('/icon')) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' })
        res.end(icon)
        return
      }
      if (!icon) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('no icon here')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>fixture ${spec.key}</title>`
      + '<link rel="icon" type="image/png" href="/icon.png"></head>'
      + `<body>fixture ${spec.key}</body></html>`)
    })
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    servers.push(srv)
    const url = `http://127.0.0.1:${srv.address().port}/`
    if (spec.key === 'added')
      added.url = url
    else
      shortcuts.push({ id: `fx-${spec.key}`, name: spec.name, url, fixtureRgb: spec.rgb })
  }

  return {
    shortcuts,
    added,
    stop: () => Promise.all(servers.map(s => new Promise(r => s.close(() => r())))),
  }
}

let fixtureSites = null
let SHORTCUTS = REVIEW_SHORTCUTS
let ADDED = REVIEW_ADDED
if (siteSet === 'fixture') {
  fixtureSites = await startFixtureSites()
  SHORTCUTS = fixtureSites.shortcuts
  ADDED = fixtureSites.added
}
const REMOVE_ID = SHORTCUTS[1].id

function extensionFingerprint() {
  const distDir = path.join(extensionPath, 'dist', 'assets')
  const indexHtml = path.join(extensionPath, 'dist', 'newtab', 'index.html')
  const stat = p => (fs.existsSync(p) ? fs.statSync(p) : null)
  const idx = stat(indexHtml)
  return {
    manifestMtime: stat(path.join(extensionPath, 'manifest.json'))?.mtime.toISOString() ?? null,
    newtabIndexMtime: idx?.mtime.toISOString() ?? null,
    newtabIndexSha256: idx ? createHash('sha256').update(fs.readFileSync(indexHtml)).digest('hex') : null,
    assets: fs.existsSync(distDir)
      ? fs.readdirSync(distDir).map(name => ({ name, bytes: fs.statSync(path.join(distDir, name)).size }))
      : [],
  }
}

const problems = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
let page = null

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  deviceScaleFactor: dsf,
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
const newTabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

async function withExtensionPage(fn, pagePath = 'dist/options/index.html') {
  const helper = await browser.newPage()
  try {
    await helper.goto(`chrome-extension://${extensionId}/${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await helper.waitForTimeout(150)
    return await fn(helper)
  }
  finally {
    await helper.close().catch(() => {})
  }
}

function summarizeFaviconCache(raw) {
  let record = {}
  let parseError = null
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      record = parsed
  }
  catch (e) {
    parseError = String(e)
  }
  const now = Date.now()
  const entries = Object.entries(record).map(([origin, entry]) => ({
    origin,
    hasData: typeof entry?.data === 'string' && entry.data.length > 0,
    dataBytes: typeof entry?.data === 'string' ? entry.data.length : 0,
    ageMs: typeof entry?.at === 'number' ? now - entry.at : null,
  }))
  return {
    present: raw !== null,
    bytes: raw ? raw.length : 0,
    entryCount: entries.length,
    withData: entries.filter(e => e.hasData).length,
    withoutData: entries.filter(e => !e.hasData).length,
    parseError,
    entries,
  }
}

const readFaviconCacheRaw = extPage => extPage.evaluate(key => localStorage.getItem(key), FAVICON_CACHE_KEY)

function faviconDbProbe(targets) {
  return withExtensionPage(helper => helper.evaluate(async ({ list, probeSite }) => {
    const favUrl = (site, size) => `chrome-extension://${location.host}/_favicon/?pageUrl=${encodeURIComponent(site)}&size=${size}`
    const fingerprint = async (url) => {
      const img = await new Promise((resolve) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => resolve(null)
        i.src = url
      })
      if (!img)
        return { ok: false }
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        let hash = 2166136261
        let opaque = 0
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < data.length; i++) {
          hash ^= data[i]
          hash = Math.imul(hash, 16777619)
          if (i % 4 === 3 && data[i] > 10)
            opaque++
        }
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }
        const n = data.length / 4
        return {
          ok: true,
          naturalWidth: img.naturalWidth,
          hash: (hash >>> 0).toString(16),
          opaque: +(opaque / 1024).toFixed(3),
          rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        }
      }
      catch (e) {
        return { ok: false, error: String(e) }
      }
    }

    const placeholder = await fingerprint(favUrl(probeSite, 64))
    const out = []
    for (const t of list) {
      const res = await fingerprint(favUrl(t.url, 64))
      const isPlaceholder = Boolean(res.ok && placeholder.ok && res.hash === placeholder.hash)
      out.push({
        id: t.id,
        url: t.url,
        ...res,
        isPlaceholder,
        verdict: !res.ok ? 'unavailable' : (isPlaceholder ? 'placeholder' : 'real'),
      })
    }
    return { placeholder, targets: out }
  }, { list: targets, probeSite: PLACEHOLDER_PROBE_URL }))
}

async function visitSitesForFaviconDb(targets) {
  const visitor = await browser.newPage()
  const results = []
  visitor.on('requestfailed', () => {})
  try {
    for (const t of targets) {
      const startedAt = Date.now()
      try {
        const resp = await visitor.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        results.push({ id: t.id, url: t.url, status: resp ? resp.status() : null, ms: Date.now() - startedAt, ok: true })
      }
      catch (e) {
        results.push({ id: t.id, url: t.url, status: null, ms: Date.now() - startedAt, ok: false, error: String(e).slice(0, 160) })
      }
    }
  }
  finally {
    await visitor.close().catch(() => {})
  }
  await sleep(1500)
  return results
}

async function warmFaviconCachePass() {
  const warm = await browser.newPage()
  await warm.setViewportSize({ width: vpW, height: vpH })
  warm.on('pageerror', e => problems.push(`warmup pageerror: ${e.message}`))
  await warm.addInitScript((key) => {
    try {
      localStorage.removeItem(key)
    }
    catch {
    }
  }, FAVICON_CACHE_KEY)
  const snapshots = []
  try {
    await warm.bringToFront()
    await warm.goto(newTabUrl)
    await warm.waitForSelector('.grid-root.is-waved', { timeout: 15000 })
    let stable = 0
    let lastShape = null
    for (let i = 0; i < 40; i++) {
      await warm.waitForTimeout(250)
      const snap = summarizeFaviconCache(await readFaviconCacheRaw(warm))
      const shape = `${snap.entryCount}/${snap.withData}`
      snapshots.push({ atMs: 250 * (i + 1), entryCount: snap.entryCount, withData: snap.withData, bytes: snap.bytes })
      stable = shape === lastShape ? stable + 1 : 0
      lastShape = shape
      if (stable >= 2)
        break
    }
    return { snapshots, final: summarizeFaviconCache(await readFaviconCacheRaw(warm)) }
  }
  finally {
    await warm.close().catch(() => {})
  }
}

async function clearFaviconCacheOnExtensionPage() {
  return withExtensionPage(async (helper) => {
    await helper.waitForSelector('[data-test="shortcut-grid"]', { timeout: 15000 }).catch(() => {})
    await helper.waitForTimeout(1500)
    const cleared = await helper.evaluate((key) => {
      const before = localStorage.getItem(key)
      localStorage.removeItem(key)
      return { hadKey: before !== null, beforeBytes: before ? before.length : 0, after: localStorage.getItem(key) }
    }, FAVICON_CACHE_KEY)
    return { ...cleared, afterSummary: summarizeFaviconCache(cleared.after) }
  })
}

async function createSamplePage() {
  const p = await browser.newPage()
  await p.setViewportSize({ width: vpW, height: vpH })
  p.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() === 'error')
      problems.push(`console.error: ${m.text()}`)
  })
  p.on('requestfailed', (r) => {
    const url = r.url()
    if (url.includes('/_favicon/'))
      return
    problems.push(`requestfailed: ${url} (${r.failure()?.errorText})`)
  })
  await p.addInitScript(newtabProbe, {
    liveTrace: withLiveTrace,
    clearFaviconCache: faviconMode !== 'warm',
    faviconCacheKey: FAVICON_CACHE_KEY,
  })
  try {
    const cdp = await browser.newCDPSession(p)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  }
  catch (e) {
    problems.push(`focus emulation failed: ${String(e)}`)
  }
  await p.bringToFront()
  return p
}
function newtabProbe(opts) {
  window.__rafFrames = []
  window.__waveStart = null
  const push = (t) => {
    window.__rafFrames.push(t)
    if (window.__rafFrames.length < 4000)
      requestAnimationFrame(push)
  }
  requestAnimationFrame(push)

  window.__jankFrames = []
  const jankTick = () => {
    window.__jankFrames.push(performance.now())
    if (window.__jankFrames.length < 4000)
      setTimeout(jankTick, 16)
  }
  setTimeout(jankTick, 16)

  window.__gridAnimEntry = (a) => {
    const t = a.effect && a.effect.target
    if (!t)
      return null
    let el = null
    let pseudo = a.effect.pseudoElement ?? null
    if (typeof Element !== 'undefined' && t instanceof Element) {
      el = t
    }
    else if (t.element && typeof Element !== 'undefined' && t.element instanceof Element) {
      el = t.element
      pseudo = t.pseudoElement ?? pseudo
    }
    if (!el || !el.closest('.grid-root'))
      return null
    return { el, pseudo: pseudo || null }
  }
  window.__gridAnims = () => document.getAnimations()
    .map(a => ({ a, hit: window.__gridAnimEntry(a) }))
    .filter(x => x.hit)

  window.__motionRead = (el, pseudo) => {
    if (!el)
      return null
    const style = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el)
    if (pseudo && (style.content === 'none' || style.content === 'normal'))
      return null
    const norm = v => (v === undefined || v === null || v === '' ? null : v)
    const parts = (v) => {
      const s = norm(v)
      if (!s || s === 'none')
        return []
      return s.trim().split(/\s+/).map(p => Number.parseFloat(p))
    }
    const translate = norm(style.translate)
    const scale = norm(style.scale)
    const rotate = norm(style.rotate)
    const tParts = parts(translate)
    const sParts = parts(scale)
    const tx = Number.isFinite(tParts[0]) ? tParts[0] : 0
    const ty = Number.isFinite(tParts[1]) ? tParts[1] : 0
    const sx = Number.isFinite(sParts[0]) ? sParts[0] : 1
    const sy = Number.isFinite(sParts[1]) ? sParts[1] : sx
    let rotateDeg = 0
    if (rotate && rotate !== 'none') {
      const m = /(-?[\d.]+)deg/.exec(rotate)
      rotateDeg = m ? Number.parseFloat(m[1]) : (Number.parseFloat(rotate) || 0)
    }
    let matrix = null
    if (style.transform && style.transform !== 'none') {
      try {
        matrix = new DOMMatrixReadOnly(style.transform)
      }
      catch {
        matrix = null
      }
    }
    return {
      transform: style.transform,
      translate,
      scale,
      rotate,
      opacity: +Number(style.opacity).toFixed(3),
      filter: style.filter,
      x: +(tx + (matrix ? matrix.m41 : 0)).toFixed(3),
      y: +(ty + (matrix ? matrix.m42 : 0)).toFixed(3),
      sx: +(sx * (matrix ? matrix.a : 1)).toFixed(4),
      sy: +(sy * (matrix ? matrix.d : 1)).toFixed(4),
      rotateDeg: +rotateDeg.toFixed(2),
      matrix: matrix
        ? { a: +matrix.a.toFixed(4), d: +matrix.d.toFixed(4), e: +matrix.m41.toFixed(3), f: +matrix.m42.toFixed(3) }
        : null,
    }
  }

  window.__animRefs = new Set()
  window.__animCollect = { startedAtMs: null, endedAtMs: null, ticks: 0, firstTickSize: null, collected: 0, windowMs: 1400 }
  window.__animMeta = []
  const animSeen = new WeakSet()
  const describeEl = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
    return `${el.tagName.toLowerCase()}${cls.map(c => `.${c}`).join('')}`
  }
  const metaOfAnim = (a, hit) => {
    const timing = a.effect.getTiming()
    const style = hit.pseudo ? getComputedStyle(hit.el, hit.pseudo) : getComputedStyle(hit.el)
    const cell = hit.el.closest('.tile-cell')
    const cls = typeof hit.el.className === 'string' ? hit.el.className.split(/\s+/).filter(Boolean) : []
    const kind = (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation)
      ? 'animation'
      : ((typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) ? 'transition' : 'other')
    let keyframes = null
    try {
      keyframes = a.effect.getKeyframes().map(k => ({
        computedOffset: typeof k.computedOffset === 'number' ? +k.computedOffset.toFixed(4) : null,
        offset: k.offset,
        easing: k.easing ?? null,
        composite: k.composite ?? null,
      }))
    }
    catch {
      keyframes = null
    }
    const startTime = Number.isFinite(a.startTime) ? +a.startTime.toFixed(2) : null
    return {
      kind,
      target: `${describeEl(hit.el)}${hit.pseudo ?? ''}`,
      targetBase: describeEl(hit.el),
      pseudo: hit.pseudo,
      iconKind: cls.includes('tile-icon') ? 'img' : (cls.includes('tile-initial') ? 'initial' : null),
      tag: hit.el.tagName.toLowerCase(),
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : false,
      animationName: style.animationName,
      durationMs: timing.duration,
      delayMs: timing.delay,
      fill: timing.fill,
      animationEasing: timing.easing,
      easing: timing.easing,
      easingNote: 'easing = effect.getTiming().easing（动画级，对 CSS 动画恒为 linear）；逐段曲线看 easingSegments',
      keyframes,
      easingSegments: keyframes
        ? keyframes.slice(0, -1).map((k, i) => ({
          fromPct: k.computedOffset === null ? null : +(k.computedOffset * 100).toFixed(2),
          toPct: keyframes[i + 1].computedOffset === null ? null : +(keyframes[i + 1].computedOffset * 100).toFixed(2),
          easing: k.easing ?? null,
        }))
        : null,
      iterations: timing.iterations,
      startTime,
      currentTimeMs: Number.isFinite(a.currentTime) ? +a.currentTime.toFixed(2) : null,
      playState: a.playState,
      startTimeRelWaveMs: (startTime !== null && window.__timelineAtWave !== null && window.__timelineAtWave !== undefined)
        ? +(startTime - window.__timelineAtWave).toFixed(1)
        : null,
      firstSeenRelWaveMs: window.__waveStart === null ? null : +(performance.now() - window.__waveStart).toFixed(1),
      playStateAtFirstSeen: a.playState,
    }
  }

  window.__collectAnimMeta = ms => new Promise((resolve) => {
    const out = []
    const seen = new WeakSet()
    const startedAt = performance.now()
    const tick = () => {
      for (const { a, hit } of window.__gridAnims()) {
        if (!seen.has(a)) {
          seen.add(a)
          out.push(metaOfAnim(a, hit))
        }
      }
      if (performance.now() - startedAt < ms)
        requestAnimationFrame(tick)
      else
        resolve(out)
    }
    requestAnimationFrame(tick)
  })
  function startAnimCollect() {
    const collect = window.__animCollect
    if (collect.startedAtMs !== null)
      return
    collect.startedAtMs = +(performance.now() - (window.__waveStart ?? performance.now())).toFixed(1)
    const tick = () => {
      collect.ticks++
      const live = window.__gridAnims()
      if (collect.firstTickSize === null)
        collect.firstTickSize = live.length
      for (const { a, hit } of live) {
        window.__animRefs.add(a)
        if (!animSeen.has(a)) {
          animSeen.add(a)
          window.__animMeta.push(metaOfAnim(a, hit))
        }
      }
      collect.collected = window.__animRefs.size
      collect.metaCollected = window.__animMeta.length
      if (performance.now() - window.__waveStart < collect.windowMs) {
        requestAnimationFrame(tick)
      }
      else {
        collect.endedAtMs = +(performance.now() - window.__waveStart).toFixed(1)
        collect.liveAtEnd = window.__gridAnims().length
      }
    }
    requestAnimationFrame(tick)
  }

  const catchWave = () => {
    if (window.__waveStart !== null)
      return true
    if (document.querySelector('.grid-root.is-waved')) {
      window.__waveStart = performance.now()
      window.__timelineAtWave = Number.isFinite(document.timeline.currentTime) ? document.timeline.currentTime : null
      window.__clockOffsetAtWave = window.__timelineAtWave === null ? null : performance.now() - window.__timelineAtWave
      startAnimCollect()
      return true
    }
    return false
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (catchWave())
      return
    const obs = new MutationObserver(() => {
      if (catchWave())
        obs.disconnect()
    })
    obs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] })
  })

  window.__iconLog = {
    installedAt: performance.now(),
    imgs: [],
    initials: [],
    trace: [],
    traceWindowMs: 1600,
    traceDegraded: null,
    errors: [],
    note: '所有时刻都是 performance.now()，报告里统一减去 __waveStart（观测到 .grid-root.is-waved 的那一刻）',
  }

  window.__settleProbe = () => {
    const read = (el, pseudo) => window.__motionRead(el, pseudo)
    const cells = [...document.querySelectorAll('.tile-cell')]
    return {
      atMs: window.__waveStart === null ? null : +(performance.now() - window.__waveStart).toFixed(1),
      isReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      cellCount: cells.length,
      cells: cells.map((c, i) => {
        const icon = c.querySelector('img.tile-icon, span.tile-initial')
        return {
          index: i,
          id: c.dataset.shortcutId ?? '<add>',
          cell: read(c),
          face: read(c.querySelector('.tile-face')),
          icon: read(icon),
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          pulse: read(c.querySelector('.tile-pulse')),
          name: read(c.querySelector('.tile-name')),
          sheen: read(c.querySelector('.tile-face'), '::after'),
          anim: (() => {
            const st = (el, pseudo) => {
              if (!el)
                return null
              const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el)
              return {
                name: s.animationName,
                delay: s.animationDelay,
                duration: s.animationDuration,
                fill: s.animationFillMode,
                timing: s.animationTimingFunction,
              }
            }
            return {
              cell: st(c),
              icon: st(icon),
              pulse: st(c.querySelector('.tile-pulse')),
              name: st(c.querySelector('.tile-name')),
              sheen: st(c.querySelector('.tile-face'), '::after'),
            }
          })(),
        }
      }),
    }
  }

  if (opts && opts.clearFaviconCache) {
    try {
      const had = localStorage.getItem(opts.faviconCacheKey)
      localStorage.removeItem(opts.faviconCacheKey)
      window.__iconLog.cacheClearedAtDocumentStart = {
        key: opts.faviconCacheKey,
        hadKey: had !== null,
        hadBytes: had ? had.length : 0,
        after: localStorage.getItem(opts.faviconCacheKey),
      }
    }
    catch (e) {
      window.__iconLog.cacheClearedAtDocumentStart = { error: String(e) }
    }
  }
  const shortSrc = (s) => {
    if (!s)
      return null
    if (s.startsWith('data:'))
      return `data:${s.slice(5, 18)}…(${s.length}B)`
    return s.length > 96 ? `${s.slice(0, 96)}…` : s
  }
  const cellMetaOf = (el) => {
    const cell = el?.closest('.tile-cell') ?? null
    return {
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : null,
    }
  }

  const seenImgs = new WeakMap()
  function watchImg(img) {
    if (seenImgs.has(img))
      return
    const rec = {
      ...cellMetaOf(img),
      tag: 'img',
      addedAt: performance.now(),
      srcShort: shortSrc(img.getAttribute('src')),
      srcIsData: (img.getAttribute('src') || '').startsWith('data:'),
      completeAtInsert: img.complete,
      naturalWidthAtInsert: img.naturalWidth,
      loadAt: null,
      loadNaturalWidth: null,
      errorAt: null,
      decodedAt: null,
      decodedNaturalWidth: null,
      decodeFailedAt: null,
      decodeError: null,
    }
    seenImgs.set(img, rec)
    window.__iconLog.imgs.push(rec)
    img.addEventListener('load', () => {
      rec.loadAt = performance.now()
      rec.loadNaturalWidth = img.naturalWidth
    })
    img.addEventListener('error', () => {
      rec.errorAt = performance.now()
    })
    if (typeof img.decode === 'function') {
      img.decode().then(
        () => {
          rec.decodedAt = performance.now()
          rec.decodedNaturalWidth = img.naturalWidth
        },
        (e) => {
          rec.decodeFailedAt = performance.now()
          rec.decodeError = String(e).slice(0, 120)
        },
      )
    }
  }

  const seenInitials = new WeakMap()
  function watchInitial(span) {
    if (seenInitials.has(span))
      return
    const rec = {
      ...cellMetaOf(span),
      tag: 'span.tile-initial',
      text: (span.textContent || '').trim().slice(0, 4),
      addedAt: performance.now(),
      removedAt: null,
    }
    seenInitials.set(span, rec)
    window.__iconLog.initials.push(rec)
  }

  function scanIcons(node) {
    if (node.nodeType !== 1)
      return
    try {
      if (node.matches?.('img.tile-icon'))
        watchImg(node)
      if (node.matches?.('span.tile-initial'))
        watchInitial(node)
      node.querySelectorAll?.('img.tile-icon')?.forEach(watchImg)
      node.querySelectorAll?.('span.tile-initial')?.forEach(watchInitial)
    }
    catch (e) {
      window.__iconLog.errors.push(`scanIcons: ${String(e)}`)
    }
  }

  function installIconWatch() {
    scanIcons(document.documentElement)
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes)
          scanIcons(n)
        for (const n of m.removedNodes) {
          const rec = n.nodeType === 1 ? seenInitials.get(n) : null
          if (rec && n.matches?.('span.tile-initial'))
            rec.removedAt = performance.now()
        }
      }
    })
    mo.observe(document.documentElement, { subtree: true, childList: true })
  }

  if (document.documentElement) {
    installIconWatch()
  }
  else {
    const iv = setInterval(() => {
      if (document.documentElement) {
        clearInterval(iv)
        installIconWatch()
      }
    }, 0)
  }

  function traceTick() {
    try {
      const waveStart = window.__waveStart
      const log = window.__iconLog
      if (waveStart !== null) {
        const t = performance.now() - waveStart
        const marks = log.earlyMarks ?? (log.earlyMarks = {})
        for (const mark of [30, 120]) {
          if (!marks[`t${mark}`] && t >= mark)
            marks[`t${mark}`] = window.__settleProbe()
        }
        if (t >= 0 && t <= log.traceWindowMs && log.trace.length < 400) {
          const cells = document.querySelectorAll('.tile-cell')
          const snap = []
          for (const cell of cells) {
            const icon = cell.querySelector('img.tile-icon, span.tile-initial')
            const kind = icon ? (icon.classList.contains('tile-icon') ? 'img' : 'initial') : null
            const motion = icon ? window.__motionRead(icon) : null
            const pulse = window.__motionRead(cell.querySelector('.tile-pulse'))
            snap.push({
              id: cell.dataset.shortcutId ?? '<add>',
              kind,
              opacity: motion ? motion.opacity : null,
              x: motion ? motion.x : null,
              y: motion ? motion.y : null,
              sx: motion ? motion.sx : null,
              rotateDeg: motion ? motion.rotateDeg : null,
              filter: motion ? motion.filter : null,
              transform: motion ? motion.transform : null,
              scaleProp: motion ? motion.scale : null,
              translateProp: motion ? motion.translate : null,
              pulseOpacity: pulse ? pulse.opacity : null,
              pulseScale: pulse ? pulse.sx : null,
              cellY: null,
              complete: kind === 'img' ? icon.complete : null,
              naturalWidth: kind === 'img' ? icon.naturalWidth : null,
            })
          }
          const firstCell = document.querySelector('.tile-cell')
          const cellMotion = firstCell ? window.__motionRead(firstCell) : null
          if (snap[0] && cellMotion)
            snap[0].cellY = cellMotion.y
          log.trace.push({ t: +t.toFixed(1), cells: snap })
        }
        if (log.traceEndMs === undefined || t > (log.traceEndMs ?? -1))
          log.traceEndMs = +t.toFixed(1)
      }
    }
    catch (e) {
      window.__iconLog.errors.push(`traceTick: ${String(e)}`)
    }
    requestAnimationFrame(traceTick)
  }
  if (opts && opts.liveTrace !== false)
    requestAnimationFrame(traceTick)
  window.__iconLog.traceEnabled = !(opts && opts.liveTrace === false)
}

function harvestIconForensics() {
  const log = window.__iconLog
  const waveStart = window.__waveStart
  const rel = v => (v === null || v === undefined || waveStart === null || waveStart === undefined)
    ? null
    : +(v - waveStart).toFixed(1)
  const cellOf = id => (id === null || id === undefined ? '<add>' : id)
  return {
    installedAtMs: log ? +log.installedAt.toFixed(1) : null,
    waveStartMs: waveStart === null || waveStart === undefined ? null : +waveStart.toFixed(2),
    timelineAtWave: window.__timelineAtWave ?? null,
    clockOffsetAtWave: window.__clockOffsetAtWave ?? null,
    traceWindowMs: log?.traceWindowMs ?? null,
    traceEndMs: log?.traceEndMs ?? null,
    traceDegraded: log?.traceEndMs === undefined ? null : log.traceEndMs < (log.traceWindowMs - 150),
    traceEnabled: log?.traceEnabled ?? null,
    cacheClearedAtDocumentStart: log?.cacheClearedAtDocumentStart ?? null,
    animCollect: window.__animCollect ?? null,
    animMeta: window.__animMeta ?? [],
    animRefCount: window.__animRefs ? window.__animRefs.size : null,
    earlyMarks: log?.earlyMarks ?? null,
    errors: (log?.errors ?? []).slice(0, 20),
    imgs: (log?.imgs ?? []).map(r => ({
      ...r,
      addedRelMs: rel(r.addedAt),
      loadRelMs: rel(r.loadAt),
      decodedRelMs: rel(r.decodedAt),
      errorRelMs: rel(r.errorAt),
      decodeFailedRelMs: rel(r.decodeFailedAt),
      addedAt: undefined,
      loadAt: undefined,
      decodedAt: undefined,
      errorAt: undefined,
      decodeFailedAt: undefined,
    })),
    initials: (log?.initials ?? []).map(r => ({
      ...r,
      addedRelMs: rel(r.addedAt),
      removedRelMs: rel(r.removedAt),
      addedAt: undefined,
      removedAt: undefined,
    })),
    trace: (log?.trace ?? []).map(f => ({
      t: f.t,
      cells: f.cells.map(c => ({ cellKey: cellOf(c.id), ...c, id: undefined })),
    })),
  }
}

async function setStorage(key, value) {
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k]: v }), [key, value])
}

async function waitForFonts() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([
      document.fonts.load('300 3rem "Space Grotesk"', '20:03'),
      document.fonts.load('500 1rem "Manrope"', 'Ziwu'),
    ])
  })
}

async function gridClip() {
  return page.evaluate(() => {
    const el = document.querySelector('.grid-root')
    if (!el)
      return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = el.getBoundingClientRect()
    const x = Math.max(0, Math.floor(r.left - 16))
    const y = Math.max(0, Math.floor(r.top - 24))
    return {
      x,
      y,
      width: Math.max(1, Math.min(vw - x, Math.ceil(r.width + 32))),
      height: Math.max(1, Math.min(vh - y, Math.ceil(r.height + 40))),
    }
  })
}

async function loadNewTab({ reload = true } = {}) {
  if (reload)
    await page.reload()
  await page.waitForSelector('.grid-root.is-waved', { timeout: 15000 })
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await waitForFonts()
  await sleep(settleMs)
}

const favicon = {
  mode: faviconMode,
  sites: siteSet,
  visitSites,
  cacheKey: FAVICON_CACHE_KEY,
  visited: null,
  dbProbeBefore: null,
  dbProbeAfter: null,
  warmup: null,
  cacheClear: null,
  cacheBeforeSample: null,
  cacheAfterSample: null,
}

await sw.evaluate(
  payload => chrome.storage.local.set(payload),
  { 'meridiem-shortcuts': JSON.stringify(SHORTCUTS), 'meridiem-theme': theme },
)
favicon.storageReadback = await sw.evaluate(
  () => chrome.storage.local.get(['meridiem-shortcuts', 'meridiem-theme']),
)

favicon.dbProbeBefore = await faviconDbProbe(SHORTCUTS)
if (faviconMode !== 'cold' && visitSites) {
  favicon.visited = await visitSitesForFaviconDb(SHORTCUTS)
  favicon.dbProbeAfter = await faviconDbProbe(SHORTCUTS)
}

if (faviconMode === 'warm') {
  favicon.warmup = await warmFaviconCachePass()
  favicon.cacheBeforeSample = favicon.warmup.final
  favicon.cacheClear = null
}
else {
  favicon.cacheClear = await clearFaviconCacheOnExtensionPage()
  favicon.cacheBeforeSample = favicon.cacheClear.afterSummary
}

page = await createSamplePage()
if (withReducedMotion)
  await page.emulateMedia({ reducedMotion: 'reduce' })
await page.bringToFront()
await page.goto(newTabUrl)
await page.waitForSelector('[data-test="search-input"]')
await loadNewTab({ reload: false })

favicon.cacheAfterSample = summarizeFaviconCache(await readFaviconCacheRaw(page))
const iconForensicsRaw = await page.evaluate(harvestIconForensics)

const settleRaw = await page.evaluate(() => ({
  settle: window.__settleProbe(),
  early: window.__iconLog?.earlyMarks ?? null,
  visibility: { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() },
}))

function checkSettleState(probe) {
  const violations = []
  const visibleMidway = []
  const neutral = (prop, v) => {
    if (v === null || v === undefined || v === '')
      return true
    const s = String(v).trim()
    if (s === 'none')
      return true
    if (/^0(?:px|%|deg|rad|turn)?$/.test(s))
      return true
    if (/^(?:0(?:px|%|deg|rad|turn)?\s+)+0(?:px|%|deg|rad|turn)?$/.test(s))
      return true
    if (prop === 'scale' && /^1(?:\s+1)?$/.test(s))
      return true
    return false
  }
  for (const c of probe.cells) {
    const label = c.id
    for (const [layer, v] of [['cell', c.cell], ['icon', c.icon], ['name', c.name]]) {
      if (!v)
        continue
      if (v.opacity < 0.999)
        violations.push(`${label} ${layer}.opacity=${v.opacity}（应当已落定为 1）`)
      for (const prop of ['translate', 'scale', 'rotate', 'transform']) {
        if (!neutral(prop, v[prop]))
          violations.push(`${label} ${layer}.${prop}=${v[prop]}（应当已回到 none / 中性值）`)
      }
      if (v.opacity > 0.02 && v.opacity < 0.98)
        visibleMidway.push(`${label} ${layer}.opacity=${v.opacity}`)
    }
    if (c.pulse && c.pulse.opacity > 0.01)
      violations.push(`${label} .tile-pulse.opacity=${c.pulse.opacity}（一次性光，结束态应当是 0）`)
    if (c.sheen && c.sheen.opacity > 0.01)
      violations.push(`${label} 高光 opacity=${c.sheen.opacity}（一次性高光，结束态应当是 0）`)
  }
  return { violations, visibleMidway }
}

function checkNotHiddenEarly(early) {
  const offenders = []
  for (const [mark, probe] of Object.entries(early ?? {})) {
    for (const c of probe.cells) {
      for (const [layer, v] of [['cell', c.cell], ['icon', c.icon], ['name', c.name]]) {
        if (v && v.opacity < 0.999)
          offenders.push(`${mark} ${c.id} ${layer}.opacity=${v.opacity}`)
      }
    }
  }
  return offenders
}

const reducedMotion = {
  emulated: withReducedMotion,
  mediaMatchesAtSettle: settleRaw.settle.isReducedMotion,
  earlySampleMarks: Object.keys(settleRaw.early ?? {}),
  early: settleRaw.early,
  settle: settleRaw.settle,
  finalCheck: checkSettleState(settleRaw.settle),
  earlyCheck: checkNotHiddenEarly(settleRaw.early),
  note: '早期待拍点（t≈30ms / t≈120ms）用来判「reduce 下有没有格子在 delay 期间被藏起来」；'
  + 'settle 是入场跑完后的落定态。reduce 时全局规则会把 animation-duration 压到 0.01ms、delay 清 0（见 src/styles/main.css）。',
}
if (withReducedMotion) {
  const reduceAnims = (iconForensicsRaw.animMeta ?? []).filter(a => typeof a.delayMs === 'number' && a.kind !== 'transition')
  const offendingDelays = reduceAnims.filter(a => a.delayMs > 0).map(a => `${a.target}:${a.delayMs}ms`)
  const layers = []
  for (const c of settleRaw.settle.cells) {
    for (const [layer, v] of Object.entries(c.anim ?? {})) {
      if (v)
        layers.push({ id: c.id, layer, ...v })
    }
  }
  const delayedLayers = layers.filter(l => !/^0s?(?:,\s*0s?)*$/.test(l.delay.trim()))
  const durationOf = l => l.duration.trim()
  const delayCleared = (reduceAnims.length > 0 || layers.length > 0) && delayedLayers.length === 0
  const settledOk = reducedMotion.finalCheck.violations.length === 0
  reducedMotion.reduceAnims = {
    collectedAnimations: reduceAnims.length,
    collectedNames: [...new Set(reduceAnims.map(a => a.animationName))],
    computedLayerCount: layers.length,
    computedDurationValues: [...new Set(layers.map(durationOf))].slice(0, 6),
    computedDelayValues: [...new Set(layers.map(l => l.delay.trim()))].slice(0, 6),
    offendingDelays,
    note: 'computed* 来自 CSS 层叠（与动画处于哪个相无关），collected* 是 rAF 收集到的动画对象；'
    + 'reduce 下动画只活 0.01ms，所以结构结论以 computed* 为准',
  }
  reducedMotion.verdict = {
    delayCleared: delayCleared
      ? `PASS（${layers.length} 个图层的 computed animation-delay 全为 0s → delay 期间不可能藏住任何东西）`
      : `FAIL（仍有图层带 delay：${delayedLayers.slice(0, 5).map(l => `${l.id}.${l.layer}:${l.delay}`).join(', ')}）`,
    settledAtEnd: settledOk
      ? 'PASS（落定态：磁贴/图标/站名的 translate·scale·rotate·transform 全为 none，pulse 不可见）'
      : `FAIL（落定残留 ${reducedMotion.finalCheck.violations.length} 条：${reducedMotion.finalCheck.violations.slice(0, 3).join(' | ')}）`,
    firstFramesObservation: reducedMotion.earlyCheck.length > 0
      ? `观察（不是 delay 违规）：入场开始后的最初几个合成帧里仍有 ${reducedMotion.earlyCheck.length} 处主层 opacity<1，`
      + '即落在 0% 关键帧上 —— 见 iconForensics.hiddenSpan'
      : '未观察到（入场最早的那一帧就已经是落定态）',
    overall: (delayCleared && settledOk) ? 'PASS' : 'FAIL',
  }
}
else {
  reducedMotion.verdict = 'NOT-ASSERTED（本轮不是 reduce 模式，只留原始读数作对照）'
}

const metrics = await page.evaluate(() => {
  const grid = document.querySelector('.tile-grid')
  const cells = [...document.querySelectorAll('.tile-cell')]
  const cs = el => getComputedStyle(el)
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
    return `${el.tagName.toLowerCase()}${cls.map(c => `.${c}`).join('')}`
  }
  const entries = window.__gridAnims().map(({ a, hit }) => {
    const timing = a.effect.getTiming()
    const style = hit.pseudo ? getComputedStyle(hit.el, hit.pseudo) : cs(hit.el)
    const cell = hit.el.closest('.tile-cell')
    const cls = typeof hit.el.className === 'string' ? hit.el.className.split(/\s+/).filter(Boolean) : []
    const startTime = Number.isFinite(a.startTime) ? +a.startTime.toFixed(2) : null
    let keyframes = null
    try {
      keyframes = a.effect.getKeyframes().map(k => ({
        computedOffset: typeof k.computedOffset === 'number' ? +k.computedOffset.toFixed(4) : null,
        offset: typeof k.offset === 'number' ? k.offset : k.offset,
        easing: k.easing ?? null,
        composite: k.composite ?? null,
      }))
    }
    catch {
      keyframes = null
    }
    const easingSegments = keyframes
      ? keyframes.slice(0, -1).map((k, i) => ({
        fromPct: k.computedOffset === null ? null : +(k.computedOffset * 100).toFixed(2),
        toPct: keyframes[i + 1].computedOffset === null ? null : +(keyframes[i + 1].computedOffset * 100).toFixed(2),
        easing: k.easing ?? null,
      }))
      : null
    return {
      target: `${describe(hit.el)}${hit.pseudo ?? ''}`,
      targetBase: describe(hit.el),
      pseudo: hit.pseudo,
      iconKind: cls.includes('tile-icon') ? 'img' : (cls.includes('tile-initial') ? 'initial' : null),
      tag: hit.el.tagName.toLowerCase(),
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : false,
      animationName: style.animationName,
      durationMs: timing.duration,
      delayMs: timing.delay,
      fill: timing.fill,
      animationEasing: timing.easing,
      easing: timing.easing,
      easingNote: 'easing = effect.getTiming().easing（动画级）；逐段曲线看 easingSegments / keyframes[].easing',
      keyframes,
      easingSegments,
      iterations: timing.iterations,
      playState: a.playState,
      startTime,
      startTimeRelWaveMs: (startTime !== null && window.__timelineAtWave !== null && window.__timelineAtWave !== undefined)
        ? +(startTime - window.__timelineAtWave).toFixed(1)
        : null,
      currentTime: Number.isFinite(a.currentTime) ? +a.currentTime.toFixed(2) : null,
    }
  })

  const groups = new Map()
  for (const e of entries) {
    const key = `${e.target}|${e.animationName}|${e.durationMs}|${e.fill}|${e.easing}`
    if (!groups.has(key)) {
      groups.set(key, {
        target: e.target,
        animationName: e.animationName,
        durationMs: e.durationMs,
        fill: e.fill,
        animationEasing: e.animationEasing,
        easingSegments: e.easingSegments,
        keyframes: e.keyframes,
        delaysMs: [],
        count: 0,
        exampleCellIds: [],
      })
    }
    const g = groups.get(key)
    g.count++
    if (!g.delaysMs.includes(e.delayMs))
      g.delaysMs.push(e.delayMs)
    if (g.exampleCellIds.length < 4)
      g.exampleCellIds.push(e.cellId ?? (e.inAddCell ? '<add>' : `<idx=${e.cellIndex}>`))
  }

  const rootStyle = cs(document.documentElement)
  return {
    viewportActual: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      narrowMediaQuery: window.matchMedia('(max-width: 768px)').matches,
    },
    columns: grid ? cs(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
    gridTemplateColumns: grid ? cs(grid).gridTemplateColumns : null,
    tileCellCount: cells.length,
    shortcutTileCount: document.querySelectorAll('.tile-cell .tile').length,
    rows: grid ? new Set(cells.map(c => Math.round(c.getBoundingClientRect().top))).size : 0,
    tokens: {
      durEnter: rootStyle.getPropertyValue('--dur-enter').trim(),
      durBase: rootStyle.getPropertyValue('--dur-base').trim(),
    },
    cells: cells.map((c, i) => ({
      index: i,
      id: c.dataset.shortcutId ?? null,
      isAddCell: !c.dataset.shortcutId,
      delayVar: c.style.getPropertyValue('--tile-enter-delay').trim() || null,
      animationName: cs(c).animationName,
      animationDelay: cs(c).animationDelay,
      animationDuration: cs(c).animationDuration,
      transformAtRest: cs(c).transform,
      translateAtRest: cs(c).translate,
      scaleAtRest: cs(c).scale,
      rotateAtRest: cs(c).rotate,
      opacityAtRest: cs(c).opacity,
      rect: (() => {
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })(),
    })),
    animations: entries,
    animationGroups: [...groups.values()].map(g => ({ ...g, delaysMs: g.delaysMs.sort((a, b) => a - b) })),
  }
})

const raf = await page.evaluate(() => {
  const waveStart = window.__waveStart
  const windowEnd = (waveStart ?? 0) + 1200
  const stats = (frames, source) => {
    const inWindow = frames.filter(t => waveStart !== null && t >= waveStart && t <= windowEnd)
    const deltas = []
    for (let i = 1; i < inWindow.length; i++)
      deltas.push(+(inWindow[i] - inWindow[i - 1]).toFixed(2))
    const long = deltas.filter(d => d > 20)
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null
    return {
      source,
      sampledFrames: inWindow.length,
      totalFrames: frames.length,
      framesBeforeWave: waveStart === null ? null : frames.filter(t => t < waveStart).length,
      firstFrameMs: frames.length ? +frames[0].toFixed(2) : null,
      lastFrameMs: frames.length ? +frames[frames.length - 1].toFixed(2) : null,
      spanMs: inWindow.length ? +(inWindow[inWindow.length - 1] - inWindow[0]).toFixed(2) : null,
      avgFrameMs: avg === null ? null : +avg.toFixed(2),
      avgFps: avg ? +(1000 / avg).toFixed(1) : null,
      longFrameCount: long.length,
      maxFrameMs: deltas.length ? Math.max(...deltas) : null,
      longDeltas: long,
      deltas,
    }
  }
  const r = stats(window.__rafFrames ?? [], 'requestAnimationFrame')
  return {
    ...r,
    waveStartMs: waveStart === null ? null : +waveStart.toFixed(2),
    jank: stats(window.__jankFrames ?? [], 'setTimeout(16)'),
    note: 'window = [is-waved 起, +1200ms]。rAF 的帧数取决于这段编排让画面动了多久'
    + '（headless 下页面静止就不再产帧），所以 sampledFrames / avgFps **不能跨轮直接比**；'
    + '跨轮比 maxFrameMs / longFrameCount，以及 jank（setTimeout 口径）。',
  }
})

const frames = []
let freezeRefs = null
let refsOk = false
if (withFrames) {
  freezeRefs = await page.evaluate(() => {
    const refs = [...(window.__animRefs ?? [])]
    refs.forEach(a => a.pause())
    return {
      count: refs.length,
      liveAtPauseTime: window.__gridAnims().length,
      collect: window.__animCollect ?? null,
    }
  })
  refsOk = freezeRefs.count > 0
  console.log(`  paused ${freezeRefs.count} grid animations（入场期间收下的引用；此刻现场只剩 ${freezeRefs.liveAtPauseTime} 条）`)
  if (!refsOk) {
    problems.push('定格失败：入场期间没有收到任何动画引用（__animRefs.size === 0）。'
    + '常见原因是 fill-mode 从 both 改成 backwards、或起波检测失效 —— '
    + '此时逐帧图只会是落定态，因此跳过逐帧/轨迹采样并以非零码退出。')
    console.error('  !! 定格失败：__animRefs 为空 —— 跳过逐帧与图层轨迹采样（不产出假帧）')
  }
}

if (withFrames && refsOk) {
  const clip = await gridClip()
  console.log(`  freeze clip ${JSON.stringify(clip)}`)

  for (let t = from; t <= to; t += step) {
    const state = await page.evaluate((time) => {
      window.__animRefs.forEach((a) => {
        a.currentTime = time
      })
      document.documentElement.getBoundingClientRect()
      const cells = [...document.querySelectorAll('.tile-cell.is-entering')]
      const sample = cells.map(c => window.__motionRead(c))
      const icon = cells[0] ? cells[0].querySelector('.tile-icon, .tile-initial') : null
      const iconMotion = icon ? window.__motionRead(icon) : null
      const cell0 = sample[0] ?? null
      return {
        firstCellTransform: cell0 ? cell0.transform : null,
        firstCellTranslate: cell0 ? cell0.translate : null,
        firstCellOpacity: cell0 ? cell0.opacity : null,
        firstIconTransform: iconMotion ? iconMotion.transform : null,
        firstIconScale: iconMotion ? iconMotion.sx : null,
        firstIconRotateDeg: iconMotion ? iconMotion.rotateDeg : null,
        firstIconRiseY: iconMotion ? iconMotion.y : null,
        firstIconOpacity: iconMotion ? iconMotion.opacity : null,
        cellsLanded: sample.filter(s => s && s.opacity >= 0.5).length,
        total: sample.length,
        opacities: sample.map(s => (s ? s.opacity : null)),
        riseByCell: sample.map(s => (s ? s.y : null)),
        scaleByCell: sample.map(s => (s ? s.sx : null)),
      }
    }, t)

    const file = `frame-t${String(t).padStart(4, '0')}.png`
    const shot = await page.screenshot({ path: path.join(outDir, file), clip })
    frames.push({ t, file, b64: shot.toString('base64'), ...state })
    if (t === from || t === to)
      await page.screenshot({ path: path.join(outDir, `viewport-t${String(t).padStart(4, '0')}.png`) })
    console.log(`  frame t=${t}ms  landed=${state.cellsLanded}/${state.total}  first-cell opacity=${state.firstCellOpacity}  icon scale=${state.firstIconScale}`)
  }
}

const zoomFrames = []
let zoomClipRect = null
if (withFrames && withZoom) {
  zoomClipRect = await page.evaluate((idx) => {
    const cell = document.querySelectorAll('.tile-cell')[idx]
    if (!cell)
      return null
    const r = cell.getBoundingClientRect()
    const pad = 14
    const x = Math.max(0, Math.floor(r.left - pad))
    const y = Math.max(0, Math.floor(r.top - pad))
    return {
      x,
      y,
      width: Math.max(1, Math.min(window.innerWidth - x, Math.ceil(r.width + pad * 2))),
      height: Math.max(1, Math.min(window.innerHeight - y, Math.ceil(r.height + pad * 2))),
    }
  }, zoomTile)
  if (!zoomClipRect) {
    problems.push(`--zoom 指定的第 ${zoomTile} 格不存在`)
  }
  else {
    console.log(`  zoom clip ${JSON.stringify(zoomClipRect)} @dsf=${dsf}`)
    for (let t = zoomFrom; t <= zoomTo; t += zoomStep) {
      const state = await page.evaluate(({ time, idx }) => {
        window.__animRefs.forEach((a) => {
          a.currentTime = time
        })
        document.documentElement.getBoundingClientRect()
        const cell = document.querySelectorAll('.tile-cell')[idx]
        if (!cell)
          return null
        const icon = cell.querySelector('img.tile-icon, span.tile-initial')
        const motion = window.__motionRead(icon)
        const pulse = window.__motionRead(cell.querySelector('.tile-pulse'))
        const cellMotion = window.__motionRead(cell)
        return {
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          iconOpacity: motion ? motion.opacity : null,
          iconScale: motion ? motion.sx : null,
          iconRotateDeg: motion ? motion.rotateDeg : null,
          iconRiseY: motion ? motion.y : null,
          pulseOpacity: pulse ? pulse.opacity : null,
          pulseScale: pulse ? pulse.sx : null,
          cellOpacity: cellMotion ? cellMotion.opacity : null,
          cellY: cellMotion ? cellMotion.y : null,
        }
      }, { time: t, idx: zoomTile })
      const file = `zoom-t${String(t).padStart(4, '0')}.png`
      const shot = await page.screenshot({ path: path.join(outDir, file), clip: zoomClipRect })
      zoomFrames.push({ t, file, b64: shot.toString('base64'), ...state })
    }
    console.log(`  zoom frames ${zoomFrames.length}（t=${zoomFrom}…${zoomTo} step ${zoomStep}，第 ${zoomTile} 格）`)
  }
}

const iconTrack = []
if (withFrames && refsOk) {
  for (let t = 0; t <= iconTo; t += iconStep) {
    const s = await page.evaluate((time) => {
      window.__animRefs.forEach((a) => {
        a.currentTime = time
      })
      document.documentElement.getBoundingClientRect()
      const num = v => +Number(v).toFixed(3)
      const readCell = (cell) => {
        if (!cell)
          return null
        const icon = cell.querySelector('.tile-icon, .tile-initial')
        const pulse = cell.querySelector('.tile-pulse')
        const motion = window.__motionRead(icon)
        const pulseMotion = window.__motionRead(pulse)
        const name = window.__motionRead(cell.querySelector('.tile-name'))
        const sheen = window.__motionRead(cell.querySelector('.tile-face'), '::after')
        return {
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          iconTransform: motion ? motion.transform : null,
          iconTranslate: motion ? motion.translate : null,
          iconScaleProp: motion ? motion.scale : null,
          iconRotateProp: motion ? motion.rotate : null,
          iconScale: motion ? motion.sx : null,
          iconRotateDeg: motion ? motion.rotateDeg : null,
          iconRiseY: motion ? motion.y : null,
          iconOpacity: motion ? motion.opacity : null,
          iconFilter: motion ? motion.filter : null,
          iconNaturalWidth: icon && icon.tagName === 'IMG' ? icon.naturalWidth : null,
          pulseOpacity: pulseMotion ? pulseMotion.opacity : null,
          pulseScale: pulseMotion ? pulseMotion.sx : null,
          nameOpacity: name ? name.opacity : null,
          nameTranslate: name ? num(name.y) : null,
          sheenOpacity: sheen ? sheen.opacity : null,
          sheenTransform: sheen ? sheen.transform : null,
        }
      }
      const cells = [...document.querySelectorAll('.tile-cell.is-entering')]
      const addBtn = document.querySelector('.add-tile')
      const addMotion = window.__motionRead(addBtn)
      return {
        t: time,
        cellsLanded: cells.filter(c => Number(getComputedStyle(c).opacity) >= 0.5).length,
        total: cells.length,
        c0: readCell(cells[0]),
        c1: readCell(cells[1]),
        add: addMotion
          ? {
              scale: addMotion.scale,
              scaleEffective: addMotion.sx,
              rotate: addMotion.rotate,
              translate: addMotion.translate,
              opacity: addMotion.opacity,
              filter: addMotion.filter,
              transform: addMotion.transform,
            }
          : null,
        all: cells.map((c, i) => ({
          index: i,
          id: c.dataset.shortcutId ?? null,
          isAdd: !c.dataset.shortcutId,
          cellTranslate: getComputedStyle(c).translate,
          cellY: (window.__motionRead(c) || {}).y ?? null,
          ...readCell(c),
        })),
      }
    }, t)
    iconTrack.push(s)
  }
}

async function settleAfterFreeze() {
  await page.evaluate(() => {
    const refs = [...(window.__animRefs ?? [])]
    for (const a of refs) {
      try {
        a.currentTime = 1e6
        a.play()
      }
      catch {
      }
    }
  })
  await sleep(800)
}

if (withFrames)
  await settleAfterFreeze()

function hoverProbe() {
  return page.evaluate(() => {
    const cs = el => getComputedStyle(el)
    const read = (el) => {
      if (!el)
        return null
      const style = cs(el)
      return {
        transform: style.transform,
        translateY: style.transform === 'none' ? 0 : +new DOMMatrixReadOnly(style.transform).m42.toFixed(2),
        scale: style.scale,
        opacity: +Number(style.opacity).toFixed(3),
        filter: style.filter,
        translate: style.translate,
      }
    }
    const cell = document.querySelector('.tile-cell[data-tile-index="0"]')
    const add = document.querySelector('.add-tile')
    return {
      face: read(cell?.querySelector('.tile-face')),
      cell: read(cell),
      icon: read(cell?.querySelector('.tile-icon, .tile-initial')),
      name: read(cell?.querySelector('.tile-name')),
      addTile: read(add),
      addCell: read(add?.closest('.tile-cell')),
      isEditing: Boolean(document.querySelector('.tile.is-editing')),
      runningEntranceAnims: window.__gridAnims().filter(x => x.a.playState === 'running').length,
      liveEntranceAnims: window.__gridAnims().length,
    }
  })
}

const hover = { isEditing: (await hoverProbe()).isEditing }
hover.rest = await hoverProbe()
await page.hover('.tile-cell[data-tile-index="0"] .tile-face')
await sleep(500)
hover.hoverFace = await hoverProbe()
await page.screenshot({ path: path.join(outDir, 'hover-clip.png'), clip: await gridClip() })
await page.screenshot({ path: path.join(outDir, 'hover-viewport.png') })
await page.mouse.move(2, 2)
await sleep(500)
hover.restAfter = await hoverProbe()
await page.hover('.add-tile')
await sleep(500)
hover.hoverAdd = await hoverProbe()
if (withFrames && refsOk)
  await page.screenshot({ path: path.join(outDir, 'hover-add-clip.png'), clip: await gridClip() })
await page.mouse.move(2, 2)
await sleep(500)
hover.restAfterAdd = await hoverProbe()

const restSampleClean = Boolean(hover.rest) && hover.rest.runningEntranceAnims === 0
function residueGate(fn) {
  return restSampleClean
    ? fn()
    : `SKIP（静止态采样时仍有 ${hover.rest?.runningEntranceAnims ?? '?'} 条入场动画在跑，该断言不适用）`
}

hover.verdicts = {
  faceHoverLift: hover.rest && hover.hoverFace
    ? (hover.hoverFace.face.translateY < hover.rest.face.translateY - 2 ? 'PASS' : `FAIL (${hover.rest.face.translateY} → ${hover.hoverFace.face.translateY})`)
    : 'UNKNOWN',
  faceBackToRest: hover.restAfter && hover.rest
    ? (hover.restAfter.face.translateY === hover.rest.face.translateY ? 'PASS' : `FAIL (rest ${hover.rest.face.translateY} → 移开后 ${hover.restAfter.face.translateY})`)
    : 'UNKNOWN',
  addTileHoverLift: hover.rest && hover.hoverAdd
    ? (hover.hoverAdd.addTile.translateY < hover.rest.addTile.translateY - 2 ? 'PASS' : `FAIL (${hover.rest.addTile.translateY} → ${hover.hoverAdd.addTile.translateY})`)
    : 'UNKNOWN',
  addTileBackToRest: hover.restAfterAdd && hover.rest
    ? (hover.restAfterAdd.addTile.translateY === hover.rest.addTile.translateY ? 'PASS' : `FAIL (${hover.rest.addTile.translateY} → 移开后 ${hover.restAfterAdd.addTile.translateY})`)
    : 'UNKNOWN',
  iconNoResidue: residueGate(() => (Math.abs(hover.rest.icon.translateY) < 0.01 ? 'PASS' : `FAIL 残留位移 ${hover.rest.icon.translateY}`)),
  labelNoResidue: residueGate(() => (hover.rest.name.translate === 'none' || hover.rest.name.translate === '0px' ? 'PASS' : `FAIL 残留 translate ${hover.rest.name.translate}`)),
  cellNoResidue: residueGate(() => (hover.rest.cell.transform === 'none' || hover.rest.cell.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'PASS' : `FAIL 残留 transform ${hover.rest.cell.transform}`)),
  addScaleNoResidue: residueGate(() => (hover.rest.addTile.scale === 'none' || hover.rest.addTile.scale === '1' ? 'PASS' : `FAIL 残留 scale ${hover.rest.addTile.scale}`)),
}
hover.gate = {
  restSampleClean,
  runningEntranceAnimsAtRest: hover.rest?.runningEntranceAnims ?? null,
  liveEntranceAnimsAtRest: hover.rest?.liveEntranceAnims ?? null,
  note: 'restSampleClean=false 时，icon/label/cell/addScale 四条残留断言记 SKIP；'
  + '采样前会把动画推到结束之后并等 800ms 落定（settleAfterFreeze）',
}

let freezeCheck = null
if (withFreeze) {
  await loadNewTab()
  const domState = () => page.evaluate(() => {
    const cs = el => getComputedStyle(el)
    const cells = [...document.querySelectorAll('.tile-cell')]
    return {
      at: new Date().toISOString(),
      timelineNow: Number.isFinite(document.timeline.currentTime) ? +document.timeline.currentTime.toFixed(2) : null,
      cellCount: cells.length,
      cells: cells.map((c, i) => ({
        index: i,
        id: c.dataset.shortcutId ?? null,
        isAdd: !c.dataset.shortcutId,
        classes: c.className,
        isEntering: c.classList.contains('is-entering'),
        isFresh: c.classList.contains('is-fresh'),
        delayVar: c.style.getPropertyValue('--tile-enter-delay').trim(),
        animationName: cs(c).animationName,
        computedDelay: cs(c).animationDelay,
        opacity: +Number(cs(c).opacity).toFixed(3),
      })),
    }
  })

  async function snapshotDuring(mutate) {
    const collecting = page.evaluate(() => window.__collectAnimMeta(900))
    await sleep(80)
    await mutate()
    const collected = await collecting
    const dom = await domState()
    const asFreezeAnim = m => ({
      key: `${m.cellId ?? '<add>'}::${m.target}::${m.animationName}`,
      cellId: m.cellId,
      inAddCell: m.inAddCell,
      target: m.target,
      name: m.animationName,
      startTime: m.startTime,
      currentTime: m.currentTimeMs,
      delayMs: m.delayMs,
      playState: m.playState,
      firstSeenRelWaveMs: m.firstSeenRelWaveMs,
    })
    const anims = collected.filter(m => m.kind !== 'transition').map(asFreezeAnim)
    const transitions = collected.filter(m => m.kind === 'transition').map(asFreezeAnim)
    return {
      ...dom,
      anims,
      transitions,
      collectedCount: collected.length,
      animationCount: anims.length,
      transitionCount: transitions.length,
      collectWindowMs: 900,
    }
  }

  const before = await snapshotDuring(async () => {})
  const afterRemove = await snapshotDuring(() =>
    setStorage('meridiem-shortcuts', JSON.stringify(SHORTCUTS.filter(s => s.id !== REMOVE_ID))))
  const afterAdd = await snapshotDuring(() =>
    setStorage('meridiem-shortcuts', JSON.stringify([...SHORTCUTS.filter(s => s.id !== REMOVE_ID), ADDED])))

  const diffStart = (a, b) => {
    const mapB = new Map(b.anims.map(x => [x.key, x]))
    const changed = []
    const missing = []
    for (const x of a.anims) {
      const y = mapB.get(x.key)
      if (!y) {
        missing.push({ key: x.key, startTimeBefore: x.startTime })
        continue
      }
      if (x.startTime !== y.startTime || x.currentTime !== y.currentTime)
        changed.push({ key: x.key, startTime: [x.startTime, y.startTime], currentTime: [x.currentTime, y.currentTime], delayMs: [x.delayMs, y.delayMs] })
    }
    const mapA = new Map(a.anims.map(x => [x.key, x]))
    const added = b.anims.filter(x => !mapA.has(x.key)).map(x => ({ key: x.key, startTime: x.startTime, delayMs: x.delayMs, playState: x.playState }))
    return { changed, missing, added }
  }

  const idDelays = s => Object.fromEntries(s.cells.filter(c => c.id).map(c => [c.id, c.delayVar]))
  const compareIdDelays = (a, b) => Object.keys(a)
    .filter(id => id in b && b[id] !== a[id])
    .map(id => ({ id, before: a[id], after: b[id] }))
  const delayChangedOnRemove = compareIdDelays(idDelays(before), idDelays(afterRemove))
  const delayChangedOnAdd = compareIdDelays(idDelays(afterRemove), idDelays(afterAdd))

  freezeCheck = {
    collectNote: '每张快照都在页面里跑 400ms 的 rAF 收集（__collectAnimMeta）——'
    + 'fill:backwards 之下入场动画跑完就消失，删/增一格触发的动画只在它自己的几百毫秒里存在，'
    + '现取 getAnimations() 会得到空表、让断言静默空转。',
    collectNotVacuous: afterAdd.anims.length > 0
      ? `PASS（新增后收到 ${afterAdd.anims.length} 条新动画，收集链路有效）`
      : 'FAIL（新增后一条动画都没收到：断言在空转，下面的结论不可信）',
    removeTriggeredNoReentrance: afterRemove.anims.length === 0
      ? `PASS（删掉一格后没有任何新动画产生 —— 后面的格子没有被重新入场；同期有 ${afterRemove.transitionCount} 条过渡）`
      : `FAIL（删掉一格后有 ${afterRemove.anims.length} 条新动画：${afterRemove.anims.slice(0, 4).map(a => `${a.cellId ?? '<add>'}:${a.name}`).join(', ')}）`,
    addTouchedOnlyNewCell: (() => {
      const others = afterAdd.anims.filter(a => a.cellId !== ADDED.id && !a.inAddCell)
      return others.length === 0
        ? `PASS（新增只给新格挂了动画：${afterAdd.anims.map(a => a.name).join(', ')}）`
        : `FAIL（其它格也被触发了：${others.slice(0, 4).map(a => `${a.cellId}:${a.name}`).join(', ')}）`
    })(),
    collectedCounts: { before: before.collectedCount, afterRemove: afterRemove.collectedCount, afterAdd: afterAdd.collectedCount },
    transitionCounts: { before: before.transitionCount, afterRemove: afterRemove.transitionCount, afterAdd: afterAdd.transitionCount },
    before: { cellCount: before.cellCount, animCount: before.anims.length, timelineNow: before.timelineNow, idDelays: idDelays(before), cells: before.cells },
    afterRemove: { cellCount: afterRemove.cellCount, animCount: afterRemove.anims.length, timelineNow: afterRemove.timelineNow, idDelays: idDelays(afterRemove), cells: afterRemove.cells, removedIds: Object.keys(idDelays(before)).filter(id => !(id in idDelays(afterRemove))) },
    afterAdd: { cellCount: afterAdd.cellCount, animCount: afterAdd.anims.length, timelineNow: afterAdd.timelineNow, idDelays: idDelays(afterAdd), cells: afterAdd.cells, freshCellIds: afterAdd.cells.filter(c => c.isFresh).map(c => c.id) },
    delayVarUnchangedOnRemove: delayChangedOnRemove.length === 0 ? 'IDENTICAL（按 id 逐条相同）' : 'CHANGED',
    delayVarChangedOnRemove: delayChangedOnRemove,
    delayVarUnchangedOnAdd: delayChangedOnAdd.length === 0 ? 'IDENTICAL（按 id 逐条相同）' : 'CHANGED',
    delayVarChangedOnAdd: delayChangedOnAdd,
    removeDiff: diffStart(before, afterRemove),
    addDiff: diffStart(afterRemove, afterAdd),
    addCell: {
      newId: ADDED.id,
      cell: afterAdd.cells.find(c => c.id === ADDED.id) ?? null,
      addCellBefore: afterRemove.cells.find(c => c.isAdd) ?? null,
      addCellAfter: afterAdd.cells.find(c => c.isAdd) ?? null,
      newIdAnims: afterAdd.anims.filter(x => x.cellId === ADDED.id),
      otherAnimsStartTimeChanged: diffStart(afterRemove, afterAdd).changed.length,
    },
    snapshotRaw: { before, afterRemove, afterAdd },
  }
}

let pixelStats = null
if (withFrames && frames.length) {
  const html = `<!doctype html><meta charset="utf-8"><title>wave filmstrip ${round} ${theme} ${vpLabel}</title>
<style>
  body { margin: 0; padding: 16px; background: #11141a; color: #e8edf2;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p.meta { margin: 0 0 14px; color: #9aa7b4; }
  .strip { display: grid; grid-template-columns: repeat(2, max-content); gap: 10px; align-items: start; }
  figure { margin: 0; }
  img { display: block; width: 680px; height: auto; border: 1px solid #2a313c; border-radius: 4px; }
  figcaption { margin-top: 3px; color: #8fa0b3; font-variant-numeric: tabular-nums; }
  figcaption b { color: #e8edf2; font-weight: 600; }
</style>
<h1>磁贴入场编排 · ${round} · ${theme} · ${vpLabel}${label ? ` (${label})` : ''}</h1>
<p class="meta">列数 ${metrics.columns} · 行数 ${metrics.rows} · 格数 ${metrics.tileCellCount} · 每帧 T 为动画自身时间轴毫秒（含 delay）</p>
<div class="strip">
${frames.map(f => `  <figure><img src="data:image/png;base64,${f.b64}"><figcaption><b>t=${f.t}ms</b> · 落位 ${f.cellsLanded}/${f.total} · 首格 opacity ${f.firstCellOpacity}</figcaption></figure>`).join('\n')}
</div>`
  fs.writeFileSync(path.join(outDir, 'filmstrip.html'), html)

  const strip = await browser.newPage()
  await strip.setViewportSize({ width: 1440, height: 900 })
  await strip.setContent(html, { waitUntil: 'load' })
  await strip.waitForTimeout(300)

  pixelStats = await strip.evaluate(() => {
    const imgs = [...document.querySelectorAll('.strip img')]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const out = []
    let base = null
    for (const img of imgs) {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let luma = 0
      for (let p = 0; p < data.length; p += 4)
        luma += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
      if (!base)
        base = data.slice()
      let diff = 0
      for (let p = 0; p < data.length; p += 4) {
        if (Math.abs(data[p] - base[p]) > 12
          || Math.abs(data[p + 1] - base[p + 1]) > 12
          || Math.abs(data[p + 2] - base[p + 2]) > 12) {
          diff++
        }
      }
      out.push({ w: canvas.width, h: canvas.height, meanLuma: +(luma / (data.length / 4)).toFixed(2), diffPixelsVsFirst: diff, totalPixels: data.length / 4 })
    }
    return out
  })

  await strip.screenshot({ path: path.join(outDir, 'filmstrip.png'), fullPage: true })
  await strip.close()
}

if (zoomFrames.length) {
  const imgW = Math.round(zoomClipRect.width * dsf)
  const html = `<!doctype html><meta charset="utf-8"><title>icon close-up ${round} ${theme}</title>
<style>
  body { margin: 0; padding: 16px; background: #11141a; color: #e8edf2;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p.meta { margin: 0 0 14px; color: #9aa7b4; }
  .strip { display: grid; grid-template-columns: repeat(8, max-content); gap: 8px; align-items: start; }
  figure { margin: 0; }
  img { display: block; width: ${imgW}px; height: auto; border: 1px solid #2a313c; border-radius: 4px; }
  figcaption { margin-top: 3px; color: #8fa0b3; font-variant-numeric: tabular-nums; font-size: 11px; }
  figcaption b { color: #e8edf2; font-weight: 600; }
</style>
<h1>图标特写 · ${round} · ${theme} · 第 ${zoomTile} 格 · dsf=${dsf}</h1>
<p class="meta">T 为该格动画自身时间轴毫秒（含 delay）· 裁切 ${zoomClipRect.width}×${zoomClipRect.height} CSS px · 每格 ${imgW}px 宽</p>
<div class="strip">
${zoomFrames.map(f => `  <figure><img src="data:image/png;base64,${f.b64}"><figcaption><b>t=${f.t}</b><br>s=${f.iconScale ?? '—'} r=${f.iconRotateDeg ?? '—'}°<br>o=${f.iconOpacity ?? '—'}</figcaption></figure>`).join('\n')}
</div>`
  fs.writeFileSync(path.join(outDir, 'zoom-filmstrip.html'), html)
  const zstrip = await browser.newPage()
  await zstrip.setViewportSize({ width: 1440, height: 900 })
  await zstrip.setContent(html, { waitUntil: 'load' })
  await zstrip.waitForTimeout(300)
  await zstrip.screenshot({ path: path.join(outDir, 'zoom-filmstrip.png'), fullPage: true })
  await zstrip.close()
}

function groupAnimations(entries) {
  const groups = new Map()
  for (const e of entries) {
    const key = `${e.target}|${e.animationName}|${e.durationMs}|${e.fill}`
    if (!groups.has(key)) {
      groups.set(key, {
        target: e.target,
        animationName: e.animationName,
        durationMs: e.durationMs,
        fill: e.fill,
        animationEasing: e.animationEasing,
        easingSegments: e.easingSegments ?? null,
        keyframes: e.keyframes ?? null,
        delaysMs: [],
        count: 0,
        exampleCellIds: [],
        startTimeRelWaveMs: [],
      })
    }
    const g = groups.get(key)
    g.count++
    if (!g.delaysMs.includes(e.delayMs))
      g.delaysMs.push(e.delayMs)
    if (e.startTimeRelWaveMs !== null && e.startTimeRelWaveMs !== undefined && !g.startTimeRelWaveMs.includes(e.startTimeRelWaveMs))
      g.startTimeRelWaveMs.push(e.startTimeRelWaveMs)
    if (g.exampleCellIds.length < 4)
      g.exampleCellIds.push(e.cellId ?? (e.inAddCell ? '<add>' : `<idx=${e.cellIndex}>`))
  }
  return [...groups.values()].map(g => ({
    ...g,
    delaysMs: g.delaysMs.sort((a, b) => a - b),
    startTimeRelWaveMs: g.startTimeRelWaveMs.sort((a, b) => a - b),
  }))
}

function buildIconForensics(raw, metrics_, faviconInfo) {
  const animList = (raw.animMeta && raw.animMeta.length) ? raw.animMeta : metrics_.animations
  const iconAnims = animList.filter(a => a.iconKind !== null && a.kind !== 'transition')
  const animsByCell = new Map()
  for (const a of iconAnims) {
    const key = a.cellId ?? '<add>'
    if (!animsByCell.has(key))
      animsByCell.set(key, [])
    animsByCell.get(key).push(a)
  }

  const traceByCell = new Map()
  for (const f of raw.trace) {
    for (const c of f.cells) {
      if (!traceByCell.has(c.cellKey))
        traceByCell.set(c.cellKey, [])
      traceByCell.get(c.cellKey).push({ t: f.t, ...c })
    }
  }

  const keyOfRecord = r => r.cellId ?? (r.inAddCell ? '<add>' : '<unknown>')
  const waveKeys = new Set(metrics_.cells.map(c => c.id ?? '<add>'))
  const cellKeys = [...new Set([
    ...metrics_.cells.map(c => c.id ?? '<add>'),
    ...animsByCell.keys(),
    ...raw.imgs.map(keyOfRecord),
    ...raw.initials.map(keyOfRecord),
  ])]

  const range = (xs) => {
    const nums = xs.filter(v => typeof v === 'number' && Number.isFinite(v))
    return nums.length ? { min: +Math.min(...nums).toFixed(3), max: +Math.max(...nums).toFixed(3), samples: nums.length } : null
  }

  const cells = cellKeys.map((key) => {
    const meta = metrics_.cells.find(c => (c.id ?? '<add>') === key) ?? null
    const anims = (animsByCell.get(key) ?? []).map(a => ({
      animationName: a.animationName,
      target: a.target,
      iconKind: a.iconKind,
      durationMs: a.durationMs,
      delayMs: a.delayMs,
      fill: a.fill,
      easing: a.easing,
      startTimeRelWaveMs: a.startTimeRelWaveMs,
      plannedEndRelWaveMs: a.startTimeRelWaveMs === null ? null : +(a.startTimeRelWaveMs + a.durationMs).toFixed(1),
    }))
    const imgRecs = raw.imgs.filter(r => keyOfRecord(r) === key)
    const initialRecs = raw.initials.filter(r => keyOfRecord(r) === key)
    const trace = traceByCell.get(key) ?? []

    let kindSwitch = null
    let prevKind = null
    for (const f of trace) {
      if (prevKind !== null && f.kind !== prevKind)
        kindSwitch = { atMs: f.t, from: prevKind, to: f.kind }
      prevKind = f.kind
    }

    const img = imgRecs[0] ?? null
    const iconAnim = anims[0] ?? null
    const firstImgFrame = trace.find(f => f.kind === 'img') ?? null
    const firstDecodableFrame = trace.find(f => f.kind === 'img' && f.complete === true && (f.naturalWidth ?? 0) > 0) ?? null

    return {
      cellKey: key,
      phase: waveKeys.has(key) ? 'wave' : 'pre-storage',
      cellIndex: meta ? meta.index : null,
      delayVarMs: meta ? meta.delayVar : null,
      kindAtSettle: imgRecs.length ? 'img.tile-icon' : (initialRecs.length ? 'span.tile-initial' : 'none'),
      iconAnimations: anims,
      img: img
        ? {
            addedRelMs: img.addedRelMs,
            loadRelMs: img.loadRelMs,
            decodedRelMs: img.decodedRelMs,
            decodeFailedRelMs: img.decodeFailedRelMs,
            decodeError: img.decodeError ?? null,
            srcIsData: img.srcIsData,
            srcShort: img.srcShort,
            completeAtInsert: img.completeAtInsert,
            naturalWidthAtInsert: img.naturalWidthAtInsert,
            loadNaturalWidth: img.loadNaturalWidth,
            decodedNaturalWidth: img.decodedNaturalWidth,
          }
        : null,
      initials: initialRecs.map(r => ({ text: r.text, addedRelMs: r.addedRelMs, removedRelMs: r.removedRelMs })),
      iconMotion: {
        opacity: range(trace.map(f => f.opacity)),
        scale: range(trace.map(f => f.sx)),
        riseY: range(trace.map(f => f.y)),
        rotateDeg: range(trace.map(f => f.rotateDeg)),
        filters: [...new Set(trace.map(f => f.filter).filter(v => v !== null))].slice(0, 4),
      },
      pulseMotion: {
        opacity: range(trace.map(f => f.pulseOpacity)),
        scale: range(trace.map(f => f.pulseScale)),
      },
      traceFrames: trace.length,
      firstImgFrameRelMs: firstImgFrame ? firstImgFrame.t : null,
      firstDecodableFrameRelMs: firstDecodableFrame ? firstDecodableFrame.t : null,
      kindSwitch,
      decodedMinusDelayMs: (img && img.decodedRelMs !== null && iconAnim) ? +(img.decodedRelMs - iconAnim.delayMs).toFixed(1) : null,
      addedMinusDelayMs: (img && img.addedRelMs !== null && iconAnim) ? +(img.addedRelMs - iconAnim.delayMs).toFixed(1) : null,
      kindSwitchMinusDelayMs: (kindSwitch && iconAnim) ? +(kindSwitch.atMs - iconAnim.delayMs).toFixed(1) : null,
      iconAnimStartedLateMs: iconAnim && iconAnim.startTimeRelWaveMs !== null
        ? +(iconAnim.startTimeRelWaveMs - (iconAnim.delayMs ?? 0)).toFixed(1)
        : null,
    }
  })

  const waveCells = cells.filter(c => c.phase === 'wave')
  const preStorageCells = cells.filter(c => c.phase !== 'wave')
  const imgCells = waveCells.filter(c => c.kindAtSettle === 'img.tile-icon')
  const initialCells = waveCells.filter(c => c.kindAtSettle === 'span.tile-initial')
  const decodedList = imgCells.map(c => c.img?.decodedRelMs).filter(v => typeof v === 'number')
  const delayedList = imgCells.map(c => c.decodedMinusDelayMs).filter(v => typeof v === 'number')

  const traceHidden = raw.trace.map(f => ({
    t: f.t,
    hiddenCells: f.cells.filter(c => typeof c.opacity === 'number' && c.opacity < 0.999).length,
  }))
  const hiddenSpan = {
    traceFrames: traceHidden.length,
    framesWithAnyHiddenCell: traceHidden.filter(x => x.hiddenCells > 0).length,
    firstHiddenMs: (traceHidden.find(x => x.hiddenCells > 0) ?? {}).t ?? null,
    lastHiddenMs: ([...traceHidden].reverse().find(x => x.hiddenCells > 0) ?? {}).t ?? null,
    contiguousFromStartFrames: (() => {
      let n = 0
      for (const x of traceHidden) {
        if (x.hiddenCells > 0)
          n++
        else break
      }
      return n
    })(),
    note: 'trace 由 rAF 驱动：这里的「帧」只在浏览器真的产帧时存在；'
    + 'contiguousFromStartFrames = 入场开始后连续「还有格子没显影」的帧数',
  }

  return {
    mode: faviconInfo.mode,
    sites: faviconInfo.sites,
    waveStartMs: raw.waveStartMs,
    clockOffsetAtWaveMs: raw.clockOffsetAtWave,
    clockNote: 'clockOffsetAtWave = performance.now() − document.timeline.currentTime（起波那一刻）；'
    + 'startTimeRelWaveMs 走 document.timeline，其余时刻走 performance.now()，这个偏离量是两者的对齐检查',
    cacheClearedAtDocumentStart: raw.cacheClearedAtDocumentStart,
    animCollect: raw.animCollect,
    trace: {
      enabled: raw.traceEnabled,
      frames: raw.trace.length,
      endMs: raw.traceEndMs,
      windowMs: raw.traceWindowMs,
      degraded: raw.traceDegraded,
      note: 'trace 由 rAF 驱动：页面静止后 rAF 可能不再回调，degraded=true 表示窗口没被覆盖满',
    },
    hiddenSpan,
    cells,
    summary: {
      cellCount: waveCells.length,
      preStorageCells: preStorageCells.length,
      preStorageNote: '种子站那一次渲染留下的图标元素记录（storage 是异步的，列表会被整份换掉）；它们不参与入场编排',
      imgCells: imgCells.length,
      initialCells: initialCells.length,
      noneCells: waveCells.filter(c => c.kindAtSettle === 'none').length,
      imgPathExercised: imgCells.length > 0,
      iconDelayRangeMs: range(waveCells.map(c => c.iconAnimations[0]?.delayMs)),
      iconDurationMs: [...new Set(waveCells.map(c => c.iconAnimations[0]?.durationMs).filter(v => typeof v === 'number'))],
      firstDecodableRelMs: decodedList.length ? Math.min(...decodedList) : null,
      lastDecodableRelMs: decodedList.length ? Math.max(...decodedList) : null,
      decodedMinusDelayMs: delayedList.length ? { min: Math.min(...delayedList), max: Math.max(...delayedList) } : null,
      cellsWhereIconInsertedAfterAnimStart: imgCells.filter(c => (c.addedMinusDelayMs ?? -Infinity) > 0).length,
      cellsWhereDecodedAfterAnimStart: imgCells.filter(c => (c.decodedMinusDelayMs ?? -Infinity) > 0).length,
      kindSwitches: waveCells.filter(c => c.kindSwitch).length,
      pulseCells: waveCells.filter(c => c.pulseMotion.scale).length,
      pulsePeakScale: range(waveCells.map(c => c.pulseMotion.scale?.max)),
      pulsePeakOpacity: range(waveCells.map(c => c.pulseMotion.opacity?.max)),
      note: 'kindAtSettle 是入场结束后的状态；kindSwitch 给出「首字母 → 真图标」发生的那一帧',
    },
    errors: raw.errors,
  }
}

const iconForensics = buildIconForensics(iconForensicsRaw, metrics, favicon)
const entranceAnimations = (iconForensicsRaw.animMeta ?? []).filter(a => a.kind !== 'transition')
const entranceTransitions = (iconForensicsRaw.animMeta ?? []).filter(a => a.kind === 'transition')
const entranceGroups = groupAnimations(entranceAnimations.length ? entranceAnimations : metrics.animations)

const artifactSanity = {
  framesWritten: frames.length,
  allFramesAlreadySettled: frames.length > 0 && frames.every(f => f.cellsLanded === f.total),
  entranceAnimationCount: entranceAnimations.length,
  freezeRefCount: freezeRefs ? freezeRefs.count : null,
  verdicts: [],
}
if (withFrames && frames.length === 0)
  artifactSanity.verdicts.push('FAIL：没有产出任何逐帧图')
if (withFrames && artifactSanity.allFramesAlreadySettled)
  artifactSanity.verdicts.push('FAIL：所有帧都已是落定态（定格失败，拍到的不是入场）')
if (entranceAnimations.length === 0 && !withReducedMotion)
  artifactSanity.verdicts.push('FAIL：入场动画表为空（animationGroups 会是空产物）')
if (entranceAnimations.length === 0 && withReducedMotion) {
  artifactSanity.note = 'reduce 模式下入场动画只活 0.01ms，rAF 收集不到它们是**预期**的；'
  + '这一轮的结构结论看 reducedMotion.verdict.delayCleared（读的是 CSS 层叠里的 computed 值）'
}
if (withFrames && freezeRefs && freezeRefs.count === 0)
  artifactSanity.verdicts.push('FAIL：入场期间没收到任何动画引用')
artifactSanity.ok = artifactSanity.verdicts.length === 0
if (!artifactSanity.ok) {
  for (const v of artifactSanity.verdicts)
    problems.push(`产物自检 ${v}`)
  console.error(`  !! 产物自检失败：${artifactSanity.verdicts.join(' / ')}`)
}

const report = {
  round,
  label: label || null,
  capturedAt: new Date().toISOString(),
  theme,
  viewport: vpLabel,
  newTabUrl,
  favicon,
  iconForensics,
  reducedMotion,
  pageVisibility: settleRaw.visibility,
  captureConfig: {
    theme,
    viewport: `${vpW}x${vpH}`,
    deviceScaleFactor: dsf,
    faviconMode,
    siteSet,
    visitSites,
    reducedMotion: withReducedMotion,
    liveTrace: withLiveTrace,
    framesEnabled: withFrames,
    freezeEnabled: withFreeze,
    zoom: withZoom ? { tile: zoomTile, from: zoomFrom, to: zoomTo, step: zoomStep } : null,
    settleMs,
    frameRange: { from, to, step },
    iconTrackRange: { from: 0, to: iconTo, step: iconStep },
  },
  extension: extensionFingerprint(),
  shortcutsInjected: SHORTCUTS.length,
  shortcutsSites: siteSet === 'fixture' ? SHORTCUTS.map(s => ({ id: s.id, name: s.name, url: s.url, fixtureRgb: s.fixtureRgb ?? null })) : null,
  viewportActual: metrics.viewportActual,
  grid: {
    columns: metrics.columns,
    rows: metrics.rows,
    gridTemplateColumns: metrics.gridTemplateColumns,
    tileCellCount: metrics.tileCellCount,
    shortcutTileCount: metrics.shortcutTileCount,
    tokens: metrics.tokens,
  },
  tileDelays: metrics.cells.map(c => ({ index: c.index, id: c.id, isAddCell: c.isAddCell, delayVar: c.delayVar, animationDelay: c.animationDelay, animationName: c.animationName })),
  cellRestState: metrics.cells.map(c => ({
    index: c.index,
    id: c.id,
    transform: c.transformAtRest,
    translate: c.translateAtRest,
    scale: c.scaleAtRest,
    rotate: c.rotateAtRest,
    opacity: c.opacityAtRest,
    rect: c.rect,
  })),
  animationGroups: entranceGroups,
  animationGroupsAtSettle: metrics.animationGroups,
  animationsAtSettle: metrics.animations,
  animationsDuringEntrance: entranceAnimations,
  transitionsDuringEntrance: entranceTransitions,
  raf,
  frames: frames.map((f, i) => ({
    t: f.t,
    file: f.file,
    firstCellOpacity: f.firstCellOpacity,
    firstCellTransform: f.firstCellTransform,
    firstCellTranslate: f.firstCellTranslate,
    firstIconTransform: f.firstIconTransform,
    firstIconScale: f.firstIconScale,
    firstIconRotateDeg: f.firstIconRotateDeg,
    firstIconRiseY: f.firstIconRiseY,
    firstIconOpacity: f.firstIconOpacity,
    cellsLanded: f.cellsLanded,
    total: f.total,
    opacities: f.opacities,
    riseByCell: f.riseByCell,
    scaleByCell: f.scaleByCell,
    pixels: pixelStats ? pixelStats[i] : null,
  })),
  waveFront: frames.map(f => `t=${f.t}:${f.cellsLanded}/${f.total}`),
  iconTrack,
  artifactSanity,
  freezeRefs,
  zoomFrames: zoomFrames.map(f => ({
    t: f.t,
    file: f.file,
    iconKind: f.iconKind,
    iconOpacity: f.iconOpacity,
    iconScale: f.iconScale,
    iconRotateDeg: f.iconRotateDeg,
    iconRiseY: f.iconRiseY,
    pulseOpacity: f.pulseOpacity,
    pulseScale: f.pulseScale,
    cellOpacity: f.cellOpacity,
    cellY: f.cellY,
  })),
  zoomClip: zoomClipRect,
  hover,
  freezeCheck,
  problems,
}
fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`)

const iconDelay0 = entranceAnimations.find(a => a.animationName?.startsWith('tile-icon-arrive') && a.cellIndex === 0)?.delayMs ?? null
const iconPeak = iconTrack.reduce((best, s) => (s.c0 && s.c0.iconScale !== null && (best === null || s.c0.iconScale > best.c0.iconScale) ? s : best), null)
const iconBlurEnd = iconTrack.find(s => s.c0 && s.c0.iconFilter === 'none') ?? null
const pulsePeak = iconTrack.reduce((best, s) => {
  const p = s.c0?.pulseOpacity
  return (typeof p === 'number' && (best === null || p > best.pulseOpacity)) ? { t: s.t, pulseOpacity: p, pulseScale: s.c0.pulseScale } : best
}, null)
console.log(JSON.stringify({
  outDir: path.relative(root, outDir),
  theme,
  viewport: vpLabel,
  favicon: {
    mode: favicon.mode,
    sites: favicon.sites,
    visited: favicon.visited ? favicon.visited.map(v => `${v.id}:${v.ok ? v.status : 'ERR'}`) : null,
    chromeDbBefore: favicon.dbProbeBefore?.targets?.map(t => `${t.id}:${t.isPlaceholder ? 'placeholder' : 'real'}`) ?? null,
    chromeDbAfter: favicon.dbProbeAfter?.targets?.map(t => `${t.id}:${t.isPlaceholder ? 'placeholder' : 'real'}`) ?? null,
    cacheBeforeSample: favicon.cacheBeforeSample && { entries: favicon.cacheBeforeSample.entryCount, withData: favicon.cacheBeforeSample.withData },
    cacheAfterSample: favicon.cacheAfterSample && { entries: favicon.cacheAfterSample.entryCount, withData: favicon.cacheAfterSample.withData },
  },
  iconForensics: {
    summary: iconForensics.summary,
    trace: iconForensics.trace,
    perCell: iconForensics.cells.map(c => ({
      cell: c.cellKey,
      kind: c.kindAtSettle,
      delayMs: c.iconAnimations[0]?.delayMs ?? null,
      durMs: c.iconAnimations[0]?.durationMs ?? null,
      animStartRelWaveMs: c.iconAnimations[0]?.startTimeRelWaveMs ?? null,
      imgAddedRelMs: c.img?.addedRelMs ?? null,
      imgDecodedRelMs: c.img?.decodedRelMs ?? null,
      decodedMinusDelayMs: c.decodedMinusDelayMs,
      firstDecodableFrameRelMs: c.firstDecodableFrameRelMs,
      kindSwitch: c.kindSwitch,
      iconScale: c.iconMotion.scale,
      iconRiseY: c.iconMotion.riseY,
      iconRotateDeg: c.iconMotion.rotateDeg,
      pulse: c.pulseMotion,
    })),
  },
  viewportActual: metrics.viewportActual,
  columns: metrics.columns,
  rows: metrics.rows,
  tileCellCount: metrics.tileCellCount,
  delays: metrics.cells.map(c => `${c.id ?? '<add>'}:${c.delayVar}`),
  animationGroups: entranceGroups.map(g => `${g.target} → ${g.animationName} ${g.durationMs}ms delays=[${g.delaysMs}] fill=${g.fill} ×${g.count}`),
  easingSegments: entranceGroups.map(g => ({
    animation: `${g.target} → ${g.animationName} ${g.durationMs}ms`,
    animationEasing: g.animationEasing,
    segments: (g.easingSegments ?? []).map(s => `${s.fromPct}%→${s.toPct}%: ${s.easing}`),
  })),
  reducedMotion: {
    emulated: reducedMotion.emulated,
    mediaMatches: reducedMotion.mediaMatchesAtSettle,
    verdict: reducedMotion.verdict,
    reduceAnims: reducedMotion.reduceAnims ?? null,
    finalViolations: reducedMotion.finalCheck.violations,
    earlyHiddenCount: reducedMotion.earlyCheck.length,
    earlyHiddenSample: reducedMotion.earlyCheck.slice(0, 6),
    earlyMarks: reducedMotion.earlySampleMarks,
    hiddenSpan: iconForensics.hiddenSpan ?? null,
  },
  zoom: withZoom
    ? {
        tile: zoomTile,
        dsf,
        clip: zoomClipRect,
        frames: zoomFrames.length,
        scaleRange: (() => {
          const xs = zoomFrames.map(f => f.iconScale).filter(v => typeof v === 'number')
          return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null
        })(),
        rotateRange: (() => {
          const xs = zoomFrames.map(f => f.iconRotateDeg).filter(v => typeof v === 'number')
          return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null
        })(),
      }
    : null,
  raf: {
    frames: raf.sampledFrames,
    totalFrames: raf.totalFrames,
    framesBeforeWave: raf.framesBeforeWave,
    avgFps: raf.avgFps,
    avgFrameMs: raf.avgFrameMs,
    longFrames: raf.longFrameCount,
    maxFrameMs: raf.maxFrameMs,
  },
  iconTrack: {
    iconDelayCell0: iconDelay0,
    at0: iconTrack[0]?.c0 ?? null,
    peak: iconPeak ? { t: iconPeak.t, scale: iconPeak.c0.iconScale, riseY: iconPeak.c0.iconRiseY, rotateDeg: iconPeak.c0.iconRotateDeg, blur: iconPeak.c0.iconFilter } : null,
    firstBlurNoneAt: iconBlurEnd?.t ?? null,
    pulsePeak,
    end: iconTrack[iconTrack.length - 1]?.c0 ?? null,
  },
  waveFront: report.waveFront,
  hover: { verdicts: hover.verdicts, restFace: hover.rest.face, hoverFace: hover.hoverFace.face, restAdd: hover.rest.addTile, hoverAdd: hover.hoverAdd.addTile },
  freeze: freezeCheck
    ? {
        delayVarUnchangedOnRemove: freezeCheck.delayVarUnchangedOnRemove,
        removedIds: freezeCheck.afterRemove.removedIds,
        removeChangedAnims: freezeCheck.removeDiff.changed.length,
        removeChangedList: freezeCheck.removeDiff.changed,
        removeMissingAnims: freezeCheck.removeDiff.missing.map(m => m.key),
        addChangedAnims: freezeCheck.addDiff.changed.length,
        addChangedList: freezeCheck.addDiff.changed,
        addNewAnims: freezeCheck.addDiff.added,
        freshCellIds: freezeCheck.afterAdd.freshCellIds,
        newCellDelay: freezeCheck.addCell.cell?.delayVar,
        newCellClasses: freezeCheck.addCell.cell?.classes,
        addCellDelayBefore: freezeCheck.addCell.addCellBefore?.delayVar,
        addCellDelayAfter: freezeCheck.addCell.addCellAfter?.delayVar,
      }
    : null,
  framesWritten: frames.length,
  artifactSanity,
  freezeRefs,
  problems,
}, null, 2))

if ((withFrames && !refsOk) || !artifactSanity.ok)
  process.exitCode = 1

await browser.close()
if (fixtureSites)
  await fixtureSites.stop()
