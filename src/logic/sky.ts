/**
 * 天光 / Skyglow —— 把「此刻」翻译成一组可以喂给着色器的参数。
 *
 * ## 为什么要有这个文件
 *
 * 新标签页一天里会被打开几十次。背景如果是一张固定的图，第 30 次打开时它就是死的；
 * 如果「天光」真的跟着太阳走，那每一次打开看到的都是**当下这一刻**的光。
 * 这是这一页唯一值得做的叙事。
 *
 * 这里只有纯函数：不碰 Vue、不碰 DOM、不碰 storage。渲染在 skyRenderer.ts 里。
 *
 * ## 光是照进**水里**的
 *
 * 画面不是天空，是**水下**：相机浸在海里，往上看水面，光从水面斜射下来。
 * 这个介质选择不是装饰，它一次解决了三件事：
 *
 * 1. **曝光有了物理载体。** 空气中的天光亮度几乎只由太阳高度决定，于是「浅色主题在
 *    夜里也要够亮」只能靠硬拉曝光，很假。水不一样：水的吸收让**深度直接决定亮度**。
 * 2. **色相有了自然的走法。** 水对红光的吸收比蓝绿快一个量级，所以光越往下走越冷、
 *    越青。一天的变化于是落在**色温**上，不落在亮度上。
 * 3. **画面有了结构。** 水面波纹把阳光折射、聚焦成一张会漂移的光网（焦散）投在沙底上，
 *    浅色主题因此有一块被光照亮的沙 —— 那是它的「地平」。
 *
 * 折射方向是真算的（Snell，n=1.333）。太阳越低，光进入水里越接近垂直：空气里贴着
 * 地面走的光一进水就被掰进 48.6° 的锥里，所以不管太阳多低，水下的光都不会躺平。
 * 这正是水下照片总显得安静的原因。
 *
 * ## 两个主题不是同一张图的明暗两版
 *
 * 两套主题共享同一套天文数据、同一套水的光学常数，差别只有一个**相机深度**：
 * 浅色主题停在被阳光灌满的浅滩，深色主题沉在红光早已被吃干净的深水。
 * 曝光差因此是深度本身的物理结果，不是调出来的。两者的具体深度见 `skyFrameAt`。
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
function longitudeForTimezone(date: Date = new Date()): number {
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
  /** 时段。只用于 `?skydebug=1` 的诊断输出，不参与渲染 */
  phase: PhaseKey
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

/**
 * 把小时数映射到时段。
 *
 * **这里是唯一真源**：`logic/ambience.ts` 的降级调色板也 re-export 它，
 * 两边各写一套界限的话，WebGL 挂掉降级到 CSS 渐变时颜色会在时段边界上跳一下。
 */
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

/** 水的折射率。1.333 这个数决定了 Snell 窗是 2 × 48.6° 宽。 */
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
 * 但一进水就被掰到离垂直方向 48.6° 以内 —— 水下的光永远比岸上看到的更「正」。
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
 * 水的**吸收**系数（1/m）。这不是调出来的：清澈海水对红光的吸收比蓝绿快将近一个量级，
 * 所以红光在水下 10m 就没了，剩下的只有青和蓝。整个「越深越冷」的色相走法全部由它推出，
 * 两个主题用的是**同一组常数** —— 它们只是待在不同的深度。
 *
 * 吸收与散射必须分开：吸收是**光被水吃掉**（能量没了），散射是**光被拐走**
 * （离开原来的直线，但还在别处冒出来）。混成一个系数的代价是画面少一整个物理环节 ——
 * 被拐走的那部分本该**重新进入视线**，也就是水自己发光的那一项（in-scattering）。
 *
 * **总消光的逐通道值刻意保持稳定**：它被两个主题的深度、scatterTint 的水程、
 * 以及自动曝光的目标带一起校准过，动它等于同时动亮度、色相和可读性三件事。
 * 改这一组数之前先想清楚要动的是「吸收多少」还是「散射多少」。
 */
