import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { measureRects, openPixelReader } from './lib/pixels.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const EXTENSION = path.join(ROOT, 'extension')
const NEWTAB_INDEX = path.join(EXTENSION, 'dist', 'newtab', 'index.html')
const OUT_ROOT = path.join(ROOT, 'docs', 'review', 'boot')

const argv = process.argv.slice(2)
const label = argv.find(a => !a.startsWith('--')) ?? 'baseline'
function flag(name, fallback) {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = name => argv.includes(`--${name}`)

const REPEATS = Number(flag('repeats', 3))
const SETTLE_MS = Number(flag('settle', 3000))
const SAVE_FRAMES = !has('no-frames')
const ONLY_SCENARIOS = flag('scenarios', '').split(',').filter(Boolean)
const ONLY_MODES = flag('modes', '').split(',').filter(Boolean)

const VIEWPORT = { width: 1280, height: 800 }

const THRESHOLDS = {
  brightLum: 0.35,
  whiteLum: 0.95,
  centerEps: 4,
  majorDelta: 24,
  downsampleWidth: 240,
}

const THEME_MIRROR_KEY = 'meridiem-theme-mirror'

const SCENARIOS = [
  {
    id: 'dark-mismatch',
    theme: 'dark',
    emulatedColorScheme: 'light',
    mirror: 'dark',
    note: 'storage=dark、系统偏好被模拟成 light、localStorage 镜像=dark（用户稳态）—— 用户报的「先浅后深」二次闪动就出在这里',
  },
  {
    id: 'dark-mismatch-cold',
    theme: 'dark',
    emulatedColorScheme: 'light',
    mirror: null,
    note: '同上，但 localStorage 镜像**不存在**：装完/更新后第一次开新标签页。首帧脚本此时只能按系统偏好兜底（light）',
  },
  {
    id: 'dark-aligned',
    theme: 'dark',
    emulatedColorScheme: 'dark',
    mirror: 'dark',
    note: 'storage 与系统偏好一致（对照：用来分辨闪动是「异步读 storage / 镜像缺失」还是「颜色偏好不一致」造成的）',
  },
  {
    id: 'light-aligned',
    theme: 'light',
    emulatedColorScheme: 'light',
    mirror: 'light',
    note: '浅色场景对照：浅色下应当看不到底色的明暗翻转；这里要看的是首帧到底是主题浅色底还是浏览器纯白',
  },
]

const MODES = [
  { id: 'goto', note: 'page.goto(扩展内 newtab URL)，最干净的可复现路径' },
  { id: 'tabs', note: '扩展 service worker 调 chrome.tabs.create({}) 走真实 newtab override，最接近用户按 Ctrl+T' },
  {
    id: 'tabs-armed',
    note: '先 chrome.tabs.create({url:"about:blank"}) 把 CDP + 录屏挂稳，再由浏览器自己走 override 导航（chrome.tabs.update → chrome://newtab/）。'
    + '目的：把 tabs 模式挂 CDP 之前那 100~400ms 也录下来，量「从提交到首次绘制」那段空白到底多长。'
    + '代价：被导航掉的上一个文档是 harness 建的 about:blank（纯白），所以 rel<0 的保留帧是测量装置产物，不是扩展画的。',
  },
]

function newtabBootProbe() {
  if (!location.pathname.includes('/dist/newtab'))
    return
  const P = {
    timeOrigin: performance.timeOrigin,
    installedAtPerfMs: performance.now(),
    marks: [],
    samples: [],
    paints: [],
    errors: [],
    ticks: 0,
  }
  window.__bootProbe = P
  const r2 = v => Math.round(v * 100) / 100
  const mark = (name, extra) => {
    P.marks.push(Object.assign({ name, t: r2(performance.now()) }, extra || null))
  }
  mark('initScript', { readyState: document.readyState, hasDocumentElement: !!document.documentElement })

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        P.paints.push({ name: e.name, t: r2(e.startTime) })
    })
    po.observe({ type: 'paint', buffered: true })
  }
  catch (e) {
    P.errors.push(`paintObserver: ${String(e)}`)
  }

  const boot = () => {
    mark('documentElement')
    try {
      let dark = document.documentElement.classList.contains('dark')
      if (dark)
        mark('htmlDark:initial')
      const classObserver = new MutationObserver(() => {
        const now = document.documentElement.classList.contains('dark')
        if (now !== dark) {
          dark = now
          mark(now ? 'htmlDark:true' : 'htmlDark:false', { className: document.documentElement.className })
        }
      })
      classObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

      let appSeen = false
      let canvasSeen = false
      let lastKey = ''
      const tick = () => {
        P.ticks++
        try {
          const rootStyle = getComputedStyle(document.documentElement)
          const bodyStyle = document.body ? getComputedStyle(document.body) : null
          const key = [
            document.documentElement.classList.contains('dark'),
            rootStyle.colorScheme,
            rootStyle.getPropertyValue('--bg-base').trim(),
            rootStyle.getPropertyValue('--bg-deep').trim(),
            bodyStyle ? bodyStyle.backgroundColor : 'no-body',
          ].join('|')
          if (key !== lastKey) {
            lastKey = key
            if (P.samples.length < 80) {
              P.samples.push({
                t: r2(performance.now()),
                darkClass: document.documentElement.classList.contains('dark'),
                colorScheme: rootStyle.colorScheme,
                bgBase: rootStyle.getPropertyValue('--bg-base').trim(),
                bgDeep: rootStyle.getPropertyValue('--bg-deep').trim(),
                bodyBg: bodyStyle ? bodyStyle.backgroundColor : null,
              })
            }
          }
          if (!appSeen) {
            const app = document.querySelector('#app')
            if (app && app.firstElementChild) {
              appSeen = true
              mark('appFirstChild')
            }
          }
          if (!canvasSeen && document.querySelector('canvas.is-painted')) {
            canvasSeen = true
            mark('canvasIsPainted')
          }
        }
        catch (e) {
          P.errors.push(`tick: ${String(e)}`)
        }
        if (performance.now() < 8000)
          requestAnimationFrame(tick)
        else mark('samplingStopped')
      }
      requestAnimationFrame(tick)
    }
    catch (e) {
      P.errors.push(`boot: ${String(e)}`)
    }
  }

  if (document.documentElement) {
    boot()
  }
  else {
    const iv = setInterval(() => {
      if (document.documentElement) {
        clearInterval(iv)
        boot()
      }
    }, 0)
  }
}

function pollSample() {
  const cs = getComputedStyle(document.documentElement)
  const bodyStyle = document.body ? getComputedStyle(document.body) : null
  return {
    path: location.pathname,
    perfMs: Math.round(performance.now() * 10) / 10,
    className: document.documentElement.className,
    darkClass: document.documentElement.classList.contains('dark'),
    colorScheme: cs.colorScheme,
    bgBase: cs.getPropertyValue('--bg-base').trim(),
    bgDeep: cs.getPropertyValue('--bg-deep').trim(),
    bodyBg: bodyStyle ? bodyStyle.backgroundColor : null,
    readyState: document.readyState,
    appChildren: document.querySelector('#app') ? document.querySelector('#app').childElementCount : -1,
    canvasPainted: !!document.querySelector('canvas.is-painted'),
    probeInstalled: !!window.__bootProbe,
    mirror: (() => {
      try {
        return localStorage.getItem('meridiem-theme-mirror')
      }
      catch {
        return '(localStorage 不可读)'
      }
    })(),
  }
}

function harvestProbe() {
  const p = window.__bootProbe
  const r2 = v => Math.round(v * 100) / 100
  const out = p
    ? {
        timeOrigin: p.timeOrigin,
        installedAtPerfMs: p.installedAtPerfMs,
        marks: p.marks.slice(),
        samples: p.samples.slice(),
        paints: p.paints.slice(),
        errors: p.errors.slice(),
        ticks: p.ticks,
        nav: null,
        final: null,
        viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
      }
    : null
  const n = performance.getEntriesByType('navigation')[0]
  if (out && n) {
    out.nav = {
      type: n.type,
      responseStart: r2(n.responseStart),
      responseEnd: r2(n.responseEnd),
      domInteractive: r2(n.domInteractive),
      domContentLoadedEventEnd: r2(n.domContentLoadedEventEnd),
      loadEventEnd: r2(n.loadEventEnd),
      activationStart: r2(n.activationStart || 0),
    }
  }
  const styles = getComputedStyle(document.documentElement)
  const bodyStyle = document.body ? getComputedStyle(document.body) : null
  if (out) {
    out.final = {
      htmlDarkClass: document.documentElement.classList.contains('dark'),
      colorScheme: styles.colorScheme,
      bgBase: styles.getPropertyValue('--bg-base').trim(),
      bgDeep: styles.getPropertyValue('--bg-deep').trim(),
      bodyBg: bodyStyle ? bodyStyle.backgroundColor : null,
      appChildren: document.querySelector('#app') ? document.querySelector('#app').childElementCount : -1,
      canvasPainted: !!document.querySelector('canvas.is-painted'),
      mirror: (() => {
        try {
          return localStorage.getItem('meridiem-theme-mirror')
        }
        catch {
          return '(localStorage 不可读)'
        }
      })(),
    }
  }
  return out
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function median(xs) {
  const a = xs.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((p, q) => p - q)
  if (!a.length)
    return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 100) / 100
}
function spread(xs) {
  const a = xs.filter(v => typeof v === 'number' && Number.isFinite(v))
  if (!a.length)
    return null
  return { min: Math.min(...a), max: Math.max(...a), jitter: Math.round((Math.max(...a) - Math.min(...a)) * 100) / 100 }
}
const rgbKey = rgb => rgb.join(',')

