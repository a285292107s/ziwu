import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { SkyFrame } from './sky'
import { SCATTER_NORM } from './sky'
import { createOceanField } from './sky/ocean'
import type { OceanStats } from './sky/ocean'
import tonemapFrag from './sky/tonemap.frag.glsl?raw'
import tonemapVert from './sky/tonemap.vert.glsl?raw'
import waterFrag from './sky/water.frag.glsl?raw'
import waterVert from './sky/water.vert.glsl?raw'

export interface SkyBand {
  mean: number
  p10: number
  p50: number
  p90: number
}

export interface SkyProbe {
  mean: number
  p10: number
  p50: number
  p90: number
  p95: number
  min: number
  max: number
  text: SkyBand
  gain: number
  scale: number
  scaleTarget: number
  perf: SkyPerf
  ocean: OceanStats | null
  elements: {
    count: number
    low: number[]
    high: number[]
    needs: number[]
    worstLow: number
    worstHigh: number
  } | null
}

export interface SkyPerf {
  fps: number
  submitMs: number
  gpuMs: number | null
  budgetMs: number
  adapt: string
}

export interface SkyTextRect {
  x: number
  y: number
  w: number
  h: number
  minBg: number
}

export interface SkyRendererOptions {
  renderScale?: number
  targetFps?: number
  onProbe?: (probe: SkyProbe) => void
  getTextRects?: () => SkyTextRect[]
  autoExposure?: boolean
  onReady?: () => void
  onTooSlow?: () => void
  themeBlendMs?: number
}

export interface SkyRenderer {
  supported: boolean
  setFrame: (frame: SkyFrame) => void
  setPointer: (nx: number, ny: number) => void
  addDrop: (nx: number, ny: number) => void
  start: () => void
  stop: () => void
  renderOnce: () => void
  dispose: () => void
}

const FOV_Y = 92
const MAX_PIXELS = 240 * 1024
const WATER_TIME_SCALE = 0.45
const GAIN_MIN = 0.03
const GAIN_MAX = 4

const MEASURE_MAX_SAMPLES = 6

const GAIN_EASE_S = 0.2

export const THEME_BLEND_MS = 1200

const WARMUP_MS = 1500

function acesInv(y: number): number {
  const t = Math.min(Math.max(y, 0), 0.999)
  const a = 2.43 * t - 2.51
  const b = 0.59 * t - 0.03
  const c = 0.14 * t
  if (Math.abs(a) < 1e-6)
    return -c / b
  const d = Math.sqrt(Math.max(b * b - 4 * a * c, 0))
  return (-b - d) / (2 * a)
}

const GEO_KEYS = new Set([
  'exposure',
  'targetLuminance',
  'scatterTint',
  'skyAbove',
  'beamTint',
  'caustic',
  'beamPower',
  'ambPower',
  'surfaceGlow',
])

const FLOOR_KEYS = new Set(['floorDrop'])

const FLOOR_FAR = 40

function mixScalar(key: string, a: number, b: number, k: number): number {
  if (FLOOR_KEYS.has(key)) {
    const aa = a > 0 ? a : FLOOR_FAR
    const bb = b > 0 ? b : FLOOR_FAR
    return aa + (bb - aa) * k
  }
  if (GEO_KEYS.has(key) && a > 0 && b > 0)
    return a * (b / a) ** k
  return a + (b - a) * k
}

function mixFrame(from: SkyFrame, to: SkyFrame, k: number): SkyFrame {
  const out: Record<string, unknown> = { ...to }
  const src = from as unknown as Record<string, unknown>
  for (const key of Object.keys(out)) {
    const a = src[key]
    const b = out[key]
    if (typeof a === 'number' && typeof b === 'number') {
      out[key] = mixScalar(key, a, b, k)
    }
    else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      out[key] = (b as number[]).map((v, i) => mixScalar(key, (a as number[])[i], v, k))
    }
  }
  return out as unknown as SkyFrame
}

