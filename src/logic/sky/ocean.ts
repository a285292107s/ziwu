/**
 * FFT 海面 —— 把「水面」从 11 个固定平面波的叠加，换成一个**真正的随机波场**。
 *
 * ## 为什么要换
 *
 * 旧波场是 11 个手写正弦项的和，有两个治不好的病：
 *
 *   - 11 个方向固定的平面波互相干涉，出来的是一层**平行条纹**，不是海面。
 *   - 焦散是用一个 lognormal 噪声场单独造的，和波场没有任何导数关系，
 *     于是光柱的形状跟水面形状对不上 —— 看起来就是一团一团模糊的亮斑。
 *
 * 换成 FFT 之后，波高、斜率、拉普拉斯**是同一个场的精确导数**，
 * 焦散从拉普拉斯直接算出来，光柱的形状和水面的形状天然一致。
 * 热点路径也从「11 项三角函数求和 × 每个像素」变成「一次纹理取样」，
 * 成本与屏幕分辨率无关。
 *
 * ## 管线（每帧 16 趟，全部 128²）
 *
 *   spectrum(CPU, 一次性) → evolve → FFT×14 → resolve → 一张 RGBA16F
 *
 * **一条链就够。** 蝶形一趟同时变换两路复数，而「一个复数组的逆变换」的
 * 实部/虚部就是它实部/虚部数组各自的逆变换，于是挑两个复数谱就能装下四个实场
 * （推导见 ocean-evolve.frag.glsl）。这比「四个场开两条链」少一半的趟数。
 * 其中第四个实场（原来装粗带拉普拉斯）现在**空着**：粗带焦散随直射光柱一起删掉了，
 * 但 FFT 的打包天然是两路复数，这一趟省不下来，所以那一格留着不用。
 *
 * 这一套索引与打包约定在 CPU 上逐项验算过（与朴素逆 DFT 最大误差 4.6e-15），
 * 不是照抄：`uSign=+1`、输入位反转、输出自然序，三者必须同时成立。
 *
 * ## 谱的形状与归一是**算出来的**，不是猜的
 *
 * 谱形沿用 clearwater（Aureliengmz，MIT）那一支：主峰 + 涌浪 + 尾巴三个
 * lognormal 项叠在 k⁻⁴ 上，方向性用 |k̂·ŵ|² 加一点顺风/逆风不对称。
 * 它比教科书 Phillips 的单峰更接近真实海面 —— 粗细尺度都有能量，
 * 所以既不是一层规则条纹，也不会只剩一层大浪。
 *
 * 绝对幅度没有物理意义（那些系数都是拟合量），真正决定外观的是**斜率均方根**：
 * 它决定 Snell 窗里镜面/直射的比例。所以先在 CPU 侧把谱的方差和算准，
 * 再整体缩放到 `TARGET_SLOPE`。
 *
 * 焦散的均值则没有解析式（`1/|J|` 在 J=0 处发散，只有夹住下限才可积），
 * 所以初始化时真的跑一遍、用 readPixels 把真实数据读回来算均值，再回填成增益。
 * 同一个回读还顺便量出**实际**的斜率均方根，用来核对归一化到底做对没有。
 */

import * as THREE from 'three'
import oceanEvolveFrag from './ocean-evolve.frag.glsl?raw'
import oceanFftFrag from './ocean-fft.frag.glsl?raw'
import oceanResolveFrag from './ocean-resolve.frag.glsl?raw'
import waterVert from './water.vert.glsl?raw'

const TAU = Math.PI * 2