async function measureFrameBatch(reader, items, downsampleWidth) {
  return reader.evaluate(async ({ items: batch, DW }) => {
    const round4 = v => Math.round(v * 10000) / 10000
    const linearize = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    const lumOf = (r, g, b) =>
      0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255)
    const out = []
    for (const it of batch) {
      const img = new Image()
      try {
        img.src = it.dataUrl
        await img.decode()
      }
      catch (e) {
        out.push({ w: 0, h: 0, decodeError: String(e), mean: -1, rgb: [-1, -1, -1], centerMean: -1, centerRgb: [-1, -1, -1], topLeftMean: -1, topLeftRgb: [-1, -1, -1] })
        continue
      }
      const w = Math.max(8, Math.min(DW, img.naturalWidth))
      const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
      ctx2d.drawImage(img, 0, 0, w, h)
      const px = ctx2d.getImageData(0, 0, w, h).data

      let sum = 0
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let i = 0; i < px.length; i += 4) {
        sum += lumOf(px[i], px[i + 1], px[i + 2])
        r += px[i]
        g += px[i + 1]
        b += px[i + 2]
        n++
      }

      if (!n) {
        out.push({ w: img.naturalWidth, h: img.naturalHeight, mean: -1, rgb: [-1, -1, -1], centerMean: -1, centerRgb: [-1, -1, -1], topLeftMean: -1, topLeftRgb: [-1, -1, -1] })
        continue
      }

      const cx0 = Math.floor(w / 3)
      const cx1 = Math.floor((2 * w) / 3)
      const cy0 = Math.floor(h / 3)
      const cy1 = Math.floor((2 * h) / 3)
      let cSum = 0
      let cr = 0
      let cg = 0
      let cb = 0
      let cn = 0
      for (let y = cy0; y < cy1; y++) {
        for (let x = cx0; x < cx1; x++) {
          const i = (y * w + x) * 4
          cSum += lumOf(px[i], px[i + 1], px[i + 2])
          cr += px[i]
          cg += px[i + 1]
          cb += px[i + 2]
          cn++
        }
      }

      const tw = Math.max(8, Math.floor(w / 8))
      const th = Math.max(8, Math.floor(h / 8))
      let tSum = 0
      let tr = 0
      let tg = 0
      let tb = 0
      let tn = 0
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const i = (y * w + x) * 4
          tSum += lumOf(px[i], px[i + 1], px[i + 2])
          tr += px[i]
          tg += px[i + 1]
          tb += px[i + 2]
          tn++
        }
      }

      out.push({
        w: img.naturalWidth,
        h: img.naturalHeight,
        mean: round4(sum / n),
        rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        centerMean: round4(cSum / cn),
        centerRgb: [Math.round(cr / cn), Math.round(cg / cn), Math.round(cb / cn)],
        topLeftMean: round4(tSum / tn),
        topLeftRgb: [Math.round(tr / tn), Math.round(tg / tn), Math.round(tb / tn)],
      })
    }
    return out
  }, { items, DW: downsampleWidth })
}

async function clockOffset(cdp) {
  await cdp.send('Performance.enable').catch(() => {})
  const before = Date.now()
  const m1 = await cdp.send('Performance.getMetrics')
  const after = Date.now()
  const mono = m1.metrics.find(m => m.name === 'Timestamp')?.value
  if (typeof mono !== 'number')
    return { offsetSec: null, roundTripMs: after - before }
  const midSec = (before + after) / 2 / 1000
  return { offsetSec: midSec - mono, roundTripMs: after - before, monotonicSec: mono }
}

