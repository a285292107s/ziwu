import * as THREE from 'three'
import oceanEvolveFrag from './ocean-evolve.frag.glsl?raw'
import oceanFftFrag from './ocean-fft.frag.glsl?raw'
import oceanResolveFrag from './ocean-resolve.frag.glsl?raw'
import waterVert from './water.vert.glsl?raw'

const TAU = Math.PI * 2

const GRID = 256
const BITS = 8
const PATCH = 6

const K_PEAK = TAU / 0.7
const K_CUT = TAU / 0.18
const K_SWELL = TAU / 1.8
const WIND_DIR = [0.8, 0.6]

const TARGET_SLOPE = 0.095

const CAUSTIC_K = 1

const CAUSTIC_MAX = 6

export interface OceanStats {
  grid: number
  patch: number
  passes: number
  expectSlope: number
  expectHeight: number
  expectLap: number
  slopeRmsX: number
  slopeRmsZ: number
  slopeRms: number
  lapRms: number
  lambdaFine: number
  causticMean: number
  causticP99: number
  causticMax: number
  inputRms: number[]
  fieldRms: number[]
}

export interface OceanField {
  texture: THREE.Texture
  patch: number
  stats: OceanStats
  update: (time: number) => void
  dispose: () => void
}

function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Spectrum {
  data: Float32Array
  heightRms: number
  lapRms: number
  lambdaFine: number
}

function buildSpectrum(): Spectrum {
  const n = GRID
  const half = n / 2
  const rnd = mulberry(7)
  const gauss = (): number => {
    let u = 0
    let v = 0
    while (u === 0) {
      u = rnd()
    }
    while (v === 0) {
      v = rnd()
    }
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
  }

  const kOf = (i: number): number => (i < half ? i : i - n)

  const pk = new Float64Array(n * n)
  let sumH = 0
  let sumS = 0
  let sumL = 0
  for (let j = 0; j < n; j++) {
    const kz = (TAU * kOf(j)) / PATCH
    for (let i = 0; i < n; i++) {
      const idx = j * n + i
      if (i === half || j === half) {
        continue
      }
      const kx = (TAU * kOf(i)) / PATCH
      const k = Math.hypot(kx, kz)
      if (k < 1e-9) {
        continue
      }
      const k2 = k * k
      const bump = Math.exp(-0.5 * (Math.log(k / K_PEAK) / 0.36) ** 2)
      const tail = 0.035 * Math.exp(-((K_PEAK / k) ** 2)) * Math.exp(-((k / K_CUT) ** 2))
      const swell = 0.35 * Math.exp(-0.5 * (Math.log(k / K_SWELL) / 0.3) ** 2)
      const c = (kx * WIND_DIR[0] + kz * WIND_DIR[1]) / k
      const spread = (0.3 + 0.7 * c * c) * (c < 0 ? 0.35 : 1)
      const p = ((bump + tail + swell) * spread) / (k2 * k2)
      pk[idx] = p
      sumH += p
      sumS += k2 * p
      sumL += k2 * k2 * p
    }
  }

  const scale = (TARGET_SLOPE * GRID * GRID) / Math.sqrt(2 * sumS)
  const expectHeight = TARGET_SLOPE * Math.sqrt(sumH / sumS)
  const expectLap = TARGET_SLOPE * Math.sqrt(sumL / sumS)

  const re = new Float32Array(n * n)
  const im = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) {
    const a = Math.sqrt(pk[i] / 2)
    re[i] = gauss() * a
    im[i] = gauss() * a
  }
  const data = new Float32Array(n * n * 4)
  for (let j = 0; j < n; j++) {
    const mj = (n - j) % n
    for (let i = 0; i < n; i++) {
      const idx = j * n + i
      const src = mj * n + ((n - i) % n)
      data[idx * 4] = re[idx] * scale
      data[idx * 4 + 1] = im[idx] * scale
      data[idx * 4 + 2] = re[src] * scale
      data[idx * 4 + 3] = -im[src] * scale
    }
  }

  return {
    data,
    heightRms: expectHeight,
    lapRms: expectLap,
    lambdaFine: expectLap > 1e-6 ? CAUSTIC_K / expectLap : 0,
  }
}

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[pos]
}

