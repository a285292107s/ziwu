/**
 * 天光 / Skyglow —— 把「此刻」翻译成一组可以喂给着色器的参数。
 *
 * ## 为什么要有这个文件
 *
 * 新标签页一天里会被打开几十次。背景如果是一张固定的图，第 30 次打开时它就是死的；
 * 如果「天光」真的跟着太阳走，那每一次打开看到的都是**当下这一刻**的光：清晨低斜的
 * 暖光、正午垂直砸下来的白、黄昏被拉长的金色光路、夜里只剩月光的那一束。同一个页面，
 * 一天里没有两次是一样的。这是这一页唯一值得做的叙事。
 *
 * 这里只有纯函数：不碰 Vue、不碰 DOM、不碰 storage。渲染在 skyRenderer.ts 里。
 *
 * ## 光是照进**水里**的
 *
 * 画面不是天空，是**水下**：相机浸在海里，往上看水面，光从水面斜射下来，
 * 在水里散成一道道体积光柱。这个介质选择不是装饰，它一次解决了三件事：
 *
 * 1. **曝光有了物理载体。** 空气中的天光亮度几乎只由太阳高度决定，于是「浅色主题在
 *    夜里也要够亮」只能靠硬拉曝光，很假。水不一样：水的吸收让**深度直接决定亮度**。
 *    浅色主题停在被阳光穿透的浅水层，深色主题沉在几十米下的深水 —— 同一个太阳，
 *    两个主题各自待在物理上就该是那个亮度的深度里。这就是「主题决定曝光」。
 * 2. **光柱有了物理来源。** 水面波纹把阳光折射、聚焦成一束束亮线（caustics），
 *    这些亮线沿着折射光的方向往水下投，被水里的悬浮颗粒散射出来，就是体积光柱。
 *    它随时间漂移、随太阳方位转动 —— 画面「活着」但不需要任何动画循环去演。
 * 3. **色相有了自然的走法。** 水对红光的吸收比蓝绿快一个量级，所以光越往下走越冷、
 *    越青。一天的变化于是落在**色温与光柱倾角**上，不落在亮度上。
 *
 * 折射方向是真算的（Snell，n=1.333）。太阳越低，光进入水里越接近垂直 —— 水下的光
 * 柱永远比空气里的光束「正」，这正是水下照片看着安静的原因。太阳贴地平线时，水下
 * 折射角的极限是 48.6°（Snell 窗），这个角是算出来的，不是调出来的。
 *
 * ## 两个主题不是同一张图的明暗两版
 *
 * - **浅色主题 = 浅水（约 3 m）**。整个水体被阳光灌满，是一片通透的高调青绿，
 *   抬头能看见水面上的天光。海里也没有真正的黑 —— 浅水层里连阴影都是亮的。
 * - **深色主题 = 深水（约 30 m）**。红光早被吃干净了，只剩深蓝，光柱从很远的地方
 *   插下来，水面缩成头顶一个小小的亮斑。真实曝光，深海里就是这样。
 *
 * 两套主题共享同一套天文数据、同一套水的光学常数，只差一个深度和曝光策略。
 */

export type PhaseKey = 'dawn' | 'day' | 'dusk' | 'night'

const RAD = Math.PI / 180

/**
 * 默认纬度。经度不写死：从系统的时区偏移反推（见 `longitudeForTimezone`），
 * 这样不论用户在哪，太阳都大致在本地正午最高 —— 视觉上最要紧的那件事是对的。
 * 纬度没法从时区推，取 35°N 作为中纬度默认值（中国大部、地中海、美国南部都在这附近）。
 */
export const DEFAULT_LATITUDE = 35

/** 从时区偏移反推经度：UTC+8 → 120°E。太阳正午因此落在本地 12:00 附近。 */
export function longitudeForTimezone(date: Date = new Date()): number {
  return -date.getTimezoneOffset() / 4
}

/** 把角度归一化到 [0, 360) */
function norm360(x: number): number {
  return ((x % 360) + 360) % 360
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** 平滑阶跃，等价于 GLSL 的 smoothstep */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 儒略日 */
function julianDate(ms: number): number {
  return ms / 86400000 + 2440587.5
}

/**
 * 太阳的赤道坐标（赤经 / 赤纬，弧度）。
 * 用的是 NOAA 的低精度公式，1900-2100 内误差 < 0.02°，对一张背景图来说是过剩的精度。
 */
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

/**
 * 月亮的赤道坐标与相位。
 *
 * 用的是 Schlyter 的简化月球模型，只取主项、不做摄动修正，位置误差在 1~2° 量级。
 * 月亮视直径只有 0.5°，所以这个误差肉眼看不出来；相位（被照亮的比例）反过来是准的，
 * 因为它只取决于日月的距角。
 */
function moonEquatorial(jd: number): { ra: number, dec: number, phase: number } {
  const d = jd - 2451543.5
  const N = norm360(125.1228 - 0.0529538083 * d) * RAD
  const inc = 5.1454 * RAD
  const peri = norm360(318.0634 + 0.1643573223 * d) * RAD
  const a = 60.2666
  const ecc = 0.0549
  const M = norm360(115.3654 + 13.0649929509 * d) * RAD

  // 开普勒方程：偏近点角（牛顿迭代 6 次足够收敛到 1e-9）
  let E = M
  for (let i = 0; i < 6; i++)
    E -= (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E))

  const xv = a * (Math.cos(E) - ecc)
  const yv = a * Math.sqrt(1 - ecc * ecc) * Math.sin(E)
  const v = Math.atan2(yv, xv)
  const r = Math.hypot(xv, yv)

  // 黄道坐标
  const xh = r * (Math.cos(N) * Math.cos(v + peri) - Math.sin(N) * Math.sin(v + peri) * Math.cos(inc))
  const yh = r * (Math.sin(N) * Math.cos(v + peri) + Math.cos(N) * Math.sin(v + peri) * Math.cos(inc))
  const zh = r * (Math.sin(v + peri) * Math.sin(inc))

  const eclLon = Math.atan2(yh, xh)
  const eclLat = Math.atan2(zh, Math.hypot(xh, yh))

  // 黄道 → 赤道
  const obliq = 23.4393 * RAD
  const ra = Math.atan2(
    Math.sin(eclLon) * Math.cos(obliq) - Math.tan(eclLat) * Math.sin(obliq),
    Math.cos(eclLon),
  )
  const dec = Math.asin(
    Math.sin(eclLat) * Math.cos(obliq) + Math.cos(eclLat) * Math.sin(obliq) * Math.sin(eclLon),
  )

  // 相位角 = 月亮 → 太阳 与 月亮 → 地球 的夹角。用赤道单位向量直接算距角即可。
  const sun = sunEquatorial(jd)
  const cosElong
    = Math.cos(dec) * Math.cos(sun.dec) * Math.cos(ra - sun.ra) + Math.sin(dec) * Math.sin(sun.dec)
  // km: 0 = 新月，1 = 满月
  const phase = (1 - clamp(cosElong, -1, 1)) / 2

  return { ra, dec, phase }
}

