<script setup lang="ts">
/**
 * 天光背景层。
 *
 * 三层结构，从下到上：
 *   1. `.sky__fallback` —— CSS 渐变兜底。WebGL 不可用、还没画出第一帧、上下文丢失、
 *      机器太慢被降级 —— 这几种情况下它就是背景。用的是 ambience.ts 的调色板，
 *      所以降级不会跳色。
 *   2. `<canvas>` —— WebGL2 水下天光。首帧画出来之后才淡入，避免开页闪一下黑。
 *   3. `.sky__veil` —— 可读性薄膜。一层大羽化的径向渐变，强度由真实像素亮度算出来；
 *      它读起来应该是「雾」，不能是「卡片」。
 *
 * 时间：默认跟随真实时间，定时重算天文参数。评审时可以用 `?sky=6.5` /
 * `?sky=2026-06-21T05:30` 钉住某个时刻 —— 见 sky.ts 的 parseSkyOverride。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { paletteFor, phaseForHour } from '~/logic/ambience'
import { DEFAULT_LATITUDE, skyFrameAt } from '~/logic/sky'
/* skyRenderer **不能静态 import**。
   它自己静态拖着 three.js、three/examples/jsm/postprocessing/* 和几个 `?raw`
   着色器（water.frag.glsl 一个就好几十 KB），模块图合计约 600KB。静态 import 意味着
   这一坨必须在 Vue 挂载**之前**解析并执行完 —— 时钟 / 搜索框 / 磁贴的首帧全在等它。
   所以它被降级成 `import type`（只在编译期存在，不产生运行时依赖），
   真正的运行时模块在 boot 里动态 import —— 那时页面已经画出来了。 */
import type { SkyRenderer } from '~/logic/skyRenderer'