export function createOceanField(renderer: THREE.WebGLRenderer): OceanField | null {
  const gl = renderer.getContext() as WebGL2RenderingContext

  if (!gl.getExtension('EXT_color_buffer_float')) {
    console.warn('[sky] 驱动不支持 EXT_color_buffer_float，FFT 波场不可用')
    return null
  }

  const spectrum = buildSpectrum()
  const spectrumTexture = new THREE.DataTexture(spectrum.data, GRID, GRID, THREE.RGBAFormat, THREE.FloatType)
  spectrumTexture.minFilter = THREE.NearestFilter
  spectrumTexture.magFilter = THREE.NearestFilter
  spectrumTexture.wrapS = THREE.ClampToEdgeWrapping
  spectrumTexture.wrapT = THREE.ClampToEdgeWrapping
  spectrumTexture.generateMipmaps = false
  spectrumTexture.needsUpdate = true

  const fftA = new THREE.WebGLRenderTarget(GRID, GRID, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  const fftB = fftA.clone()

  const surface = new THREE.WebGLRenderTarget(GRID, GRID, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  })

  const evolveUniforms: Record<string, THREE.IUniform> = {
    uSpectrum: { value: spectrumTexture },
    uTime: { value: 0 },
    uPatch: { value: PATCH },
    uBits: { value: BITS },
  }
  const fftUniforms: Record<string, THREE.IUniform> = {
    uSrc: { value: spectrumTexture },
    uAxis: { value: 0 },
    uHalf: { value: 1 },
    uSign: { value: 1 },
  }
  const resolveUniforms: Record<string, THREE.IUniform> = {
    uSrc: { value: fftA.texture },
    uNorm: { value: 1 / (GRID * GRID) },
    uLambdaFine: { value: spectrum.lambdaFine },
    uGainFine: { value: 1 },
    uCausMax: { value: CAUSTIC_MAX },
  }

  const makeMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: waterVert,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    })

  const evolveMaterial = makeMaterial(oceanEvolveFrag, evolveUniforms)
  const fftMaterial = makeMaterial(oceanFftFrag, fftUniforms)
  const resolveMaterial = makeMaterial(oceanResolveFrag, resolveUniforms)

  const geometry = new THREE.PlaneGeometry(2, 2)
  const quad = new THREE.Mesh(geometry, evolveMaterial)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  function drawInto(material: THREE.RawShaderMaterial, dst: THREE.WebGLRenderTarget): void {
    quad.material = material
    renderer.setRenderTarget(dst)
    renderer.render(scene, camera)
  }

  const PASSES = 2 + 2 * BITS

  let disposed = false
  let lastFft: THREE.WebGLRenderTarget = fftA

  function update(time: number): void {
    if (disposed) {
      return
    }
    evolveUniforms.uTime.value = Math.max(0, time)
    drawInto(evolveMaterial, fftA)

    let src = fftA
    let dst = fftB
    for (let bits = 1; bits <= BITS; bits++) {
      for (let axis = 0; axis < 2; axis++) {
        fftUniforms.uSrc.value = src.texture
        fftUniforms.uAxis.value = axis
        fftUniforms.uHalf.value = 1 << (bits - 1)
        drawInto(fftMaterial, dst)
        const swap = src
        src = dst
        dst = swap
      }
    }
    lastFft = src

    resolveUniforms.uSrc.value = src.texture
    drawInto(resolveMaterial, surface)
    renderer.setRenderTarget(null)
  }

  function readbackTarget(target: THREE.WebGLRenderTarget): Float32Array | null {
    const buffer = new Float32Array(GRID * GRID * 4)
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    gl.readPixels(0, 0, GRID, GRID, gl.RGBA, gl.FLOAT, buffer)
    renderer.setRenderTarget(previous)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) {
      console.warn('[sky] 波场回读失败，错误码', error)
      return null
    }
    return buffer
  }

  function channelRms(buffer: Float32Array, scale: number): number[] {
    const out = [0, 0, 0, 0]
    const count = GRID * GRID
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 4; c++) {
        const v = buffer[i * 4 + c] * scale
        out[c] += v * v
      }
    }
    return out.map(v => Math.sqrt(v / count))
  }

  drawInto(evolveMaterial, fftA)
  const inputBuffer = readbackTarget(fftA)
  const inputRms = inputBuffer ? channelRms(inputBuffer, 1) : []

  let slopeRmsX = 0
  let slopeRmsZ = 0
  let slopeRms = 0
  let lapRms = 0
  let causticMean = 1
  let causticP99 = 1
  let fieldRms: number[] = []

  update(0)
  const field = readbackTarget(lastFft)
  if (field) {
    fieldRms = channelRms(field, 1 / (GRID * GRID))
    const norm = 1 / (GRID * GRID)
    const count = GRID * GRID
    let sxx = 0
    let szz = 0
    let ll = 0
    let sum = 0
    const raw = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const sx = field[i * 4] * norm
      const lapF = field[i * 4 + 2] * norm
      const sz = field[i * 4 + 3] * norm
      sxx += sx * sx
      szz += sz * sz
      ll += lapF * lapF
      const cf = Math.min(Math.max(1 / Math.max(Math.abs(1 - spectrum.lambdaFine * lapF), 2e-3), 0), CAUSTIC_MAX)
      raw[i] = cf
      sum += cf
    }
    slopeRmsX = Math.sqrt(sxx / count)
    slopeRmsZ = Math.sqrt(szz / count)
    slopeRms = Math.sqrt(sxx / count + szz / count)
    lapRms = Math.sqrt(ll / count)
    causticMean = sum / count
    resolveUniforms.uGainFine.value = causticMean > 1e-6 ? 1 / causticMean : 1
    const gainF = resolveUniforms.uGainFine.value
    for (let i = 0; i < count; i++)
      raw[i] = Math.min(raw[i] * gainF, CAUSTIC_MAX)
    raw.sort()
    causticP99 = percentile(raw, 0.99)
  }

  update(0)

  const stats: OceanStats = {
    grid: GRID,
    patch: PATCH,
    passes: PASSES,
    expectSlope: TARGET_SLOPE,
    expectHeight: spectrum.heightRms,
    expectLap: spectrum.lapRms,
    slopeRmsX,
    slopeRmsZ,
    slopeRms,
    lapRms,
    lambdaFine: spectrum.lambdaFine,
    causticMean,
    causticP99,
    causticMax: CAUSTIC_MAX,
    inputRms,
    fieldRms,
  }

  return {
    texture: surface.texture,
    patch: PATCH,
    stats,
    update,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      spectrumTexture.dispose()
      fftA.dispose()
      fftB.dispose()
      surface.dispose()
      geometry.dispose()
      evolveMaterial.dispose()
      fftMaterial.dispose()
      resolveMaterial.dispose()
    },
  }
}
