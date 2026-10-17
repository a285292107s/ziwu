<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import SkyBackdrop from '~/components/SkyBackdrop.vue'
import { paletteFor, phaseForHour } from '~/logic/ambience'
import { PAGE_BEAT_MS } from '~/logic/motion'
import { parseSkyOverride } from '~/logic/sky'
import { useTheme } from '~/composables/useTheme'
import { greeting } from '~/logic/storage'

const { isDark, setTheme } = useTheme()

/* ---------------- 评审用的时间覆盖 ----------------
   `?sky=6.5` 把整页钉在今天 06:30。连时钟一起钉住是故意的：
   截图评审要的是「这一页在清晨六点半长什么样」，
   钟面上写着真实的凌晨一点、天上却是清晨，那张图没法看。
   没有这个参数时一切照旧，一秒一跳。 */
const skyOverride = parseSkyOverride(window.location.search)

/* ---------------- 时钟 ----------------
   钟点与分钟是主角，秒单独降级成一个小号数字：
   每秒刷新的元素越少、字号越小，视线就越不会被秒针拽走，
   同时仍然是「活着的」时钟而不是一张静态图。 */
const now = ref(skyOverride ?? new Date())
const timer = skyOverride
  ? 0
  : window.setInterval(() => {
    now.value = new Date()
  }, 1000)
onUnmounted(() => {
  if (timer)
    window.clearInterval(timer)
})

const pad = (n: number) => String(n).padStart(2, '0')

const clockMain = computed(() => `${pad(now.value.getHours())}:${pad(now.value.getMinutes())}`)
const clockSeconds = computed(() => pad(now.value.getSeconds()))
const date = computed(() =>
  now.value.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }),
)

/* ---------------- 随时间变化的氛围背景 ---------------- */
const phase = computed(() => phaseForHour(now.value.getHours()))
const palette = computed(() => paletteFor(phase.value, isDark.value))

const backdropStyle = computed(() => ({
  '--amb-from': palette.value.from,
  '--amb-to': palette.value.to,
  '--amb-glow': palette.value.glow,
}))

/**
 * hero 的入场拍子交给 CSS：延迟写成 `calc(var(--beat) * n)`。
 *
 * 节拍本身在 logic/motion.ts —— 磁贴带的起波也取同一个值（见 ShortcutGrid.vue
 * 的 BAND_START_MS）。两处若各写一份延迟，就会重演「一份编排两套时间轴」：
 * hero 在首帧起算、磁贴带却跟着 storage 的往返漂。
 */
const beatStyle = { '--beat': `${PAGE_BEAT_MS}ms` }

/* ---------------- 问候语就地编辑 ---------------- */
const editingGreeting = ref(false)

function openOptionsPage() {
  browser.runtime.openOptionsPage()
}

/* ---------------- 预置站点 ----------------
   首次安装的种子站点由 `defaultShortcuts()` 提供，且**只在 storage 里没有
   `meridiem-shortcuts` 键时写入一次**（`storage.ts` 里 `mergeDefaults: false`）。

   这里刻意不做任何「补进预置站点」的合并动作：
   个人站点属于用户本机数据，只通过设置页的「导入备份」写入 storage。
   页面若在挂载时往回补种子站点，用户删掉的磁贴会被复活，
   而预置清单本身也不该被扩展到个人站点上。 */
</script>

