/**
 * 天光的 WebGL 渲染器 —— 光是照进**水里**的。
 *
 * ## 它到底在算什么
 *
 * 不是「几个渐变叠一叠」，而是**水下的单次散射积分**：
 * 相机浸在水面之下若干米，沿视线把水切成若干段，每段累加
 * **漫射底光**（整个天空是一个面光源，从水面均匀漏下来），
 * 再乘上两段水的透过率：光从水面走到这一点、光从这一点走到相机。
 * （**直射光柱那一项已经删掉了** —— 理由见 water.frag.glsl 的 waterVolume。）
 *
 * 于是这些现象是**算出来的，不是画出来的**：
 *   - 越往下越冷。水对红光的吸收比蓝绿快一个量级，同一束光在水面附近是暖白的，
 *     走到深处只剩青蓝。
 *   - 抬头只有一个亮窗。Snell 窗的半角 48.6° 是 asin(1/1.333) 算出来的，
 *     窗外水面变成一面镜子（全反射），映的是水里的暗 —— 明暗分界不用画。
 *   - 浅水主题看得见海底。白沙把光弹回来，往下看是亮的 —— 画面因此有了「地平」，
 *     不再是一块无方向的渐变，可读性也有了物理下限。
 *
 * ## 三个关键取舍
 *
 * 1. **主题决定曝光，而介质负责让这件事成立。** 浅色和深色用的是同一组水的光学常数、
 *    同一个太阳，差别只有一个**相机深度**（见 sky.ts）。亮度差于是不是「调出来的」，
 *    是深度本身的物理结果。
 * 2. **闭环自动曝光是最后一道保险，不是主要手段。** 它读内容区的真实像素，把亮度拉回
 *    主题该在的区间（±2 档以内）—— 一旦让它去补几档以上的差距，增益会顶到上限、
 *    整幅画面糊成一片灰。亮度该由美术层的 exposure 摆对。
 * 3. **不是演示，是背景。** 相机几乎不动（指针只带一点点视差），波纹漂得很慢。
 *    这是新标签页，用户是来搜索的，不是来看特效的。
 *
 * ## 性能
 *
 * 水的散射是低频信号 → 低分辨率渲染再让浏览器放大，肉眼分不出来；
 * 目标帧率很低（这片水一分钟才动一点点）；掉帧自动降分辨率；页面不可见就停。
 */

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

/* 着色器现在是独立的 .glsl 文件，用 Vite 的 ?raw 当字符串导进来。
 *
 * 为什么非要从模板字面量里搬出来：GLSL 注释里只要出现一个反引号，模板字符串
 * 就在那里被截断。这个坑在这个文件里踩过两次，而且 node scripts/rebuild.mjs
 * 照样打印「✓ 生产构建完成」，只有 pnpm typecheck 才会报出来 —— 也就是说
 * 构建成功完全不能证明着色器是完整的。抽成文件之后，这个失败模式从根上消失。
 *
 * 分工：
 *   water.*   —— 水体本身，输出**线性 HDR**（不做色调映射，留给泛光）
 *   tonemap.* —— 泛光之后的最终 pass：ACES + sRGB + 抖动
 */

/** 一条亮度带的统计量 */
export interface SkyBand {
  mean: number
  p10: number
  p50: number
  p90: number
}

export interface SkyProbe {
  /** 内容区的平均相对亮度 */
  mean: number
  /** 第 10 百分位。浅色主题盯的是它 —— 画面里最暗的那一小片决定字还读不读得出来 */
  p10: number
  /** 中位数 */
  p50: number
  /** 第 90 百分位；小面积的高光（Snell 窗里的太阳、星）不该主导曝光 */
  p90: number
  /** 第 95 百分位 */
  p95: number
  min: number
  max: number
  /**
   * **正文那一条带子**的统计量（内容区上部的 20%）。
   *
   * 这是浅色主题真正的可读性约束所在。拿整幅画面的分位数去控曝光，等于要求
   * 「画面里最暗的 10% 也得亮过某个下限」—— 那恰恰是「水里必须有一块够暗的地方」
   * 的反面，于是整幅画被锁成一片浅底，再准的光也没有明暗可用。
   * 可正文只贴在**一条带子**上：钟点、日期、问候。别处暗下来不影响任何一个字。
   */
  text: SkyBand
  /** 这一帧实际用的曝光增益（闭环控制器的输出） */
  gain: number
  /** 这一帧的渲染分辨率比例（已被像素预算夹过，就是画面真正的像素密度） */
  scale: number
  /** 自适应控制器手里的目标比例。和 scale 不同时，差值就是像素预算砍掉的部分 */
  scaleTarget: number
  /**
   * **真实性能**：按帧率、提交耗时、GPU 计时。
   *
   * 主信号必须是**交付出去的帧率**（两次真实绘制之间的墙钟间隔），不能用提交耗时：
   * WebGL 的绘制是**异步提交**，CPU 把命令塞进队列就返回了，真实的 GPU 开销根本不在
   * 那段里。只看提交耗时的话，小缓冲上它永远读到「很闲」，分辨率会一路涨到上限并停住
   * —— 那不是性能好的证据，只是尺子坏了。交付帧率会把 GPU 反压算进去：GPU 跟不上时
   * 命令队列积压，rAF 回调被推后，交付帧率就会掉。
   *
   * 另外尽量拿显卡自己的计时（EXT_disjoint_timer_query_webgl2）作旁证，
   * 拿不到时 `gpuMs` 是 null，**不会**拿提交耗时冒充它。
   */
  perf: SkyPerf
  /**
   * FFT 波场的诊断量（初始化时实测一次）。驱动不支持浮点 render target 时为 null。
   *
   * 挂在这里是为了让「这水对不对」有可核对的第一手数字：谱推出来的斜率均方根
   * 和 GPU 回读的实测值应该对得上，对不上就说明归一化或索引约定错了。
   */
  ocean: OceanStats | null
  /**
   * **元素级**的正文背景统计（调用方传了 `getTextRects` 才有，否则 null）。
   *
   * 为什么非要有这一块：`text` 那条带子是**整幅宽度**的，而字只占左边一小块 ——
   * 两者不是一回事。只按整条带定薄膜，就得为左边那几个字在**整幅**上多盖一层雾，
   * 而那份余量其实只该花在有字的地方。
   *
   * p05/p95 而不是 min/max：单像素的极值会被抖动噪声主导，
   * 而审计脚本用的也是 p05（对比度分布的第 5 百分位），两边口径对齐。
   */
  elements: {
    count: number
    /** 每个元素框内背景亮度的 p05（最暗的一档；浅色主题怕它） */
    low: number[]
    /** 每个元素框内背景亮度的 p95（最亮的一档；深色主题怕它） */
    high: number[]
    /** 浅色主题的驱动量：所有元素里**最暗**的那个 p05 */
    worstLow: number
    /** 深色主题的驱动量：所有元素里**最亮**的那个 p95 */
    worstHigh: number
  } | null
}

export interface SkyPerf {
  /** 实际交付的帧率（近 2 秒窗口），这是自适应用的主信号 */
  fps: number
  /** CPU 侧提交耗时 EMA（毫秒）。**不含 GPU 时间**，只用来发现主线程卡顿 */
  submitMs: number
  /**
   * GPU 每帧耗时（毫秒），来自 EXT_disjoint_timer_query_webgl2；
   * 扩展不可用时为 null —— 宁可没有，也不要拿提交耗时冒充
   */
  gpuMs: number | null
  /** 期待的帧间隔（毫秒） */
  budgetMs: number
  /** 上一次自适应分辨率的决定（up / down:fps / down:cpu / hold:band / hold:max） */
  adapt: string
}

