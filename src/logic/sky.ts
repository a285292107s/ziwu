export type PhaseKey = 'dawn' | 'day' | 'dusk' | 'night'

const RAD = Math.PI / 180

export const DEFAULT_LATITUDE = 35

function longitudeForTimezone(date: Date = new Date()): number {
  return -date.getTimezoneOffset() / 4
}

function norm360(x: number): number {
  return ((x % 360) + 360) % 360
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function julianDate(ms: number): number {
  return ms / 86400000 + 2440587.5
}

function sunEquatorial(jd: number): { ra: number, dec: number } {
  const n = jd - 2451545
  const meanLon = norm360(280.46 + 0.9856474 * n)
  const meanAnom = norm360(357.528 + 0.9856003 * n) * RAD
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * RAD
  const obliq = (23.439 - 0.0000004 * n) * RAD

  return {
    ra: Math.atan2(Math.cos(obliq) * Math.sin(eclLon), Math.cos(eclLon)),
    dec: Math.asin(Math.sin(obliq) * Math.sin(eclLon)),
  }
}

function moonEquatorial(jd: number): { ra: number, dec: number, phase: number } {
  const d = jd - 2451543.5
  const N = norm360(125.1228 - 0.0529538083 * d) * RAD
  const inc = 5.1454 * RAD
  const peri = norm360(318.0634 + 0.1643573223 * d) * RAD
  const a = 60.2666
  const ecc = 0.0549
  const M = norm360(115.3654 + 13.0649929509 * d) * RAD

  let E = M
  for (let i = 0; i < 6; i++)
    E -= (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E))

  const xv = a * (Math.cos(E) - ecc)
  const yv = a * Math.sqrt(1 - ecc * ecc) * Math.sin(E)
  const v = Math.atan2(yv, xv)
  const r = Math.hypot(xv, yv)

  const xh = r * (Math.cos(N) * Math.cos(v + peri) - Math.sin(N) * Math.sin(v + peri) * Math.cos(inc))
  const yh = r * (Math.sin(N) * Math.cos(v + peri) + Math.cos(N) * Math.sin(v + peri) * Math.cos(inc))
  const zh = r * (Math.sin(v + peri) * Math.sin(inc))

  const eclLon = Math.atan2(yh, xh)
  const eclLat = Math.atan2(zh, Math.hypot(xh, yh))

  const obliq = 23.4393 * RAD
  const ra = Math.atan2(
    Math.sin(eclLon) * Math.cos(obliq) - Math.tan(eclLat) * Math.sin(obliq),
    Math.cos(eclLon),
  )
  const dec = Math.asin(
    Math.sin(eclLat) * Math.cos(obliq) + Math.cos(eclLat) * Math.sin(obliq) * Math.sin(eclLon),
  )

  const sun = sunEquatorial(jd)
  const cosElong
    = Math.cos(dec) * Math.cos(sun.dec) * Math.cos(ra - sun.ra) + Math.sin(dec) * Math.sin(sun.dec)
  const phase = (1 - clamp(cosElong, -1, 1)) / 2

  return { ra, dec, phase }
}

function toHorizon(ra: number, dec: number, jd: number, lat: number, lon: number) {
  const gmst = norm360(18.697374558 + 24.06570982441908 * (jd - 2451545))
  const lst = norm360(gmst * 15 + lon) * RAD
  const hourAngle = lst - ra

  const sinAlt = Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hourAngle)
  const elevation = Math.asin(clamp(sinAlt, -1, 1))

  const azSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat * RAD) - Math.tan(dec) * Math.cos(lat * RAD),
  )
  const azimuth = Math.atan2(Math.sin(azSouth + Math.PI), Math.cos(azSouth + Math.PI))

  return { elevation, azimuth: azimuth < 0 ? azimuth + 2 * Math.PI : azimuth }
}

export interface SkyOptions {
  dark: boolean
  latitude?: number
  longitude?: number
}

export type Vec3 = [number, number, number]