/**
 * 赤道坐标 → 地平坐标。
 * 返回的方位角以正北为 0、向东为正，与着色器里 X=东 / Y=天顶 / Z=北 的约定一致。
 */
function toHorizon(ra: number, dec: number, jd: number, lat: number, lon: number) {
  const gmst = norm360(18.697374558 + 24.06570982441908 * (jd - 2451545))
  const lst = norm360(gmst * 15 + lon) * RAD
  const hourAngle = lst - ra

  const sinAlt = Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hourAngle)
  const elevation = Math.asin(clamp(sinAlt, -1, 1))

  // 方位角：从南向西量，再转成从北向东量
  const azSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat * RAD) - Math.tan(dec) * Math.cos(lat * RAD),
  )
  const azimuth = Math.atan2(Math.sin(azSouth + Math.PI), Math.cos(azSouth + Math.PI))

  return { elevation, azimuth: azimuth < 0 ? azimuth + 2 * Math.PI : azimuth }
}

export interface SkyOptions {
  /** 浅色主题走长曝光的高调曝光，深色主题走真实曝光 */
  dark: boolean
  latitude?: number
  longitude?: number
}

export type Vec3 = [number, number, number]

export interface SkyFrame {
  /** 这一帧对应的时间 */
  timeMs: number
  /** 时段，用于 data 属性与降级配色 */
  phase: PhaseKey
  /** 时段中文名 */
  label: string
  /** 太阳高度角（弧度），负值在地平线下 */
  sunElevation: number
  /** 太阳方位角（弧度，正北为 0、向东为正） */
  sunAzimuth: number
  moonElevation: number
  moonAzimuth: number
  /** 0 = 新月，1 = 满月 */
  moonPhase: number
  /** 相机方位角（弧度）：白天对着太阳，夜里转向月亮 */
  cameraAzimuth: number
  /** 相机俯仰角（弧度）：太阳越高，越抬头看水面 */
  cameraPitch: number
  /** 夜的程度：0 = 白昼，1 = 深夜 */
  night: number
  /** 曝光倍数 */
  exposure: number
  /** 内容区可读性薄膜的强度 0..1 */
  veil: number
  /** 当前主题是否是深色 */
  dark: boolean
  /**
   * 内容区应当收敛到的相对亮度。渲染器按这个目标做闭环自动曝光 ——
   * 水下的光是任何样子都行，但正文底下的亮度必须落在可读区间里。
   */
  targetLuminance: number

  /* ---------------- 水 ---------------- */