<template>
  <main
    class="newtab-root"
    :style="[backdropStyle, beatStyle]"
    :data-phase="phase"
  >
    <!-- 天光背景层：WebGL2 大气散射，带 CSS 兜底与可读性薄膜。
         纯装饰，不承载任何信息。 -->
    <SkyBackdrop :dark="isDark" :override="skyOverride" />

    <!-- 暗角：把视线收向版心，同时让四周的玻璃元素有「退后」的层次。
         天空本身不带暗角 —— 那是镜头的事，不是大气的事。 -->
    <div class="vignette" aria-hidden="true" />

    <!-- 胶片颗粒：给玻璃材质一个「实体表面」，避免大面积渐变显得像石膏 -->
    <div class="grain" aria-hidden="true" />

    <!-- ---------------- 页眉：品牌标记 + 全局控件 ---------------- -->
    <header class="masthead">
      <span class="brand">
        <span class="brand__tick" aria-hidden="true" />
        <span class="brand__word">Meridiem</span>
      </span>

      <div class="masthead__controls">
        <button
          type="button"
          class="ghost-control focus-ring"
          data-test="open-options"
          @click="openOptionsPage"
        >
          <span class="i-carbon-settings-adjust" aria-hidden="true" />
          设置
        </button>

        <div class="theme-switch" role="group" aria-label="主题">
          <button
            type="button"
            class="theme-switch__btn focus-ring"
            :aria-pressed="!isDark"
            aria-label="浅色主题"
            data-test="theme-light"
            @click="setTheme('light')"
          >
            <span class="i-carbon-sun" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="theme-switch__btn focus-ring"
            :aria-pressed="isDark"
            aria-label="深色主题"
            data-test="theme-dark"
            @click="setTheme('dark')"
          >
            <span class="i-carbon-moon" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>

    <!-- ---------------- 主体 ---------------- -->
    <div class="shell">
      <section class="hero">
        <!-- 时间：这一页的视觉主角 -->
        <div class="clock-block">
          <h1 class="clock" data-test="clock">
            <span class="clock__main">{{ clockMain }}</span>
            <span class="clock__seconds" aria-hidden="true">{{ clockSeconds }}</span>
          </h1>
          <p class="clock-date" data-test="clock-date">
            {{ date }}
          </p>
        </div>

        <!-- 问候语：点一下就地改 -->
        <div class="greeting-block">
          <div
            v-if="!editingGreeting"
            class="greeting focus-ring"
            title="点击编辑"
            tabindex="0"
            role="button"
            data-test="greeting"
            @click="editingGreeting = true"
            @keydown.enter.prevent="editingGreeting = true"
            @keydown.space.prevent="editingGreeting = true"
          >
            {{ greeting }}
          </div>
          <input
            v-else
            v-model="greeting"
            class="greeting-input"
            aria-label="编辑问候语"
            data-test="greeting-input"
            @blur="editingGreeting = false"
            @keyup.enter="editingGreeting = false"
          >
        </div>

        <SearchBox autofocus />
      </section>

      <div class="shortcuts-band">
        <ShortcutGrid />
      </div>
    </div>
  </main>
</template>

<style scoped>
/* ---------------------------------------------------------------
   外壳
   ---------------------------------------------------------------
   用 100dvh 而不是 100vh：移动端 Safari 地址栏收起/展开时
   100vh 会跳，100dvh 不会。
   --------------------------------------------------------------- */
.newtab-root {
  position: relative;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(168deg, var(--amb-from) 0%, var(--amb-to) 58%, var(--bg-deep) 100%);
  color: var(--text-1);
  font-family: var(--font-sans);
  user-select: none;
}

/* ---- 暗角 ----
   压得很轻：天空已经有自己的明暗结构了，暗角只负责把四角收一收，
   让玻璃控件有「退后」的层次。压重了会把天光变成一口井。 */
.vignette {
  /* 和 .sky 一样钉在视口上。它是压在天空上的可读性层，暗角中心必须落在
     **人看得到的那一帧**的中心；跟着文档长到 1096 高的话，暗角中心会掉到
     滚动区中心，可见部分的四角压暗就不对称了。 */
  position: fixed;
  inset: 0;
  z-index: var(--z-ambience);
  pointer-events: none;
  background: radial-gradient(128% 96% at 50% 38%, transparent 46%, var(--bg-deep) 132%);
  opacity: 0.5;
}

/* ---- 胶片颗粒 ----
   固定定位 + pointer-events-none，只画一次、不随滚动重绘。
   颗粒让渐变背景有实体感；缺了它，大面积模糊渐变会显得像塑料。 */
.grain {
  position: fixed;
  inset: 0;
  z-index: var(--z-grain);
  pointer-events: none;
  opacity: var(--grain-opacity, 0.4);
  mix-blend-mode: soft-light;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E");
}

/* ---- 页眉 ---- */
.masthead {
  position: relative;
  z-index: var(--z-rail);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: clamp(1.25rem, 3vh, 2.25rem) var(--gutter) 0;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-display);
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-1);
}

.brand__tick {
  width: 0.85rem;
  height: 2px;
  border-radius: 2px;
  background: var(--brand-vivid);
}

.masthead__controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 主题切换：两态都是显式的，当前状态一眼可读，
   比单按钮「显示将要切换到的状态」更少歧义。 */