function deriveRun(frames, probe) {
  const docFrames = frames.filter(f => f.relMs >= 0)
  const preFrames = frames.filter(f => f.relMs < 0)
  const finalFrame = frames[frames.length - 1] ?? null
  const finalRgb = finalFrame ? finalFrame.centerRgb : null

  for (const f of frames) {
    f.bright = f.mean > THRESHOLDS.brightLum
    f.white = f.mean >= THRESHOLDS.whiteLum
    if (finalRgb) {
      f.centerDeltaFromFinal = Math.max(...f.centerRgb.map((v, i) => Math.abs(v - finalRgb[i])))
      f.finalLike = f.centerDeltaFromFinal <= THRESHOLDS.centerEps
    }
  }

  const brightDoc = docFrames.filter(f => f.bright)
  const nonBrightDoc = docFrames.filter(f => !f.bright)
  const firstNonBrightDoc = nonBrightDoc[0] ?? null
  const lastFrameRelMs = frames.length ? frames[frames.length - 1].relMs : null

  let docBrightSurfaceMs = 0
  if (brightDoc.length) {
    const start = Math.max(0, docFrames[0].relMs)
    const end = firstNonBrightDoc ? firstNonBrightDoc.relMs : lastFrameRelMs
    docBrightSurfaceMs = Math.max(0, end - start)
  }

  const firstPaintMark = probe?.paints.find(p => p.name === 'first-paint')
  const fcpMark = probe?.paints.find(p => p.name === 'first-contentful-paint')
  const markAt = (name) => {
    const m = probe?.marks.find(x => x.name === name)
    return m ? m.t : null
  }
  const htmlDarkMark = probe?.marks.find(m => m.name === 'htmlDark:true') ?? null
  const firstFinalLikeDoc = docFrames.find(f => f.finalLike) ?? null

  let ownWhiteMs = null
  if (firstPaintMark) {
    const end = firstNonBrightDoc ? firstNonBrightDoc.relMs : (brightDoc.length ? lastFrameRelMs : null)
    ownWhiteMs = brightDoc.length ? Math.max(0, Math.round(end - firstPaintMark.t)) : 0
  }

  const clusters = []
  for (const f of frames) {
    const key = rgbKey(f.centerRgb.map(v => Math.round(v / 8) * 8))
    const last = clusters[clusters.length - 1]
    if (last && last.key === key) {
      last.toRelMs = f.relMs
      last.frames++
      last.endIndex = f.index
    }
    else {
      clusters.push({ key, fromRelMs: f.relMs, toRelMs: f.relMs, frames: 1, startIndex: f.index, endIndex: f.index, phase: f.relMs < 0 ? 'pre-document' : 'document' })
    }
  }

  const majorTransitions = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    const delta = Math.max(...a.centerRgb.map((v, k) => Math.abs(v - b.centerRgb[k])))
    if (delta >= THRESHOLDS.majorDelta)
      majorTransitions.push({ relMs: b.relMs, fromRgb: a.centerRgb, toRgb: b.centerRgb, maxChannelDelta: delta })
  }

  const cadence = []
  for (let i = 1; i < frames.length; i++) cadence.push(frames[i].relMs - frames[i - 1].relMs)

  let maxStaticGap = null
  for (let i = 1; i < frames.length; i++) {
    const ms = frames[i].relMs - frames[i - 1].relMs
    if (!maxStaticGap || ms > maxStaticGap.ms) {
      maxStaticGap = {
        ms,
        fromRelMs: frames[i - 1].relMs,
        toRelMs: frames[i].relMs,
        colorBefore: frames[i - 1].centerRgb,
        meanBefore: frames[i - 1].mean,
        colorAfter: frames[i].centerRgb,
      }
    }
  }

  const finalIsBright = finalFrame ? finalFrame.mean > THRESHOLDS.brightLum : null
  const matchingDoc = docFrames.filter(f => f.bright === finalIsBright)
  const wrongThemeDoc = docFrames.filter(f => f.bright !== finalIsBright)
  const firstMatchingDoc = matchingDoc[0] ?? null
  let wrongThemeSurfaceMs = null
  let ownWrongThemeMs = null
  if (finalIsBright != null && docFrames.length) {
    const start = Math.max(0, docFrames[0].relMs)
    if (!wrongThemeDoc.length) {
      wrongThemeSurfaceMs = 0
      ownWrongThemeMs = 0
    }
    else {
      const end = firstMatchingDoc ? firstMatchingDoc.relMs : lastFrameRelMs
      wrongThemeSurfaceMs = Math.max(0, end - start)
      ownWrongThemeMs = firstPaintMark ? Math.max(0, Math.round(end - firstPaintMark.t)) : null
    }
  }

  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1]
    frames[i].displayMs = next
      ? Math.max(0, next.relMs - frames[i].relMs)
      : Math.max(0, (lastFrameRelMs ?? frames[i].relMs) - frames[i].relMs)
  }

  const LIGHT_TOKEN_RGB = [232, 237, 242]
  const isLightToken = f => Math.max(...f.centerRgb.map((v, k) => Math.abs(v - LIGHT_TOKEN_RGB[k]))) <= 8
  const isPureWhite = f => f.centerRgb.every(v => v >= 250)
  const appearance = {
    lightTokenRgb: LIGHT_TOKEN_RGB,
    classifyNote: 'pureWhite=浏览器纯白(≥250)；lightToken=本页浅色底 #e8edf2(±8)；otherBright=其它亮底(浅色天空等)；dark=mean≤0.35',
    frames: { pureWhite: 0, lightToken: 0, otherBright: 0, dark: 0 },
    displayMs: { pureWhite: 0, lightToken: 0, otherBright: 0, dark: 0 },
    pureWhiteNote: '纯白只可能是「CSS 还没到」的那一帧：本页第一帧就是浏览器白，正好是要被内联底色干掉的那一帧',
  }
  const firstOf = pred => docFrames.find(pred) ?? null
  for (const f of docFrames) {
    const cls = isPureWhite(f) ? 'pureWhite' : (isLightToken(f) ? 'lightToken' : (f.bright ? 'otherBright' : 'dark'))
    f.appearanceClass = cls
    appearance.frames[cls]++
    appearance.displayMs[cls] += f.displayMs
  }
  for (const k of Object.keys(appearance.displayMs)) appearance.displayMs[k] = Math.round(appearance.displayMs[k])
  appearance.firstPureWhiteRelMs = firstOf(isPureWhite)?.relMs ?? null
  appearance.lastPureWhiteRelMs = [...docFrames].reverse().find(isPureWhite)?.relMs ?? null
  appearance.firstNonWhiteRelMs = firstOf(f => !isPureWhite(f))?.relMs ?? null
  appearance.firstLightTokenRelMs = firstOf(isLightToken)?.relMs ?? null
  appearance.lastLightTokenRelMs = [...docFrames].reverse().find(isLightToken)?.relMs ?? null
  appearance.firstNonBrightRelMs = firstOf(f => !f.bright)?.relMs ?? null

  return {
    boundary: {
      timeOriginEpochMs: probe ? probe.timeOrigin : null,
      docPhaseFrames: docFrames.length,
      preDocPhaseFrames: preFrames.length,
    },
    frames: {
      count: frames.length,
      firstRelMs: frames.length ? frames[0].relMs : null,
      lastRelMs: lastFrameRelMs,
      cadenceMedianMs: median(cadence),
      cadenceMaxMs: cadence.length ? Math.max(...cadence) : null,
      dims: frames.length ? `${frames[0].w}x${frames[0].h}` : null,
      firstDocFrameRelMs: docFrames.length ? docFrames[0].relMs : null,
      preDocBrightFrames: preFrames.filter(f => f.bright).length,
      preDocWhiteFrames: preFrames.filter(f => f.white).length,
      docBrightFrames: brightDoc.length,
      docWhiteFrames: docFrames.filter(f => f.white).length,
      docDarkFrames: nonBrightDoc.length,
      finalIsBright,
      wrongThemeFrames: wrongThemeDoc.length,
      wrongThemeFirstRelMs: wrongThemeDoc.length ? wrongThemeDoc[0].relMs : null,
      wrongThemeLastRelMs: wrongThemeDoc.length ? wrongThemeDoc[wrongThemeDoc.length - 1].relMs : null,
      lastBrightDocRelMs: brightDoc.length ? brightDoc[brightDoc.length - 1].relMs : null,
      firstNonBrightDocRelMs: firstNonBrightDoc ? firstNonBrightDoc.relMs : null,
      maxStaticGap,
    },
    metrics: {
      docBrightSurfaceMs,
      ownWhiteMs,
      wrongThemeSurfaceMs,
      ownWrongThemeMs,
      timeOriginToFinalLookMs: firstFinalLikeDoc ? firstFinalLikeDoc.relMs : null,
      firstNonBrightDocRelMs: firstNonBrightDoc ? firstNonBrightDoc.relMs : null,
      firstDocFrameRelMs: docFrames.length ? docFrames[0].relMs : null,
      firstDocFrameRgb: docFrames.length ? docFrames[0].centerRgb : null,
      firstDocFrameMean: docFrames.length ? docFrames[0].mean : null,
      firstDocFrameIsPureWhite: docFrames.length
        ? docFrames[0].mean >= THRESHOLDS.whiteLum && docFrames[0].centerRgb.every(v => v >= 250)
        : null,
      firstPaintMs: firstPaintMark ? firstPaintMark.t : null,
      fcpMs: fcpMark ? fcpMark.t : null,
      dclMs: probe?.nav ? probe.nav.domContentLoadedEventEnd : null,
      loadMs: probe?.nav ? probe.nav.loadEventEnd : null,
      htmlDarkClassMs: htmlDarkMark ? htmlDarkMark.t : null,
      appFirstChildMs: markAt('appFirstChild'),
      canvasPaintedMs: markAt('canvasIsPainted'),
      maxStaticGapMs: maxStaticGap ? maxStaticGap.ms : null,
      pureWhiteDisplayMs: appearance.displayMs.pureWhite,
      lightTokenDisplayMs: appearance.displayMs.lightToken,
      otherBrightDisplayMs: appearance.displayMs.otherBright,
      firstNonWhiteRelMs: appearance.firstNonWhiteRelMs,
      firstLightTokenRelMs: appearance.firstLightTokenRelMs,
    },
    clusters: clusters.slice(0, 14),
    majorTransitions: majorTransitions.slice(0, 20),
    appearance,
    finalLook: finalRgb ? { centerRgb: finalRgb, mean: finalFrame.mean } : null,
  }
}