/* 网格 256²、物理边长 6m ⇒ 格距 0.023m，能表达的最短波 0.047m。
 * （clearwater 用 L = 4.6，但那是水上俯视浅池的取景；理由见下面 K_PEAK 的注释。）
 *
 * **试过 128²（water28），又退回来了 —— 理由值得留着。**
 * 当时的论证是「谱已经被 K_CUT 截在 0.18m 波长上，128 网格的 Nyquist 是 0.094m，
 * 还有两倍余量，所以画面不变，而 18 趟全屏 pass 的像素数能降到 1/4」。
 * 那个论证漏了一件更要紧的事：**换网格不是重采样，是换了一整片海**。
 * 谱是在 n×n 的 k 格点上生成的，n 一变，每个 k 拿到的随机相位就全变了 ——
 * 统计量几乎不变（expectHeight 差 2e-5、slopeRms 差 0.2%），但**具体的波场
 * 是另一个实现**。确定性单帧对照（同分辨率、同曝光、藏掉薄膜）量到的是
 * 整幅 12~17 级的差（p99 63~78），集中在有结构的那条带里 ——
 * 也就是「看得见」。既然看得见，就不该算在这一轮「只删不可见的」账上。 */
const GRID = 256
const BITS = 8
const PATCH = 6

/* 谱形（波数单位 rad/m）。三个 lognormal 项叠在 k⁻⁴ 上：
   bump 是主峰，swell 是更宽的涌浪，tail 把高频接上。
 *
 * **这里的波长比参考项目大一档，是刻意的。**
 * 参考项目是「站在岸上看浅水」：水面就在眼前几米，0.62m 的涟漪在屏幕上很大，
 * 而且焦散是投在**海底平面**上直接看的。我们是「人在水下抬头看」：
 * Snell 窗只看得到头顶 1.3m 见方的一小块水面，光柱又是沿视线积分的 ——
 * 同样的 0.62m 主峰在这里会变成一层**细密的霜**，而不是一张能读出来的网。
 *
 * 决定「网眼多大」的是**拉普拉斯的频带**：k⁴P 在 k⁻⁴ 谱下几乎是**平的**，
 * 所以拉普拉斯方差是沿着 log k 均匀摊开的 —— 只要 K_CUT 放在网格 Nyquist 附近，
 * 焦散就会吃到网格尺度的能量，零等值线密成一团乱麻，看起来就是噪点。
 * 把 K_CUT 从 0.045m 抬到 0.45m（Nyquist 是 0.0625m，留了 7 倍余量），
 * 拉普拉斯就只剩 [0.45m, 3.2m] 这一档 —— 焦散的零等值线变成**大网格的连线**，
 * 这才是参考画面里那种「细亮线围出大块暗格」的样子。
 *
 * 这一条是照着参考项目的**画面**校的（docs/review/sky17/REF-clearwater.png，
 * 本地渲染出来的），不是照它的参数抄的 —— 两者的相机与几何完全不同，
 * 参数能抄、尺度不能抄。 */
const K_PEAK = TAU / 0.7
const K_CUT = TAU / 0.18
const K_SWELL = TAU / 1.8
const WIND_DIR = [0.8, 0.6]

/**
 * 总斜率均方根（两轴合起来，弧度）。决定 Snell 窗里镜面/直射的比例。
 *
 * 0.12 → 0.095。clearwater 用的是 0.078，但它的水面是**直接看**的（相机在水上俯视浅池），
 * 我们是透过 Snell 窗看，窗把 ±σ 的抖动映射成 ±n²σ 的视角摆动（压缩 1.9 倍），
 * 所以同样 σ 在窗里更「静」。取 0.095 是两者之间：窗里的碎银收拢一些，
 * 正文带（入射角 38.3°、离临界角只有 10.3° 余量）被翻到镜面侧的像素也少一些。
 * 多倍频取样（water.frag.glsl 的 waveField）会再补回细节，总粗糙度不会掉太多。
 */
const TARGET_SLOPE = 0.095

/** λ·σ_lap 的目标值：决定「亮暗比」，也就是焦散有多稀疏。 */
const CAUSTIC_K = 1

