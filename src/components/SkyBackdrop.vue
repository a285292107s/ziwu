<script setup lang="ts">
/**
 * 天光背景层。
 *
 * 三层结构，从下到上：
 *   1. `.sky__fallback` —— CSS 渐变兜底。WebGL 不可用、还没画出第一帧、上下文丢失、
 *      机器太慢被降级 —— 这几种情况下它就是背景。用的是 ambience.ts 的老调色板，
 *      所以降级不会跳色。
 *   2. `<canvas>` —— WebGL2 大气散射。首帧画出来之后才淡入，避免开页闪一下黑。
 *   3. `.sky__veil` —— 可读性薄膜。一条大羽化的径向渐变，强度由真实像素亮度算出来；
 *      它读起来应该是「雾」，不能是「卡片」。
 *
 * 时间：默认跟随真实时间，每 15 秒重算一次天文参数（15 秒里天球只转 0.06°，肉眼看不出跳）。
 * 评审时可以用 `?sky=6.5` / `?sky=2026-06-21T05:30` 钉住某个时刻 —— 见 sky.ts 的 parseSkyOverride。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { paletteFor, phaseForHour } from '~/logic/ambience'
import { DEFAULT_LATITUDE, skyFrameAt } from '~/logic/sky'
import { THEME_BLEND_MS, createSkyRenderer } from '~/logic/skyRenderer'
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
 * **一层，整幅，均匀。** 中间试过「每个正文元素一块带羽化的补丁」（sky22~sky24），
 * 出发点是「判据是每个元素自己框内、一条带只有一个 alpha 管不过来」。
 * 它在对比度数字上确实有效，但**画面上不成立**：
 * 二十多个站名各一块补丁，等于在磁贴栏上横着铺了十几条深浅不一的带子，
 * 逐行量能看出明显的横向条纹（行均值在 0.44~0.67 之间跳）。
 * 薄膜是**背景层的一部分**，它的第一要求是「像雾」而不是「像贴片」。
 *
 * 现在回到一层：`--veil-alpha` 一个数管全幅。
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

   判据用的是**和正文同一条带子**：浅色主题看正文带最暗处（p10），深色主题看正文带最亮处（p90）。
   约束的方向两个主题是相反的，但都在正文带里：
   - 浅色是深字压浅底，要保证**最暗的那块**也不低于下限，所以取 p10；
   - 深色是浅字压深底，要保证**最亮的那块**也不高于上限，所以取 p90。
   之前深色误取了整幅 p90 —— 而画面最亮的地方（Snell 窗、月亮倒影）根本不在正文带里，
   拿它去驱动薄膜，薄膜就会长期顶在上限，正文带糊成一块灰。约束在哪，就在哪量。 */
const VEIL_LIGHT = 0.9 // 浅色主题薄膜色 #f2f6fa 的相对亮度
const VEIL_DARK = 0.0125 // 深色主题薄膜色 #07202a 的相对亮度（必须和 main.css 同步）

/**
 * 浅色主题：背景亮度**下限**。薄膜至少把最不利的那一处抬到这里。
 *
 * --- 它一路被抬上去过：0.496 → 0.52 → 0.56 → 0.50 → 0.54 → 0.58 → 0.60 → 0.64 ---
 *
 * 每一次都是「实测偏低 → 把目标往上抬」。**那是拿目标补模型误差**，方向是错的：
 * 目标抬多高，雾就有多重，而误差还在那儿。抬到 0.64 的时候，
 * 画面已经在替一个**不存在的需求**买单了。
 *
 * water5 用 `%TEMP%\elemdump.mjs`（把探针逐框数据按 low 排序倒出来）查清了谁在定这个数 ——
 * 浅色正午 48 个框，最苛刻的是**磁贴站名**：
 *
 *   .tile-name        low=0.2932   rgb(56,68,79) --text-2  11.68px/500  ← 定住全局
 *   .grid-title       low=0.3323   rgb(58,68,77) --text-3  12.48px/600
 *   .grid-edit        low=0.3595
 *   [data-test=clock] low=0.5295   rgb(16,24,32) --text-1                ← 早就够亮
 *
 * 站名不是大字号，按 4.5:1 它只需要背景 `(0.0554+0.05)×4.5−0.05 = 0.4243`。
 * 之前定 0.64，比任何一个字真正需要的都高 **50%** —— 差额全以雾付掉。
 *
 * 所以现在按「最苛刻那个字真正需要多少 + 约 20% 余量」定：**0.52**。
 * 判据仍然是「每元素自己框内」，驱动量仍然是元素级最坏值 —— 变的只是目标的来路：
 * **从「一次次补差」改成「按需求反算」**。
 */