function derivePoll(rawSamples, probe) {
  if (!probe)
    return null
  const doc = rawSamples.filter(s => s && typeof s.path === 'string' && s.path.includes('/dist/newtab'))
  if (!doc.length) {
    return { sampleCount: 0, note: '轮询没采到 newtab 文档的样本（可能全都落在 about:blank 上）' }
  }

  const styled = doc.filter(s => typeof s.bgDeep === 'string' && /^rgba?\(|^#/.test(s.bgDeep))
  const first = doc[0]
  const last = doc[doc.length - 1]

  const byIndex = new Map(doc.map((s, i) => [s, i]))
  const prevRel = s => (byIndex.get(s) > 0 ? Math.round(doc[byIndex.get(s) - 1].perfMs) : null)
  const hit = (pred) => {
    const s = doc.find(pred)
    if (!s)
      return null
    const at = Math.round(s.perfMs)
    const since = prevRel(s)
    return { detectedAtRelMs: at, couldHaveHappenedSinceRelMs: since, uncertaintyMs: since == null ? null : at - since }
  }

  const deepInitialSample = styled[0] ?? null
  const baseInitialSample = styled[0] ?? null
  const deepInitial = deepInitialSample ? deepInitialSample.bgDeep : null
  const baseInitial = baseInitialSample ? baseInitialSample.bgBase : null
  const deepFinal = styled.length ? styled[styled.length - 1].bgDeep : null
  const baseFinal = styled.length ? styled[styled.length - 1].bgBase : null

  const gaps = []
  for (let i = 1; i < doc.length; i++)
    gaps.push({ from: doc[i - 1].perfMs, to: doc[i].perfMs, ms: Math.round((doc[i].perfMs - doc[i - 1].perfMs) * 10) / 10 })
  const maxGap = gaps.length ? gaps.reduce((a, b) => (b.ms > a.ms ? b : a)) : null

  const timeline = []
  let lastKey = ''
  for (let i = 0; i < doc.length; i++) {
    const s = doc[i]
    const key = [s.darkClass, s.className, s.bgBase, s.bgDeep, s.bodyBg, s.appChildren > 0, s.canvasPainted].join('|')
    const gapBefore = i > 0 ? doc[i].perfMs - doc[i - 1].perfMs : 0
    if (key !== lastKey || gapBefore > 60 || i === 0) {
      timeline.push({
        relMs: Math.round(s.perfMs),
        gapBeforeMs: Math.round(gapBefore * 10) / 10,
        className: s.className,
        mirror: s.mirror ?? null,
        bgBase: s.bgBase,
        bgDeep: s.bgDeep,
        bodyBg: s.bodyBg,
        appChildren: s.appChildren,
        canvasPainted: s.canvasPainted,
        readyState: s.readyState,
      })
      lastKey = key
    }
  }

  return {
    sampleCount: doc.length,
    styledSampleCount: styled.length,
    firstSampleRelMs: Math.round(first.perfMs),
    lastSampleRelMs: Math.round(last.perfMs),
    firstDarkClass: hit(s => s.darkClass),
    firstBgBaseSwitch: baseInitial ? hit(s => s.bgBase !== baseInitial && /^rgba?\(|^#/.test(s.bgBase)) : null,
    firstBgDeepMove: deepInitial ? hit(s => s.bgDeep !== deepInitial && /^rgba?\(|^#/.test(s.bgDeep)) : null,
    bgBaseInitial: baseInitial,
    bgBaseFinal: baseFinal,
    bgDeepInitial: deepInitial,
    bgDeepFinal: deepFinal,
    bgDeepFinalReached: deepFinal ? hit(s => s.bgDeep === deepFinal) : null,
    maxSampleGap: maxGap ? { ms: maxGap.ms, fromRelMs: Math.round(maxGap.from), toRelMs: Math.round(maxGap.to) } : null,
    gapsOver60ms: gaps.filter(g => g.ms > 60).map(g => ({ fromRelMs: Math.round(g.from), toRelMs: Math.round(g.to), ms: g.ms })),
    timeline,
    note: 'body 的底色是 var(--bg-deep)，而 main.css 在 :root 上声明了 transition: --bg-deep 1200ms ease-in-out。'
    + '所以「html 挂上 dark 类」不等于「屏幕变深」：前者由 firstDarkClass 给出，后者看 firstBgDeepMove / bgDeepFinalReached。'
    + '每个变化点都带 couldHaveHappenedSinceRelMs —— 两次采样之间可能隔着一段主线程占满的时间，'
    + '真实变化时刻只能确定在这个区间内（帧那边能给更紧的界）。',
  }
}

async function runOnce(opts) {
  const { ctx, sw, extensionId, scenario, mode, repeat, reader, savedDir } = opts
  const runId = `${scenario.id}/${mode.id}#${repeat}`
  const newTabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`
  const runProblems = []

  await sw.evaluate(
    ([k, v]) => chrome.storage.local.set({ [k]: v }),
    ['meridiem-theme', scenario.theme],
  )
  const readback = await sw.evaluate(k => chrome.storage.local.get(k).then(d => d[k]), 'meridiem-theme')

  let mirrorSeed = null
  {
    const helper = await ctx.newPage()
    try {
      await helper.goto(`chrome-extension://${extensionId}/dist/options/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await helper.waitForTimeout(400)
      mirrorSeed = await helper.evaluate(([key, mode]) => {
        try {
          if (mode === null)
            localStorage.removeItem(key)
          else
            localStorage.setItem(key, mode)
          return { requested: mode, readback: localStorage.getItem(key), localStorageKeys: Object.keys(localStorage) }
        }
        catch (e) {
          return { requested: mode, error: String(e) }
        }
      }, [THEME_MIRROR_KEY, scenario.mirror])
    }
    catch (e) {
      mirrorSeed = { requested: scenario.mirror, error: String(e) }
      runProblems.push(`种主题镜像失败: ${String(e)}`)
    }
    finally {
      await helper.close().catch(() => {})
    }
  }

  let page
  let createAtEpochMs = null
  let armedTabId = null
  let armedUpdate = null
  if (mode.id === 'goto') {
    page = await ctx.newPage()
  }
  else if (mode.id === 'tabs') {
    const pagePromise = ctx.waitForEvent('page', { timeout: 15000 })
    createAtEpochMs = Date.now()
    await sw.evaluate(() => chrome.tabs.create({}))
    page = await pagePromise
  }
  else {
    const pagePromise = ctx.waitForEvent('page', { timeout: 15000 })
    createAtEpochMs = Date.now()
    armedTabId = await sw.evaluate(() => chrome.tabs.create({ url: 'about:blank' }).then(t => t.id))
    page = await pagePromise
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  }

  const runErrors = []
  page.on('pageerror', e => runErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error')
      runErrors.push(`console.error: ${m.text()}`)
  })
  page.on('requestfailed', (r) => {
    const url = r.url()
    if (url.includes('/_favicon/'))
      return
    runErrors.push(`requestfailed: ${url} (${r.failure()?.errorText})`)
  })

  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Page.enable')
  const clock = await clockOffset(cdp)
  const lifecycle = []
  cdp.on('Page.lifecycleEvent', (e) => {
    lifecycle.push({
      name: e.name,
      monotonicSec: e.timestamp,
      epochMs: typeof clock.offsetSec === 'number' ? Math.round((e.timestamp + clock.offsetSec) * 1000) : null,
    })
  })
  const navigations = []
  cdp.on('Page.frameNavigated', (e) => {
    if (!e.frame.parentId)
      navigations.push({ url: e.frame.url, epochMs: Date.now() })
  })
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {})

  const rawFrames = []
  let ackFailures = 0
  cdp.on('Page.screencastFrame', (f) => {
    rawFrames.push({
      epochMs: Math.round(f.metadata.timestamp * 1000),
      b64: f.data,
      metadata: {
        deviceWidth: f.metadata.deviceWidth,
        deviceHeight: f.metadata.deviceHeight,
        pageScaleFactor: f.metadata.pageScaleFactor,
        offsetTop: f.metadata.offsetTop,
        scrollOffsetY: f.metadata.scrollOffsetY,
      },
    })
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {
      ackFailures++
    })
  })

  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: 640,
    maxHeight: 400,
    everyNthFrame: 1,
  })
  const attachEpochMs = Date.now()
  await page.bringToFront().catch(() => {})

  const pollSamples = []
  const pollDeadline = Date.now() + SETTLE_MS + 1500
  const pollLoop = (async () => {
    while (Date.now() < pollDeadline) {
      try {
        pollSamples.push(await page.evaluate(pollSample))
      }
      catch {
      }
      await new Promise(r => setTimeout(r, 20))
    }
  })()

  if (mode.id === 'goto') {
    await page.goto(newTabUrl, { waitUntil: 'commit' })
  }
  else if (mode.id === 'tabs-armed') {
    await page.waitForTimeout(300)
    armedUpdate = await sw.evaluate(
      id => chrome.tabs.update(id, { url: 'chrome://newtab/' })
        .then(t => ({ ok: true, url: t.url || t.pendingUrl || '' }))
        .catch(e => ({ ok: false, error: String(e) })),
      armedTabId,
    )
  }
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(SETTLE_MS)
  await pollLoop.catch(() => {})
  await cdp.send('Page.stopScreencast').catch(() => {})

  let probe = null
  try {
    probe = await page.evaluate(harvestProbe)
  }
  catch (e) {
    runProblems.push(`probe harvest failed: ${String(e)}`)
  }
  const finalShot = path.join(savedDir, 'final.png')
  await page.screenshot({ path: finalShot }).catch(() => {})
  const url = page.url()
  await page.close().catch(() => {})

  if (!probe)
    runProblems.push('探针没装到页面上（window.__bootProbe 不存在），时间轴退化为帧时间戳')

  const stats = []
  const BATCH = 12
  for (let i = 0; i < rawFrames.length; i += BATCH) {
    const slice = rawFrames.slice(i, i + BATCH)
    const got = await measureFrameBatch(
      reader,
      slice.map(f => ({ dataUrl: `data:image/png;base64,${f.b64}` })),
      THRESHOLDS.downsampleWidth,
    )
    stats.push(...got)
  }

  const frames = rawFrames.map((f, i) => ({
    index: i,
    epochMs: f.epochMs,
    relMs: probe ? Math.round(f.epochMs - probe.timeOrigin) : null,
    mean: stats[i].mean,
    rgb: stats[i].rgb,
    centerMean: stats[i].centerMean,
    centerRgb: stats[i].centerRgb,
    topLeftRgb: stats[i].topLeftRgb,
    w: stats[i].w,
    h: stats[i].h,
  }))

  const crossCheck = { checked: 0, maxChannelDelta: 0, detail: [] }
  const probeTargets = []
  const firstBright = frames.find(f => f.relMs >= 0 && f.mean > THRESHOLDS.brightLum)
  if (firstBright)
    probeTargets.push(firstBright.index)
  if (frames.length)
    probeTargets.push(frames.length - 1)
  for (const idx of new Set(probeTargets)) {
    const st = stats[idx]
    const rects = {
      centerThird: { x: st.w / 3, y: st.h / 3, w: st.w / 3, h: st.h / 3 },
      topLeft: { x: 0, y: 0, w: 24, h: 24 },
    }
    try {
      const exact = await measureRects(reader, Buffer.from(rawFrames[idx].b64, 'base64'), rects, 1)
      const deltas = [
        ...exact.centerThird.rgb.map((v, k) => Math.abs(v - st.centerRgb[k])),
        ...exact.topLeft.rgb.map((v, k) => Math.abs(v - st.topLeftRgb[k])),
      ]
      const maxDelta = Math.max(...deltas)
      crossCheck.checked++
      crossCheck.maxChannelDelta = Math.max(crossCheck.maxChannelDelta, maxDelta)
      crossCheck.detail.push({
        frame: idx,
        relMs: frames[idx].relMs,
        downsampledCenterRgb: st.centerRgb,
        exactCenterRgb: exact.centerThird.rgb,
        exactCenterMean: Math.round(exact.centerThird.mean * 10000) / 10000,
        downsampledMean: st.mean,
        maxChannelDelta: maxDelta,
      })
    }
    catch (e) {
      runProblems.push(`measureRects 交叉验证失败（frame ${idx}）: ${String(e)}`)
    }
  }

  const derived = deriveRun(frames, probe)
  derived.poll = derivePoll(pollSamples, probe)
  if (derived.poll) {
    const p = derived.poll
    derived.metrics.pollFirstDarkClassMs = p.firstDarkClass ? p.firstDarkClass.detectedAtRelMs : null
    derived.metrics.pollFirstBgDeepMovedMs = p.firstBgDeepMove ? p.firstBgDeepMove.detectedAtRelMs : null
    derived.metrics.pollBgDeepFinalReachedMs = p.bgDeepFinalReached ? p.bgDeepFinalReached.detectedAtRelMs : null
    derived.metrics.pollMaxSampleGapMs = p.maxSampleGap ? p.maxSampleGap.ms : null
    derived.metrics.pollSampleCount = p.sampleCount ?? null
  }

  const attachRelMs = probe ? Math.round(attachEpochMs - probe.timeOrigin) : null
  const firstFrameRel = derived.frames.firstRelMs
  const observedFromRelMs = (attachRelMs == null || firstFrameRel == null)
    ? null
    : Math.min(attachRelMs, firstFrameRel)
  const coverage = {
    attachRelMs,
    firstFrameRelMs: firstFrameRel,
    observedFromRelMs,
    headUnobservedMs: observedFromRelMs == null ? null : Math.max(0, 0 - observedFromRelMs),
    note: 'startScreencast 之后收到的第一帧，其 metadata.timestamp 可能早于 startScreencast 调用本身'
    + '（浏览器把当前保留帧先发一遍，时间戳是那一帧产出时的时间）；所以 observedFromRelMs 取两者较早值。'
    + 'tabs 模式 attachRelMs 通常有 200~400ms：Playwright 先收到 page 事件、再建 CDP session，这段抓不到。',
  }

  const savedFrames = []
  if (SAVE_FRAMES && frames.length) {
    const pick = new Set()
    pick.add(0)
    const preLast = [...frames].reverse().find(f => f.relMs < 0)
    if (preLast)
      pick.add(preLast.index)
    const firstDoc = frames.find(f => f.relMs >= 0)
    if (firstDoc)
      pick.add(firstDoc.index)
    const lastBrightDoc = [...frames].reverse().find(f => f.relMs >= 0 && f.bright)
    if (lastBrightDoc)
      pick.add(lastBrightDoc.index)
    const firstNonBright = frames.find(f => f.relMs >= 0 && !f.bright)
    if (firstNonBright)
      pick.add(firstNonBright.index)
    const firstFinalLike = frames.find(f => f.relMs >= 0 && f.finalLike)
    if (firstFinalLike)
      pick.add(firstFinalLike.index)
    pick.add(frames.length - 1)
    for (const t of derived.majorTransitions.slice(0, 3)) {
      const f = frames.find(x => x.relMs === t.relMs)
      if (f)
        pick.add(f.index)
    }
    for (const idx of [...pick].sort((a, b) => a - b).slice(0, 10)) {
      const name = `f${String(idx).padStart(4, '0')}_rel${frames[idx].relMs}ms.png`
      fs.writeFileSync(path.join(savedDir, name), Buffer.from(rawFrames[idx].b64, 'base64'))
      savedFrames.push(name)
    }
  }

  rawFrames.length = 0

  const boundaryCandidates = lifecycle.filter(e => e.epochMs && probe && Math.abs(e.epochMs - probe.timeOrigin) < 1500)
  const commitEvent = lifecycle.find(e => e.name === 'commit' && e.epochMs && probe && e.epochMs >= probe.timeOrigin - 5)

  return {
    runId,
    scenario: scenario.id,
    theme: scenario.theme,
    emulatedColorScheme: scenario.emulatedColorScheme,
    mode: mode.id,
    repeat,
    storage: { key: 'meridiem-theme', written: scenario.theme, readback },
    themeSource: {
      mirrorKey: THEME_MIRROR_KEY,
      scenarioMirror: scenario.mirror,
      seed: mirrorSeed,
      observedInPage: probe?.final?.mirror ?? null,
      observedInPollTimeline: derived.poll?.timeline?.find(s => s.mirror != null)?.mirror ?? null,
      note: '首帧脚本（src/newtab/theme-boot.js）只认 localStorage 镜像；镜像缺失时按 prefers-color-scheme 兜底',
    },
    url,
    boundary: {
      primary: 'performance.timeOrigin（文档自己的时间轴起点）；rel<0 = 浏览器上一文档的空白，rel>=0 = 本页自己的时间轴',
      timeOriginEpochMs: probe ? Math.round(probe.timeOrigin) : null,
      cdpLifecycleCommitEpochMs: commitEvent ? commitEvent.epochMs : null,
      lifecycleInWindow: boundaryCandidates,
      frameNavigated: navigations,
      attachEpochMs,
      tabsCreateAtEpochMs: createAtEpochMs,
      armedTabId,
      armedUpdate,
      clockOffsetRoundTripMs: clock.roundTripMs,
      note: '实测扩展文档的 CDP commit 事件不一定上报；timeOrigin 页内精确可得，误差远小于本次要量的事件',
    },
    probe,
    lifecycle,
    derived,
    coverage,
    frames,
    crossCheck,
    finalState: probe ? probe.final : null,
    savedFrames,
    finalScreenshot: path.relative(OUT_ROOT, finalShot).split(path.sep).join('/'),
    errors: runErrors,
    problems: runProblems,
    ackFailures,
  }
}