/* 焦散的**色散**（亮线两侧红青分离）一度放在取样端做（water.frag.glsl 的
   dispCaustic），water28 连同它一起删掉了：它要给 R/B 各多一次偏移取样，
   而 0.34 渲染比例 + mipmap 之后那圈彩边本来就落在像素以下。
   生成端这边从来不做色散 —— 逐通道焦散要三倍带宽，而这张纹理只有四个通道。 */

/* **粗带（带限）焦散已随直射光柱一起删除（water28）。**
 *
 * 它原本是同一份谱乘一个低频窗 W(k) = exp(−|k|²/kc²)，把焦散胞元从 0.18~1.8m
 * 拉到 1.5~6m，好让它在体积步进的有效积分长度（SCAT_LEN = 3m）里活下来 ——
 * 服务的唯一对象是丁达尔光柱，而光柱已经按用户要求删掉了。
 * 删掉之后：谱只算一份拉普拉斯、resolve 少一路焦散、初始化少一套回读标定，
 * 着色器侧则省掉每像素 18 次纹理取样（见 water.frag.glsl 的 waterVolume）。 */

/** 焦散上限（乘完增益之后）。 */
const CAUSTIC_MAX = 6

/** 波场诊断量。既是归一化的自证，也是「这水对不对」的第一手证据。 */
export interface OceanStats {
  grid: number
  patch: number
  passes: number
  /** 谱推出的预期总斜率均方根 */
  expectSlope: number
  /** 谱推出的预期波高均方根（米），用来和 GPU 回读对照 */
  expectHeight: number
  /** 谱推出的预期拉普拉斯均方根，用来和 GPU 回读对照 */
  expectLap: number
  /** 从 GPU 回读的真实斜率均方根（每轴） */
  slopeRmsX: number
  slopeRmsZ: number
  slopeRms: number
  lapRms: number
  lambdaFine: number
  causticMean: number
  causticP99: number
  causticMax: number
  /** 回读诊断：演化输出（FFT 的输入）四个通道的均方根 */
  inputRms: number[]
  /** 回读诊断：蝶形输出（已归一化）四个通道的均方根，顺序同纹理 (sx, 空置, lap, sz) */
  fieldRms: number[]
}

/** 可用的 FFT 波场。`texture` 的 R 空置 / G = ∂h∂x / B = ∂h∂z / A = 全带焦散。 */
export interface OceanField {
  texture: THREE.Texture
  patch: number
  stats: OceanStats
  update: (time: number) => void
  dispose: () => void
}

/** 确定性伪随机：同一份谱每次刷新都一样，方便逐轮对比截图。 */
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