  /** 相机深度（米，水面之下）。**这就是两套主题的曝光差**：浅水被阳光灌满，深水只剩蓝。 */
  depth: number
  /**
   * 沙面在**相机下方**多少米（不是「水面下多少米」，也不是相机的绝对深度）。0 表示没有底 ——
   * 深水主题看到的是深渊。
   *
   * 名字里用 drop 不用 depth：错误的写法 (uDepth - floorDepth)/dir.y 在几何上算出的是
   * 「沙面在相机上方」——对每一条向下的视线都得到负数，整幅画面的下半部分因此是由
   * 相机背后的一个点画出来的。这个量必须是「相机到沙的垂直距离」，符号才不会错。
   *
   * 浅水主题里它是必须的，理由有两条，一条是画面的、一条是可读性的：
   * 构图上有了一块被光照亮的沙，画面就有了「地平」，不再是一块无方向的渐变；
   * 亮度上往下看是亮的沙而不是一个黑洞，闭环自动曝光才不用为了照亮它把整幅画顶到过曝。
   * 沙子把光弹回来 —— 浅水的高调是这么来的，不是调出来的。
   */
  floorDrop: number
  /**
   * 直射光进入水中之后的传播方向（单位向量，指向光走的方向，y < 0）。
   * 由水面上的太阳/月亮方向经 Snell 折射（n = 1.333）得到；光源在地平线下时
   * 退化成漫射天光的方向，仍然朝下。
   */
  beamDir: Vec3
  /**
   * 漫射天光的方向（单位向量，y < 0）。整个天空是一个面光源，所以它几乎垂直向下，
   * 只在月亮的方位上偏一点 —— 水下那道又宽又软的底光就是它。
   */
  ambDir: Vec3
  /** 水面之上光源的色温（线性 RGB，已归一化到最大分量为 1） */
  beamTint: Vec3
  /** 直射光强度。太阳在地平线下会掉到接近 0，只剩月亮和城市辉光。 */
  beamPower: number
  /** 漫射天光强度。有它画面才不会在光源落下时直接死掉。 */
  ambPower: number
  /**
   * 水的**总消光**系数（1/m，RGB）= 吸收 + 散射。
   * 着色器里所有「光走过一段水还剩多少」的指数都用它；
   * 拆开的那两项见 scatter。
   */
  absorb: Vec3
  /**
   * 水的**散射**系数（1/m，RGB）。着色器用它做两件事：
   * ① 单次散射源强 = 散射/总消光 × 中途平均辐照（水自己发光的那一项，
   *    从此由系数算出来，不再只是一个拍出来的颜色）；
   * ② Henyey-Greenstein 相函数的方向性（见 phaseG）。
   * 其中 ① 的定值部分（σs/σt 按亮度归一）已经算成 `scatterNorm` 直接传下去。
   */
  scatter: Vec3
  /**
   * σs/σt 按亮度归一后的谱形（常量，见 SCATTER_NORM）。
   * 它决定「水自己发的光」比「透过去的光」蓝多少 —— 色相变、亮度不变，
   * 所以自动曝光闭环与薄膜的校准不受它影响。
   */
  scatterNorm: Vec3
  /** HG 相函数的不对称因子（0..1）。见 PHASE_G。 */
  phaseG: number
  /** 水体自身的散射色（线性 RGB）：没被直射光照到的地方看到的就是它 */
  scatterTint: Vec3
  /** 水面波纹的强度 0..1：0 = 平静（镜面规整），1 = 起浪（光网碎成一片） */
  caustic: number
  /**
   * 水面本身的自发光 0..1。夜里水面上是月光、气辉和远处的城市辉光，
   * 长曝光把它们拍成一层亮 —— 浅色主题夜里那条「水面还很亮」的依据就是它。
   */
  surfaceGlow: number
  /** 水面之上的天空亮度（线性），透过 Snell 窗看到的就是它 */
  skyAbove: Vec3
}

/** 把小时数映射到时段（与旧的 ambience.ts 保持同一套界限，降级配色不会跳变） */
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

const LABELS: Record<PhaseKey, string> = {
  dawn: '清晨',
  day: '白天',
  dusk: '黄昏',
  night: '夜晚',
}

/** 水的折射率。1.333 这个数决定了 Snell 窗是 2 × 48.6° 宽 —— 水下的光柱永远是「正」的。 */
export const N_WATER = 1.333

/** 从地平坐标（弧度）取指向光源的单位向量。X = 东，Y = 天顶，Z = 北。 */
function dirFrom(elevation: number, azimuth: number): Vec3 {
  const cosEl = Math.cos(elevation)
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), cosEl * Math.cos(azimuth)]
}

/**
 * 光从空气进入水里之后的方向（Snell 折射，从空气侧射入）。
 *
 * 输入是**指向光源**的单位向量（光源在地平线上时 y > 0），输出是**光在水里传播**的
 * 方向（y < 0）。空气到水永远不会有全反射（1 < 1.333），所以总能折射进去。
 *
 * 这一步是整个画面安静下来的原因：太阳压到地平线时空气里的光几乎贴着地面走，
 * 但一进水就被掰到离垂直方向 48.6° 以内 —— 水下的光柱永远比岸上看到的更「正」。
 */
function refractIntoWater(toSource: Vec3): Vec3 {
  const eta = 1 / N_WATER
  const cosI = Math.max(toSource[1], 0)
  const sinT2 = eta * eta * (1 - cosI * cosI)
  const cosT = Math.sqrt(Math.max(1 - sinT2, 0))
  // 水平分量按 eta 缩短、方向不变（继续朝远离光源的一侧走），垂直分量转成向下
  return [-eta * toSource[0], -cosT, -eta * toSource[2]]
}

/** 水在某深度处的透过率（每通道），用来把水面上的颜色折算到水下。 */
function transmittance(absorb: Vec3, meters: number): Vec3 {
  return [Math.exp(-absorb[0] * meters), Math.exp(-absorb[1] * meters), Math.exp(-absorb[2] * meters)]
}

function scale3(c: Vec3, k: number): Vec3 {
  return [c[0] * k, c[1] * k, c[2] * k]
}

function mul3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

/** 把颜色的最大分量归一化到 1，只保留色相 —— 亮度全部交给曝光闭环。 */
function normalizeHue(c: Vec3): Vec3 {
  const m = Math.max(c[0], c[1], c[2], 1e-4)
  return [c[0] / m, c[1] / m, c[2] / m]
}