const FLOOR_LIGHT = 0.52
/* 深色主题的背景亮度上限 —— **由需求反算**，不是手定的。
   最严的一处是 .clock-date：14.08px、--text-3 #aab6c2（相对亮度 0.4647）。
   14px 不算大字号，所以需要 4.5:1 ⇒ 背景亮度 ≤ (0.4647 + 0.05) / 4.5 − 0.05 = 0.0644。
   原来写 0.042，比需求严 1.5 倍 —— 严出来的那部分全部由薄膜的 alpha 付账。 */
const CEIL_DARK = 0.0644

/* 上限 0.62 原来是拍脑袋定的，理由是「再高就会糊出一块明显的暗斑」。
   实测之后这个理由站不住：深色主题的薄膜色是 #05080e（相对亮度 0.0025），
   压在深青的水上只是把那一带压得更深一点 —— 在一个本来就暗的画面上，
   它读起来像柔和的渐隐，不像斑。而 0.62 是有代价的：
   深色主题正午（水最亮的时候）正文带 p10 量到 0.153，
   0.62 只能把背景压到 0.061，浅字 --text-3 在那上面是 3.7:1 —— 不到 AA。
   抬到 0.72 之后同一处 5.4:1，而且正文带 p10 在实测里会随光网漂到 0.20 上下，
   那时 0.72 仍然守得住 4.7:1。这才是这个上限该由什么决定：**由最坏那一行的实测值**，
   不是由最初那一版的观感。
   再抬到 0.78 是因为同一份审计发现深色主题正午的问候语（19.2px）量到 4.37 ——
   0.72 只差 0.13 个点。0.78 把它推到 5.0:1。 */
/* 上限按主题分开（浅色留 0.78 的保险，它实测停在 0.18~0.22，碰不到上限）。
   深色的 0.78 **试过降到 0.55，被审计否决了** —— 这一条值得留着，因为它记的是一次
   「用推算代替实测」的失败：
   当时的推理是「深色分支长期顶在上限，说明它被过度遮罩了」，依据是
   从**整条正文带的 p90** 反推元素局部背景 ≈0.107，于是算出 0.41 就够、0.55 有余量。
   实测（docs/review/sky16/wcag-*.json，veil=0.5497）：深色正午 clockDate **3.97**、
   夜里 **3.66**（需要 4.5）—— 两项不达标。
   反解出来 .clock-date 那一框的**原始**背景是 0.198，不是 0.107：
   整条带的 p90 在这个位置**低估**了元素局部亮度（和浅色主题那边 p10 高估的方向正好相反）。
   要把它压到 CEIL_DARK = 0.0644，需要 alpha ≥ 0.68；留出运行间波动（gain 会漂）取 0.78。
   所以：**这个数只能由最坏那一行的实测值决定**，不能由别的统计量推算。 */
const VEIL_MAX_LIGHT = 0.78
/* 深色主题的 alpha 上限**可以放开了**，因为薄膜现在是局部的：
   0.78 这个上限当初是「不许把整幅画压平」的妥协，而 sky16 反解过深色主题
   真正需要的是 alpha ≥ 0.68、夜里到 0.90。一条整幅宽的带用 0.90 会把画面压死，
   一块压在字后面的补丁不会 —— 所以上限抬到 0.92，让深色主题**真的达到它的目标**。 */
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
 * sky23 把审计从 4 个元素扩到 12 个之后，暴露出**一直存在**的问题：
 * 磁贴栏那一片（快捷方式标题、拖动提示、整理按钮、站名、首字母）
 * 从来没被量过，实测**四个组合里 17 项不达标**，
 * 深色正午最惨：快捷方式 1.07、首字母 1.95（需要 4.5）。
 *
 * 原因是背景层的薄膜从来没盖到那一带（旧的整条带只到画面 66%，新的补丁只盖 4 个元素），
 * 而深色主题的**原始画布在那一带是亮的**（实测元素背后约 0.43）——
 * 亮灰文字压在亮背景上，等于看不见。
 * 而且这一档**换文字颜色救不了**：要 4.5 就得 `L_text ≥ 2.09`，超过 1.0 的上限，
 * 也就是说背景**必须**被压暗。所以这些元素必须一起进补丁集。
 *
 * `search-input` 一度被排除在外，理由是「搜索框有自己的玻璃底，不受背景约束」——
 * **这个理由是错的**：那块玻璃是**半透明**的，背景透过它就成了它自己的背景。
 * 把它移出补丁集之后深色正午从 8.97 掉到 **2.03**。
 *
 * 教训合起来是一句话：**「有自己的一层」不等于「不依赖背景」**，半透明就是依赖；
 * 而「没量过」不等于「没问题」。 */
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
       它们横跨整幅，背景沿宽度变化很大 —— 只量第一个会漏掉最坏的那一个
       （实测浅色正午第一个 3.95、中间那个 5.63，差一档半）。 */
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2)
        continue
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
  }
  return out
}