/**
 * 一个正文元素在**视口 CSS 像素**里的框。
 *
 * 为什么要由调用方传进来：可读性的判据是「**每个元素自己框内**最不利的那块背景」，
 * 而渲染器不该去查 DOM。SkyBackdrop 有 DOM，它量好框传进来。
 */
export interface SkyTextRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SkyRendererOptions {
  /** 渲染分辨率相对 CSS 像素的比例 */
  renderScale?: number
  /** 目标帧率。天空变化极慢，30 已经绰绰有余 */
  targetFps?: number
  /** 每隔一段时间回报内容区的真实像素亮度 */
  onProbe?: (probe: SkyProbe) => void
  /**
   * 回报「正文元素各自在哪儿」。给了它，探针就会额外量**元素级**的背景统计
   * （见 SkyProbe.elements），闭环也就用元素级的值驱动薄膜 —— 那才是判据本身。
   * 不给就退回整条带的统计量。
   */
  getTextRects?: () => SkyTextRect[]
  /**
   * 闭环自动曝光。默认开。
   *
   * 它是「正文可读」的**主要**保障机制：天空自己不知道字压在上面，
   * 只有回读真实像素、盯住最坏的那一侧，才能保证任何时刻任何主题下正文都够清楚。
   * 关掉只在一种情况下有意义：想量某一片天在固定增益下的原始色相。
   */
  autoExposure?: boolean
  /** 画面可以露出来了（首帧画完、再等一帧 —— 理由见 ready() 的注释） */
  onReady?: () => void
  /** 已经降到最低分辨率还是吃不下，调用方应该切回 CSS 背景 */
  onTooSlow?: () => void
  /**
   * 主题切换时水体参数的过渡时长（毫秒），见 `THEME_BLEND_MS`。0 = 硬切。
   * `prefers-reduced-motion` 的调用方必须传 0。
   */
  themeBlendMs?: number
}

export interface SkyRenderer {
  supported: boolean
  setFrame: (frame: SkyFrame) => void
  setPointer: (nx: number, ny: number) => void
  /**
   * 在画面上投一圈涟漪（clearwater 的 tap-to-ripple）。
   *
   * 参数是**视口归一化坐标**（x 从左、y 从上，0~1）。CPU 侧按着色器同一个
   * rayDir 把这一点打到水面上（求交 t = depth/dir.y），得到世界 xz 后塞进
   * uDrops 环形缓冲。dir.y ≤ 0（看向天空上方）时不落点。
   */
  addDrop: (nx: number, ny: number) => void
  start: () => void
  stop: () => void
  /** 只画一帧（prefers-reduced-motion 用：有画面，但不动） */
  renderOnce: () => void
  dispose: () => void
}

/**
 * 竖直视场角。**这个数不是风格选择，是构图能不能成立的前提。**
 *
 * 画面被地平线切成上下两块，各自占多少只由俯仰角和视场角决定（针孔投影）：
 *
 *   地板占比 = 0.5 − 0.5·tan(pitch)/tan(FOV/2)
 *   光窗占比 = (pitch + FOV/2 − 41.4°) / FOV     ← 41.4° 是全反射的下边界（临界角）
 *
 * 分母 tan(FOV/2) 一小，光窗和地板就在抢同一块画布：角度窄的时候，怎么调俯仰都
 * 拿不到「亮天窗 / 暗水体 / 亮沙地」三段同时在场的剖面 —— 反复在这两个数之间来回挪
 * 却怎么挪都不对，原因就在这里。
 *
 * 超广角本身也是水下摄影的本来面目：贴着水面拍，视场一定是宽的。
 */
const FOV_Y = 92
/** 再压一道总像素上限：超宽屏上不做无谓的填充 */
const MAX_PIXELS = 240 * 1024
/**
 * **水面时钟相对真实时间的倍率。** 1 = 真实速度，越小越舒缓。
 *
 * 按真实速度走是「跳」的：这套波场的峰值波长对应的周期不到一秒 ——
 * 水下贴着水面看当然就是这个速度，但**贴在时钟和搜索框后面当背景，它太快了**，
 * 眼睛会一直被抓过去。
 *
 * 这不是「假造一个慢动作」，而是把时间轴整体放慢 ——
 * 波与波之间的**相对关系完全不变**（色散、聚焦、焦散都是同一套），
 * 只是整体乘了一个系数，所以看上去仍然是「真的水」，只是更从容。
 * 再慢下去会开始显得黏滞、像慢动作回放。
 */
const WATER_TIME_SCALE = 0.45
/** 自动曝光的增益范围。上限留给夜晚，下限留给深色主题的正午。 */
const GAIN_MIN = 0.03
const GAIN_MAX = 4

/**
 * 增益过渡的时间常数（秒）。
 *
 * 闭环每次探测给出的是一个**阶跃**值（单步限幅），切主题时更是要跨一个量级。
 * 把阶跃直接乘进画面，看到的就是「黑一下再跳回来」。
 * 这里让实际使用的增益按这个时间常数**指数逼近**控制器的目标：
 * 稳态时命令值和显示值本来就几乎相等（控制器每 2 秒才动一点点），
 * 所以这段过渡只在阶跃真的发生时才看得见。
 */
const GAIN_EASE_S = 0.2

/**
 * 主题切换时，水体参数的过渡时长（毫秒）。
 *
 * 浅色和深色不是「同一个场景换个颜色」——**是两片水**：深度差一个量级、
 * 曝光差一个量级、俯仰也不一样。这些量在一帧里同时换掉，画面就是一刀切。
 * 这里把这一帧摊成一段：所有参数（深度、曝光、消光、焦散、沙面、俯仰、
 * 天空亮度…）按 smootherstep 插值，两端一阶导为 0，起停都不顿。
 *
 * 时长要比页面入场慢一档：亮度不是参数的线性函数 —— 深度变化时透过率按
 * Beer–Lambert 走指数，参数均匀地走、画面亮度却会在中段一头扎下去。
 * 上一版是 720ms，实测一次帧间跳变就有终值的 85%，读起来是「闪一下」而不是「沉下去」。
 *
 * `prefers-reduced-motion` 时调用方传 0 —— 那种情况下渲染器只画一帧，
 * 过渡会永远停在起点。
 */
export const THEME_BLEND_MS = 1200

/**
 * 开页热机时长（毫秒）。这段时间里的帧是**一次性初始化**的产物 ——
 * 着色器编译、波场回读标定、页面图标取色都挤在这里 —— 不代表稳态性能，
 * 所以既不进 submitMs 的 EMA，也不参与自适应分辨率、不计入帧率窗口。
 *
 * 太短会把开页那几帧的长任务当成稳态瓶颈（分辨率一砍下去要十几秒才爬回来），
 * 太长又会把「开页后的第一眼」拖住。曝光闭环的密集探测照旧跑，不受它影响。
 */
const WARMUP_MS = 1500

/**
 * ACES 拟合曲线的反函数。
 *
 * 闭环必须**在场景空间里做误差**，这是它能不能收敛的关键。
 * 反读回来的分位数是显示后的亮度（ACES + gamma 之后），而增益乘的是 ACES 之前的光。
 * 直接拿显示亮度的比值去乘增益，等于假设这条曲线是线性的 ——
 * 可它偏偏在肩部斜率很低，于是同样的误差每次只能推进一点点，几十次探针都到不了。
 * 换成场景空间，同样的误差一步就走完大半。
 *
 * 拟合式是 x 的二次有理函数，所以反函数就是一个二次方程，不需要迭代：
 *   y(2.43x² + 0.59x + 0.14) = 2.51x² + 0.03x
 *   ⇒ (2.43y − 2.51)x² + (0.59y − 0.03)x + 0.14y = 0
 */