/**
 * 水的**吸收**系数（1/m）。这不是调出来的：清澈海水在红光的吸收比蓝绿快将近一个量级，
 * 所以红光在水下 10m 就没了，剩下的只有青和蓝。整个「越深越冷」的色相走法全部由它推出，
 * 两个主题用的是**同一组常数** —— 它们只是待在不同的深度。
 *
 * --- 这一轮拆成了「吸收 + 散射」两项（clearwater 的 SIG_A / SIG_S） ---
 *
 * 旧版只有一个系数，把两件事混成了一个：吸收是**光被水吃掉**（能量没了），
 * 散射是**光被拐走**（离开原来的直线，但还在别处冒出来）。混在一起的代价不是数值，
 * 是画面少了一整个物理环节 —— 被拐走的那部分本该**重新进入视线**，
 * 也就是水自己发光的那一项（in-scattering）。它一直靠 CPU 拍的 uScatterTint 顶替。
 *
 * 现在 ABSORB 只留真正的吸收，SCATTER 是散射，两者相加才是着色器里那条
 * 指数衰减用的**总消光**。分谱的形状按散射的规矩来：吸收在红端最狠（水分子的红外尾），
 * 散射在蓝端最狠（分子散射 ∝ λ⁻⁴）。
 *
 * **总消光的逐通道值刻意保持和旧版一致**（0.36 / 0.062 / 0.048）：
 * 那三个数被两个主题的深度、uScatterTint 的 2.4 倍水程、以及自动曝光的目标带一起校准过，
 * 动它们等于同时动亮度、色相和可读性三件事。这一轮只补上「其中多少是散射」，
 * 不改「一共吃掉多少」。
 */
const ABSORB: Vec3 = [0.355, 0.058, 0.042]
/**
 * 散射系数（1/m）。很小 —— 这是**清水**，不是近岸浑水：
 * 清到能看见沙底的水体，散射只占消光的几个百分点，所以它几乎不改亮度（总消光没动），
 * 只改**水自己发光的颜色**：蓝端散射占消光的比是红端的九倍，
 * 于是水体的底光比「透过去的水」更蓝 —— 这就是水为什么是蓝的。
 */
const SCATTER: Vec3 = [0.005, 0.004, 0.006]
/** 总消光 = 吸收 + 散射，逐通道。着色器里所有指数衰减用的都是它。 */
const EXTINCT: Vec3 = [
  ABSORB[0] + SCATTER[0],
  ABSORB[1] + SCATTER[1],
  ABSORB[2] + SCATTER[2],
]
/**
 * 相函数的不对称因子 g（Henyey-Greenstein）。0 = 各向同性，1 = 全部往前散。
 * 水加悬浮颗粒的实测值在 0.6~0.9；取 0.6 是**克制的**：
 * 这个参数在画面上的表现是「顺着光看过去更亮」的一层方向性，
 * 给大了会在 Snell 窗那一侧顶出一个亮包 —— 那正是被删掉的直射光柱想干的事。
 */
const PHASE_G = 0.6

/**
 * σs/σt 按亮度归一后的**谱形**（常量）。
 *
 * 蓝端散射占消光的比是红端的九倍，所以「水自己发的光」（in-scattering）
 * 比「透过去的光」更蓝 —— 这就是水为什么是蓝的，而它现在是同一组常数的推论，
 * 不再是一个拍出来的颜色。
 *
 * 归一的方式很关键：按加权亮度（Rec.709）归一之后，它的加权均值是 1，
 * 所以乘上去只**转色相、不动亮度** —— 自动曝光闭环和薄膜的整套校准因此不受影响。
 * 以前这段是每个像素在着色器里算的（三次除法 + 一次点积），现在只在模块加载时算一次。
 */
export const SCATTER_NORM: Vec3 = (() => {
  const ratio: Vec3 = [
    SCATTER[0] / EXTINCT[0],
    SCATTER[1] / EXTINCT[1],
    SCATTER[2] / EXTINCT[2],
  ]
  const lum = 0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2]
  return [ratio[0] / lum, ratio[1] / lum, ratio[2] / lum]
})()

/**
 * 水面之上那片天的颜色（线性 RGB，只有色相有意义）。水下的一切颜色都是它的下游：
 * 直射光柱取它的暖，水体的底光取它的冷。
 */
function skyTint(elevation: number, moonlit: boolean, night: number): Vec3 {
  const el = elevation / RAD
  if (moonlit) {
    // 月光本身是反射的阳光，只是暗；色温接近正午的太阳，略冷
    return [0.80, 0.87, 1.0]
  }
  if (el > 25) {
    // 高空太阳：正白偏蓝
    return [0.76, 0.88, 1.0]
  }
  if (el > 8) {
    // 中空太阳：暖白
    const k = smoothstep(8, 25, el)
    return [1.0, 1.0 - 0.12 * k, 1.0 - 0.22 * k]
  }
  if (el > -1) {
    // 低太阳：金橙。这一段是画面里唯一的暖色来源，越low越红。
    const k = smoothstep(-1, 8, el)
    return [1.0, 0.42 + 0.46 * k, 0.16 + 0.62 * k]
  }
  // 太阳落下去之后：残红很快被夜色吃掉
  const k = smoothstep(-7, -1, el)
  return [0.30 + 0.70 * k, 0.22 + 0.20 * k, 0.38 + 0.40 * k * (1 - night * 0.5)]
}

/**
 * **直射光本身**的颜色。注意它和 skyTint 是两件事，这是上一版画面糊成一片灰的根源。
 *
 * skyTint 描述的是「头顶那片天」，那是**散射光**，天生偏蓝 —— 拿它去染光柱，
 * 等于让太阳也是蓝的，于是画面上每个像素都是同一个青白色，
 * 色相上没有任何分层，剩下的差别全被 ACES 压平。
 *
 * 直射光的真实颜色正好相反：正午是接近白的暖白（D65 那一带），
 * 压到地平线才变成金橙。水下的暖色**只能**从这条路进来，
 * 因为水本身把红光吃得最快 —— 红色在画面里的存在感全靠光柱自己带。
 */
function keyTint(elevation: number, moonlit: boolean): Vec3 {
  if (moonlit) {
    // 月光是反射的阳光，色温比正午略冷，但仍明显比天光白
    return [0.86, 0.90, 1.0]
  }
  const el = elevation / RAD
  if (el > 20)
    return [1.0, 0.965, 0.925]
  // 20° 以下开始镀金，到地平线是深橙
  const k = smoothstep(0, 20, el)
  return [1.0, 0.60 + 0.365 * k, 0.26 + 0.665 * k]
}