/* 生成频域谱。自然序存放（0…n/2-1 是正频、n/2…n-1 是负频），
   位反转留给 evolve 那一趟 —— 这样这里每个求和都对着清晰的 k，
   归一化对不对可以逐项验算。 */
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

  // 第一遍：未归一化的谱 P(k)，顺手把三个方差和累出来
  const pk = new Float64Array(n * n)
  let sumH = 0
  let sumS = 0
  let sumL = 0
  for (let j = 0; j < n; j++) {
    const kz = (TAU * kOf(j)) / PATCH
    for (let i = 0; i < n; i++) {
      const idx = j * n + i
      /* Nyquist 格（下标 = n/2）是它自己的镜像。实函数在那里必须只有实谱值，
         否则 i·k·H 在那一格不再 Hermitian，导数场会带出虚部、反过来污染波高。
         物理上 Nyquist 对应「隔一格一正一负」的锯齿，本来也不该有能量。 */
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
      // 方向性：|k̂·ŵ|² 决定能量沿风向集中多少；逆风一侧再压一档
      const c = (kx * WIND_DIR[0] + kz * WIND_DIR[1]) / k
      const spread = (0.3 + 0.7 * c * c) * (c < 0 ? 0.35 : 1)
      const p = ((bump + tail + swell) * spread) / (k2 * k2)
      pk[idx] = p
      sumH += p
      sumS += k2 * p
      sumL += k2 * k2 * p
    }
  }

  /* 归一化。h(k,t) = h0(k)e^{iωt} + conj(h0(-k))e^{-iωt} 里同时出现 h0(k) 与 h0(-k)，
     所以 Var(H(k)) = Pk + P(-k) = 2Pk（谱关于 k 对称）。
     sumS = Σ|k|²P 是**两轴合起来**的总斜率方差源，所以归一化目标是
     总斜率均方根 = TARGET_SLOPE（每轴约 TARGET/√2）。

     **那个 N² 不能漏。** 蝶形是未归一化的逆变换 X[j] = Σ_k H[k]e^{ikx}，
     真正写进纹理的场还要除 N²，于是方差里带着 1/N⁴：
       Var(∂x h) = (2·scale²/N⁴)·Σkx²P
     漏掉它整片水面会缩成 1/65536，实测到的就是「斜率 rms 2e-5」这种几乎为零的场。
     这一条在 CPU 上用已验证的 FFT 跑过：补上 N² 之后总斜率 rms = 0.1209（目标 0.12），
     波高 rms 0.0199m、拉普拉斯 rms 1.343 —— 与解析预期都在 1% 内。 */
  const scale = (TARGET_SLOPE * GRID * GRID) / Math.sqrt(2 * sumS)
  // 同一条 1/N² 也作用在派生量上：这两行和 scale 一起构成「解析预期」，
  // 用来和 GPU 回读的实测值对照（对不上就说明索引约定或打包错了）
  const expectHeight = TARGET_SLOPE * Math.sqrt(sumH / sumS)
  const expectLap = TARGET_SLOPE * Math.sqrt(sumL / sumS)

  /* 第二遍：抽 h0(k) 存 RG，镜像格子的共轭存 BA。
     注意 BA 存的是 **conj(h0(-k))**（虚部取反），这正是 Tessendorf 演化式
     需要的那个量；存成 h0(-k) 会让波形相位整体镜像，光柱会从错误的一侧斜过来。 */
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
    // λ 反算：让 λ·σ_lap 正好等于目标值，换风速外观也不漂
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

/**
 * 建 FFT 波场。返回 null 表示当前驱动不支持浮点颜色缓冲 —— 调用方应当
 * 退到一张 1×1 的常值纹理（斜率为零、焦散为 1），水会变成一潭平静的水，
 * 但辐射传输那一层仍然成立，画面不会瞎。
 *
 * @param renderer 已经建好的 three.js 渲染器；本函数会短暂改变它的 render target
 * @returns 波场句柄，或 null
 */