function acesInv(y: number): number {
  const t = Math.min(Math.max(y, 0), 0.999)
  const a = 2.43 * t - 2.51
  const b = 0.59 * t - 0.03
  const c = 0.14 * t
  // a → 0 时退化成一次方程；ACES 的渐近线在 1.033 附近，0.999 还差得远，够用
  if (Math.abs(a) < 1e-6)
    return -c / b
  const d = Math.sqrt(Math.max(b * b - 4 * a * c, 0))
  // a < 0（t < 1.033），正根取 −b − √D 这一支
  return (-b - d) / (2 * a)
}

/**
 * 把两帧的参数按 k（0..1）插值，用于主题过渡。
 *
 * **只有两套主题真的不同的量会动。** 太阳 / 月亮的位置、`scatterNorm`、
 * 水的消光与散射系数都是天文量或常量，两帧里本来就一样，插了也是原地不动。
 *
 * 离散量（`dark` / `phase` / `timeMs`）一律取目标帧的：插值一个布尔值或时刻没有意义。
 *
 * 三类量三种混法，理由都写在下面两个常量旁。
 */
const GEO_KEYS = new Set([
  'exposure',
  'targetLuminance',
  /* 辐射量：它们描述的是「走完某段水程之后还剩多少光」，真实路径是
     Beer–Lambert 的指数衰减（exp(-σ·depth)），透射率正是逐通道的指数。
     在 RGB 上线性插一条指数曲线，中段会系统性偏高、偏灰绿 —— 浅→深和深→浅
     都会经过一段「不是两片水里任何一片」的颜色。逐通道取几何平均，
     等价于把深度轴走成对数尺，中段色相才落在物理路径上。 */
  'scatterTint',
  'skyAbove',
  'beamTint',
  /* 同属「乘性强度」：等比例变化才是视觉匀速，线性插会让暗端变化过快。 */
  'caustic',
  'beamPower',
  'ambPower',
  'surfaceGlow',
])

/**
 * 沙面这个量单独混（`floorDrop` 是「沙在相机下方多少米」，0 表示没有底）。
 * 怎么混、为什么不取两端里的「有沙侧」，见下面 FLOOR_FAR 那段。
 */
const FLOOR_KEYS = new Set(['floorDrop'])

/**
 * 沙面（`floorDrop`）在过渡里的走法。
 *
 * 0 表示**没有底**。不能线性走到 0：那样沙面一边靠近一边变亮、最后一刻凭空消失。
 * 也不能像上一版那样取 max()：浅→深的整段里沙一直停在 1.6m，直到过渡结束那一帧
 * 才归零 —— 实测那一帧画面下半幅亮度直接掉一个台阶（整幅均值单帧变化 46%），
 * 深→浅则在**第一帧**把沙凭空长出来（44%）。两头都是硬切，只是藏在了过渡的两端。
 *
 * 现在的做法：把「没有底」当成一个**很远**的底（FAR），让距离连续地走过去。
 * 沙的亮度本来就按 Beer–Lambert 随水程指数衰减 —— 距离一远，它自己就暗没了；
 * 视线在沙上的终止距离同时连续地拉远，体积积分也从「只走一米多」平滑地接到
 * 「整段水体」。两头都不需要额外的淡出参数，路径本身就是连续的。
 * 光的衰减是指数的，所以这个过渡在前半段变化快、后半段几乎是平的 ——
 * 那正是「沙先暗下去，水深到位」的物理顺序。
 */
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