export interface SkyFrame {
  timeMs: number
  phase: PhaseKey
  sunElevation: number
  sunAzimuth: number
  moonElevation: number
  moonAzimuth: number
  moonPhase: number
  cameraAzimuth: number
  cameraPitch: number
  night: number
  exposure: number
  veil: number
  dark: boolean
  targetLuminance: number

  depth: number
  floorDrop: number
  beamDir: Vec3
  ambDir: Vec3
  beamTint: Vec3
  beamPower: number
  ambPower: number
  absorb: Vec3
  scatter: Vec3
  scatterNorm: Vec3
  phaseG: number
  scatterTint: Vec3
  caustic: number
  surfaceGlow: number
  skyAbove: Vec3
}

export function phaseForHour(hour: number): PhaseKey {
  const h = clamp(Math.floor(hour), 0, 23)
  if (h >= 5 && h < 8)
    return 'dawn'
  if (h >= 8 && h < 17)
    return 'day'
  if (h >= 17 && h < 20)
    return 'dusk'
  return 'night'
}

export const N_WATER = 1.333

function dirFrom(elevation: number, azimuth: number): Vec3 {
  const cosEl = Math.cos(elevation)
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), cosEl * Math.cos(azimuth)]
}

function refractIntoWater(toSource: Vec3): Vec3 {
  const eta = 1 / N_WATER
  const cosI = Math.max(toSource[1], 0)
  const sinT2 = eta * eta * (1 - cosI * cosI)
  const cosT = Math.sqrt(Math.max(1 - sinT2, 0))
  return [-eta * toSource[0], -cosT, -eta * toSource[2]]
}

function transmittance(absorb: Vec3, meters: number): Vec3 {
  return [Math.exp(-absorb[0] * meters), Math.exp(-absorb[1] * meters), Math.exp(-absorb[2] * meters)]
}

function scale3(c: Vec3, k: number): Vec3 {
  return [c[0] * k, c[1] * k, c[2] * k]
}

function mul3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

function normalizeHue(c: Vec3): Vec3 {
  const m = Math.max(c[0], c[1], c[2], 1e-4)
  return [c[0] / m, c[1] / m, c[2] / m]
}

const ABSORB: Vec3 = [0.355, 0.058, 0.042]
const SCATTER: Vec3 = [0.005, 0.004, 0.006]
const EXTINCT: Vec3 = [
  ABSORB[0] + SCATTER[0],
  ABSORB[1] + SCATTER[1],
  ABSORB[2] + SCATTER[2],
]
const PHASE_G = 0.6

export const SCATTER_NORM: Vec3 = (() => {
  const ratio: Vec3 = [
    SCATTER[0] / EXTINCT[0],
    SCATTER[1] / EXTINCT[1],
    SCATTER[2] / EXTINCT[2],
  ]
  const lum = 0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2]
  return [ratio[0] / lum, ratio[1] / lum, ratio[2] / lum]
})()

function skyTint(elevation: number, moonlit: boolean, night: number): Vec3 {
  const el = elevation / RAD
  if (moonlit) {
    return [0.80, 0.87, 1.0]
  }
  if (el > 25) {
    return [0.76, 0.88, 1.0]
  }
  if (el > 8) {
    const k = smoothstep(8, 25, el)
    return [1.0, 1.0 - 0.12 * k, 1.0 - 0.22 * k]
  }
  if (el > -1) {
    const k = smoothstep(-1, 8, el)
    return [1.0, 0.42 + 0.46 * k, 0.16 + 0.62 * k]
  }
  const k = smoothstep(-7, -1, el)
  return [0.30 + 0.70 * k, 0.22 + 0.20 * k, 0.38 + 0.40 * k * (1 - night * 0.5)]
}

function keyTint(elevation: number, moonlit: boolean): Vec3 {
  if (moonlit) {
    return [0.86, 0.90, 1.0]
  }
  const el = elevation / RAD
  if (el > 20)
    return [1.0, 0.965, 0.925]
  const k = smoothstep(0, 20, el)
  return [1.0, 0.60 + 0.365 * k, 0.26 + 0.665 * k]
}