const props = defineProps<{
  dark: boolean
  /** 评审用的固定时刻；null 表示跟随真实时间 */
  override?: Date | null
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const renderer = shallowRef<SkyRenderer | null>(null)
/** WebGL 首帧画出来了 —— 这时才把 canvas 淡入 */
const painted = ref(false)
/**
 * 薄膜强度，由探针实测的像素亮度算出来。
 *
 * **一层，整幅，均匀。** 中间试过「每个正文元素一块带羽化的补丁」：
 * 出发点是「判据是每个元素自己框内、一条带只有一个 alpha 管不过来」。
 * 它在对比度数字上确实有效，但**画面上不成立** ——
 * 二十多个站名各一块补丁，等于在磁贴栏上横着铺了十几条深浅不一的带子。
 * 薄膜是**背景层的一部分**，它的第一要求是「像雾」而不是「像贴片」。
 *
 * 所以现在只留一层：`--veil-alpha` 一个数管全幅。
 * 驱动量仍然用**元素级**的最坏值（探针逐框量的那个），只是**渲染**不再逐元素 ——
 * 这样既保留了「量在判据所在的位置」这个正确性，又不会把画面切成条。
 */
const veil = ref(0.2)

const FRAME_INTERVAL = 15000

/**
 * 兜底配色用的时段。它跟真实时间走，跟 override 无关 ——
 * override 是调试入口，兜底层只在 WebGL 挂了的时候露出来，没必要为它精确。
 */
const fallbackPhase = computed(() => phaseForHour(new Date().getHours()))
const palette = computed(() => paletteFor(fallbackPhase.value, props.dark))

const fallbackStyle = computed(() => ({
  '--amb-from': palette.value.from,
  '--amb-to': palette.value.to,
  '--amb-glow': palette.value.glow,
}))

const veilStyle = computed(() => ({ '--veil-alpha': String(veil.value) }))

const now = () => props.override ?? new Date()

/**
 * 诊断出口：`?skydebug=1` 时把渲染器的实时状态挂到 window 上。
 *
 * 之所以要留这个口子：天光对不对**只能靠真机量**。自动曝光是正文可读性的主要保障，
 * 而它的收敛过程（真实像素亮度 → 增益 → 薄膜强度）全在 canvas 里，
 * 截图和 computed style 都看不见。没有这个出口，验证就只能靠猜。
 * 默认关闭，生产路径上零开销、零全局变量。
 */
const DEBUG = new URLSearchParams(window.location.search).has('skydebug')

function publishDebug(patch: Record<string, unknown>) {
  if (!DEBUG)
    return
  const w = window as unknown as { __sky?: Record<string, unknown> }
  w.__sky = { ...w.__sky, ...patch }
}

/* ---------------- 薄膜强度 ----------------
   目标区间和 sky.ts 里的 targetLuminance 是同一件事的两面：
   浅色主题怕暗（正文是深色的），深色主题怕亮（正文是浅色的）。
   自动曝光会先把亮度拉进区间，薄膜负责补它拉不动的残差 ——
   所以正常情况下这个值会停在很小的地方，只在极端场景才顶上来。

   判据用的是**和正文同一条带子**：浅色主题看最暗处，深色主题看最亮处。
   方向两个主题是相反的：
   - 浅色是深字压浅底，要保证**最暗的那块**也不低于下限；
   - 深色是浅字压深底，要保证**最亮的那块**也不高于上限。
   曾经深色误取了整幅的最亮处 —— 而画面最亮的地方（Snell 窗）根本不在正文带里，
   拿它去驱动薄膜，薄膜就会长期顶在上限，正文带糊成一块灰。约束在哪，就在哪量。 */
const VEIL_LIGHT = 0.9 // = main.css 里浅色 --veil-color-strong 的相对亮度，必须同步
const VEIL_DARK = 0.0125 // = main.css 里深色 --veil-color-strong 的相对亮度，必须同步

/**
 * 浅色主题：背景亮度**下限**。薄膜至少把最不利的那一处抬到这里。
 *
 * 这个数**由需求反算**，不是一次次「实测偏低就把目标往上抬」试出来的。
 * 后者的方向是错的：目标抬多高，雾就有多重，而误差还在那儿 —— 差额全以雾付掉。
 *
 * 定住这个数的通常是**磁贴站名**（一排里最暗、又不够大字号，只能按 4.5:1 算），
 * 而不是时钟或日期。想改这个值，先把探针的逐框数据按 low 排序倒出来，
 * 看当前到底是谁在定它，再按那个字真正需要多少加一点余量。
 */
const FLOOR_LIGHT = 0.52
/* 深色主题的背景亮度上限 —— 同样由需求反算。
   最严的一处是 .clock-date（14px、--text-3）：14px 不算大字号，要 4.5:1。
   改 --text-3 就要重量这个数，它会跟着变。 */
const CEIL_DARK = 0.0644

/* alpha 上限按主题分开。
   浅色这个上限它实测从来碰不到（停在很低的位置），留着只是保险。
   深色的上限**只能由最坏那一行的实测值决定，不能由别的统计量推算** ——
   这一条记的是一次「用推算代替实测」的失败：当时从**整条正文带的 p90**
   反推元素局部背景，算出比实际需求低得多的 alpha 就够，实测直接不达标：
   正文带的 p90 在那些位置上**低估**了元素局部背景。

   也不能因为「长期顶在上限」就断定它被过度遮罩 —— 那可能只是在补贴正确的东西。
   留出运行间波动（gain 会漂）的余量，宁可比算出来的多给一点。 */
const VEIL_MAX_LIGHT = 0.78
const VEIL_MAX_DARK = 0.92

function veilFor(worst: number) {
  const ratio = props.dark
    ? (worst - CEIL_DARK) / Math.max(worst - VEIL_DARK, 1e-4)
    : (FLOOR_LIGHT - worst) / Math.max(VEIL_LIGHT - worst, 1e-4)
  return Math.min(Math.max(ratio, 0), props.dark ? VEIL_MAX_DARK : VEIL_MAX_LIGHT)
}

/* ---------------- 帧驱动 ---------------- */
let frameTimer = 0
/** 延后初始化的两个句柄（卸载时要能取消，见 onUnmounted） */
let bootRaf = 0
let bootTimer = 0
/** `watch(() => props.dark)` 的停止句柄。boot 跑在 setup 之外，不会自动随组件销毁 */
let stopDarkWatch: (() => void) | null = null
/**
 * 组件已经卸载。
 *
 * boot 现在是 **async** 的（里面有一次动态 import），await 期间组件完全可能被卸载：
 * 新标签页被关掉、`<SkyBackdrop>` 被条件渲染切走。那之后 boot 会从 await 醒过来，
 * 而这时 canvas 已经没了、`onUnmounted` 也已经跑过一遍 —— 再建渲染器就等于
 * 建了一个没人 dispose 的东西。这个标志是那条路径的闸门。
 */
let disposed = false

function pushFrame() {
  const r = renderer.value
  if (!r)
    return
  const date = now()
  const frame = skyFrameAt(date, { dark: props.dark, latitude: DEFAULT_LATITUDE })
  r.setFrame(frame)
  publishDebug({ frame })
  // 探针还没回来的头几百毫秒，先用解析式给的初值，避免开页那一瞬正文是糊的
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

/**
 * 点在水面上 -> 一圈涟漪（clearwater 的 tap-to-ripple）。
 *
 * 挂在 window 的 pointerdown 上而不是 canvas 上：背景层是 pointer-events: none，
 * 收不到事件；而「点哪儿都有水花」这件事本来也不该挑地方 —— 磁贴、搜索栏底下
 * 都是同一片水。事件目标是可交互元素时**跳过**：点按钮已经有一整套视觉反馈，
 * 再在同一个位置开一朵水花是抢戏。
 */
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
  // 尺寸变化只影响渲染缓冲，下一次绘制会自己 resize；这里只需要补一帧静态画面
  renderer.value?.renderOnce()
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* **所有压在背景上的文字。**
 *
 * 这张表就是「可读性约束到底在哪」的那份清单。磁贴栏那一片（快捷方式标题、拖动提示、
 * 整理按钮、站名）曾经**从来没被量过**，而深色主题的**原始画布在那一带是亮的** ——
 * 亮灰文字压在亮背景上，等于看不见。而且这一档**换文字颜色救不了**：要达标所需的
 * 文字亮度会超过 1.0 的上限，也就是说背景**必须**被压暗。
 *
 * `search-input` 一度被排除在外，理由是「搜索框有自己的玻璃底，不受背景约束」——
 * **这个理由是错的**：那块玻璃是**半透明**的，背景透过它就成了它自己的背景。
 *
 * 教训合起来是一句话：**「有自己的一层」不等于「不依赖背景」**，半透明就是依赖；
 * 而「没量过」不等于「没问题」。往页面里加压在背景上的文字时，记得往这张表里加一行。
 */
const TEXT_SELECTORS = [
  '[data-test="clock"]',
  '[data-test="clock-date"]',
  '[data-test="greeting"]',
  '[data-test="search-input"]',
  '.brand__word',
  '.grid-title',
  '.grid-hint',
  '.grid-edit',
  '.tile-name',
]

function getTextRects() {
  const out: { x: number, y: number, w: number, h: number }[] = []
  for (const sel of TEXT_SELECTORS) {
    /* `querySelectorAll` 而不是 `querySelector`：`.tile-name` 有二十来个，
       它们横跨整幅，背景沿宽度变化很大 —— 只量第一个会漏掉最坏的那一个。 */
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2)
        continue
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
  }
  return out
}

async function boot() {
  if (!canvas.value)
    return

  /* **天光渲染器在这里、也只在这里加载。**
     这一次 await 就是那约 600KB（three.js + postprocessing + 几个 `?raw` 着色器）
     的下载与解析。它发生在 onMounted 的 rAF → setTimeout 之后（见 onMounted），
     所以时钟 / 搜索框 / 磁贴先画出来，水随后才到。

     chunk 拿不到（离线、安装包残缺、升级过程中旧文件被删）时**不许抛出去**：
     抛出去是 unhandled rejection，而且会留下一个「以为在跑、其实没有」的半状态。
     这条路和「没有 WebGL」是同一套兜底 —— 什么都不建，canvas 保持透明
     （`painted` 一直 false、opacity 0），露出来的就是 `.sky__fallback` 那层 CSS 渐变。 */
  let sky: typeof import('~/logic/skyRenderer')
  try {
    sky = await import('~/logic/skyRenderer')
  }
  catch (error) {
    console.warn('[sky] 天光渲染器加载失败，走 CSS 兜底：', error)
    publishDebug({ skyImportFailed: true })
    return
  }

  /* await 期间可能已经卸载：既不能再建渲染器（没人负责 dispose），
     也不能接着在 null 上操作。canvas ref 在卸载时被置空，disposed 是更直接的判据。 */
  const el = canvas.value
  if (disposed || !el)
    return

  const r = sky.createSkyRenderer(el, {
    renderScale: 0.34,
    targetFps: 30,
    /* 主题切换把「两片水」摊成一段过渡，而不是一帧硬切（见 THEME_BLEND_MS）。
       prefers-reduced-motion 下传 0：那种情况下渲染器只画一帧，
       过渡会永远停在起点。
       常量跟渲染器一起从动态 import 的命名空间里取，保持**单一来源** ——
       不复制一份数字到这里，也不新建一个只放常量的模块。 */
    themeBlendMs: reducedMotion ? 0 : sky.THEME_BLEND_MS,
    getTextRects,
    onReady: () => {
      painted.value = true
      publishDebug({ painted: true })
    },
    onTooSlow: () => {
      // 实测吃不下才降级，不是靠 hardwareConcurrency 猜
      r.stop()
      r.dispose()
      renderer.value = null
      painted.value = false
      veil.value = 0
      publishDebug({ painted: false, degraded: true })
    },
    onProbe: (probe) => {
      /* **一层薄膜，一个 alpha。**
         驱动量取**元素级的最坏值**（探针逐框量的 p05/p95），渲染则是一整幅 ——
         薄膜要像雾，不能像贴片。判据仍然是「每个元素自己框内最不利的那块背景」，
         所以量在哪儿是对的；只是把「最坏的那一处」摊到整幅去盖。
         浅色主题看框内最暗的那一档（p05），深色反过来（p95）。 */
      const el = probe.elements
      const cap = props.dark ? VEIL_MAX_DARK : VEIL_MAX_LIGHT
      let need: number
      if (el && el.count > 0) {
        const list = props.dark ? el.high : el.low
        let worst = 0
        for (let i = 0; i < list.length; i++)
          worst = Math.max(worst, veilFor(list[i]))
        need = Math.min(worst, cap)
      }
      else {
        // 拿不到元素框时退回整条带的统计量（旧口径）
        need = veilFor(props.dark ? probe.text.p90 : probe.text.p10)
      }
      // 平滑一下：薄膜是慢慢浮上来的雾，不该跟着焦散一起呼吸
      veil.value += (need - veil.value) * 0.5
      publishDebug({ probe, veil: veil.value })
    },
  })

  if (!r.supported) {
    // canvas 一直是透明的，露出来的就是 CSS 兜底层
    return
  }

  renderer.value = r
  pushFrame()

  /**
   * 主题一换就得重推一帧，不能等下一个定时器。
   *
   * 这一行是补一个真实存在的漏洞：主题模式是从 `chrome.storage.local` **异步**读出来的，
   * 组件挂载的那一刻它还是默认值，于是 `pushFrame()` 按浅色算了一帧 ——
   * 而薄膜那边每次都读实时的 `props.dark`，两边的 `dark` 就对不上了。
   * 实测抓到的现象：`html` 上是 `dark` 类、薄膜按深色算，画面却一直是浅色的水。
   */
  stopDarkWatch = watch(() => props.dark, () => {
    pushFrame()
    /* reduced-motion 下没有 rAF 循环，`setFrame` 之后没有任何东西会重画 ——
       不补这一下，切主题后画面会一直停在上一个主题（旧代码就是这个行为）。 */
    if (reducedMotion)
      r.renderOnce()
  })

  if (reducedMotion) {
    // 有画面，但不动：只画一帧，不启动 rAF
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
  /* **延后一帧再初始化。**
   *
   * `createSkyRenderer` 是**同步**的，里面挤着：水体着色器的编译链接、
   * FFT 三趟程序与泛光/tonemap 的首次编译、两次阻塞 `readPixels`（标定焦散均值）、
   * 波谱生成 —— 这些一次性工作会把主线程占住一段可感的时间。
   * 写在 onMounted 里，等于把「时钟 / 搜索框 / 磁贴」的第一帧一起推迟——
   * 用户先看到一个空页面，然后水才出来。
   *
   * 所以先让页面画出来，再在下一帧做这件事。这段时间露出来的是 CSS 兜底渐变
   * （`.sky__fallback` 本来就是为「还没画出第一帧」准备的），水随后照常淡入。
   *
   * 必须 rAF → setTimeout：rAF 回调仍然跑在本帧绘制**之前**，
   * 直接写在 rAF 里等于没延后。
   *
   * boot 从这一步开始是 async 的（动态 import 天光渲染器），但 **await 在 boot 里面** ——
   * setup / onMounted 这条同步路径上没有任何 await，页面该画的一帧不会被谁挡住。 */
  bootRaf = window.requestAnimationFrame(() => {
    bootTimer = window.setTimeout(() => {
      void boot()
    }, 0)
  })
})

onUnmounted(() => {
  /* 先立闸门：万一 boot 正卡在动态 import 的 await 上，它醒来后会看到这个标志并直接退出 */
  disposed = true
  window.cancelAnimationFrame(bootRaf)
  window.clearTimeout(bootTimer)
  stopDarkWatch?.()
  window.clearInterval(frameTimer)
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
  /* **必须是 fixed，不能是 absolute。**
     这个页面在矮视口上会纵向溢出。absolute 的天空会跟着文档一起长高，
     两件坏事一起发生：
       1. 着色器是按整个文档高度构图的，而人只看得到视口那一块 ——
          设计好的构图里有相当一部分落在屏幕外；
       2. 探针的正文带跟着往下挪，和真正的时钟 / 日期 / 问候语错开。
     fixed 之后画布就是可见视口本身，构图和探针的坐标系同时回到设计值。
     页面本身的溢出是布局问题，不在背景层职责内。 */
  position: fixed;
  inset: 0;
  z-index: var(--z-ambience);
  overflow: hidden;
  pointer-events: none;
}

/* 兜底渐变。WebGL 一画出来它就被完全盖住，但它必须一直在 ——
   上下文丢失是随时可能发生的，那时候页面不能变成一块白。 */
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

/* 可读性薄膜 —— **一层，整幅，像雾**。
 *
 * 历史（每一步都是被实测推着走的）：
 *   1. 一个「中心偏上、半径很大」的圆 —— 等于整幅白纱；
 *   2. 一条横铺在正文带上的光雾；
 *   3. 横向半径拉到 165% —— 正文左对齐，边缘处实际强度远低于满值；
 *   4. **每个正文元素一块带羽化的补丁**。
 *
 * 第 4 步在对比度数字上确实有效，但**画面上不成立**：二十多个站名各一块补丁，
 * 等于在磁贴栏上横着铺了十几条深浅不一的带子，逐行量能看出明显的横向条纹。
 * 薄膜是**背景层的一部分**，第一要求是「像雾」而不是「像贴片」。
 *
 * 所以回到一层。用一条**很柔的**径向渐变而不是纯色：
 * 平台铺到 55%，只有最外圈才衰减 —— 正文（从左上一直到磁贴栏底部）都在平台里，
 * 所以驱动量按「满强度」算是准的；而四角轻微淡出，不至于像一块盖上去的板。
 */
.sky__veil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: var(--veil-alpha, 0);
  transition: opacity 1200ms ease-out;
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