const AGG_METRICS = [
  'docBrightSurfaceMs',
  'ownWhiteMs',
  'wrongThemeSurfaceMs',
  'ownWrongThemeMs',
  'timeOriginToFinalLookMs',
  'firstNonBrightDocRelMs',
  'firstDocFrameRelMs',
  'firstPaintMs',
  'fcpMs',
  'dclMs',
  'loadMs',
  'htmlDarkClassMs',
  'appFirstChildMs',
  'canvasPaintedMs',
  'maxStaticGapMs',
  'pureWhiteDisplayMs',
  'lightTokenDisplayMs',
  'otherBrightDisplayMs',
  'firstNonWhiteRelMs',
  'firstLightTokenRelMs',
  'pollFirstDarkClassMs',
  'pollFirstBgDeepMovedMs',
  'pollBgDeepFinalReachedMs',
  'pollMaxSampleGapMs',
  'pollSampleCount',
]

function aggregate(runs) {
  const groups = new Map()
  for (const run of runs) {
    const key = `${run.scenario}/${run.mode}`
    if (!groups.has(key))
      groups.set(key, [])
    groups.get(key).push(run)
  }
  const out = {}
  for (const [key, list] of groups) {
    const metrics = {}
    for (const name of AGG_METRICS) {
      const vals = list.map(r => r.derived.metrics[name])
      metrics[name] = { median: median(vals), spread: spread(vals), values: vals }
    }
    const frameCounts = list.map(r => r.derived.frames.count)
    const brightFrames = list.map(r => r.derived.frames.docBrightFrames)
    const wrongThemeFrames = list.map(r => r.derived.frames.wrongThemeFrames)
    const clusterSeq = list.map(r => r.derived.clusters.map(c => `${c.key}@${c.fromRelMs}~${c.toRelMs}`).join(' > '))
    const majorSeq = list.map(r => r.derived.majorTransitions.map(t => `${t.relMs}:${t.fromRgb.join('.')}->${t.toRgb.join('.')}`).join(' | '))
    out[key] = {
      scenario: list[0].scenario,
      mode: list[0].mode,
      repeats: list.length,
      theme: list[0].theme,
      emulatedColorScheme: list[0].emulatedColorScheme,
      metrics,
      frames: { count: { median: median(frameCounts), spread: spread(frameCounts) }, docBrightFrames: { median: median(brightFrames), spread: spread(brightFrames) }, wrongThemeFrames: { median: median(wrongThemeFrames), spread: spread(wrongThemeFrames) } },
      clusterSequenceStable: new Set(clusterSeq).size === 1,
      clusterSequences: clusterSeq,
      majorTransitionStable: new Set(majorSeq).size === 1,
      majorSequences: majorSeq,
      runIds: list.map(r => r.runId),
    }
  }
  return out
}