/** 不支持的渲染器：调用方不用写 if，所有方法都是空操作 */
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

  /* ---- three.js 渲染器 ----
   *
   * 账要先算清楚：换成 three.js **不是**为了换掉水。
   *
   * 水（波谱、体积步进、Snell 窗、Fresnel、焦散）是算出来的，几百行 GLSL。
   * three.js 的 Water2 / Reflector 换不了它 —— 那两个 helper 都**默认相机在水面之上**，
   * 从水下往上看根本没有实现。所以水仍然是我们自己的 shader。
   *
   * 真正买到的是**后处理管线**：EffectComposer + UnrealBloomPass。焦散的高光要溢出到
   * 邻近像素才有「亮」的感觉，单 pass 做不到这一点，而它恰好是这类画面最容易被一眼
   * 看出的差距。附带买到的是尺寸管理、上下文丢失处理、程序缓存这些管道。
   *
   * 代价：three 是这个项目唯一的运行时依赖，新标签页的包会变大。
   */
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
    /* three.js 拿不到上下文时是**抛异常**，不是返回 null。
       而降级路径必须安静：脚本会把 getContext 打成永远返回 null，要求这里老老实实
       退回 CSS 兜底。所以构造本身要包起来 —— 只做特性检测是不够的。 */
    console.warn('[sky] 建不出 WebGL 上下文，走 CSS 降级：', error)
    return nullRenderer()
  }

  // 显式标注：下面的回调里 TS 不会保留对 const 的窄化
  const gl: WebGL2RenderingContext = renderer.getContext() as WebGL2RenderingContext

  /* 颜色管理整条关掉。这条管线里的颜色是**一步一步自己算出来的**：
     线性 HDR → 泛光 → ACES → sRGB。three.js 不需要、也不该再插一手 ——
     它哪怕只做一次 sRGB 转换，曝光闭环用的 acesInv() 就全错位了。 */
  THREE.ColorManagement.enabled = false
  renderer.toneMapping = THREE.NoToneMapping
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  // 分辨率由 render target 控制，canvas 的像素尺寸在 resize() 里定
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 1)

  /* GPU 计时用的是可选扩展，Chrome 出于安全和稳定性考虑时开时关。
     拿不到就让它一直 null —— 交付帧率本身已经是端到端的真实信号，
     gpuMs 只是旁证，不值得为它写一条「猜」的退路。 */
  const disjointTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
    | { TIME_ELAPSED_EXT: number, GPU_DISJOINT_EXT: number }
    | null

  /* 着色器错误检查提前打开：FFT 海面（ocean.ts）自己也会编译三趟全屏 pass，
     那些程序的编译失败同样只能靠它报出来。 */
  renderer.debug.checkShaderErrors = true

  /* FFT 海面。每帧跑若干趟全屏 pass，把随机波场算成一张纹理（见 ocean.ts）。
     必须在 composer.render 之前跑完 —— 主着色器要采样它的结果。
     失败时（驱动不支持浮点 render target）退回一张 1×1 常值纹理：
     斜率为零、焦散为 1，水会变成一潭平静的水，但辐射传输那一层仍然成立。 */
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

  /* 泛光的三个参数。阈值取在 **1.0 之上**：只让真的过曝的部分发光。
     阈值一低就变成整体发糊 —— 那不是辉光，那是没对上焦，也是最容易看出来的
     廉价 HDR。线性 HDR 上的 1.0 大致就是 ACES 曲线的肩部起点。
     强度刻意压得小：这片水里该发光的只有焦散的高光，
     大面积的水体一旦开始泛光，画面立刻失去「水」的质感。 */
  const BLOOM_STRENGTH = 0.38
  const BLOOM_RADIUS = 0.55
  const BLOOM_THRESHOLD = 1.0

  /* uniform 从一个一个有名字的对象管起来。这里的初值只是占位：
     真正的值每帧由 setFrame() 按 `SkyFrame` 填进来。 */
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
    /* σs/σt 的谱形只在 CPU 侧算一次（它只依赖 SCATTER / EXTINCT 两个常量），
       不必每个像素做三次除法和一次点积。 */
    uScatterNorm: { value: new THREE.Vector3(...SCATTER_NORM) },
    uPhaseG: { value: 0.6 },
    uScatterTint: { value: new THREE.Vector3(0.2, 0.5, 0.6) },
    uCaustic: { value: 1 },
    uSurfaceGlow: { value: 0.2 },
    uSkyAbove: { value: new THREE.Vector3(0.5, 0.7, 0.9) },
    uOcean: { value: ocean?.texture ?? flatOcean },
    /* 倒数而不是原值：取样是热点路径，除法在这里预先做掉 */
    uInvPatch: { value: ocean ? 1 / ocean.patch : 1 },
    /* 点击涟漪（clearwater 的 tap-to-ripple，解析波包版，见 water.frag.glsl）。
       环形波有闭式解，不必为它开第二条 FFT 链；这里只维护最多 8 个环的 (xz, 出生时刻, 振幅)。 */
    uDropCount: { value: 0 },
    uDrops: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  }

  /* RawShaderMaterial：着色器本来就是独立的 GLSL ES 3.00 文件，
     不想要 three.js 往里注入的那一堆 chunk（注入进去反而会把
     precision / in / out 声明搞重复）。
     #version 由 three.js 按 glslVersion 自动加在**文件开头**，
     所以 .glsl 文件里不能自己写 —— GLSL 要求 #version 必须是第一行。
     GLSL3 下 three.js 同样不替我们声明属性，water.vert.glsl 里那句
     `in vec3 position;` 因此是必需的。 */
  const waterMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    uniforms: waterUniforms,
    depthTest: false,
    depthWrite: false,
  })

  /* 全屏那一个三角形：几何体是 2×2 的平面，配正交相机后顶点位置
     正好就是裁剪空间坐标，所以顶点着色器几乎什么都不用做。
     frustumCulled 必须关掉 —— 否则 three.js 会拿默认包围盒去剔除它。 */
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waterMaterial)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  /* Composer 的 render target 用 HalfFloatType：线性 HDR 必须能存住
     大于 1.0 的值，8bit 会把高光直接切平，泛光就无从挑起了。
     depth/stencil 都关掉 —— 全程只有全屏四边形，用不上。 */
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
  // 最终 pass 负责 ACES + sRGB + 抖动，见 tonemap.frag.glsl
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: tonemapVert,
    fragmentShader: tonemapFrag,
  }))

  /* 提前把着色器编出来，并**检查它到底编没编过**。
     three.js 编译失败时只是往 console 里打一段日志，然后照常出图 ——
     也就是一块纯黑的画布。用户看到的是「背景瞎了」，而不是降级到 CSS。
     所以这里主动编译一次，把链接失败的程序当成编译失败处理。
     renderer.compile() 顺带把首次渲染的编译卡顿提前到初始化阶段。

     判据用 runnable 而不是「diagnostics 存在」：three.js 的 diagnostics
     在链接成功但 info log 非空时也会挂上（那时 runnable 仍是 true），
     拿它当失败会把一个只是话多的驱动误判成编译不过。
     链接成功且日志干净时 diagnostics 是 **undefined**，所以默认就是通过。 */
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
    // 检查本身出错不代表着色器坏了，只记一笔，继续往下走
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
  /**
   * 曝光增益。**两个变量，分工要分清**（见 GAIN_EASE_S）：
   *   gainTarget —— 闭环控制器（probe）算出来的**目标**值，阶跃式的；
   *   gainShown  —— 真正乘进画面的值，按 GAIN_EASE_S 向目标逼近。
   *
   * 分开是为了两件事同时成立：
   *   1. 「命令」和「实测」始终对齐 —— 控制器每一步都从 **gainShown**（画面上
   *      真正用的那个值，也就是探针量到的那个状态）出发，所以过渡期间不会
   *      把同一份修正重复投入进去；
   *   2. 阶跃变成 ~0.2 秒的连续过渡，切主题不再是「黑一下 + 跳回来」。
   */
  let gainTarget = 1
  let gainShown = 1
  /**
   * 主题过渡的状态。`blendFrom` 非 null 时，渲染用的不是 `frame` 而是
   * `mixFrame(blendFrom, frame, k)`（见 setFrame / renderFrame）。
   */
  let blendFrom: SkyFrame | null = null
  let blendStart = 0
  /**
   * 过渡期间「曝光 × 增益」的乘积：从起点几何地走到终点。
   *
   * 乘积是**场景无关**的量（两个 uniform 都是线性乘子），所以它适合当过渡的骨架；
   * 而终点的乘积不是估出来的 —— 过渡开始的那一帧会**真画一次终点帧再回读像素**，
   * 反解出终点需要的增益（见 measureTargetGain）。上一版用「上一次收敛的乘积」
   * 或「乘积不变」当终点，第一次切到某个主题时终点是错的，过渡结束后的闭环
   * 只能把误差补回来，于是画面先沉到底再浮起来。
   */
  let blendProductFrom = 1
  let blendProductTo = 1
  /** 本次过渡的终点曝光还没量过（见 measureTargetGain） */
  let blendMeasurePending = false
  /**
   * 每个主题最近一次收敛（闭环落在滞回带内）时的「曝光 × 增益」。
   * 只有 `prefers-reduced-motion`（没有过渡、一帧到位）才拿它直接预置增益 ——
   * 正常过渡的终点是量出来的，不靠这个记忆。
   */
  const productMemory = new Map<boolean, number>()
  /**
   * 最近一次**真正用于渲染**的帧。过渡中途又切了一次主题时，新的过渡要从
   * 这里接着走 —— 从当时的 `frame`（目标）走会先把画面拉回去，看着像闪一下。
   */
  let renderedFrame: SkyFrame | null = null

  let raf = 0
  let running = false
  let lastDraw = 0
  let lastAdapt = 0
  /**
   * **水面自己的时钟 —— 比 `elapsed` 慢。**
   *
   * 这个因子只作用于波动（FFT 波场的相位推进 + 着色器里的 `uTime`），
   * **不动**任何别的东西：曝光闭环、探针、指针视差、自适应分辨率都照旧用真实时间。
   * 分开是为了让「水慢下来」这件事只有一个旋钮，而不会顺带把别的时序也拖慢。
   *
   * 为什么不直接改 `uTime` 的乘数而要单独攒一个累加器：`uTime` 同时喂给
   * 水面着色器和 FFT 的演进 pass（`ocean.update`）。波场的形状完全来自 FFT，
   * 着色器采样它的坐标里**没有**时间项（见 water.frag.glsl 的 waveField）——
   * 也就是说两者的相位必须严格一致，各自乘各自的系数会让「波峰」和「焦散」错开，
   * 出现重影。
   */
  let waterTime = 0
  /** uDrops 环形缓冲的写头（addDrop 每投一个环推进一次，超过 8 后覆盖最旧的） */
  let dropHead = 0
  let probeCount = 0
  let probeDue = 0
  let slowStreak = 0
  let firstFrameDone = false
  /** 首帧画完了但还没翻牌（见 ready()），等第二帧再让 canvas 露出来 */
  let pendingReady = false
  let startedAt = 0
  /**
   * 热机截止时刻（首帧时间 + WARMUP_MS）。首帧之前是 Infinity，
   * 也就是「什么时候都不算热机结束」—— 副作用是首帧自己一定不算稳态数据，
   * 这正是要的（见 renderFrame 里 warm 的注释）。
   */
  let warmupUntil = Number.POSITIVE_INFINITY

  /* ---- 真实性能统计 ----
     交付帧率：数窗口内真的画了几帧，除以窗口墙钟长度。别用 1/平均间隔 ——
     窗口里有长间隔时两者会差得离谱，而这里要的正是「这一段时间交付了多少」。 */
  let drawnInWindow = 0
  let windowStart = 0
  let measuredFps = 0
  let submitMs = 0
  /* 刷新间隔与 vsync 计数：节流靠它们跳帧，见 draw() */
  let refreshMs = 0
  let lastRaf = 0
  let rafCount = 0
  /** resize() 算出来的、真正用的渲染比例（已被像素预算夹过） */
  let effectiveScale = scale
  /* GPU 计时：扩展在 Chrome 里时有时无，拿不到就一直是 null */
  const timerExt = disjointTimer
  let gpuQuery: WebGLQuery | null = null
  let gpuQueryPending = false
  let gpuMs: number | null = null
  /** 上一次自适应做了什么决定。分辨率为什么停在那儿，只有这里说得清 */
  let adaptNote = 'init'

  let probePixels = new Uint8Array(0)
  const samples: number[] = []
  /** 正文带的那一份，见 probe 的注释 */
  const textSamples: number[] = []
  /** 单个元素框的那一份（复用同一个数组，逐个框清空重填） */
  const rectSamples: number[] = []

  /**
   * 按 CSS 尺寸 × 自适应比例重设渲染缓冲。
   *
   * **刻意不依赖 `frame`**：预热（见下面 `composer.render(0)` 那一段）要在首帧
   * 之前就把尺寸定下来，好让泛光 / tonemap 的编译发生在真实分辨率上。
   * 帧还没来时调用它只是白算一次尺寸，画不出东西而已。
   */
  function resize() {
    const rect = canvas.getBoundingClientRect()
    const cssW = Math.max(rect.width, 1)
    const cssH = Math.max(rect.height, 1)
    const budget = Math.sqrt(MAX_PIXELS / (cssW * cssH))
    const effective = Math.min(scale, Math.max(budget, minScale))
    /* 真正用的比例要记下来：像素预算会把它压得比 scale 低。
       探针里回报的必须是**这个**数 —— 那个字段就是用来描述「画面有多少像素」的，
       报一个被预算砍掉之前的愿望值等于虚报分辨率。 */
    effectiveScale = effective
    const w = Math.max(2, Math.round(cssW * effective))
    const h = Math.max(2, Math.round(cssH * effective))
    if (canvas.width !== w || canvas.height !== h) {
      /* canvas 的**像素尺寸就是渲染分辨率**（CSS 负责把它拉到满屏）。
         这一点是刻意的，别改成「canvas 满分辨率 + composer 低分辨率」：
         probe() 要 readPixels 整块画布，满分辨率下每次探测都会把 GPU 管线掐停一段
         可观的时间，而低分辨率下回读的数据量要小一个量级。
         另外 canvas 一改尺寸 drawing buffer 就重置，所以必须带 if 守卫。 */
      canvas.width = w
      canvas.height = h
      renderer.setSize(w, h, false)
      composer.setSize(w, h)
      // 着色器里的 uResolution 要和 gl_FragCoord 同一套坐标（渲染分辨率）
      waterUniforms.uResolution.value.set(w, h)
    }
  }

  /**
   * 量一次正文区背后的真实像素亮度。**分成两条带子**：
   *
   *   all  —— 内容区（正文从画面上部一直铺到接近底部，只探一个小矩形必然漏掉）
   *   text —— 只有正文的那一条：钟点、日期、问候。它们没有自己的玻璃底，
   *           直接压在背景上，是唯一真正约束画面的东西。
   *
   * text 这条带子的上下界和 `sky.ts` 的 `cameraPitch` 是一份**契约**：浅色主题的俯仰
   * 决定了 Snell 窗的下缘落在画面哪个高度，正文带必须整条落在窗里。
   * 窗是画面里最平滑最亮的区域 —— 带子不跨过它和镜面的交界，量出来的分位数才不抖。
   * 改俯仰就要一起改这里，否则闭环会开始追噪声。
   *
   * 一次 readPixels 覆盖两条带子，成本不变；整帧本来就没多少像素（渲染分辨率是低的）。
   *
   * 用 p90 而不是 max 当「最亮」：月亮和星点是小面积高光，让它们决定整片天的曝光是错的
   * —— 但它们也不该被无视，所以 max 一并回报出去。
   */
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

    // 必须紧跟在 drawArrays 之后读，否则 drawing buffer 已经被合成器清掉了
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, probePixels)

    // 内容区：CSS 的 y 从上往下 10%~92%，换成 GL 坐标（原点在左下）就是 8%~90%
    const x0 = Math.floor(w * 0.06)
    const x1 = Math.ceil(w * 0.94)
    const y0 = Math.floor(h * 0.08)
    const y1 = Math.ceil(h * 0.90)
    // 正文带：CSS y 10%~28% → GL y 72%~90%
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

    /* ---- 元素级：逐个正文框量背景 ----
       调用方给的是**视口 CSS 像素**的框，这里换成画布像素。
       注意 GL 的原点在左下，所以 y 要翻过来：`cssH - (y + h)` 是框底在 GL 里的位置。 */
    let elements: SkyProbe['elements'] = null
    const rects = options.getTextRects?.() ?? []
    if (rects.length) {
      const cssW = Math.max(canvas.clientWidth, 1)
      const cssH = Math.max(canvas.clientHeight, 1)
      const sx = w / cssW
      const sy = h / cssH
      const low: number[] = []
      const high: number[] = []
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
        /* **试过把这里降到 p02（为了对齐「驱动量在渲染分辨率、判据在 2×」这个口径差），
           量下来是负收益，已回退**：薄膜被推得更重，而最苛刻的那个元素的对比度
           并没有变好（差值在运行间漂移范围内）。原因清楚：多出来的那层雾是
           **整幅宽度**的，而元素自己在薄膜径向渐变的边缘、系数低于满强度，
           所以加雾并不能等比地补到那个元素头上。
           ⇒ 结论：**靠调分位数补不了这个口径差**，该修的是驱动量的模型（见 SkyBackdrop）。 */
        low.push(quantiles(rectSamples, 0.05))
        high.push(quantiles(rectSamples, 0.95))
      }
      if (low.length) {
        elements = {
          count: low.length,
          low,
          high,
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
      // 回报的是「这一帧用的」增益，不是控制器刚算出来的下一个 —— 否则对不上画面
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
    /* **只量不算**：主题过渡开始时用它测一下「终点帧大概需要多少增益」，
       见 measureTargetGain。那时画面上显示的不是这一帧，所以既不能发布探针，
       也不能改增益。 */
    if (measureOnly)
      return stats

    options.onProbe?.(stats)

    if (!autoExposure)
      return stats

    /* 过渡期间不走闭环：过渡的曝光终点由**量出来的终点帧**决定（见 measureTargetGain），
       闭环在这段时间只负责按那条曲线把增益走完。探针照常回报 —— 薄膜和外部诊断要看它。 */
    if (blendFrom)
      return stats

    /**
     * 闭环曝光。**带滞回的区间调节**：低于下限才抬，高于上端才压，带内一律不动。
     *
     * 为什么不是「对齐目标」的双边调节：可读性是一个**不等式**，不是一个等式。
     * 双边调节会一直把整幅画往下拉到刚好等于下限为止，那时画面全在暗部，
     * 一天里的亮度也不再由美术层决定，而是由可读性下限决定。
     *
     * 但「不等式」不等于「只往一边走」：没有回程的控制器就是一台**棘轮**。
     * 统计量本来就会随焦散网漂过而上下起伏；只要某一帧恰好落在下限以下，
     * 增益就往上跳一档，而那之后没有任何机制把它拉回来 —— 逐轮累积的结果是
     * 整幅画被推进 ACES 肩部，纵向的明暗层次全部抹平。
     * 所以上端必须落在**这个统计量真实会走到的范围里**，否则「压」的那条路
     * 永远不会触发，棘轮只是变慢、没有消失。
     *
     * 于是画面的**亮度由美术层的 exposure 决定**，闭环只负责它兜不住的时候（±2 档以内）。
     *
     * 设定值必须取**整幅中位数**，不能取正文带的分位数：正文带整体落在 Snell 窗里，
     * 而窗里那层菲涅耳碎丝是**故意**画出来的，必然把一半像素压得很低。
     * 拿它当设定值等于要求「连碎丝都得是亮的」，而增益是个全局乘数 —— 它抬碎丝
     * 的同时会把窗顶穿过曝，环路于是在追一个美术层根本给不出的数。
     *
     * 教训是：**设定值必须是美术层本来就达得到的量**。整幅中位数由窗 / 倒影 / 沙
     * 三段的占比决定，对碎丝的覆盖率不敏感，管的正是「这幅画整体曝光对不对」——
     * 换时刻、降级、掉帧都会改它，闭环把它拉回来。
     * 可读性则**完全交给薄膜**：拿闭环去保可读性，就是拿整幅画去迁就一排小字。
     *
     * 也曾经用过 `stats.min`，那是个陷阱：画面里只要有一个角落是黑的，控制器就会
     * 要求「每一个像素都够亮」，增益顶到上限、薄膜拉到最大，整幅糊成一片中性灰。
     * 分位数让一小块极值不参与决策。
     *
     * 误差**必须在场景空间里算**（先 ACES 反变换再比），理由见 acesInv 的注释。
     */
    /* **过渡期间闭环停摆，但终点曝光是量出来的。**
       上一版直接在这里 return，画面在 1.2 秒里只带着上一个主题的增益走，
       过渡结束后再靠快档闭环把一个大台阶追回来 —— 实测亮度会先探底再回弹
       （浅→深 0.25 → 0.32），读起来是「沉下去又浮起来」。
       反过来，若让闭环在过渡中途直接纠正，中间态的亮度并不是任何稳定状态，
       又会被拽出凹陷。所以两头都不选：过渡开始的那一帧先**私下量一次终点帧**
       （见 measureTargetGain），把增益的终点定准；过渡期间只按这条终点
       几何地走过去，闭环不参与。 */
    const target = acesInv(frame.targetLuminance)
    const measured = acesInv(stats.p50)
    // 滞回带：下限是曝光目标、上端是「再亮就开始发灰」的那条线。
    // 两个数必须一起动 —— 只降目标不降上端，带子被拉宽，而闭环**在带内一律不动**，
    // 画面会停在新旧目标之间不动，等于没改。
    const hi = acesInv(frame.dark ? 0.34 : 0.56)
    let ratio = 1
    if (measured < target)
      ratio = target / Math.max(measured, 1e-3)
    else if (measured > hi)
      ratio = hi / Math.max(measured, 1e-3)

    /* 落在带子里 = 这一片水的曝光已经收敛。把「曝光 × 增益」记下来：
       `prefers-reduced-motion` 下没有过渡，下一次切主题用它直接预置增益。
       那是**场景无关**的量，所以记的是它而不是增益本身 ——
       夜里和正午的曝光常数差几倍，记增益会记成一个只能当次用的数。 */
    if (ratio === 1)
      productMemory.set(frame.dark, gainShown * frame.exposure)
    /* 收敛节奏：先密后疏。
       **开新标签页后的头一两秒就是第一眼**，所以头几次探测一步走大步；
       之后放慢到只压波纹漂过带来的小抖动，否则整片水会跟着呼吸。 */
    const rate = probeCount === 0 ? 1.0 : probeCount < 3 ? 0.7 : probeCount < 6 ? 0.45 : 0.14
    /* 单步限幅（clamp 的两个边界）必须收得够紧：一次读错的探测不该能一步把画面
       推亮一大截，而且还是不可逆的 —— 波动是暂时的，增益是永久的。
       实测过一次坏读数造成的后果：第一帧水面因为初相同步叠加而掀斜，顶部翻进镜面
       成了暗斑，一次探测就把增益顶到上限并停在那里。宁可让收敛多花一两次探测。 */
    /* 从 **gainShown**（这一帧真正用的值，也就是刚刚量到的那个状态）出发，
       而不是从 gainTarget —— 过渡期间两者不同步，从目标出发等于把同一份
       修正重复算一遍。稳态下两者相等。 */
    gainTarget = clamp(gainShown * clamp(ratio ** rate, 0.60, 1.45), GAIN_MIN, GAIN_MAX)
    probeCount++
    return stats
  }

  /** 把一帧的全部 uniform 写进去（uTime 用当前水面时钟，uGain 用 gainShown）。 */
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

  /**
   * 量一次「终点主题」需要的曝光，写进过渡终点的乘积（blendProductTo）。
   *
   * 为什么非量不可：两片水的曝光差接近一个量级，而它没有解析式 ——
   * 介质、俯仰、窗占比一起变。上一版拿「这个主题上次收敛的乘积」当终点，
   * 第一次切到某主题时没有记忆，只能让乘积保持不变，于是过渡结束时曝光还差几倍，
   * 画面在过渡之后还要补一段亮度（先沉到底再浮起来）。
   *
   * 做法：在过渡的**第一帧**，趁这一帧还没提交给合成器，先用终点帧的参数
   * 画一次、回读像素、按 `gain' = gain · acesInv(目标亮度) / acesInv(实measure)` 反解。
   * 这个式子在场景空间里是精确的（ACES 反函数之后增益是纯乘子）；
   * 泛光阈值带来的那点非线性由过渡结束后的闭环收尾。
   *
   * 代价：每次切主题多一趟渲染 + 一次 readPixels。切主题是低频事件，
   * 而且渲染分辨率本来就只有屏幕的百分之几十，这个一次性开销换掉的是一段被所有人
   * 一眼看到的「回弹」。这一趟的耗时也不计入性能统计（见下面重置 startedAt）。
   */
  function measureTargetGain() {
    const target = frame
    blendMeasurePending = false
    if (!target)
      return
    const want = acesInv(target.targetLuminance)
    let guess = gainShown
    /* 迭代两次：从「增益 → 显示亮度」不是纯线性的 —— 泛光阈值和自适应分辨率
       都会掺一手，一次线性反解会偏。第二次用第一次的结果再量一遍，
       残差就落在泛光那点非线性里，过渡结束之后不需要再补一段。 */
    for (let i = 0; i < 2; i++) {
      applyUniforms(target)
      waterUniforms.uGain.value = guess
      composer.render(0)
      startedAt = performance.now()
      const measuredStats = probe(true)
      if (!measuredStats) {
        blendProductTo = guess * Math.max(target.exposure, 1e-6)
        return
      }
      const measured = acesInv(measuredStats.p50)
      const next = clamp(guess * (want / Math.max(measured, 1e-3)), GAIN_MIN, GAIN_MAX)
      const done = Math.abs(next / guess - 1) < 0.02
      guess = next
      if (done)
        break
    }
    blendProductTo = guess * Math.max(target.exposure, 1e-6)
  }

  function renderFrame(now: number, dt: number) {
    if (!frame)
      return

    waterTime += dt * WATER_TIME_SCALE

    // 指针视差：极端克制，只够让天空「有厚度」
    pointerSmoothX += (pointerX - pointerSmoothX) * 0.045
    pointerSmoothY += (pointerY - pointerSmoothY) * 0.045
    yaw += (targetYaw - yaw) * 0.02
    pitch += (targetPitch - pitch) * 0.02

    resize()

    /* ---- 主题过渡 ----
     * 不在过渡里时就是 `frame` 本身。在过渡里用插值帧渲染。
     * 闭环在过渡期间停摆（见 probe），终点曝光另由 measureTargetGain 量出。 */
    let f = frame
    /** 过渡的缓动进度（0..1）；不在过渡里是 1 */
    let blendEase = 1
    if (blendFrom) {
      const k = clamp((now - blendStart) / themeBlendMs, 0, 1)
      if (k >= 1) {
        blendFrom = null
        /* 过渡刚结束：立刻探一次把泛光非线性带来的小残差收掉。
           收敛节奏用中档 —— 终点是量出来的，剩下的差只该是一两次小修正；
           重置成「第一眼」的快档反而会把一点残差放大成可见回弹。 */
        probeDue = 0
        probeCount = 2
      }
      else {
        // smootherstep：两端一阶导为 0，起停不顿
        blendEase = k * k * k * (k * (k * 6 - 15) + 10)
        f = mixFrame(blendFrom, frame, blendEase)
        /* 过渡期间相机也由插值帧驱动。否则那两行缓慢的平滑插值会比过渡本身
           还慢，把「平滑」拖成「迟钝」。 */
        yaw = f.cameraAzimuth
        pitch = f.cameraPitch
      }
    }
    renderedFrame = f

    // 本次过渡的终点曝光还没量：趁这一帧还没提交，先私下画一次终点帧
    if (blendFrom && blendMeasurePending)
      measureTargetGain()

    /* ---- 增益 ----
     * 过渡期间：「曝光 × 增益」的乘积几何地走完这一段，再由它反解增益。
     * 乘积是场景无关的量，它的终点是**量出来的**（见 measureTargetGain），
     * 所以过渡结束时就落在正确曝光上，不需要事后补一段。
     * 不在过渡里：向控制器的目标值指数逼近（见 GAIN_EASE_S）。
     * `dt === 0`（首帧、renderOnce、标签页刚恢复）时直接到位 ——
     * 那种情况下没有「过渡」可言，硬要点亮一个中间值反而多一帧错的画面。 */
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

    // uResolution 在 resize() 里设：只有画布尺寸真的变了才需要动它
    applyUniforms(f)

    /* FFT 海面要先算完，主着色器才采得到这一帧的水面。
       它自带 renderer.setRenderTarget(null)，所以不会影响下面 composer 的画布绑定。 */
    ocean?.update(waterTime)

    /* 一趟 composer.render() 跑完三段：
       水体（线性 HDR）→ 泛光 → ACES + sRGB。
       曝光仍然乘在水体那一段，所以泛光阈值会跟着自动曝光一起动 ——
       夜里增益拉高时会有更多东西开始发光，这在物理上是对的。 */
    composer.render(dt)

    const cost = performance.now() - startedAt

    /* **热机期不喂任何性能统计。**
     *
     * 开页后的头一两秒里挤着一次性工作：水体着色器与 FFT 程序的编译链接、
     * 波场标定的阻塞回读、页面自己那批图标的取色。那几帧的 submitMs 极长、
     * 窗口帧率只有个位数 —— 它们描述的是「启动」，不是「稳态」。
     *
     * 拿它们做自适应决策的代价是实测过的：首帧会被当成 CPU 瓶颈直接砍一档分辨率，
     * 接着开页窗口的帧率又被当成 GPU 瓶颈再砍一档，之后每过一个调整周期才爬回一点，
     * 要十几秒才回到像素预算上限 —— 也就是「刚打开的那十几秒，水一直不是它该有的
     * 清晰度」，而且分辨率一旦砍下去没有任何机制能立刻拉回来。
     * 慢的那几帧本来就是一次性的。
     *
     * 所以热机结束之前：不记 submitMs、不累计帧率窗口、也不触发自适应
     * （lastAdapt 跟着 now 走）。热机一结束就是一段干净的新窗口，
     * 第一次决策看到的是真实的稳态。 */
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
      /* 交付帧率：累计窗口内真实绘制的帧数。
         第一个 draw 之后才开始计时，否则开页那一帧的长耗时会被算成「帧率极低」。 */
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

    /* GPU 计时：查询必须延迟一帧读，同一帧读会拿到未完成的结果。
       拿不到扩展就保持 null —— 不猜。 */
    if (timerExt) {
      if (gpuQueryPending && gpuQuery) {
        const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT)
        const done = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE)
        if (done) {
          if (!disjoint) {
            const ns = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT) as number
            /* 软件光栅化（headless 的 SwiftShader）会拿得到扩展但**恒返回 0**。
               那是一个看着很漂亮的假数，宁可不报。
               判据不能写成 `ns > 0`：实测这套代码在 SwiftShader 上**大部分帧返回 0、
               偶尔返回一个 0 附近的伪值**，于是「连续两次为 0 才置空」会漏掉第一帧，
               日志里就混进 0.00 —— 一个 627×392 的光线步进不可能只花 0 毫秒，
               那不是「很快」，那是没测到。所以门槛按**物理下限**取：
               一次正经的 GPU 框至少得有几十微秒，低于 0.05ms 一律当没测到，
               立刻回到 null（不留 streak 窗口）。 */
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

    /* 自适应分辨率：掉帧就降，富余就升。每 2 秒最多动一次，避免来回抖。
     *
     * **主信号是交付帧率，不是提交耗时。** 提交耗时（submitMs）只cover 了 CPU 把命令
     * 塞进 GL 队列的时间，GPU 那边慢不慢它一点都不知道；而交付帧率会把 GPU 反压算进来。
     * 两者都要看，但分工不同：
     *   - 交付帧率低于目标 → 这台机器交付不出来，降分辨率（降分辨率同时减轻 CPU 和 GPU）；
     *   - 交付帧率达标但提交耗时超预算 → 主线程被别的东西占着，降分辨率也有帮助；
     *   - 都富余才升。
     * 原来只看提交耗时，在小缓冲上它恒等于「闲」，于是分辨率一路涨到上限 —— 尺子坏了，
     * 读数再好看也不算证据。 */
    if (now - lastAdapt > 2000) {
      lastAdapt = now
      const budgetMs = 1000 / targetFps
      // 交付帧率要留 15% 的宽容：窗口边界和 rAF 抖动会让它天然略低于目标
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
        // 已经降到最低分辨率还是交付不出来 —— 这台机器吃不下这片天，交给 CSS 兜底
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

    /* 亮度探针：刚打开时密一点，让曝光几帧内就收敛；之后降频。
       密集段要盖满上面的收敛表（前 6 次），否则第 5、6 次会掉到 2s 一档，收敛尾巴拖到 5s 之后。 */
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

    /* 节流要**按显示器的刷新节奏跳帧，不能拿墙钟间隔去比**。
     *
     * 曾经用的是「本次与上次绘制的墙钟差是否小于目标帧间隔」，而 rAF 的间隔是跟着
     * 刷新率走的。于是出现一个很隐蔽的半速 bug：刷新率一旦接近或低于目标帧率，
     * 每次回调都**差一点点不够**，于是一律跳过、下一次才画 —— 交付帧率正好是
     * 显示器帧率的一半。60Hz 上不会暴露，只在低刷新率（包括 headless 的软件光栅化）
     * 时才现形。
     *
     * 现在的做法是量出刷新间隔，算出「每几个 vsync 画一帧」，按回调计数跳。
     * 这样交付帧率永远是刷新率能支持的最好值，而不是被一个固定阈值腰斩。 */
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

  /**
   * 通知调用方「画面可以露出来了」（SkyBackdrop 收到就把 canvas 淡入）。
   *
   * **刻意晚一帧。** 第一帧是整条管线第一次真正跑起来：驱动内部状态、纹理上传、
   * 以及紧随其后的 `gl.readPixels`（探针）同步 —— 后者本身就是一次昂贵的阻塞，
   * 冷启动更贵。而淡入是从 `onReady` 那一刻开始的：按第一帧翻牌的话，
   * 这段开销正好落在「水刚出现」的瞬间，看起来就是开页那一下顿。
   * 让它先花在还全透明的那一帧上，第二帧才开始淡入：
   * 用户看到的第一眼水就已经是稳的。
   */
  function ready() {
    if (!pendingReady)
      return
    pendingReady = false
    options.onReady?.()
  }

  canvas.addEventListener('webglcontextlost', handleContextLost)

  /* ---- 预热：把泛光 / tonemap 的程序也提前编掉 ----
   *
   * `renderer.compile(quadScene, quadCamera)` 只编**场景里的材质**，也就是水体那一个。
   * 而 EffectComposer 的几个 pass —— 水体、UnrealBloom（它自己有好几个 program）、
   * 最终 tonemap —— 是在**首帧 `composer.render()` 里才逐个编译**的。
   *
   * 那一次提交是一段很长的阻塞，而它正好落在 canvas 淡入的那一刻
   * （`painted` 就是在这帧之后翻的）—— 用户看到的就是「水刚出现就很卡，
   * 过一会儿才好」。
   *
   * 所以这里先空跑一趟完整管线，把编译挪到「画面还全透明」的时候：
   * canvas 的 opacity 是 0（要等 `painted`），尺寸也已经按真实视口定好。
   * 此时还没有 SkyFrame，但预热要的只是尺寸与程序，不需要天文参数 ——
   * 着色器里那些 uniform 保持初值即可。
   */
  resize()
  composer.render(0)

  function setFrame(next: SkyFrame) {
    const first = !frame
    /* 主题切换 = **换了一片水**：两套主题的深度差一个量级，连曝光常数都差一个量级。
       而 `gain` 是**有状态**的，切换后它仍然是上一个主题收敛出来的值 ——
       实测的后果很极端：切过去之后整幅几乎全黑（或整幅过曝发白）。
       有过渡时，过渡的第一帧会**量一次终点帧的曝光**，整段过渡按量出来的终点
       几何地走过去（见 measureTargetGain）；没有过渡（reduced-motion）时
       只能解析预置（见下面 productMemory / 曝光比）。 */
    const prev = frame
    const themeChanged = prev !== null && prev.dark !== next.dark
    frame = next
    targetYaw = next.cameraAzimuth
    targetPitch = next.cameraPitch
    if (first || themeChanged) {
      /* 首帧与主题切换都把相机**直接放到位**。
         这两件事都是「换了一片水」，不是指针漂移；而 pitch 的插值很慢
         （两档的俯仰又差得多），慢慢摇过去会让曝光闭环
         在**还没到位的构图**上量亮度。 */
      yaw = targetYaw
      pitch = targetPitch
    }
    if (themeChanged && prev) {
      probeCount = 0
      probeDue = 0
      /* 参数过渡：把「一次换掉」摊成 THEME_BLEND_MS 一段（见 mixFrame）。
         起点取 renderedFrame（上次真正画出来的那一帧），连续快切才不会跳。 */
      if (themeBlendMs > 0) {
        blendFrom = renderedFrame ?? prev
        blendStart = performance.now()
        blendProductFrom = gainShown * Math.max(blendFrom.exposure, 1e-6)
        // 这个初值只用来占位：本次过渡的第一帧会量出真正的终点（见 measureTargetGain）
        blendProductTo = blendProductFrom
        blendMeasurePending = true
      }
      else {
        /* 没有过渡（prefers-reduced-motion）：画面一帧就到终点，没有「等它暗下去」
           这件事，只能解析预置。优先用这个主题上次收敛的「曝光 × 增益」
           （场景无关的量）；没有记忆就按曝光比补一半。 */
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
      /* 和着色器的 rayDir 同一套几何（见 water.frag.glsl）：
         uv 以半高归一，先转俯仰再转方位。屏幕点 (nx, ny∈从上数) 换成
         GL 坐标（原点在左下）就是 fragCoord = (nx·w, (1−ny)·h)。 */
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
      // rotateX(-pitch)
      const cp = Math.cos(-pitch)
      const sp = Math.sin(-pitch)
      const y1 = cp * dy - sp * dz
      const z1 = sp * dy + cp * dz
      dy = y1
      dz = z1
      // rotateY(yaw)
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
      /* 涟漪落在水面（y = 0）上的哪一点：
       *   - 视线朝上（dy > 0）：直接和水面求交，t = depth/dy；
       *   - 视线朝下（dy < 0）：它在几何上打不到水面，但「点沙底」这件事照样该有水花。
       *     扰动从深处传上去，水面上「正对着那个沙点」的位置起环。
       *
       *     注意这里的 xz 不是沙点本身的 xz，而要**沿光的来向退回去**：
       *     沙上某点的焦散来自水面上游的那一点（seaFloor 里那个偏移），
       *     所以要让环出现在手指底下，落点得放在那个上游点上。少了这一步，
       *     环会整块被光路推偏几米，甚至跑出取景框 —— 沙区就几乎没有响应。
       */
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
        const sy = -frame.depth + dy * t // 沙面交点的 y（负值）
        const beamY = Math.min(frame.beamDir[1], -1e-3)
        const beamLen = sy / beamY // > 0：光从水面走到沙点那一段
        px = dx * t - frame.beamDir[0] * beamLen
        pz = dz * t - frame.beamDir[2] * beamLen
      }
      else {
        return
      }
      // 超出波场平铺尺度太远的点，涟漪在着色器里也会被距离淡出，直接丢
      if (Math.hypot(px, pz) > 40)
        return
      const slot = dropHead % 8
      dropHead++
      const v = (waterUniforms.uDrops.value as THREE.Vector4[])[slot]
      /* w 是**相对振幅**（1 = 标准强度）：环的绝对尺度是着色器里的 DROP_AMP ——
         它是「画面尺度」的事，和点击位置无关，留在 GLSL 里只用改一处。 */
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
      /* **没有 rAF 时，闭环的修正永远落不到画面上。**
         这条路径（prefers-reduced-motion）只画一帧：探针在第一帧量完之后
         把 gainTarget 改了，但没有下一帧去用它 —— 切主题时那一帧就会一直错着，
         直到窗口尺寸变化之类的偶然事件再触发一次 renderOnce。
         所以这里检查一下：如果刚量出来的目标与画面上的增益差得多，就再画一帧。 */
      if (Math.abs(gainTarget / Math.max(gainShown, 1e-6) - 1) > 0.05)
        renderFrame(performance.now(), 0)
      /* 只画一帧（prefers-reduced-motion）时没有第二帧，这里补上那次翻牌，
         否则 canvas 会一直停在 opacity:0。 */
      ready()
    },
    dispose() {
      running = false
      if (raf)
        cancelAnimationFrame(raf)
      raf = 0
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      /* 交给 three.js 回收：program、render target、几何体、材质它自己都记着账。
         手动 deleteProgram 反而会和它的程序缓存对不上（缓存里仍留着那条记录，
         万一这个 canvas 又被复用就会拿到一个已删除的 program）。 */
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

/** 高度角 / 方位角 → 世界坐标方向向量（X = 东，Y = 天顶，Z = 北） */
/** 从高度角 / 方位角（弧度）取单位方向向量，喂给着色器里的 uSunDir / uMoonDir。 */
function dirVector(elevation: number, azimuth: number): [number, number, number] {
  const cosEl = Math.cos(elevation)
  return [cosEl * Math.sin(azimuth), Math.sin(elevation), cosEl * Math.cos(azimuth)]
}

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x
}

/** sRGB 通道值 → 线性亮度分量 */
function linearize(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