function waterAmbTint(sky: Vec3): Vec3 {
  return normalizeHue([sky[0] ** 3, sky[1] ** 2.4, sky[2]])
}

export function skyFrameAt(date: Date, options: SkyOptions): SkyFrame {
  const lat = options.latitude ?? DEFAULT_LATITUDE
  const lon = options.longitude ?? longitudeForTimezone(date)
  const jd = julianDate(date.getTime())

  const sun = sunEquatorial(jd)
  const sunH = toHorizon(sun.ra, sun.dec, jd, lat, lon)
  const moon = moonEquatorial(jd)
  const moonH = toHorizon(moon.ra, moon.dec, jd, lat, lon)

  const sunEl = sunH.elevation
  const hour = date.getHours() + date.getMinutes() / 60
  const phase = phaseForHour(hour)

  const night = smoothstep(4 * RAD, -9 * RAD, sunEl)

  const sunPower = smoothstep(-4 * RAD, 2 * RAD, sunEl)
  const moonPower = 0.20 * (0.22 + 0.78 * moon.phase) * smoothstep(-2 * RAD, 8 * RAD, moonH.elevation)
  const keyIsSun = sunPower >= moonPower
  const keyElev = Math.max(keyIsSun ? sunEl : moonH.elevation, 0.7 * RAD)
  const keyAzimuth = keyIsSun ? sunH.azimuth : moonH.azimuth
  const beamPower = Math.max(sunPower, moonPower)

  const tint = normalizeHue(skyTint(keyElev, !keyIsSun, night))

  const depth = options.dark ? 9.0 : 1.15

  const floorDrop = options.dark ? 0 : 1.6

  const longExposure = options.dark ? 1 : 1.6 + 5 * night

  const beamDir = refractIntoWater(dirFrom(keyElev, keyAzimuth))
  const ambDir = refractIntoWater(dirFrom(52 * RAD, keyAzimuth))

  const ambTint = waterAmbTint(tint)
  const beamTint = keyTint(keyElev, !keyIsSun)

  const scatterTint = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 2.4)), 0.30)

  const skyAbove = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 1.3)), 8.2)

  const caustic = options.dark ? 0.55 + 0.2 * (1 - night) : 1.0

  const surfaceGlow = clamp(0.08 + 0.34 * (1 - Math.abs(keyElev / RAD - 6) / 30), 0.06, 0.34)

  const cameraPitch = options.dark ? 12.8 * RAD : 19 * RAD

  const cameraAzimuth = lerpAngle(sunH.azimuth - 14 * RAD, moonH.azimuth + 14 * RAD, night)

  const exposure = options.dark ? 0.75 : 0.60 * longExposure

  const veil = clamp(0.22 - night * 0.06, 0, 0.6)

  return {
    timeMs: date.getTime(),
    phase,
    sunElevation: sunEl,
    sunAzimuth: sunH.azimuth,
    moonElevation: moonH.elevation,
    moonAzimuth: moonH.azimuth,
    moonPhase: moon.phase,
    cameraAzimuth,
    cameraPitch,
    night,
    exposure,
    veil,
    dark: options.dark,
    targetLuminance: options.dark ? 0.07 + 0.15 * (1 - night) : 0.42,
    depth,
    floorDrop,
    beamDir,
    ambDir,
    beamTint,
    beamPower,
    ambPower: 0.85,
    absorb: EXTINCT,
    scatter: SCATTER,
    scatterNorm: SCATTER_NORM,
    phaseG: PHASE_G,
    scatterTint,
    caustic,
    surfaceGlow,
    skyAbove,
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (2 * Math.PI)
  if (delta > Math.PI)
    delta -= 2 * Math.PI
  if (delta < -Math.PI)
    delta += 2 * Math.PI
  return a + delta * t
}

export function parseSkyOverride(search: string, now: Date = new Date()): Date | null {
  const raw = new URLSearchParams(search).get('sky')
  if (!raw || raw === 'real')
    return null

  const hour = Number(raw)
  if (Number.isFinite(hour)) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setSeconds(hour * 3600)
    return d
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