function deltaVs(baseline, current) {
  const out = {}
  for (const key of Object.keys(current)) {
    const b = baseline[key]
    const c = current[key]
    if (!b) {
      out[key] = { note: 'baseline 里没有这个场景/打开方式组合' }
      continue
    }
    const per = {}
    for (const name of ['docBrightSurfaceMs', 'ownWhiteMs', 'wrongThemeSurfaceMs', 'ownWrongThemeMs', 'timeOriginToFinalLookMs', 'htmlDarkClassMs', 'firstPaintMs', 'fcpMs']) {
      const bv = b.metrics[name]?.median
      const cv = c.metrics[name]?.median
      per[name] = {
        baseline: bv,
        current: cv,
        delta: typeof bv === 'number' && typeof cv === 'number' ? Math.round((cv - bv) * 100) / 100 : null,
      }
    }
    per.docBrightFrames = {
      baseline: b.metrics ? b.frames.docBrightFrames.median : null,
      current: c.frames.docBrightFrames.median,
      delta: b.frames.docBrightFrames.median != null && c.frames.docBrightFrames.median != null
        ? c.frames.docBrightFrames.median - b.frames.docBrightFrames.median
        : null,
    }
    out[key] = per
  }
  return out
}

async function launchExtensionContext(scenario, attempt) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: scenario.emulatedColorScheme,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
  })
  try {
    await ctx.addInitScript(newtabBootProbe)
    let sw = ctx.serviceWorkers()[0]
    if (!sw) {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 12000 }).catch(() => null)
    }
    if (!sw)
      throw new Error('service worker 没注册（扩展很可能没加载成功）')
    const extensionId = sw.url().split('/')[2]

    const hasTabsApi = await sw.evaluate(() => typeof chrome?.tabs?.create === 'function').catch(() => false)
    if (!hasTabsApi)
      throw new Error('service worker 里没有 chrome.tabs（不是我们的扩展上下文）')

    const pagePromise = ctx.waitForEvent('page', { timeout: 15000 })
    await sw.evaluate(() => chrome.tabs.create({}))
    const probePage = await pagePromise
    await probePage.waitForURL(/^chrome-extension:\/\//, { timeout: 10000 }).catch(() => {})
    const landedUrl = probePage.url()
    await probePage.close().catch(() => {})
    if (!landedUrl.startsWith(`chrome-extension://${extensionId}/`))
      throw new Error(`newtab override 未接管：chrome.tabs.create({}) 落地在 ${landedUrl || '(空)'}`)

    return { ctx, sw, extensionId, overrideUrl: landedUrl, attempt }
  }
  catch (e) {
    await ctx.close().catch(() => {})
    throw e
  }
}