export function createOceanField(renderer: THREE.WebGLRenderer): OceanField | null {
  const gl = renderer.getContext() as WebGL2RenderingContext

  /* RGBA32F 是硬要求。实测 half-float 会把 1234.5 存成 1234、
     超过 65504 直接溢出，而 FFT 的中间量恰好在这个量级 ——
     用 16F 会在蝶形里悄悄丢精度，最后表现成水面上浮着一层噪点。 */
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

  /* 乒乓两张 32F：evolve 写进 A，16 趟蝶形在 A/B 之间来回。
     16 是偶数所以结果落回 A —— 但下面按实际返回的 target 走，不依赖奇偶。 */
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

  /* 主着色器唯一要用的那一张：16F 够用（波高 ~0.2m、斜率 ~0.1、拉普拉斯 ~3），
     而且 16F 能开 mipmap —— 这很关键：mipmap 会把远处的高频自然平均掉，
     等于**免费且正确地**做了距离 LOD。旧版是手写一个 fade 标量去压高频，
     既不准（分不清各向异性）又要自己维护一个参考波长。
     开 RepeatWrapping 让 5m 的波场可以平铺，取样时传未取模的 uv 就不会有接缝。 */
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

  /* 三个 uniform 表都显式标成 Record<string, IUniform>：不标的话 TS 会从初值
     把 `value` 推成具体类型（比如 uSrc 被推成 DataTexture），
     而蝶形每趟都要把它换成普通的 Texture —— 那是合法用法，只是类型推窄了。 */
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

  /* 三趟共用同一个顶点着色器和同一块全屏几何。
     顶点着色器就是 water.vert.glsl —— 它做的事（把 2×2 平面直接当裁剪空间坐标）
     与主着色器完全一样，没有理由再抄一份出来。 */
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
    /* 半区长 half **必须从小到大**（1, 2, 4, …, 128）。
     *
     * 这一条踩过：原来写成 `bits` 从 BITS 递减，也就是 half 从 128 降到 1 ——
     * 那是 DIF 的顺序，而这里用的是 DIT 的蝶形（twiddle 乘在 b 上、取 a±bw）。
     * 两者混用出来的东西**依然是酉变换**，所以总能量守恒、画面也不会崩，
     * 只是把能量摊错了通道：实测四个通道的均方根从
     *   [0.0208, 0.0929, 2.1263, 0.0820] 变成 [0.0648, 0.0698, 1.5049, 1.5044]。
     * 光看「有波纹、有焦散」根本发现不了；是靠 CPU 侧的逐通道对照抓出来的。 */
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
    // 交还默认帧缓冲，否则后面的 composer 会画进这里
    renderer.setRenderTarget(null)
  }

  /* 把一张 32F target 读回 CPU。只在初始化时用：校准焦散均值、量真实的斜率均方根，
     以及**分段定位**（见下面的 inputRms）。运行时不碰 —— readPixels 会强制同步。 */
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

  /** 四个通道各自的均方根。用来和 CPU 侧的解析预期逐通道对照 —— 对不上就能立刻看出是哪一路错了。 */
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

  /* 初始化第一步：**只跑演化那一趟**，把 FFT 的输入读回来。
     这一步把「演化写错了」和「蝶形写错了」分开 —— 只读最终结果的话，
     两者都表现成「场不对」，只能靠猜。 */
  drawInto(evolveMaterial, fftA)
  const inputBuffer = readbackTarget(fftA)
  const inputRms = inputBuffer ? channelRms(inputBuffer, 1) : []

  /* 第二步：跑完整的一帧，读回蝶形输出。读回的是**未归一化**的蝶形结果，
     所以 CPU 侧要补上 1/N²。
     `1/|J|` 的期望没有解析式（J 过零处发散，只有夹住下限才可积），
     与其推一个不可靠的近似，不如真的跑一遍量出来。 */
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
      // 通道顺序见 ocean-resolve.frag.glsl：(sx, 空置, lap, sz)
      const sx = field[i * 4] * norm
      const lapF = field[i * 4 + 2] * norm
      const sz = field[i * 4 + 3] * norm
      sxx += sx * sx
      szz += sz * sz
      ll += lapF * lapF
      // 和 resolve 那一趟完全相同的算子（增益先按 1 算，只为求均值）
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
    // p99 按**真正写进纹理**的那一档算（增益已乘、上限已夹），不然报的数对不上画面
    const gainF = resolveUniforms.uGainFine.value
    for (let i = 0; i < count; i++)
      raw[i] = Math.min(raw[i] * gainF, CAUSTIC_MAX)
    raw.sort()
    causticP99 = percentile(raw, 0.99)
  }

  // 用校准后的增益再跑一帧，这一帧才是最终纹理
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
    // fieldRms 是**纹理通道顺序** (sx, 空置, lap, sz)，和 resolve 的输出一致
    fieldRms,
  }

  /* 这些数字不往 console 打：控制台是给用户看的，不是给我看的。
     它们跟着 probe 一起挂在 window.__sky.probe.ocean 上（?skydebug=1），
     验证脚本直接从那儿读 —— 谱推出的斜率均方根和 GPU 回读的实测值应当对得上，
     对不上就说明归一化或索引约定错了。 */
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