.theme-switch {
  display: inline-flex;
  align-items: center;
  gap: 0.1rem;
  padding: 0.15rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.theme-switch__btn {
  display: grid;
  place-items: center;
  width: 1.7rem;
  height: 1.7rem;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-3);
  font-size: 0.85rem;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.theme-switch__btn:hover {
  color: var(--text-1);
}

.theme-switch__btn[aria-pressed='true'] {
  background: var(--surface-strong);
  color: var(--text-1);
  box-shadow: var(--shadow-1);
}

/* ---- 版心 ----
   主体垂直居中，磁贴带跟在后面而不是钉在底部：
   内容少时整块居中，内容多时自然向下延展。 */
.shell {
  position: relative;
  z-index: var(--z-content);
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: clamp(2rem, 5.5vh, 3.25rem);
  width: 100%;
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: clamp(1.25rem, 3vh, 2rem) var(--gutter) clamp(1.75rem, 5vh, 3rem);
}

/* ---- 时间 ----
   这一块是页面的「标题区」，所以内部用一条紧凑的节奏线：
   钟点 → 日期 → 问候，间距从紧到松，最后和搜索框之间留一个大跳。 */
.hero {
  display: flex;
  flex-direction: column;
}

.clock-block {
  animation: rise-in var(--dur-enter) var(--ease-out) both;
}

.clock {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  font-family: var(--font-display);
  font-weight: 300;
  letter-spacing: -0.045em;
  line-height: 0.92;
}

.clock__main {
  font-size: clamp(3.6rem, 12.5vw, 6.4rem);
  font-variant-numeric: tabular-nums;
}

/* 秒：小一号、低一档、贴基线，只做很轻的呼吸。
   字号刻意固定 1.6rem = 25.6px，踩在 WCAG「大字号」门槛（24px）之上：
   强调色要在时刻变化的氛围底上稳住对比度，走大字号那条线比
   把青色压到发黑更合理。用固定值而不是 clamp，是为了任何视口下
   都不会掉回普通字号的对比度要求。 */
.clock__seconds {
  font-size: 1.6rem;
  font-weight: 400;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--seconds, var(--brand-vivid));
  padding-top: 0.5em;
  animation: tick-pulse 2s var(--ease-in-out) infinite;
}

.clock-date {
  margin: 1rem 0 0;
  font-size: 0.88rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-3);
}

/* ---- 问候语 ---- */
.greeting-block {
  margin-top: 0.7rem;
  animation: rise-in var(--dur-enter) var(--ease-out) calc(var(--beat) * 1) both;
}

.greeting {
  display: inline-block;
  max-width: 32ch;
  padding: 0.12rem 0;
  font-size: clamp(1rem, 1.6vw, 1.2rem);
  font-weight: 500;
  line-height: 1.5;
  color: var(--text-2);
  /* 这里是「点击进入编辑」，不是可选择文本（根节点 user-select: none），
     所以用 pointer 而不是 text，别让光标许诺一个做不到的操作。 */
  cursor: pointer;
  border-radius: 6px;
  border-bottom: 1px solid transparent;
  transition:
    color var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out);
}

.greeting:hover {
  color: var(--text-1);
  border-bottom-color: var(--line-strong);
}

.greeting-input {
  min-width: 12ch;
  max-width: 32ch;
  padding: 0.12rem 0;
  font-size: clamp(1rem, 1.6vw, 1.2rem);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-1);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--brand-vivid);
  outline: none;
}

/* ---- 搜索框 ----
   入场动画挂在 .search-shell（真正的胶囊）上，不挂在 .search-root 上。
   原因：animation ... both 会让动画结束后依然保留 transform 的「已结束」状态，
   而带 transform 的元素会自成一格层叠上下文。.search-root 一旦被算成层叠上下文，
   它内部 position:absolute 的引擎下拉就会被压在后面的磁贴带下面
   （截图里能看到磁贴从菜单里透出来）。挂在没有子级浮层的 .search-shell 上就没这个问题。 */
.hero :deep(.search-shell) {
  animation: rise-in var(--dur-enter) var(--ease-out) calc(var(--beat) * 2) both;
}

.hero :deep(.search-root) {
  margin-top: clamp(1.85rem, 4.5vh, 2.75rem);
}

/* ---- 磁贴带 ----
   这里**不给**整块磁贴带挂入场动画。
   曾经挂过一层延迟后开始的 rise-in（`both` 填充让整块先隐身后升起），它顺手把
   磁贴各自的错峰整个盖住了 —— 磁贴的动画在幕布后面就跑完了，
   用户看到的其实是「整块一起升起」。
   现在磁贴带自己在 hero 第三拍起波（同一份节拍见 logic/motion.ts），
   每行退开一拍、每格竖直沉落；常量与理由都在 components/ShortcutGrid.vue。
   幕布也由 ShortcutGrid 自己按「真列表是否就位」控制：storage 异步回来后列表会被
   整份替换，用固定计时器当幕布会在慢机器上露出「种子站 → 用户磁贴」那一下。 */

/* ---------------------------------------------------------------
   响应式
   ---------------------------------------------------------------
   窄屏不保留任何非对称结构：一律单列、左对齐、缩紧节奏。
   --------------------------------------------------------------- */
@media (max-width: 768px) {
  .shell {
    justify-content: flex-start;
    gap: 2.25rem;
    padding-top: 2rem;
  }

  .clock__seconds {
    padding-top: 0.45em;
  }

  .greeting {
    max-width: 100%;
  }
}

/* 矮视口（笔记本横屏、分屏）：把节奏收紧，保证搜索框和磁贴都在首屏 */
@media (max-height: 720px) {
  .shell {
    justify-content: flex-start;
    gap: 1.9rem;
    padding-top: 1.25rem;
  }

  .clock__main {
    font-size: clamp(3rem, 9vw, 4.6rem);
  }
}
</style>