const ABSORB: Vec3 = [0.355, 0.058, 0.042]
/**
 * 散射系数（1/m）。很小 —— 这是**清水**，不是近岸浑水：
 * 清到能看见沙底的水体，散射只占消光的几个百分点，所以它几乎不改亮度，
 * 只改**水自己发光的颜色**：蓝端散射占消光的比远高于红端，
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
 * 水加悬浮颗粒的实测值在 0.6~0.9；这里取得**克制**：
 * 它在画面上的表现是「顺着光看过去更亮」的一层方向性，
 * 给大了会在 Snell 窗那一侧顶出一个亮包 —— 而那片区域正是正文所在的地方。
 */
const PHASE_G = 0.6

/**
 * σs/σt 按亮度归一后的**谱形**（常量）。
 *
 * 归一的方式很关键：按加权亮度（Rec.709）归一之后，它的加权均值是 1，
 * 所以乘上去只**转色相、不动亮度** —— 自动曝光闭环和薄膜的整套校准因此不受影响。
 * 这是一个逐像素的常数，所以只在模块加载时算一次。
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
 * 直射光取它的暖，水体的底光取它的冷。
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
 * **直射光本身**的颜色。注意它和 skyTint 是两件事，这是早期画面糊成一片灰的根源。
 *
 * skyTint 描述的是「头顶那片天」，那是**散射光**，天生偏蓝 —— 拿它去染直射光，
 * 等于让太阳也是蓝的，于是画面上每个像素都是同一个青白色，
 * 色相上没有任何分层，剩下的差别全被 ACES 压平。
 *
 * 直射光的真实颜色正好相反：正午是接近白的暖白（D65 那一带），
 * 压到地平线才变成金橙。水下的暖色**只能**从这条路进来，
 * 因为水本身把红光吃得最快。
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
 * 指数越大水越蓝。太阳压到地平线时它会给出偏琥珀的底光，那也是对的：
 * 浅水被金光灌满时本来就是琥珀色的，而「变蓝」是深度干的事，交给 transmittance。
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
   * 浅色主题停在贴着水面的浅滩，深色主题沉在红光早已被吃干净的深水。
   * 同一个太阳、同一组水的常数，两边各自待在物理上就该是那个亮度的深度里 ——
   * 这就是「主题决定曝光」的落地方式。
   *
   * 浅水必须浅：体积散射沿一条掠射视线积分会**把结构抹平**（一条视线要走
   * 十几二十米，上面的细波纹全被平均掉了），所以画面里「有东西可看」的区域只能是
   * 眼睛够得着水面的区域。
   */
  const depth = options.dark ? 9.0 : 1.15

  /**
   * 海底。浅水主题必须有它，理由一条是画面的、一条是可读性的：
   * 有了一块被光照亮的沙，画面就有了「地平」，不再是一块无方向的渐变；
   * 往下看是亮的沙而不是一个黑洞，闭环自动曝光才不用为了照亮它把整幅画顶到过曝。
   * 深水主题没有底 —— 往下看就是深渊，这正是它要的。
   *
   * 距离要拉开：太近（半米量级）时沙粒尺度只有几厘米，拍出来是一块没有纹理的白斑，
   * 而且视线在撞到沙之前几乎没有水，沙面上也就没有雾盖着；太远（三四米）时沙面的
   * 红光要穿过几米水才到眼睛，暖色被吃干净，画面下半幅又糊成一块青。
   */
  const floorDrop = options.dark ? 0 : 1.6

  /**
   * 浅色主题在夜里是**长曝光**，深色主题是肉眼所见。
   *
   * 这一档亮度差不能让闭环自动曝光去补：那会把增益顶到上限、整幅画面糊成一片灰。
   * 它该是美术层的意图，闭环只负责 ±2 档以内的修正。
   * 注意它走的是**曝光**而不是画面亮度：一天里的最终亮度不变，变的只是色温和色相。
   */
  const longExposure = options.dark ? 1 : 1.6 + 5 * night

  const beamDir = refractIntoWater(dirFrom(keyElev, keyAzimuth))
  /**
   * 漫射天光：整个天空是一个面光源，所以它几乎垂直向下，只在主光源那一侧偏一点。
   * 水下那道又宽又软的底光就是它 —— 没有它，画面在别处会是纯黑，看着像太空。
   */
  const ambDir = refractIntoWater(dirFrom(52 * RAD, keyAzimuth))

  /**
   * 两条颜色，必须分开 —— 分开这件事本身就是这幅画的结构：
   *
   *   ambTint  ＝ 水体自己的蓝。画面里所有「水」的地方（漫射底光、水体、镜面衬底、
   *               透过 Snell 窗看到的天）都用它。红被压得很低，所以远和近、上和下
   *               在**色相**上就分开了，不必靠亮度去分。
   *   beamTint ＝ 直射光的暖白。只有被直射光照亮的地方（沙面、水面反光）用它。
   *
   * 两者叠加的地方才会出现 R 通道的高值。早期把两者用同一个 tint，
   * 结果整幅画只有一个青白色，ACES 一把过曝就把它压成了灰。
   */
  const ambTint = waterAmbTint(tint)
  const beamTint = keyTint(keyElev, !keyIsSun)

  /**
   * 水体的底光颜色：水面上的天光走一小段水之后的颜色。
   *
   * 这一项是**画面的底板**，不是微调。它乘在三个「水自己发的光」上：体积积分的漫射项、
   * 镜面的衬底、沙面的环境光。这三项的共同点是**沿视线几乎不变**；底板一高，
   * 窗 / 水体 / 沙三段的场景亮度就挤在一起，而 ACES 在肩部斜率很低，
   * 场景里那点差别到屏幕上只剩几个百分点 —— 画面看着「平」是这个原因，不是缺对比度。
   *
   * 深度系数要**大于 1 倍相机深度**：相机看到的水体光是「从水面下来 + 沿视线回来」两段，
   * 单程不够。给不足时画面中段会是一层中性偏白的薄雾，整幅读成「冰面 / 卷云」而不是水。
   */
  const scatterTint = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 2.4)), 0.30)

  /**
   * 透过 Snell 窗看到的天。视线要穿过相机到水面这一整段水，所以衰减比底光重得多。
   * 深度越大窗越暗 —— 深水主题下那个亮斑只剩几个百分点，这正是它要的。
   *
   * 乘数是「天比水亮多少」。不能给大：窗是全画幅最亮的地方，一旦它的场景值被推进
   * ACES 肩部，窗内部的起伏就会被压平，顶部变成一张白纸 ——
   * 而且闭环救不了它（正文带就在窗里，闭环把正文带钉在可读性下限上，
   * 窗的峰值跟着一起被钉住）。给足色相所需的水程，让窗是一块**青白**而不是一张白纸。
   *
   * 水程系数必须**接近 1 倍而不是 2 倍**：窗不是散射，它是透过水面直接看到的天，
   * 光从水面到相机只走了一段，没有「再由水面反射回来」那一程。多算一倍水程的代价
   * 在日落时最明显 —— 暖橙的天光会被滤成灰紫。
   */
  const skyAbove = scale3(mul3(ambTint, transmittance(EXTINCT, depth * 1.3)), 8.2)

  /**
   * 水面波纹强度：它是那张光网的**总增益**。风浪越大，光网碎得越细；
   * 两个主题给不同的性格：浅水是一池被搅动过的碎光，深水压得低，光网更成条。
   */
  const caustic = options.dark ? 0.55 + 0.2 * (1 - night) : 1.0

  /**
   * 水面下方那层波光：低太阳时抬头的方向上是整面晃动的亮墙，
   * 正午时它退成头顶一个稳定的亮斑。
   *
   * 这一项是所有项里最小的一个 —— 它只是给已经压在 ACES 肩部的那片天光
   * 再加一点波动，加多了整幅画立刻失去高调的干净。
   */
  const surfaceGlow = clamp(0.08 + 0.34 * (1 - Math.abs(keyElev / RAD - 6) / 30), 0.06, 0.34)

  /**
   * 相机俯仰角。两个主题的取法不一样，因为它们在构图上要的东西不一样。
   *
   * 浅水这个数是**从可读性倒推出来的**，不是取景偏好：Snell 窗的下缘永远在世界坐标
   * 41.4°（全反射临界角的余角），和太阳在哪、几点钟都无关。相机俯仰决定了这条下缘
   * 落在画面的哪个高度上 —— 取一个让**整条正文带都落在窗里**的值，可读性就是
   * 几何保证的，不是靠曝光去追的：窗内部是一个明亮的、平滑的、几乎不变的区域。
   * 曾经让俯仰跟着太阳漂，结果太阳一高，问候那一行就压到有波纹的镜面纹理上，
   * 曝光探针量到的分位数随之乱跳，闭环只好跟着抖。
   *
   * 深水不需要窗给正文让位（正文是浅色的，怕的是**亮**），所以取一个窗更小的取景：
   * 框顶一条极亮的窄带，下面是整片深蓝。
   *
   * 改了俯仰就要重量一次正文带的位置（探针那边的带子与它是一份契约）。
   */
  const cameraPitch = options.dark ? 12.8 * RAD : 19 * RAD

  // 白天对着主光源、夜里对着月亮：两次打开之间画面会缓慢转过去
  const cameraAzimuth = lerpAngle(sunH.azimuth - 14 * RAD, moonH.azimuth + 14 * RAD, night)

  /**
   * 曝光曲线**由主题决定，不由太阳决定**。
   *
   * 这是被可读性倒逼出来的结论，也是这一页最重要的美术决定：直接贴在天空上、
   * 没有自己底色的正文（日期、问候语）定死了背景的亮度窗口 —— 它们要求 4.5:1，
   * 而背景越亮，可用动态范围就越窄。所以浅色主题的 `--text-3` 被压深过两次
   * （见 main.css 里那段注释），把背景下限换下来，画面才有地方放明暗。
   *
   * 一天里的变化因此不走亮度，只走三件事：色温、Snell 窗的位置、水体吸收出来的色。
   *
   * longExposure 是**夜里**才起来的，它改的是曝光、不是最终亮度：闭环自动曝光仍然
   * 会把画面收回同一个亮度，浅色主题因此「一天里都一样亮」。
   *
   * 这里的系数是**实测反推**的，目标是让美术层自己就把亮度摆对、闭环只做收尾。
   * 否则新标签页打开后的头几秒画面会一路从过曝滑到正确亮度 —— 那几秒正是第一眼。
   * 想让画面更亮，改这里的系数，不要去动闭环的 GAIN 范围。
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
    // 深色主题的曝光目标跟着夜色走。目标死钉在昼值上时，夜里的水永远够不着它，
    // 增益会被顶到 GAIN_MAX 卡死 —— 那样「往下压」的那条路等于不存在，控制器退回成
    // 单向棘轮。让目标在夜里降下来，两端就都够得着。**暗是美术层的事，不是闭环硬拉出来的。**
    //
    // 浅色目标的教训（试过更低，已回退）：目标压低之后水体确实暗了，但同一套场景被
    // 推进 ACES 曲线的中段，那里色相是饱和的 —— 日落的下半幅会变成一片薄荷绿。
    // 明暗层次不能靠压曝光买：这个画面的纵向层次由**吸收**决定（窗、水体、沙面三段
    // 各走不同的水程），曝光只决定这三段落在线性段的哪里。想要更亮的窗，让窗本身更亮。
    targetLuminance: options.dark ? 0.07 + 0.15 * (1 - night) : 0.42,
    depth,
    floorDrop,
    beamDir,
    ambDir,
    beamTint,
    beamPower,
    /* **水体「厚薄」的唯一旋钮。**
     *
     * 它抬的是**水自己发多少光**，不是「水有多深」—— 深度由 depth 与着色器里那套
     * 形状因子决定。给低了画面会暗到自动曝光顶到 GAIN_MAX 也补不回来（深色主题
     * 只剩漫射底光这一项，没有多余的光可借）。 */
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