function loadHtmlEvidence() {
  const html = fs.readFileSync(NEWTAB_INDEX, 'utf8')

  const scriptTags = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({
    attrs: m[1],
    src: (m[1].match(/\bsrc="([^"]+)"/) ?? [])[1] ?? null,
    type: (m[1].match(/\btype="([^"]+)"/) ?? [])[1] ?? null,
    inline: m[2].trim(),
    index: m.index,
  }))
  const srcScripts = scriptTags.filter(s => s.src).map(s => s.src)
  const inlineScripts = scriptTags.filter(s => !s.src && s.inline).map(s => s.inline)
  const styleTags = [...html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)].map(m => ({ css: m[2].trim(), index: m.index }))
  const stylesheetTags = [...html.matchAll(/<link([^>]*)>/g)]
    .filter(m => /\brel="stylesheet"/.test(m[1]))
    .map(m => ({
      tag: m[0],
      href: (m[1].match(/href="([^"]+)"/) ?? [])[1] ?? null,
      index: m.index,
    }))
  const moduleScript = scriptTags.find(s => s.type === 'module' || (s.src && s.src.endsWith('.js') && !/theme-boot/.test(s.src))) ?? null
  const themeBootTag = scriptTags.find(s => s.src && /theme-boot/.test(s.src)) ?? null

  const themeBootPaths = []
  if (themeBootTag) {
    const rel = themeBootTag.src.replace(/^\.?\//, '')
    themeBootPaths.push(rel.startsWith('dist/') ? path.join(EXTENSION, rel) : path.join(EXTENSION, 'dist', 'newtab', rel))
    themeBootPaths.push(path.join(EXTENSION, 'dist', 'assets', 'theme-boot.js'))
  }
  const themeBootFile = themeBootPaths.find(p => fs.existsSync(p)) ?? null

  const inlineCss = styleTags.map(s => s.css).join('\n')
  const firstStyleIndex = styleTags.length ? styleTags[0].index : null

  return {
    path: path.relative(ROOT, NEWTAB_INDEX).split(path.sep).join('/'),
    sha256: sha256(NEWTAB_INDEX),
    bytes: fs.statSync(NEWTAB_INDEX).size,
    scripts: srcScripts,
    themeBoot: {
      scriptTagPresent: !!themeBootTag,
      scriptSrc: themeBootTag ? themeBootTag.src : null,
      scriptTagIsClassic: themeBootTag ? themeBootTag.type === null : null,
      fileExists: !!themeBootFile,
      filePath: themeBootFile ? path.relative(ROOT, themeBootFile).split(path.sep).join('/') : null,
      fileSha256: themeBootFile ? sha256(themeBootFile) : null,
      fileBytes: themeBootFile ? fs.statSync(themeBootFile).size : null,
    },
    stylesheets: stylesheetTags.map(s => s.href),
    inlineScriptCount: inlineScripts.length,
    inlineStyleCount: styleTags.length,
    inlineStyleBytes: inlineCss.length,
    inlineBackgroundRuleCount: styleTags.filter(s => /background/i.test(s.css)).length,
    inlineHasDarkBackground: /html\.dark[^{]*\{[^}]*background/i.test(inlineCss) || /background-color:\s*#0/.test(inlineCss),
    inlineStyleBeforeFirstStylesheet: firstStyleIndex != null && stylesheetTags.length
      ? firstStyleIndex < Math.min(...stylesheetTags.map(s => s.index))
      : null,
    inlineStyleBeforeModuleScript: firstStyleIndex != null && moduleScript
      ? firstStyleIndex < moduleScript.index
      : null,
    hasInlineBackgroundRule: styleTags.some(s => /background/i.test(s.css)),
    bodyLine: (html.match(/<body[^>]*>/) ?? [''])[0],
    note: 'hasInlineBackgroundRule=false 表示文档里没有任何内联底色：第一帧完全由外部 CSS 决定',
  }
}

function bootCheck(payload) {
  const ext = payload.extension.newtabIndex
  const runs = payload.runs
  const aggregates = payload.aggregates ?? {}

  const perRun = runs.map((r) => {
    const m = r.derived.metrics
    return {
      runId: r.runId,
      theme: r.theme,
      mode: r.mode,
      scenarioMirror: r.themeSource?.scenarioMirror ?? null,
      mirrorObserved: r.themeSource?.observedInPage ?? null,
      finalIsBright: r.derived.frames.finalIsBright,
      wrongThemeFrames: r.derived.frames.wrongThemeFrames,
      wrongThemeSurfaceMs: m.wrongThemeSurfaceMs,
      ownWrongThemeMs: m.ownWrongThemeMs,
      docBrightFrames: r.derived.frames.docBrightFrames,
      docWhiteFrames: r.derived.frames.docWhiteFrames,
      firstDocFrameRelMs: m.firstDocFrameRelMs,
      firstDocFrameRgb: m.firstDocFrameRgb,
      firstDocFrameIsPureWhite: m.firstDocFrameIsPureWhite,
      firstDocFrameMatchesLightToken: m.firstDocFrameRgb
        ? Math.max(...m.firstDocFrameRgb.map((v, i) => Math.abs(v - [232, 237, 242][i]))) <= 6
        : null,
      firstPaintMs: m.firstPaintMs,
      htmlDarkClassMs: m.htmlDarkClassMs,
      darkClassBeforeFirstPaint: (m.htmlDarkClassMs != null && m.firstPaintMs != null) ? m.htmlDarkClassMs <= m.firstPaintMs : null,
      ownWhiteMs: m.ownWhiteMs,
      frames: r.derived.frames.count,
    }
  })

  return {
    artifact: {
      sha256: ext.sha256,
      inlineStyleCount: ext.inlineStyleCount,
      inlineStyleHasDarkBackground: ext.inlineHasDarkBackground,
      inlineStyleBeforeFirstStylesheet: ext.inlineStyleBeforeFirstStylesheet,
      inlineStyleBeforeModuleScript: ext.inlineStyleBeforeModuleScript,
      themeBootScriptTag: ext.themeBoot.scriptTagPresent,
      themeBootScriptSrc: ext.themeBoot.scriptSrc,
      themeBootScriptIsClassic: ext.themeBoot.scriptTagIsClassic,
      themeBootFileExists: ext.themeBoot.fileExists,
      themeBootFileSha256: ext.themeBoot.fileSha256,
    },
    perRun,
    allRunsFirstFrameDark: perRun.length ? perRun.every(r => r.docBrightFrames === 0) : null,
    anyRunDarkClassBeforeFirstPaint: perRun.some(r => r.darkClassBeforeFirstPaint === true),
    lightScenario: perRun.filter(r => r.theme === 'light'),
    darkScenario: perRun.filter(r => r.theme === 'dark'),
    byMirror: {
      seeded: perRun.filter(r => r.scenarioMirror !== null),
      absent: perRun.filter(r => r.scenarioMirror === null),
    },
    headline: {
      wrongThemeFramesMedianByKey: Object.fromEntries(Object.entries(aggregates).map(([k, v]) => [k, {
        wrongThemeFrames: v.frames.wrongThemeFrames.median,
        wrongThemeSurfaceMs: v.metrics.wrongThemeSurfaceMs.median,
        ownWrongThemeMs: v.metrics.ownWrongThemeMs.median,
        firstDocFrameRgbMedians: v.metrics.firstDocFrameRgb?.values ?? null,
      }])),
    },
  }
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true })
  const outDir = path.join(OUT_ROOT, label)
  fs.mkdirSync(outDir, { recursive: true })

  const htmlBefore = loadHtmlEvidence()
  const mainJs = path.join(EXTENSION, 'dist', htmlBefore.scripts[0]?.replace(/^\/dist\//, '') ?? '')
  const mainJsSha = fs.existsSync(mainJs) ? sha256(mainJs) : null

  const scenarios = SCENARIOS.filter(s => !ONLY_SCENARIOS.length || ONLY_SCENARIOS.includes(s.id))
  const modes = MODES.filter(m => !ONLY_MODES.length || ONLY_MODES.includes(m.id))

  console.log(`[boot-trace] label=${label} repeats=${REPEATS} settle=${SETTLE_MS}ms`)
  console.log(`[boot-trace] extension/dist/newtab/index.html sha256=${htmlBefore.sha256}`)
  console.log(`[boot-trace] 内联底色: ${htmlBefore.hasInlineBackgroundRule ? '有' : '无'} / 内联脚本 ${htmlBefore.inlineScriptCount} 个 / theme-boot.js ${htmlBefore.themeBoot.fileExists ? '有' : '无'}`)
  console.log(`[boot-trace] 场景: ${scenarios.map(s => `${s.id}(theme=${s.theme},系统=${s.emulatedColorScheme},镜像=${s.mirror ?? '缺失'})`).join('  ')}`)

  const allRuns = []
  const globalProblems = []
  const contextFailures = []
  const contextAttempts = []
  const t0 = Date.now()

  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= REPEATS; repeat++) {
      let launched = null
      for (let attempt = 1; attempt <= 3 && !launched; attempt++) {
        try {
          launched = await launchExtensionContext(scenario, attempt)
          contextAttempts.push({ scenario: scenario.id, repeat, attempt, ok: true, overrideUrl: launched.overrideUrl })
        }
        catch (e) {
          contextAttempts.push({ scenario: scenario.id, repeat, attempt, ok: false, error: String(e) })
          console.log(`  ~ ${scenario.id}#${repeat} 第 ${attempt} 次起浏览器失败：${String(e)}`)
          await new Promise(r => setTimeout(r, 700))
        }
      }
      if (!launched) {
        const msg = `${scenario.id}#${repeat} 连起 3 次都没能加载扩展 / 没接管 newtab，跳过这一轮`
        contextFailures.push(msg)
        globalProblems.push(msg)
        console.log(`  !! ${msg}`)
        continue
      }

      const { ctx, sw, extensionId } = launched
      try {
        const reader = await openPixelReader(ctx)

        for (const mode of modes) {
          const savedDir = path.join(outDir, 'frames', `${scenario.id}_${mode.id}#${repeat}`)
          fs.mkdirSync(savedDir, { recursive: true })
          try {
            const run = await runOnce({
              ctx,
              sw,
              extensionId,
              scenario,
              mode,
              repeat,
              reader,
              savedDir,
            })
            if (!run.url.startsWith(`chrome-extension://${extensionId}/`))
              run.problems.push(`页面 URL 不是扩展 newtab（${run.url}），这一轮无效`)
            allRuns.push(run)
            const m = run.derived.metrics
            console.log(
              `  ${run.runId.padEnd(26)} frames=${String(run.derived.frames.count).padStart(3)} `
              + `异类帧=${String(run.derived.frames.wrongThemeFrames).padStart(3)} `
              + `异类=${String(m.wrongThemeSurfaceMs).padStart(5)}ms `
              + `本页异类=${String(m.ownWrongThemeMs).padStart(5)}ms `
              + `亮底帧=${String(run.derived.frames.docBrightFrames).padStart(3)} `
              + `纯白帧=${String(run.derived.frames.docWhiteFrames).padStart(2)} `
              + `纯白停=${String(m.pureWhiteDisplayMs).padStart(5)}ms `
              + `浅色停=${String(m.lightTokenDisplayMs).padStart(5)}ms `
              + `首帧RGB=${JSON.stringify(m.firstDocFrameRgb)} `
              + `最长静止=${String(m.maxStaticGapMs).padStart(5)}ms `
              + `dark类=${String(m.pollFirstDarkClassMs ?? m.htmlDarkClassMs).padStart(6)}ms `
              + `firstPaint=${String(m.firstPaintMs).padStart(6)}ms`
              + ` attach=+${run.coverage.attachRelMs}ms err=${run.errors.length}`,
            )
            if (run.problems.length)
              console.log(`     ! ${run.problems.join('; ')}`)
            if (run.errors.length)
              console.log(`     ! ${run.errors.slice(0, 3).join('; ')}`)
          }
          catch (e) {
            const msg = `${scenario.id}/${mode.id}#${repeat} 失败: ${String(e)}`
            globalProblems.push(msg)
            console.log(`  !! ${msg}`)
          }
        }
      }
      finally {
        await ctx.close().catch(() => {})
      }
    }
  }

  const htmlAfter = loadHtmlEvidence()
  if (htmlAfter.sha256 !== htmlBefore.sha256)
    globalProblems.push(`追踪期间 extension/dist/newtab/index.html 变了（${htmlBefore.sha256} → ${htmlAfter.sha256}），这一版数据不能当作单一基线`)

  const aggregates = aggregate(allRuns)
  const payload = {
    label,
    generatedAt: new Date().toISOString(),
    script: 'scripts/boot-trace.mjs',
    args: { repeats: REPEATS, settleMs: SETTLE_MS, scenarios: scenarios.map(s => s.id), modes: modes.map(m => m.id) },
    extension: {
      newtabIndex: htmlBefore,
      precondition: 'extension/ 必须是生产产物；刚跑过 pnpm dev 的话先 node scripts/rebuild.mjs',
      mainJs: { path: htmlBefore.scripts[0] ?? null, sha256: mainJsSha },
      sha256AfterRuns: htmlAfter.sha256,
      stableDuringRun: htmlAfter.sha256 === htmlBefore.sha256,
      note: 'sha256 是「这一版基线」的身份；lead 冻结构建后重跑，靠它确认测的是新版',
    },
    method: {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorSchemeContext: '每个 (场景 × 重复) 起一个全新 persistent context，colorScheme 在 context 级设定（这样 chrome.tabs.create 出来的新页在首帧之前就已经是目标偏好）',
      screencast: {
        enabledVia: 'CDP Page.startScreencast，导航前开启',
        format: 'png',
        maxWidth: 640,
        maxHeight: 400,
        everyNthFrame: 1,
        note: '帧是「画面有变化才发」的变化驱动：两帧之间没有帧 = 画面没变。所以不能用「没有帧」判断页面没渲染，只能用有帧的时刻判断「变了」。',
      },
      pixelMeasurement: {
        downsampleWidth: THRESHOLDS.downsampleWidth,
        rounds: ['整帧平均相对亮度', '中心 1/3 平均亮度 + 平均 RGB', '左上角 1/8 区域平均 RGB'],
        crossCheck: '对每轮的第一帧亮底与最后一帧，另用 scripts/lib/pixels.mjs 的 measureRects 在原分辨率上重量，JSON 里 crossCheck.maxChannelDelta 就是两种算法的最大通道差',
        luminance: 'WCAG 相对亮度（线性化 sRGB 后加权），与 scripts/contrast-audit.mjs 一致',
      },
      thresholds: THRESHOLDS,
      repeats: REPEATS,
      statistic: '每场景取中位数；spread 给 min/max/jitter',
      timelineZero: 'performance.timeOrigin（epoch 毫秒，注入探针在文档开始处读取）',
      themeStorageWrite: 'chrome.storage.local.set({ \'meridiem-theme\': \'dark\' }) —— 原始字符串（string 序列化器直接返回原值），与 scripts/preview.mjs 一致',
      probe: 'context.addInitScript，在任何页面脚本之前；只安装到 /dist/newtab/ 文档',
      observerEffect: '探针每帧读一次 computed style 并跑 rAF，可能带来极小开销（约百微秒级）；另外录屏本身会强制合成，headless 下与实际窗口的合成节奏可能有差异',
      rafSamplingCaveat: 'rAF 回调跟着合成帧走：headless 下页面静止时实测 650ms 不回调。所以探针里的 samples 会漏掉静止窗口，'
      + '不要用它判断「token 什么时候变」；判断时改用 derived.poll（Node 侧 20ms 轮询，主线程真实执行时刻）与 MutationObserver 的 marks。',
      pollSampling: 'Node 侧每 ~20ms 一次 page.evaluate(pollSample)。导航瞬间 execution context 销毁会让个别采样抛错，已忽略。'
      + '轮询本身会在主线程空闲时强制一次 style recalc（把待处理的样式变更提前落地），影响量级在数毫秒，JSON 里如实标注。',
      knownPitfalls: [
        'screencast 帧是变化驱动的：两个帧之间没有帧 = 画面没变。所以「白屏持续多久」只能靠两侧帧的时间戳之差，以及首帧之前那段无法用帧证明的空白必须靠 first-paint 补。',
        'CDP 的 commit 事件在扩展文档上并不总上报（本次 baseline 里扩展文档只见到 init/firstPaint/DOMContentLoaded/load）。所以时间轴零点用页内的 performance.timeOrigin。',
        'startScreencast 后收到的第一帧，其时间戳可能早于 startScreencast 调用本身（浏览器先补发当前保留帧）。',
        'tabs 模式（chrome.tabs.create）从 page 事件到建好 CDP session 通常要 200~400ms，这段的帧抓不到，只能靠探针（探针在文档开始前就装好了，不受影响）。',
      ],
    },
    scenarios,
    contextAttempts,
    contextFailures,
    valid: contextFailures.length === 0 && allRuns.length === scenarios.length * REPEATS * modes.length,
    interpretation: {
      whatThisMeasures: [
        '(a) rel<0 的帧 = 本页文档开始之前浏览器自己的画面（含 about:blank 的白）。这段不由扩展控制，只如实汇报。',
        '(b) rel>=0 的帧 = 本页自己的时间轴。亮底帧（整帧平均相对亮度 > brightLum）就是用户说的「白屏闪一下」。',
      ],
      headlineMetrics: {
        docBrightFrames: '文档开始后出现的亮底帧数。归零 = 首帧就是深色底。',
        docBrightSurfaceMs: '从文档开始（或第一帧文档帧）到第一次出现非亮底帧的时长。',
        ownWhiteMs: '从本页 first-paint 到亮底结束的时长 —— 扣掉了 first-paint 之前那段浏览器白，是本页该背的锅。',
        maxStaticGapMs: '最长「画面完全没变」的间隔，配合 derived.frames.maxStaticGap.colorBefore 就是用户盯着不动的那一屏是什么颜色。',
        pollFirstDarkClassMs: 'html 挂上 dark 类的时刻（Node 轮询 / MutationObserver 交叉确认）。',
        pollFirstBgDeepMovedMs: '整屏底色（body 的 var(--bg-deep)）开始变化的时刻。',
        pollBgDeepFinalReachedMs: '底色到达终值的时刻。',
        timeOriginToFinalLookMs: '与最后一帧同色的第一帧；注意它包含天空 canvas 0.9s 淡入，不等于「主题闪动结束」。',
      },
      expectedAfterFix: '内联 boot 底色 + 同步主题镜像生效后：docBrightFrames 应为 0、ownWhiteMs ≈ 0、'
      + 'pollFirstDarkClassMs 应在 first-paint 之前；timeOriginToFinalLookMs 仍会有 1~2s（天空淡入是设计内的，不是闪动）。',
      varianceNote: '重复之间的抖动主要来自：主线程被 module 脚本/字体/three.js 占住的时长、以及 :root 上 --bg-deep 1.2s 的过渡开始时刻。'
      + '所以报告里给中位数 + min/max，单次数字不要当结论。',
    },
    runs: allRuns,
    aggregates,
    problems: globalProblems,
    notMeasured: [
      'commit 之前那段浏览器白：只如实汇报，不归零（rel<0 的帧）',
      '真实 GFP/GPU 合成下的节奏：headless=new 没有真实垂直同步，帧到达节奏可能与窗口模式不同',
      '设备像素比 > 1（本次 dsf=1）；高 DPI 下白闪的物理时长一样，但像素统计口径不同',
      'Chrome 冷启动的首次 newtab（本次每次都复用同一个「刚启动的浏览器 profile」，但没有覆盖「浏览器启动后第一个标签页」这种更冷的场景）',
      '真实用户按 Ctrl+T 时的窗口/焦点切换开销：tabs 模式是 SW 调 chrome.tabs.create，已经接近但不是键盘路径',
    ],
    nextStep: `lead 冻结构建之后：node --no-experimental-require-module scripts/boot-trace.mjs after，脚本会自动比对 ${label === 'baseline' ? 'baseline.json' : 'baseline.json'}`,
  }

  payload.bootCheck = bootCheck(payload)

  const baselinePath = path.join(OUT_ROOT, 'baseline.json')
  if (label !== 'baseline' && fs.existsSync(baselinePath)) {
    try {
      const baselinePayload = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
      payload.deltaVsBaseline = {
        baselineGeneratedAt: baselinePayload.generatedAt,
        baselineIndexSha256: baselinePayload.extension?.newtabIndex?.sha256 ?? null,
        indexSha256Changed: baselinePayload.extension?.newtabIndex?.sha256 !== htmlBefore.sha256,
        delta: deltaVs(baselinePayload.aggregates ?? {}, aggregates),
      }
    }
    catch (e) {
      payload.problems.push(`读 baseline.json 失败: ${String(e)}`)
    }
  }

  const outFile = path.join(OUT_ROOT, `${label}.json`)
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`)

  console.log('\n--- boot 产物核对（lead 的 after 检查项）---')
  console.log(`  内联 <style> ${payload.bootCheck.artifact.inlineStyleCount} 个，深色底=${payload.bootCheck.artifact.inlineStyleHasDarkBackground}，`
  + `排在样式表之前=${payload.bootCheck.artifact.inlineStyleBeforeFirstStylesheet}`)
  console.log(`  theme-boot.js 标签=${payload.bootCheck.artifact.themeBootScriptTag} src=${payload.bootCheck.artifact.themeBootScriptSrc} `
  + `经典脚本=${payload.bootCheck.artifact.themeBootScriptIsClassic} 文件存在=${payload.bootCheck.artifact.themeBootFileExists}`)
  console.log(`  首帧即深色：${payload.bootCheck.allRunsFirstFrameDark}；dark 类早于 first-paint 的轮次：`
  + `${payload.bootCheck.perRun.filter(r => r.darkClassBeforeFirstPaint).length}/${payload.bootCheck.perRun.length}`)

  console.log(`\n[boot-trace] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，写了 ${allRuns.length} 轮`)
  console.log(`[boot-trace] → ${path.relative(ROOT, outFile).split(path.sep).join('/')}`)
  console.log('\n--- 聚合（中位数 / 抖动）---')
  for (const [key, agg] of Object.entries(aggregates)) {
    const g = n => agg.metrics[n]?.median
    const j = n => (agg.metrics[n]?.spread ? agg.metrics[n].spread.jitter : '-')
    console.log(
      `${key.padEnd(24)} 亮底 ${String(g('docBrightSurfaceMs')).padStart(6)}ms(±${j('docBrightSurfaceMs')})`
      + ` | 本页白 ${String(g('ownWhiteMs')).padStart(6)}ms(±${j('ownWhiteMs')})`
      + ` | 最长静止 ${String(g('maxStaticGapMs')).padStart(6)}ms(±${j('maxStaticGapMs')})`
      + ` | dark类 ${String(g('pollFirstDarkClassMs')).padStart(6)}ms`
      + ` | 底色动 ${String(g('pollFirstBgDeepMovedMs')).padStart(6)}ms`
      + ` | 底色到位 ${String(g('pollBgDeepFinalReachedMs')).padStart(6)}ms`
      + ` | 亮底帧中位 ${agg.frames.docBrightFrames.median} 序列稳定=${agg.clusterSequenceStable}`,
    )
  }
  if (payload.deltaVsBaseline) {
    console.log('\n--- before → after（中位数）---')
    console.log(`  baseline sha ${payload.deltaVsBaseline.baselineIndexSha256?.slice(0, 12)} → after sha ${htmlBefore.sha256.slice(0, 12)}（变了=${payload.deltaVsBaseline.indexSha256Changed}）`)
    for (const [key, d] of Object.entries(payload.deltaVsBaseline.delta)) {
      if (d.note) {
        console.log(`  ${key.padEnd(24)} ${d.note}`)
        continue
      }
      const cell = n => d[n] ? `${String(d[n].baseline).padStart(7)} → ${String(d[n].current).padStart(7)} (${d[n].delta > 0 ? '+' : ''}${d[n].delta})` : '-'
      console.log(`  ${key.padEnd(24)} 异类表面 ${cell('wrongThemeSurfaceMs')} | 本页异类 ${cell('ownWrongThemeMs')} | 亮底表面 ${cell('docBrightSurfaceMs')} | 本页白 ${cell('ownWhiteMs')} | dark类 ${cell('htmlDarkClassMs')} | firstPaint ${cell('firstPaintMs')}`)
    }
  }

  if (globalProblems.length) {
    console.log('\n--- 全局问题 ---')
    for (const p of globalProblems) console.log(`  ! ${p}`)
  }
  return payload
}

await main()
