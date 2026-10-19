<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { paletteFor, phaseForHour } from '~/logic/ambience'
import { DEFAULT_LATITUDE, skyFrameAt } from '~/logic/sky'
import type { SkyRenderer } from '~/logic/skyRenderer'

const props = defineProps<{
  dark: boolean
  override?: Date | null
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const renderer = shallowRef<SkyRenderer | null>(null)
const painted = ref(false)
const veil = ref(0.2)
const veilFast = ref(false)

const FRAME_INTERVAL = 15000

const fallbackPhase = computed(() => phaseForHour(new Date().getHours()))
const palette = computed(() => paletteFor(fallbackPhase.value, props.dark))

const fallbackStyle = computed(() => ({
  '--amb-from': palette.value.from,
  '--amb-to': palette.value.to,
  '--amb-glow': palette.value.glow,
}))

const veilStyle = computed(() => ({
  '--veil-alpha': String(veil.value),
  '--veil-dur': veilFast.value ? '260ms' : '1200ms',
}))

const now = () => props.override ?? new Date()

const DEBUG = new URLSearchParams(window.location.search).has('skydebug')

function publishDebug(patch: Record<string, unknown>) {
  if (!DEBUG)
    return
  const w = window as unknown as { __sky?: Record<string, unknown> }
  w.__sky = { ...w.__sky, ...patch }
}

const VEIL_LIGHT = 0.9
const VEIL_DARK = 0.0125

const FLOOR_LIGHT = 0.52
const CEIL_DARK = 0.0644

const VEIL_MAX_LIGHT = 0.78
const VEIL_MAX_DARK = 0.92

function encodeSrgb(linear: number) {
  const v = Math.min(Math.max(linear, 0), 1)
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

function veilForLight(actual: number, minBg: number) {
  const canvas = encodeSrgb(actual)
  const target = encodeSrgb(minBg * 1.03)
  const veil = encodeSrgb(VEIL_LIGHT)
  return Math.min(
    Math.max((target - canvas) / Math.max(veil - canvas, 1e-4), 0),
    VEIL_MAX_LIGHT,
  )
}

const SKY_NEED_CAP = 0.36

function veilFor(worst: number) {
  const ratio = props.dark
    ? (worst - CEIL_DARK) / Math.max(worst - VEIL_DARK, 1e-4)
    : (FLOOR_LIGHT - worst) / Math.max(VEIL_LIGHT - worst, 1e-4)
  return Math.min(Math.max(ratio, 0), props.dark ? VEIL_MAX_DARK : VEIL_MAX_LIGHT)
}

let frameTimer = 0
let veilFastTimer = 0
let bootRaf = 0
let bootTimer = 0
let stopDarkWatch: (() => void) | null = null
let disposed = false

function pushFrame() {
  const r = renderer.value
  if (!r)
    return
  const date = now()
  const frame = skyFrameAt(date, { dark: props.dark, latitude: DEFAULT_LATITUDE })
  r.setFrame(frame)
  publishDebug({ frame })
  if (!painted.value)
    veil.value = frame.veil
}

function onPointerMove(event: PointerEvent) {
  const r = renderer.value
  if (!r)
    return
  r.setPointer(
    (event.clientX / window.innerWidth) * 2 - 1,
    (event.clientY / window.innerHeight) * 2 - 1,
  )
}

function onPointerDown(event: PointerEvent) {
  const r = renderer.value
  if (!r || !painted.value)
    return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, a, input, [role="button"], [role="menuitem"]'))
    return
  r.addDrop(event.clientX / window.innerWidth, event.clientY / window.innerHeight)
}

function onVisibility() {
  const r = renderer.value
  if (!r)
    return
  if (document.hidden)
    r.stop()
  else
    r.start()
}

function onResize() {
  renderer.value?.renderOnce()
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const TEXT_SELECTORS = [
  '[data-test="clock"]',
  '.clock__seconds',
  '[data-test="clock-date"]',
  '[data-test="greeting"]',
  '[data-test="search-input"]',
  '.brand__word',
  '.grid-title',
  '.grid-hint',
  '.grid-edit',
  '.tile-name',
]

function parseColor(color: string): { r: number, g: number, b: number, a: number } | null {
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (!m)
    return null
  const parts = m[1].split(',').map(s => Number.parseFloat(s.trim()))
  if (parts.length < 3 || parts.slice(0, 3).some(v => !Number.isFinite(v)))
    return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

function colorLuminance(c: { r: number, g: number, b: number }) {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

function cumulativeOpacity(el: Element) {
  let o = 1
  let node: Element | null = el
  while (node && node !== document.documentElement) {
    const v = Number.parseFloat(getComputedStyle(node).opacity)
    if (Number.isFinite(v))
      o *= v
    node = node.parentElement
  }
  return o
}

function requiredBackdrop(el: Element) {
  const cs = getComputedStyle(el)
  const ink = parseColor(cs.color)
  const textLum = ink ? colorLuminance(ink) : 0.055
  const size = Number.parseFloat(cs.fontSize)
  const weight = Number.parseInt(cs.fontWeight, 10) || 400
  const large = size >= 24 || (size >= 18.66 && weight >= 700)
  const ratio = large ? 3 : 4.5
  const alpha = Math.min(1, Math.max((ink?.a ?? 1) * cumulativeOpacity(el), 0.01))
  if (alpha > 0.999)
    return Math.min(ratio * (textLum + 0.05) - 0.05, 1)
  const denom = 1 - ratio * (1 - alpha)
  if (denom <= 1e-4)
    return 1
  return Math.min((ratio * alpha * textLum + 0.05 * (ratio - 1)) / denom, 1)
}

function getTextRects() {
  const out: { x: number, y: number, w: number, h: number, minBg: number }[] = []
  for (const sel of TEXT_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2)
        continue
      out.push({
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        minBg: requiredBackdrop(el),
      })
    }
  }
  return out
}

async function boot() {
  if (!canvas.value)
    return

  let sky: typeof import('~/logic/skyRenderer')
  try {
    sky = await import('~/logic/skyRenderer')
  }
  catch (error) {
    console.warn('[sky] 天光渲染器加载失败，走 CSS 兜底：', error)
    publishDebug({ skyImportFailed: true })
    return
  }

  const el = canvas.value
  if (disposed || !el)
    return

  const blendMs = reducedMotion ? 0 : sky.THEME_BLEND_MS
  let switchingUntil = 0
  let veilFastUntil = 0
  const steadyAfter = performance.now() + 1800

  const r = sky.createSkyRenderer(el, {
    renderScale: 0.34,
    targetFps: 30,
    themeBlendMs: blendMs,
    getTextRects,
    onReady: () => {
      painted.value = true
      publishDebug({ painted: true })
    },
    onTooSlow: () => {
      r.stop()
      r.dispose()
      renderer.value = null
      painted.value = false
      veil.value = 0
      publishDebug({ painted: false, degraded: true })
    },
    onProbe: (probe) => {
      const el = probe.elements
      const now = performance.now()
      const settled = now >= steadyAfter && now >= switchingUntil
      let need: number
      if (el && el.count > 0) {
        let worst = 0
        if (props.dark) {
          for (let i = 0; i < el.count; i++)
            worst = Math.max(worst, veilFor(el.high[i]))
        }
        else if (settled) {
          for (let i = 0; i < el.count; i++)
            worst = Math.max(worst, veilForLight(el.low[i], el.needs[i]))
        }
        else {
          for (let i = 0; i < el.count; i++)
            worst = Math.max(worst, veilForLight(el.low[i], Math.min(el.needs[i], SKY_NEED_CAP)))
        }
        need = worst
      }
      else {
        need = veilFor(props.dark ? probe.text.p90 : probe.text.p10)
      }
      const switchingToLight = !props.dark && now < veilFastUntil
      veil.value += (need - veil.value) * (switchingToLight ? 0.8 : 0.5)
      publishDebug({ probe, veil: veil.value })
    },
  })

  if (!r.supported) {
    return
  }

  renderer.value = r
  pushFrame()

  stopDarkWatch = watch(() => props.dark, (dark) => {
    switchingUntil = performance.now() + blendMs + 250
    veilFastUntil = performance.now() + blendMs + 900
    veilFast.value = !dark
    window.clearTimeout(veilFastTimer)
    veilFastTimer = window.setTimeout(() => {
      veilFast.value = false
    }, blendMs + 1000)
    pushFrame()
    if (reducedMotion)
      r.renderOnce()
  })

  if (reducedMotion) {
    r.renderOnce()
  }
  else {
    r.start()
    frameTimer = window.setInterval(pushFrame, FRAME_INTERVAL)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', onResize)
  }
}

onMounted(() => {
  bootRaf = window.requestAnimationFrame(() => {
    bootTimer = window.setTimeout(() => {
      void boot()
    }, 0)
  })
})

onUnmounted(() => {
  disposed = true
  window.cancelAnimationFrame(bootRaf)
  window.clearTimeout(bootTimer)
  stopDarkWatch?.()
  window.clearInterval(frameTimer)
  window.clearTimeout(veilFastTimer)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('resize', onResize)
  renderer.value?.dispose()
  renderer.value = null
})
</script>

<template>
  <div class="sky" :style="[fallbackStyle, veilStyle]" aria-hidden="true">
    <div class="sky__fallback" />
    <canvas ref="canvas" class="sky__canvas" :class="{ 'is-painted': painted }" />
    <div class="sky__veil" />
  </div>
</template>

<style scoped>
.sky {
  position: fixed;
  inset: 0;
  z-index: var(--z-ambience);
  overflow: hidden;
  pointer-events: none;
}

.sky__fallback {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 70% at 50% 6%, var(--amb-glow) 0%, transparent 62%),
    linear-gradient(168deg, var(--amb-from) 0%, var(--amb-to) 58%, var(--bg-deep) 100%);
}

.sky__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  opacity: 0;
  transition: opacity 900ms ease-out;
}

.sky__canvas.is-painted {
  opacity: 1;
}

.sky__veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: var(--veil-alpha, 0);
  transition: opacity var(--veil-dur, 1200ms) ease-out;
  background: radial-gradient(
    125% 115% at 50% 45%,
    var(--veil-color-strong) 0%,
    var(--veil-color-strong) 55%,
    var(--veil-color-soft) 82%,
    transparent 100%
  );
}

@media (prefers-reduced-motion: reduce) {
  .sky__canvas {
    transition: none;
  }
}
</style>