function boot() {
  const el = canvas.value
  if (!el)
    return

  const r = createSkyRenderer(el, {
    renderScale: 0.34,
    targetFps: 30,
    /* 主题切换把「两片水」摊成一段过渡，而不是一帧硬切（见 THEME_BLEND_MS）。
       prefers-reduced-motion 下传 0：那种情况下渲染器只画一帧，
       过渡会永远停在起点。 */
    themeBlendMs: reducedMotion ? 0 : THEME_BLEND_MS,
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
   * 主题一换就得重推一帧，不能等下一个 15 秒的定时器。
   *
   * 这一行是补一个真实存在的漏洞：主题模式是从 `chrome.storage.local` **异步**读出来的，
   * 组件挂载的那一刻它还是默认值 `light`，于是 `pushFrame()` 按浅色算了一帧 ——
   * 而薄膜那边每次都读实时的 `props.dark`，两边的 `dark` 就对不上了。
   * 实测抓到的现象：`html` 上是 `dark` 类、薄膜按深色算，画面却一直是浅色的
   * `depth 1.15` / `exposure 3.96`，深色主题其实**从来没有**渲染过深色的水。
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
   * `createSkyRenderer` 是**同步**的，里面挤着：54KB 水体着色器的编译链接、
   * FFT 三趟程序与泛光/tonemap 的首次编译、两次阻塞 `readPixels`（标定焦散均值）、
   * 256² 波谱生成。实测（RTX 5060，冷启动）这一段占住主线程约 750ms。
   * 写在 onMounted 里，等于把「时钟 / 搜索框 / 磁贴」的第一帧一起推迟 ——
   * 用户先看到一个空页面，然后水才出来。
   *
   * 所以先让页面画出来，再在下一帧做这件事。这段时间露出来的是 CSS 兜底渐变
   * （`.sky__fallback` 本来就是为「还没画出第一帧」准备的），水随后照常淡入。
   *
   * 必须 rAF → setTimeout：rAF 回调仍然跑在本帧绘制**之前**，
   * 直接写在 rAF 里等于没延后。 */
  bootRaf = window.requestAnimationFrame(() => {
    bootTimer = window.setTimeout(boot, 0)
  })
})

onUnmounted(() => {
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
     这个页面目前会纵向溢出 195px（快捷方式第二排落在 y 864~948，视口只有 900 高），
     absolute 的天空会跟着文档一起长到 1096 高。两件坏事一起发生：
       1. 着色器是按 1096 的帧高构图的，而人只看得到上面 900 —— 设计好的
          「窗口 30% / 镜面 36% / 沙地 33%」里有 f>0.821 的那部分沙地在屏幕外；
       2. 探针的正文带（GL y 0.72~0.90 帧高）跟着往下挪，和真正的时钟/日期/问候语错开。
     fixed 之后画布就是可见视口本身，构图和探针的坐标系同时回到设计值。
     页面本身的溢出是布局问题，不在背景层职责内，另行汇报。 */
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
 * 历史（每一步都是被实测推着走的，值得留着）：
 *   1. 「中心在 42%、半径 104%」的大圆 —— 等于整幅白纱；
 *   2. 一条横铺在正文带上的光雾（竖半径 46%、中心 20%）；
 *   3. 横向半径 120% → 165%（正文左对齐，x=6% 处实际只有 70% 强度，
 *      14px 的日期在正午/日落量到 4.09 / 3.88）；
 *   4. **每个正文元素一块带羽化的补丁**（sky22~sky24）。
 *
 * 第 4 步在对比度数字上确实有效（深色主题 clock 8.46 → 11.75），
 * 但**画面上不成立**：二十多个站名各一块补丁，等于在磁贴栏上横着铺了十几条
 * 深浅不一的带子 —— 逐行量能看出明显的横向条纹（行均值在 0.44~0.67 之间跳，
 * 最大跳变是中位的 7.8 倍）。薄膜是**背景层的一部分**，第一要求是「像雾」而不是「像贴片」。
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