function nullRenderer(): SkyRenderer {
  return {
    supported: false,
    setFrame: () => {},
    setPointer: () => {},
    addDrop: () => {},
    start: () => {},
    stop: () => {},
    renderOnce: () => {},
    dispose: () => {},
  }
}

export function createSkyRenderer(
  canvas: HTMLCanvasElement,
  options: SkyRendererOptions = {},
): SkyRenderer {
  const targetFps = options.targetFps ?? 30
  const autoExposure = options.autoExposure ?? true
  const themeBlendMs = Math.max(0, options.themeBlendMs ?? THEME_BLEND_MS)
  const minScale = 0.18
  const maxScale = 0.5

  let scale = Math.min(Math.max(options.renderScale ?? 0.34, minScale), maxScale)

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    })
  }
  catch (error) {
    console.warn('[sky] 建不出 WebGL 上下文，走 CSS 降级：', error)
    return nullRenderer()
  }

  const gl: WebGL2RenderingContext = renderer.getContext() as WebGL2RenderingContext

  THREE.ColorManagement.enabled = false
  renderer.toneMapping = THREE.NoToneMapping
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 1)

  const disjointTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
    | { TIME_ELAPSED_EXT: number, GPU_DISJOINT_EXT: number }
    | null

  renderer.debug.checkShaderErrors = true

  const ocean = createOceanField(renderer)
  const flatOcean = ocean
    ? null
    : (() => {
        const texture = new THREE.DataTexture(
          new Float32Array([0, 0, 0, 1]),
          1,
          1,
          THREE.RGBAFormat,
          THREE.FloatType,
        )
        texture.needsUpdate = true
        return texture
      })()

  const BLOOM_STRENGTH = 0.38
  const BLOOM_RADIUS = 0.55
  const BLOOM_THRESHOLD = 1.0

  const waterUniforms = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uCam: { value: new THREE.Vector2(0, 0) },
    uTanHalfFov: { value: Math.tan((FOV_Y * Math.PI) / 360) },
    uExposure: { value: 0.6 },
    uGain: { value: 1 },
    uDepth: { value: 2 },
    uFloorDrop: { value: 1.6 },
    uBeamDir: { value: new THREE.Vector3(0, 1, 0) },
    uAmbDir: { value: new THREE.Vector3(0, 1, 0) },
    uBeamTint: { value: new THREE.Vector3(1, 1, 1) },
    uBeamPower: { value: 1 },
    uAmbPower: { value: 1 },
    uAbsorb: { value: new THREE.Vector3(0.36, 0.062, 0.048) },
    uScatterNorm: { value: new THREE.Vector3(...SCATTER_NORM) },
    uPhaseG: { value: 0.6 },
    uScatterTint: { value: new THREE.Vector3(0.2, 0.5, 0.6) },
    uCaustic: { value: 1 },
    uSurfaceGlow: { value: 0.2 },
    uSkyAbove: { value: new THREE.Vector3(0.5, 0.7, 0.9) },
    uOcean: { value: ocean?.texture ?? flatOcean },
    uInvPatch: { value: ocean ? 1 / ocean.patch : 1 },
    uDropCount: { value: 0 },
    uDrops: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  }

  const waterMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    uniforms: waterUniforms,
    depthTest: false,
    depthWrite: false,
  })

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waterMaterial)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  }))
  composer.addPass(new RenderPass(quadScene, quadCamera))
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  ))
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: tonemapVert,
    fragmentShader: tonemapFrag,
  }))

  try {
    renderer.compile(quadScene, quadCamera)
    const broken = (renderer.info.programs ?? []).some(
      p => (p as { diagnostics?: { runnable?: boolean } }).diagnostics?.runnable === false,
    )
    if (broken) {
      console.error('[sky] 着色器编译/链接失败（详见上面 three.js 的日志），走 CSS 降级')
      return nullRenderer()
    }
  }
  catch (error) {
    console.warn('[sky] 着色器预编译检查没能完成：', error)
  }

  let frame: SkyFrame | null = null
  let yaw = 0
  let pitch = 0
  let targetYaw = 0
  let targetPitch = 0
  let pointerX = 0
  let pointerY = 0
  let pointerSmoothX = 0
  let pointerSmoothY = 0
  let gainTarget = 1
  let gainShown = 1
  let blendFrom: SkyFrame | null = null
  let blendStart = 0
  let blendProductFrom = 1
  let blendProductTo = 1
  let blendMeasurePending = false
  const productMemory = new Map<boolean, number>()
  let renderedFrame: SkyFrame | null = null

  let raf = 0
  let running = false
  let lastDraw = 0
  let lastAdapt = 0
  let waterTime = 0
  let dropHead = 0
  let probeCount = 0
  let probeDue = 0
  let slowStreak = 0
  let firstFrameDone = false
  let pendingReady = false
  let startedAt = 0
  let warmupUntil = Number.POSITIVE_INFINITY

  let drawnInWindow = 0
  let windowStart = 0
  let measuredFps = 0
  let submitMs = 0
  let refreshMs = 0
  let lastRaf = 0
  let rafCount = 0
  let effectiveScale = scale
  const timerExt = disjointTimer
  let gpuQuery: WebGLQuery | null = null
  let gpuQueryPending = false
  let gpuMs: number | null = null
  let adaptNote = 'init'

  let probePixels = new Uint8Array(0)
  const samples: number[] = []
  const textSamples: number[] = []
  const rectSamples: number[] = []

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const cssW = Math.max(rect.width, 1)
    const cssH = Math.max(rect.height, 1)
    const budget = Math.sqrt(MAX_PIXELS / (cssW * cssH))
    const effective = Math.min(scale, Math.max(budget, minScale))
    effectiveScale = effective
    const w = Math.max(2, Math.round(cssW * effective))
    const h = Math.max(2, Math.round(cssH * effective))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      renderer.setSize(w, h, false)
      composer.setSize(w, h)
      waterUniforms.uResolution.value.set(w, h)
    }
  }

  function probe(measureOnly = false): SkyProbe | null {
    if (!frame)
      return null

    const w = canvas.width
    const h = canvas.height
    if (w < 4 || h < 4)
      return null

    const size = 4 * w * h
    if (probePixels.length !== size)
      probePixels = new Uint8Array(size)

    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, probePixels)

    const x0 = Math.floor(w * 0.06)
    const x1 = Math.ceil(w * 0.94)
    const y0 = Math.floor(h * 0.08)
    const y1 = Math.ceil(h * 0.90)
    const ty0 = Math.floor(h * 0.72)
    const ty1 = Math.ceil(h * 0.90)
    const span = Math.max(1, (x1 - x0) * (y1 - y0))
    const step = Math.max(1, Math.round(Math.sqrt(span / 4096)))

    samples.length = 0
    textSamples.length = 0
    let sum = 0
    for (let y = y0; y < y1; y += step) {
      const row = y * w * 4
      const inText = y >= ty0 && y < ty1
      for (let x = x0; x < x1; x += step) {
        const i = row + x * 4
        const l = 0.2126 * linearize(probePixels[i] / 255)
          + 0.7152 * linearize(probePixels[i + 1] / 255)
          + 0.0722 * linearize(probePixels[i + 2] / 255)
        samples.push(l)
        if (inText)
          textSamples.push(l)
        sum += l
      }
    }
    if (samples.length < 8 || textSamples.length < 8)
      return null

    const quantiles = (list: number[], q: number) =>
      list[Math.min(list.length - 1, Math.floor(list.length * q))]

    let elements: SkyProbe['elements'] = null
    const rects = options.getTextRects?.() ?? []
    if (rects.length) {
      const cssW = Math.max(canvas.clientWidth, 1)
      const cssH = Math.max(canvas.clientHeight, 1)
      const sx = w / cssW
      const sy = h / cssH
      const low: number[] = []
      const high: number[] = []
      const needs: number[] = []
      for (const r of rects) {
        const rx0 = Math.max(0, Math.floor(r.x * sx))
        const rx1 = Math.min(w, Math.ceil((r.x + r.w) * sx))
        const ry0 = Math.max(0, Math.floor((cssH - (r.y + r.h)) * sy))
        const ry1 = Math.min(h, Math.ceil((cssH - r.y) * sy))
        if (rx1 - rx0 < 2 || ry1 - ry0 < 2)
          continue
        rectSamples.length = 0
        for (let y = ry0; y < ry1; y++) {
          const row = y * w * 4
          for (let x = rx0; x < rx1; x++) {
            const i = row + x * 4
            rectSamples.push(
              0.2126 * linearize(probePixels[i] / 255)
              + 0.7152 * linearize(probePixels[i + 1] / 255)
              + 0.0722 * linearize(probePixels[i + 2] / 255),
            )
          }
        }
        if (rectSamples.length < 8)
          continue
        rectSamples.sort((a, b) => a - b)
        low.push(quantiles(rectSamples, 0.05))
        high.push(quantiles(rectSamples, 0.95))
        needs.push(r.minBg)
      }
      if (low.length) {
        elements = {
          count: low.length,
          low,
          high,
          needs,
          worstLow: Math.min(...low),
          worstHigh: Math.max(...high),
        }
      }
    }

    samples.sort((a, b) => a - b)
    textSamples.sort((a, b) => a - b)
    const stats: SkyProbe = {
      mean: sum / samples.length,
      p10: quantiles(samples, 0.1),
      p50: quantiles(samples, 0.5),
      p90: quantiles(samples, 0.9),
      p95: quantiles(samples, 0.95),
      min: samples[0],
      max: samples[samples.length - 1],
      text: {
        mean: textSamples.reduce((a, b) => a + b, 0) / textSamples.length,
        p10: quantiles(textSamples, 0.1),
        p50: quantiles(textSamples, 0.5),
        p90: quantiles(textSamples, 0.9),
      },
      gain: gainShown,
      scale: effectiveScale,
      scaleTarget: scale,
      ocean: ocean?.stats ?? null,
      elements,
      perf: {
        fps: measuredFps,
        submitMs,
        gpuMs,
        budgetMs: 1000 / targetFps,
        adapt: adaptNote,
      },
    }
    if (measureOnly)
      return stats

    options.onProbe?.(stats)

    if (!autoExposure)
      return stats

    if (blendFrom)
      return stats

    const target = acesInv(frame.targetLuminance)
    const measured = acesInv(stats.p50)
    const hi = acesInv(frame.dark ? 0.34 : 0.56)
    let ratio = 1
    if (measured < target)
      ratio = target / Math.max(measured, 1e-3)
    else if (measured > hi)
      ratio = hi / Math.max(measured, 1e-3)

    if (ratio === 1)
      productMemory.set(frame.dark, gainShown * frame.exposure)
    const rate = probeCount === 0 ? 1.0 : probeCount < 3 ? 0.7 : probeCount < 6 ? 0.45 : 0.14
    gainTarget = clamp(gainShown * clamp(ratio ** rate, 0.60, 1.45), GAIN_MIN, GAIN_MAX)
    probeCount++
    return stats
  }

  function applyUniforms(f: SkyFrame) {
    waterUniforms.uTime.value = waterTime
    waterUniforms.uCam.value.set(yaw + pointerSmoothX * 0.030, pitch + pointerSmoothY * 0.018)
    waterUniforms.uExposure.value = f.exposure
    waterUniforms.uGain.value = gainShown
    waterUniforms.uDepth.value = f.depth
    waterUniforms.uFloorDrop.value = f.floorDrop
    waterUniforms.uBeamPower.value = f.beamPower
    waterUniforms.uAmbPower.value = f.ambPower
    waterUniforms.uCaustic.value = f.caustic
    waterUniforms.uSurfaceGlow.value = f.surfaceGlow
    waterUniforms.uSunDir.value.set(...dirVector(f.sunElevation, f.sunAzimuth))
    waterUniforms.uMoonDir.value.set(...dirVector(f.moonElevation, f.moonAzimuth))
    waterUniforms.uBeamDir.value.set(...f.beamDir)
    waterUniforms.uAmbDir.value.set(...f.ambDir)
    waterUniforms.uBeamTint.value.set(...f.beamTint)
    waterUniforms.uAbsorb.value.set(...f.absorb)
    waterUniforms.uScatterNorm.value.set(...f.scatterNorm)
    waterUniforms.uPhaseG.value = f.phaseG
    waterUniforms.uScatterTint.value.set(...f.scatterTint)
    waterUniforms.uSkyAbove.value.set(...f.skyAbove)
  }

  function measureTargetGain() {
    const target = frame
    blendMeasurePending = false
    if (!target)
      return
    const want = acesInv(target.targetLuminance)
    const exposure = Math.max(target.exposure, 1e-6)
    const savedYaw = yaw
    const savedPitch = pitch
    yaw = target.cameraAzimuth
    pitch = target.cameraPitch

    function sample(gain: number, sceneFrame: SkyFrame): number | null {
      applyUniforms(sceneFrame)
      waterUniforms.uGain.value = gain
      composer.render(0)
      startedAt = performance.now()
      const stats = probe(true)
      if (!stats)
        return null
      const scene = acesInv(stats.p50)
      return Number.isFinite(scene) && scene > 0 ? scene : null
    }

    const tol = Math.log(1.02)
    const maxStep = Math.log(6)
    const minX = Math.log(GAIN_MIN)
    const maxX = Math.log(GAIN_MAX)

    let x = Math.log(clamp(gainShown, GAIN_MIN, GAIN_MAX))
    const first = sample(Math.exp(x), target)
    let f = first === null ? Number.NaN : Math.log(first / want)
    let bestX = x
    let bestMiss = Number.isFinite(f) ? Math.abs(f) : Number.POSITIVE_INFINITY
    let prevX: number | null = null
    let prevF: number | null = null
    for (let i = 1; i < MEASURE_MAX_SAMPLES && Number.isFinite(f) && Math.abs(f) > tol; i++) {
      let next: number
      if (prevX === null || prevF === null) {
        next = x - f
      }
      else {
        const slope = (f - prevF) / (x - prevX)
        next = Math.abs(slope) < 1e-4 ? x - f : x - f / slope
      }
      next = clamp(clamp(next, x - maxStep, x + maxStep), minX, maxX)
      if (Math.abs(next - x) < 1e-4)
        break
      const measuredNext = sample(Math.exp(next), target)
      if (measuredNext === null)
        break
      prevX = x
      prevF = f
      x = next
      f = Math.log(measuredNext / want)
      if (Math.abs(f) < bestMiss) {
        bestMiss = Math.abs(f)
        bestX = x
      }
    }
    blendProductTo = Math.exp(bestX) * exposure
    yaw = savedYaw
    pitch = savedPitch
  }

  function renderFrame(now: number, dt: number) {
    if (!frame)
      return

    waterTime += dt * WATER_TIME_SCALE

    pointerSmoothX += (pointerX - pointerSmoothX) * 0.045
    pointerSmoothY += (pointerY - pointerSmoothY) * 0.045
    yaw += (targetYaw - yaw) * 0.02
    pitch += (targetPitch - pitch) * 0.02

    resize()

    let f = frame
    let blendEase = 1
    if (blendFrom) {
      const k = clamp((now - blendStart) / themeBlendMs, 0, 1)
      if (k >= 1) {
        blendFrom = null
        probeDue = 0
        probeCount = 2
      }
      else {
        blendEase = k * k * k * (k * (k * 6 - 15) + 10)
        f = mixFrame(blendFrom, frame, blendEase)
        yaw = f.cameraAzimuth
        pitch = f.cameraPitch
      }
    }
    renderedFrame = f

    if (blendFrom && blendMeasurePending)
      measureTargetGain()

    if (blendFrom) {
      const product = blendProductFrom > 0 && blendProductTo > 0
        ? blendProductFrom * (blendProductTo / blendProductFrom) ** blendEase
        : blendProductFrom
      gainShown = clamp(product / Math.max(f.exposure, 1e-6), GAIN_MIN, GAIN_MAX)
      gainTarget = gainShown
    }
    else {
      gainShown += (gainTarget - gainShown) * (dt > 0 ? 1 - Math.exp(-dt / GAIN_EASE_S) : 1)
    }

    applyUniforms(f)

    ocean?.update(waterTime)

    composer.render(dt)

    const cost = performance.now() - startedAt

    const warm = now >= warmupUntil
    if (warm)
      submitMs = submitMs ? submitMs * 0.9 + cost * 0.1 : cost

    if (!warm) {
      windowStart = 0
      drawnInWindow = 0
      measuredFps = 0
      submitMs = 0
      lastAdapt = now
    }
    else {
      drawnInWindow++
      if (!windowStart) {
        windowStart = now
      }
      else if (now - windowStart >= 2000) {
        measuredFps = (drawnInWindow * 1000) / (now - windowStart)
        drawnInWindow = 0
        windowStart = now
      }
    }

    if (timerExt) {
      if (gpuQueryPending && gpuQuery) {
        const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT)
        const done = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE)
        if (done) {
          if (!disjoint) {
            const ns = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT) as number
            const ms = ns / 1e6
            if (ms >= 0.05) {
              gpuMs = gpuMs === null ? ms : gpuMs * 0.8 + ms * 0.2
            }
            else {
              gpuMs = null
            }
          }
          gl.deleteQuery(gpuQuery)
          gpuQuery = null
          gpuQueryPending = false
        }
      }
      else if (!gpuQuery) {
        gpuQuery = gl.createQuery()
        if (gpuQuery) {
          gl.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery)
          gl.endQuery(timerExt.TIME_ELAPSED_EXT)
          gpuQueryPending = true
        }
      }
    }

    if (!firstFrameDone) {
      firstFrameDone = true
      warmupUntil = now + WARMUP_MS
      pendingReady = true
    }
    else {
      ready()
    }

    if (now - lastAdapt > 2000) {
      lastAdapt = now
      const budgetMs = 1000 / targetFps
      const starving = measuredFps > 0 && measuredFps < targetFps * 0.85
      const cpuBound = submitMs > budgetMs * 0.45
      const healthy = measuredFps >= targetFps * 0.97 && submitMs < budgetMs * 0.25

      if ((starving || cpuBound) && scale > minScale) {
        scale = Math.max(minScale, scale * 0.8)
        slowStreak = 0
        adaptNote = starving ? 'down:fps' : 'down:cpu'
      }
      else if (healthy && scale < maxScale) {
        scale = Math.min(maxScale, scale * 1.12)
        slowStreak = 0
        adaptNote = 'up'
      }
      else if (starving && scale <= minScale) {
        if (++slowStreak >= 3) {
          slowStreak = 0
          console.warn(`[sky] 最低分辨率下仍只有 ${measuredFps.toFixed(1)}fps（目标 ${targetFps}），降级到 CSS 背景`)
          options.onTooSlow?.()
        }
        adaptNote = 'down:floor'
      }
      else {
        slowStreak = 0
        adaptNote = scale >= maxScale ? 'hold:max' : 'hold:band'
      }
    }

    const interval = probeCount < 6 ? 320 : 2000
    if (options.onProbe && now - probeDue > interval) {
      probeDue = now
      probe()
    }
  }

  function draw(now: number) {
    raf = requestAnimationFrame(draw)
    if (!running || !frame)
      return

    refreshMs = refreshMs ? refreshMs * 0.9 + (now - lastRaf) * 0.1 : 32
    lastRaf = now
    const stride = Math.max(1, Math.round((1000 / targetFps) / refreshMs))
    if (++rafCount % stride !== 0)
      return

    const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : 0
    lastDraw = now
    startedAt = performance.now()
    renderFrame(now, dt)
  }

  function handleContextLost(event: Event) {
    event.preventDefault()
    running = false
    console.warn('[sky] WebGL 上下文丢失，先停下，等浏览器恢复')
  }

  function ready() {
    if (!pendingReady)
      return
    pendingReady = false
    options.onReady?.()
  }

  canvas.addEventListener('webglcontextlost', handleContextLost)

  resize()
  composer.render(0)

  function setFrame(next: SkyFrame) {
    const first = !frame
    const prev = frame
    const themeChanged = prev !== null && prev.dark !== next.dark
    frame = next
    targetYaw = next.cameraAzimuth
    targetPitch = next.cameraPitch
    if (first || themeChanged) {
      yaw = targetYaw
      pitch = targetPitch
    }
    if (themeChanged && prev) {
      probeCount = 0
      probeDue = 0
      if (themeBlendMs > 0) {
        blendFrom = renderedFrame ?? prev
        blendStart = performance.now()
        blendProductFrom = gainShown * Math.max(blendFrom.exposure, 1e-6)
        blendProductTo = blendProductFrom
        blendMeasurePending = true
      }
      else {
        const remembered = productMemory.get(next.dark)
        gainTarget = clamp(
          remembered && remembered > 0
            ? remembered / Math.max(next.exposure, 1e-6)
            : gainShown * (next.exposure > 1e-6 ? prev.exposure / next.exposure : 1),
          GAIN_MIN,
          GAIN_MAX,
        )
      }
    }
  }

  return {
    supported: true,
    setFrame,
    setPointer(nx: number, ny: number) {
      pointerX = nx
      pointerY = ny
    },
    addDrop(nx: number, ny: number) {
      if (!frame)
        return
      const w = canvas.width
      const h = canvas.height
      if (w < 4 || h < 4)
        return
      const uvx = (nx - 0.5) * (w / h)
      const uvy = 0.5 - ny
      const tanHalf = Math.tan((FOV_Y * Math.PI) / 360)
      let dx = uvx
      let dy = uvy
      let dz = 0.5 / tanHalf
      const cp = Math.cos(-pitch)
      const sp = Math.sin(-pitch)
      const y1 = cp * dy - sp * dz
      const z1 = sp * dy + cp * dz
      dy = y1
      dz = z1
      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      const x2 = cy * dx + sy * dz
      const z2 = -sy * dx + cy * dz
      dx = x2
      dz = z2
      const len = Math.hypot(dx, dy, dz)
      dx /= len
      dy /= len
      dz /= len
      let t: number
      let px: number
      let pz: number
      if (dy > 0.02) {
        t = frame.depth / dy
        px = dx * t
        pz = dz * t
      }
      else if (dy < -0.02 && frame.floorDrop > 0) {
        t = frame.floorDrop / -dy
        const sy = -frame.depth + dy * t
        const beamY = Math.min(frame.beamDir[1], -1e-3)
        const beamLen = sy / beamY
        px = dx * t - frame.beamDir[0] * beamLen
        pz = dz * t - frame.beamDir[2] * beamLen
      }
      else {
        return
      }
      if (Math.hypot(px, pz) > 40)
        return
      const slot = dropHead % 8
      dropHead++
      const v = (waterUniforms.uDrops.value as THREE.Vector4[])[slot]
      v.set(px, pz, waterTime, 1)
      waterUniforms.uDropCount.value = Math.min(dropHead, 8)
    },
    start() {
      if (running)
        return
      running = true
      lastDraw = 0
      probeDue = 0
      raf = requestAnimationFrame(draw)
    },
    stop() {
      running = false
      if (raf)
        cancelAnimationFrame(raf)
      raf = 0
    },
    renderOnce() {
      if (!frame)
        return
      startedAt = performance.now()
      renderFrame(performance.now(), 0)
      if (Math.abs(gainTarget / Math.max(gainShown, 1e-6) - 1) > 0.05)
        renderFrame(performance.now(), 0)
      ready()
    },
    dispose() {
      running = false
      if (raf)
        cancelAnimationFrame(raf)
      raf = 0
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      quad.geometry.dispose()
      waterMaterial.dispose()
      ocean?.dispose()
      flatOcean?.dispose()
      composer.dispose()
      renderer.dispose()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

function dirVector(elevation: number, azimuth: number): [number, number, number] {
  const cosEl = Math.cos(elevation)
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), cosEl * Math.cos(azimuth)]
}

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x
}

function linearize(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