/**
 * **水体自己**的颜色。这是画面里那一大片蓝的来源。
 *
 * 环境光不是天空色的直接复制。光穿过水面时还是天空色，但一进水就被水分子再散射一次，
 * 而分子散射强烈偏爱蓝 —— 所以水下的底光比头顶的天蓝得多。
 *
 * 这里把「再散射一次」写成按分量乘方：这是最简形式的「再过滤一遍」，
 * 蓝分量不动、红压得最狠、绿居中，而且天然保住了亮度序（不会被推成洋红）。
 * 指数越大水越蓝。太阳压到地平线时它会给出偏琥珀的底光，
 * 那也是对的：一米深的浅水被金光灌满时本来就是琥珀色的，
 * 「变蓝」是深度干的事，交给 transmittance。
 */
function waterAmbTint(sky: Vec3): Vec3 {
  return normalizeHue([sky[0] ** 3, sky[1] ** 2.4, sky[2]])
}

/**
 * 算出某一时刻的天光参数。
 *
 * 曝光与各散射系数是**美术调参**，不是物理量：真实大气的动态范围远超一张网页背景
 * 该有的对比度，所以这里的目标是「任何时刻都好看、且正文永远读得清」，
 * 物理只负责让光的方向和颜色是对的。
 */
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

  /**
   * 夜的程度。太阳高度 -6° 以下是天文暮光结束、真正的夜；+3° 以上已经是白天。
   * 用两条 smoothstep 相乘而不是一条，是为了让「蓝调时刻」有一段稳定停留，
   * 而不是一闪而过。
   */
  const night = smoothstep(4 * RAD, -9 * RAD, sunEl)

  /**
   * 水面上真正在发光的是谁，以及它有多强。
   *
   * 太阳落到地平线下之后直射光不是「变小」而是「没有了」—— 剩下的是月亮。
   * 月亮也没有的夜里（新月前后），还剩气辉和城市辉光：它们没有方位，
   * 于是水下的光柱收成一束很弱、很正的底光。这条链子决定了夜里的画面不会死。
   */
  const sunPower = smoothstep(-4 * RAD, 2 * RAD, sunEl)
  // 满月的照明远弱于太阳，但绝不是零 —— 水下那一束冷白的光柱就是它
  const moonPower = 0.20 * (0.22 + 0.78 * moon.phase) * smoothstep(-2 * RAD, 8 * RAD, moonH.elevation)
  const keyIsSun = sunPower >= moonPower
  const keyElev = Math.max(keyIsSun ? sunEl : moonH.elevation, 0.7 * RAD)
  const keyAzimuth = keyIsSun ? sunH.azimuth : moonH.azimuth
  const beamPower = Math.max(sunPower, moonPower)

  const tint = normalizeHue(skyTint(keyElev, !keyIsSun, night))

  /**
   * 相机深度：**两个主题的曝光差就是它**。
   *
   * 浅色主题停在**贴着水面**的浅滩上（1.15m），深色主题沉在红光早已被吃干净的深水。
   * 同一个太阳、同一组水的常数，两边各自待在物理上就该是那个亮度的深度里 ——
   * 这就是「主题决定曝光」在有了介质之后的落地方式。
   *
   * 为什么浅水要这么浅：体积散射沿一条掠射光线积分会**把结构抹平**（一条视线要走
   * 十几二十米，上面的细波纹全被平均掉了），所以画面里「有东西可看」的区域只能是
   * 眼睛够得着水面的区域。相机贴近水面，抬头是波光、低头是沙，中间那条空白带
   * 才会窄到可以接受。
   */
  const depth = options.dark ? 9.0 : 1.15

  /**
   * 海底。浅水主题必须有它，理由一条是画面的、一条是可读性的：
   * 有了一块被光照亮的沙，画面就有了「地平」，不再是一块无方向的渐变；
   * 往下看是亮的沙而不是一个黑洞，闭环自动曝光才不用为了照亮它把整幅画顶到过曝。
   * 深水主题没有底 —— 往下看就是深渊，这正是它要的。
   *
   * 1.6m 而不是 0.45m：0.45 的时候沙面离眼睛只有半米，画面上那些沙粒尺度是
   * 几厘米 —— 拍出来是一块没有纹理的白斑，而且视线在撞到沙之前几乎没有水，
   * 沙面上也就没有雾盖着。拉到 1.6m（相机在水面下 1.15m，水深 2.75m），
   * 画面下缘的沙在 1.8m 外、地平线附近的沙在几十米外 ——
   * 距离一拉开就同时得到了两样东西：沙的透视，和**由吸收自己做出来的纵深**：
   * 近处的沙亮，远处被水吃掉红光之后自己沉进青色里。
   *
   * 再远就不行了。3.4m 试过：沙面的红光要穿过 4.5m 水才到眼睛，
   * exp(-0.36×4.5)=0.20 —— 沙自己那点暖被水吃干净，画面下半幅又变成一块青。
   */
  const floorDrop = options.dark ? 0 : 1.6

  /**
   * 浅色主题在夜里是**长曝光**，深色主题是肉眼所见。
   *
   * 这一档亮度差不能让闭环自动曝光去补：那会把增益顶到上限、整幅画面糊成一片灰。
   * 它该是美术层的意图，闭环只负责 ±2 档以内的修正。
   * 2.7 档（约 6.6×）刚好把夜里的浅水从「几乎全黑」抬到「一片发亮的夜海」。
   * 注意它走的是**曝光**而不是画面亮度：一天里的最终亮度不变，变的只是色温和光柱。
   */
  const longExposure = options.dark ? 1 : 1.6 + 5 * night

  const beamDir = refractIntoWater(dirFrom(keyElev, keyAzimuth))
  /**
   * 漫射天光：整个天空是一个面光源，所以它几乎垂直向下，只在主光源那一侧偏一点。
   * 水下那道又宽又软的底光就是它 —— 没有它，光柱之间会是纯黑，看着像太空。
   */
  const ambDir = refractIntoWater(dirFrom(52 * RAD, keyAzimuth))

  /**
   * 两条颜色，必须分开 —— 分开这件事本身就是这幅画的结构：
   *
   *   ambTint  ＝ 水体自己的蓝。画面里所有「水」的地方（漫射底光、水体、镜面衬底、
   *               透过 Snell 窗看到的天）都用它。红被压得很低，所以远和近、上和下
   *               在**色相**上就分开了，不必靠亮度去分。
   *   keyTint  ＝ 直射光的暖白。只有光柱、被光照亮的沙面、水面反光用它。
   *
   * 两者叠加的地方才会出现 R 通道的高值。上一版把两者用同一个 tint，
   * 结果整幅画只有一个青白色，ACES 一把过曝就把它压成了灰。
   */
  const ambTint = waterAmbTint(tint)
  const beamTint = keyTint(keyElev, !keyIsSun)

  /**
   * 水体的底光颜色：水面上的天光走一小段水之后的颜色。
   *
   * 它自带深度的曝光 —— 浅水是通透的青白，深水是自己那点蓝。
   *
   * 0.30 这个系数是**画面的分水岭**，不是微调。它乘在三个「水自己发的光」上：
   * 体积积分的漫射项、镜面的衬底、沙面的环境光。这三项的共同点是**沿视线几乎不变** ——
   * 它们是把整幅画抬起来的那块底板。底板高的时候，窗、水柱、沙三段的场景亮度
   * 会挤在 1.4 倍以内，而 ACES 在 1.0 以上的斜率只有 0.2 左右，
   * 于是 1.4 倍的场景差到屏幕上只剩几个百分点 —— 画面看着「平」就是这个原因，不是缺对比度。
   * 把底板压下去，三段之间才是真的拉开：窗≈2.3、水柱≈0.25、沙≈1.1。
   *
   * 深度系数从 0.85 提到 2.4，理由是**散射光走的路比相机到散射点那段更长**：
   * 相机看到的水体光是「从水面下来 + 沿视线回来」两段，0.85 倍相机深度
   * 连单程都不够，等于说水的颜色几乎没被吸收过。量出来的后果在色相上：
   * 画面中段（倒影带）落在 rgb 136,194,207，R/G = 0.70 —— 一层中性偏白的薄雾，
   * 于是整幅读成「冰面/卷云」而不是水。而同一张图里沙面是 114,218,219（R/G 0.52），
   * 因为沙面那一路的衰减是**沿着光自己的 2.4m 水路**算的，颜色就是对的。
   * 也就是说：画面里唯一像水的地方，正是唯一按真实水路算过颜色的地方。
   * 2.4 倍深度（浅水主题约 2.8m）把 R 压到 0.40、G/B 留在 0.85 上下，
   * 中段变成一块有分量的青，窗与水的色相差才立得住。
   */
  const scatterTint = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 2.4)), 0.30)

  /**
   * 透过 Snell 窗看到的天。视线要穿过相机到水面这一整段水，所以衰减比底光重得多。
   * 深度越大窗越暗 —— 30m 下那个亮斑只剩几个百分点，这正好是深色主题要的。
   *
   * 3.3 是「天比水亮多少」这一件事，物理上还保守得多：天空的亮度是水面散射光的几千倍，
   * 这里只取了几倍。它给的是画面顶部那块**接近过曝的亮**，正是这幅画的天花板。
   *
   * 这里曾经是 7.0，量出来的后果是：整块窗的场景值在 3~6 之间，而 ACES 在 1.0 以上
   * 的斜率只剩 0.2 —— 窗内部那 2.3 倍的起伏（出射角从 34° 到 90°）压到屏幕上只剩
   * 两三个百分点，画面顶部 30% 就是一张 241,254,255、横向 R±16 的白纸。
   * 而且闭环救不了它：正文带**就在窗里**，闭环把正文带钉在可读性下限之上，
   * 窗的峰值跟着一起被钉住 —— 唯一能动的是美术层这两个数的比例。
   * 3.3 之后窗峰值落在场景 2.1~3.2（显示 0.92~0.96，不再顶到 255），
   * 正文带落在 0.86 左右（仍远高于 0.496 的下限，遮罩不必介入），
   * 而窗沿那一圈回到 0.62 —— 那条边终于有了层次。
   *
   * 1.15 同步提到 2.0：窗里的天光也要走「下来 + 上去」两段水，
   * 而且它是全画幅最亮的地方 —— 亮的地方最容易在 ACES 肩部丢掉色相变成纯白，
   * 这正是顶部那片「卷云白」的来源。色相得在**进肩部之前**就带上，
   * 所以这里给足路程，让窗是一块**青白**而不是一张白纸。
   *
   * 5.6 → 8.2（实测）：5.6 的时候整幅最亮的地方只到 display 0.679（p90），
   * 全画幅挤在 0.18~0.68 这一段中间调里，没有**亮点**——而主题要的就是「天光」，
   * 没有一处真正发亮的光源，画面就只是「一片水」，不是「光进了水」。
   * 原因是窗虽然算得对，但被两件事压着：出射角的四次方falloff把窗心压到 0.5 左右，
   * 而水面的粗波又把正文带里约一半的像素翻到了临界角之外的镜面侧（见 SURF_SLOPE）。
   * 提到 8.2 之后窗心进到场景 3 附近、display 0.85+，画面才第一次有了明暗的落点。
   *
   * 2.0 → 1.3（实测，日落那一帧逼出来的）：上面那句「下来 + 上去」把两件
   * 不同的事混成了一个指数。**散射项**（scatterTint）确实要走两段 —— 那是水体
   * 里被散到镜头上的光，先沉到水深再拐向相机，2.4 是对的，保持不动。
   * 但 **Snell 窗不是散射**：它是透过水面**直接看到的天**，光从水面到相机
   * 只走了一段 ≈ depth/cosθ ≈ 1.3×depth，没有任何「上去」那一程。
   * 用 2.0 就是给窗多算了一倍的水。代价在日落时最明显 —— 红被多吸掉
   * exp(0.7×1.15×0.36) ≈ 1.34 倍，于是暖橙的天光被水滤成**灰紫**，
   * 正好就是 light-1900-sunset 顶部那一大片。改回 1.3 之后红光回来了，
   * 窗在日落时是**金**的，正午因为 ambTint 本来就接近白，只是略暖，不影响。
   */
  const skyAbove = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 1.3)), 8.2)

  /**
   * 水面波纹强度：它现在是那张光网的**总增益**。风浪越大，光柱碎得越细；
   * 两个主题给不同的性格：浅水是一池被搅动过的碎光，深水是从很远处插下来、
   * 几乎成条的几道光，所以深水压得低。
   */
  const caustic = options.dark ? 0.55 + 0.2 * (1 - night) : 1.0

  /**
   * 水面下方那层波光：低太阳时抬头的方向上是整面晃动的亮墙，
   * 正午时它退成头顶一个稳定的亮斑。
   *
   * 这一项是两个数量级里最小的一个 —— 它只是给已经压在 ACES 肩部的那片天光
   * 再加一点波动，加多了整幅画立刻失去高调的干净。
   */
  const surfaceGlow = clamp(0.08 + 0.34 * (1 - Math.abs(keyElev / RAD - 6) / 30), 0.06, 0.34)

  /* **星星那一项已删除（water28）。** 它算的是「星星可见度」，而它在着色器里唯一的
     消费者是水面倒影里那层常数微光（`uStarAmount`）；星空本身（starField 与
     starBasis 那套绕天极的坐标系）从来没有被调用过。整条链一起删掉。
     夜里水面读得出来的是月亮与 uScatterTint 那片蓝，它们都还在。 */

  /**
   * 相机俯仰角。两个主题的取法不一样，因为它们在构图上要的东西不一样。
   *
   * 浅水：固定 **19°**，而且这个数是**从可读性倒推出来的**，不是取景偏好。
   *
   * Snell 窗的下缘永远在世界坐标 41.4°（全反射临界角的余角 asin(1/1.333)），
   * 和太阳在哪、几点钟都无关。相机俯仰 p 时，窗的下缘落在画面上
   *   f = 0.5 - tan(41.4° - p) / (2·tan(FOV/2))
   * 处（f 从画面顶端往下数）。取 p = 19°、FOV = 92°：f = 0.30 —— 窗占画面顶部 30%。
   *
   * 为什么正好要 30%：正文里唯一没有玻璃底的三个元素（钟点、日期、问候）
   * 压在 CSS 的 y 12%~24% 上，也就是 f 0.12~0.24。窗下缘在 0.30 时，
   * **整条正文带都落在窗里** —— 一个明亮的、平滑的、几乎不变的区域。
   * 可读性因此是几何保证的，不是靠曝光去追的。
   *
   * 曾经让俯仰跟着太阳在 7°~13° 之间漂：那样窗的下缘在 f = 0.06~0.24 之间移动，
   * 太阳一高，问候那一行就压到水柱/镜面的纹理上，而那一带有波纹——
   * 曝光探针量到的 p10 会在 0.51 和 0.60 之间乱跳，闭环只好跟着抖。
   * 俯仰定死之后取景也不再天天换：一天里变的是光的角度、色温和水色，这是对的。
   *
   * 深水：固定 **12.8°**。那里不需要窗给正文让位（正文是浅色的，怕的是**亮**），
   * 所以取一个窗更小的取景：框顶一条极亮的窄带，下面是整片深蓝。
   */
  const cameraPitch = options.dark ? 12.8 * RAD : 19 * RAD

  // 白天对着主光源、夜里对着月亮：两次打开之间光柱会缓慢转过去
  const cameraAzimuth = lerpAngle(sunH.azimuth - 14 * RAD, moonH.azimuth + 14 * RAD, night)

  /**
   * 曝光曲线**由主题决定，不由太阳决定**。
   *
   * 这是被可读性倒逼出来的结论，也是这一页最重要的美术决定。
   * 直接贴在天空上、没有自己底色的正文只有两处，它们定死了背景的亮度窗口：
   *   .clock-date（14px, --text-3）、.greeting（16~19px, --text-2），都要 4.5:1。
   *
   * 浅色主题原来把 --text-3 定在 #55636e（相对亮度 0.123），于是背景必须 ≥ 0.727 ——
   * 换算成 sRGB 就是**第 10 百分位不得低于 222 级**。那等于要求九成的画面都亮过 222：
   * 可用的动态范围只剩 222~255 这 33 级，天光再准也只能是一张白纸，怎么调都平。
   *
   * 所以把浅色的 --text-3 压深到 #414d58（相对亮度 0.071），背景下限随之降到 0.50
   * （≈193 级）—— 换回来整整 30 级，画面这才有地方放明暗。
   * 这是**前台为了给背景让路而做的最小改动**：同一个灰阶层级、同一个用法，
   * 只是不再贴着 4.5:1 的边线取值。文字反而更清楚了。
   *
   * 深色主题的 --text-3 #97a4b1（0.362）要求背景 ≤ 0.042，那一侧本来就宽裕。
   *
   * 一天里的变化于是不走亮度，只走三件事：色温、光柱的倾角、水体吸收出来的色。
   *
   * 曝光里那一档 longExposure 是**夜里**才起来的，它改的是曝光、不是最终亮度：
   * 闭环自动曝光仍然会把画面收回同一个亮度，浅色主题因此「一天里都一样亮」。
   *
   * 0.60 这个系数是**实测反推**的，不再是从旧目标换算来的：
   * 夏至正午 E=0.96（longExposure=1.6）、闭环收敛在 gain≈0.99 时整幅中位数落到 0.49，
   * 正落在目标带 0.42~0.56 里 —— 美术层自己就把亮度摆对了，闭环基本不动。
   *
   * 这一步很要紧：美术层必须自己把亮度摆对，闭环只做收尾。
   * 否则新标签页打开后的头几秒画面会一路从过曝滑到正确亮度 —— 那几秒正是第一眼。
   * 闭环增益仍然保留 ±2 档（GAIN_MIN/GAIN_MAX），只负责把 ±10% 以内的误差抹平。
   *
   * 0.60 这个系数是实测反推的：夏至正午 E=0.96（longExposure=1.6）、
   * 闭环收敛在 gain≈0.99 时整幅中位数落到 0.47~0.49，正落在目标 0.42~0.56 的带里。
   * 也就是说闭环基本不需要动 —— 美术层自己就把亮度摆对了，这正是要的状态。
   * 曾经想过把系数收到 0.36 让 gain 精确等于 1，那是拿「试过 0.30 目标」那版的
   * 数据算的，目标回退之后这个推导也跟着作废，别再按它改。
   */
  const exposure = options.dark ? 0.75 : 0.60 * longExposure

  /**
   * 内容区薄膜：可读性的兜底，初值给保守一点，渲染器会按真实像素把它调下来。
   * 它是一条大羽化的径向渐变，读起来应该像雾，不能像卡片。
   */
  const veil = clamp(0.22 - night * 0.06, 0, 0.6)

  return {
    timeMs: date.getTime(),
    phase,
    label: LABELS[phase],
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
    // 深色主题的曝光目标跟着夜色走。夜里的水本来就只有月光，实测整幅中位数落在 0.09 附近；
    // 如果目标死钉在 0.22，闭环就永远够不着，增益会被顶到 GAIN_MAX=4 卡死 —— 那样「压」的
    // 那条路等于不存在，又退回成单向棘轮。让目标在夜里降到 0.07，两端就都够得着了：
    // 夜里增益会自己回到 1 附近，白天则停在 0.22 上。**暗是美术层的事，不是闭环硬拉出来的。**
    // 浅色的曝光目标是 0.42。**试过 0.30，是错的，已回退**：
    // 目标压低之后水体确实暗下来了，但同一套场景被推出了 ACES 肩部、
    // 落进曲线的中段，那里色相是饱和的 —— 日落那张的下半幅直接变成一片
    // 薄荷绿，顶部因为薄膜是中性白、和暖色天光混出一层粉紫，
    // 两张都从「水」变成了「果冻」。而 0.42 时下半幅是青绿，
    // 顶部是一片被搅动过的碎光，颜色是对的。
    // 教训：明暗层次不能靠压曝光买。这个画面的纵向层次由**吸收**决定
    // （窗、水体、沙面三段各走不同的水程），曝光只决定这三段落在线性段的哪里。
    // 想要更亮的窗，得让窗本身更亮（skyAbove），不是让整体更暗。
    targetLuminance: options.dark ? 0.07 + 0.15 * (1 - night) : 0.42,
    depth,
    floorDrop,
    beamDir,
    ambDir,
    beamTint,
    beamPower,
    /* **水体「厚薄」的唯一旋钮。**
     *
     * 这里是 0.40 的时候，画面暗到**自动曝光顶到 GAIN_MAX=4 也补不回来**：
     * 实测深色正午 gain=3.77、p50=0.171，而目标是 0.22。直射光柱删掉之后，
     * 水体只剩漫射底光这一项，于是把这个权重抬起来，让曝光闭环重新有余量。
     * 现在是 0.85（旧注释里那个 SCATTER 旋钮已经随光柱一起删了）。
     *
     * 注意它抬的是**水自己发多少光**，不是「水有多深」—— 深度由 depth 与
     * SCAT_LEN 那套形状因子决定。 */
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

/** 两个方位角之间取插值，走最短的一侧（方位角是环形的，不能直接 lerp） */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (2 * Math.PI)
  if (delta > Math.PI)
    delta -= 2 * Math.PI
  if (delta < -Math.PI)
    delta += 2 * Math.PI
  return a + delta * t
}

/**
 * 评审用的时间覆盖。
 *
 * 截图脚本需要「拍早上 6 点」这种能力，否则一轮评审得等一整天。
 * 支持三种写法：
 *   ?sky=6.5                      → 今天 06:30
 *   ?sky=2026-06-21T05:30         → 指定日期时间
 *   ?sky=real / 缺省               → 跟随真实时间
 *
 * 这是**只读的调试入口**，不写 storage、不进设置页：它不该成为用户会依赖的功能。
 */
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
