<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  buildSearchUrl,
  cycleSearchEngine,
  engineColor,
  getSearchEngine,
  searchEngines,
} from '~/logic/searchEngines'
import { useTheme } from '~/composables/useTheme'
import { searchEngineKey } from '~/logic/storage'

const props = withDefaults(defineProps<{
  /**
   * 提交搜索时是否**开新标签页**。
   *
   * 默认 false（同标签页），与新标签页上的观感一致。
   * 设置页要传 true：那里只是「试一下」的预览，同标签页跳转会把设置页自己顶掉，
   * 和 `ShortcutGrid` 的 `openInNewTab` 是同一个道理。
   */
  openInNewTab?: boolean
  /**
   * 挂载后是否把光标直接放进搜索框。
   *
   * 新标签页传 true：这一页的主要动作就是「敲一次关键字」，让用户先点一下
   * 输入框再打字是白付一次点击。顺带解决另一个坑 —— 焦点不在输入框时，
   * 未聚焦状态下敲 `N` 会被 ShortcutGrid 的全局快捷键接成「新增磁贴」，
   * 想搜 `node` 的人会先撞出一个对话框。
   *
   * 默认 false：设置页 / 侧边栏里这个框只是预览，抢焦点会打断用户手里的事。
   */
  autofocus?: boolean
  /**
   * 是否在搜索框左侧显示「引擎气泡环」。
   *
   * 新标签页保持默认 true：当前引擎停在搜索框左侧，其余引擎以气泡围成一圈。
   * 设置页的预览传 false：那张卡片上方已经有引擎卡片，再铺一圈气泡会溢出版心。
   */
  engineRing?: boolean
  /**
   * 输入框聚焦时，Tab / Shift+Tab 是否永久在引擎之间轮换。
   *
   * 新标签页传 true：Tab 不再承担把焦点送出搜索框的任务，用户靠 Esc 或区块快捷键离开。
   * 设置页的预览保持 false：那里 Tab 仍按浏览器原生顺序移动焦点，不能把用户困在预览里。
   */
  tabCyclesEngines?: boolean
}>(), {
  openInNewTab: false,
  autofocus: false,
  engineRing: true,
  tabCyclesEngines: false,
})

const emit = defineEmits<{
  (event: 'exit'): void
}>()

const { isDark } = useTheme()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)
/** 下拉面板，用于把键盘高亮滚进可视区 */
const menuRef = ref<HTMLElement | null>(null)

/** 下拉面板是否展开 */
const open = ref(false)
/** 下拉面板中键盘高亮的下标，-1 表示没有高亮 */
const activeIndex = ref(-1)
/**
 * 用户是否真的在「用」这个搜索框（而不是打开页面时被 autofocus 摆上去）。
 *
 * 决定 `.search-shell` 要不要画高亮（青色描边 + 外圈光晕 + 更实的底）。
 * 每次打开新标签页都亮一圈的话，这一页最响的视觉元素会变成搜索框的焦点环，
 * 和「打开就是一次干净的停留」不符；而输入框的 `:focus-visible` **恒为真**，
 * 纯 CSS 分不清「页面加载时摆上去的焦点」和「用户自己走过来的焦点」，
 * 所以这里用一个状态门住它：点进来、输入、或者从外部 Tab 进来才算「在用」。
 * 键盘用户的焦点可见性因此不打折 —— 他们一进来（或一敲键）环就在。
 */
const engaged = ref(false)

/**
 * 初始 autofocus 那一次焦点不能算「用户在用」。
 *
 * `focus()` 的 focus 事件是同步派发的，正常情况下一个赋值就够了；
 * 这里用微任务复位，是为了「某个环境把派发推迟一帧」时也不会误亮。
 */
let suppressMountFocus = false
/** 当前引擎；storage 里存的是旧 key 时自动回退到默认引擎 */
const current = computed(() => getSearchEngine(searchEngineKey.value))

function currentIndexOf() {
  return searchEngines.findIndex(engine => engine.key === current.value.key)
}

/**
 * 环的连续相位（角度）。
 *
 * 不能每次从当前引擎下标重新取模：从最后一颗绕回第一颗时，步数会取模跳一圈，
 * CSS 会在两个相差接近整圈的角度之间插值，那颗旧锚点气泡就会反向绕远路。
 * 相位每按一次 Tab 只 ±一格，当前引擎始终通过「基础角度 + 相位」落在锚点，
 * 数字连续，所有气泡才会朝同一个方向走。
 */
const RING_STEP_DEG = 360 / searchEngines.length
const RING_REVEAL_STAGGER_MS = 30
const ringPhase = ref(-currentIndexOf() * RING_STEP_DEG)

/**
 * 环上所有引擎的固定槽位 + 连续相位。
 *
 * 每颗气泡的绝对角度 = 自己的基础角度 + 环相位；DOM 顺序固定按 `searchEngines`
 * 的目录顺序，不按角度排序：元素不增删、不重排，位置只由 `transform` 过渡。
 * `revealDelay` 按离锚点的环上距离算，展开时从两侧依次出现。
 */
const ringEngines = computed(() => {
  const currentIndex = currentIndexOf()
  return searchEngines.map((engine, index) => {
    const ringDistance = Math.min(
      Math.abs(index - currentIndex),
      searchEngines.length - Math.abs(index - currentIndex),
    )

    const angle = index * RING_STEP_DEG + ringPhase.value
    const drift = 10 + ringDistance * 4
    const rad = angle * Math.PI / 180

    return {
      engine,
      angle,
      revealDelay: Math.max(0, ringDistance - 1) * RING_REVEAL_STAGGER_MS,
      // 退场像呼出一口气：从锚点向外依次散开，近的先走、远的稍后，
      // 同时沿半径向外、略微向上飘，再模糊淡出。
      exitDelay: ringDistance * 36,
      exitX: Math.cos(rad) * drift,
      exitY: Math.sin(rad) * drift - 4,
      isCurrent: index === currentIndex,
    }
  })
})

/**
 * 直接点选 / 外部同步换了引擎时，把相位对到最近的等效角度。
 * Tab 轮换自己会先更新相位，这里算出来的差是 0；不能每次无条件重置，
 * 否则从最后一颗绕回第一颗时又会走远路。
 */
watch(() => current.value.key, () => {
  const target = -currentIndexOf() * RING_STEP_DEG
  const delta = ((target - ringPhase.value) % 360 + 540) % 360 - 180
  if (Math.abs(delta) > 0.001)
    ringPhase.value += delta
})

/**
 * 引擎环只在「刚按过 Tab」时展开。
 *
 * 默认收起，只留锚点上的当前引擎气泡（也就是搜索框左侧那颗）；
 * 每按一次 Tab / Shift+Tab 重新计时，停手后短暂停留再淡出。
 * 输入、开下拉、失焦都会提前收起，避免用户已经在做别的事时环还挂着。
 */
const ringRevealed = ref(false)
const RING_HOLD_MS = 1400
let ringHideTimer: number | undefined

function scheduleRingHide() {
  if (ringHideTimer)
    window.clearTimeout(ringHideTimer)
  ringHideTimer = window.setTimeout(() => {
    ringHideTimer = undefined
    ringRevealed.value = false
  }, RING_HOLD_MS)
}

function revealRing() {
  ringRevealed.value = true
  scheduleRingHide()
}

function dismissRing() {
  if (ringHideTimer)
    window.clearTimeout(ringHideTimer)
  ringHideTimer = undefined
  ringRevealed.value = false
}

/**
 * 气泡的落点：绝对角度绕环心旋转后沿半径推出去；末段反向旋转，保证图标始终正立。
 * 角度变化时 `transform` 会过渡，所有气泡的角度每步都只差一格，不会有人绕远路。
 *
 * 展开 / 收起各用一组变量：展开从外侧略偏的位置往里收，收起则沿半径向外飘散。
 */
function ringBubbleStyle(
  angle: number,
  revealDelay: number,
  exitDelay: number,
  exitX: number,
  exitY: number,
) {
  return {
    'transform': `translate(-50%, -50%) rotate(${angle}deg) translateX(var(--engine-ring-radius)) rotate(${-angle}deg)`,
    '--reveal-delay': `${revealDelay}ms`,
    '--exit-delay': `${exitDelay}ms`,
    '--exit-x': `${exitX}px`,
    '--exit-y': `${exitY}px`,
  }
}

/** 锚点气泡的 hover / focus：宽屏时触发器的本体是透明的，反馈要落到环上的当前气泡 */
const anchorHovered = ref(false)
const anchorFocused = ref(false)

/** 屏幕阅读器用的状态播报：焦点留在输入框里，轮换结果需要单独说一声 */
const engineStatus = ref('')

function announceEngine(engine: (typeof searchEngines)[number]) {
  const index = searchEngines.findIndex(item => item.key === engine.key)
  engineStatus.value = `已切换到 ${engine.label}，第 ${index + 1} 个，共 ${searchEngines.length} 个`
}

function openDropdown() {
  dismissRing()
  open.value = true
  activeIndex.value = currentIndexOf()
}

function closeDropdown() {
  open.value = false
  activeIndex.value = -1
}

function selectEngine(key: string) {
  // 写入 browser.storage.local，其他新标签页 / 设置页会自动同步
  dismissRing()
  searchEngineKey.value = key
  announceEngine(getSearchEngine(key))
  closeDropdown()
  inputRef.value?.focus()
}

/** 轮换引擎，step 可为负 */
function rotate(step: number) {
  // 先让相位连续地走一格；下面的 current 变化不会再触发一次「对齐到最近角度」
  ringPhase.value -= step * RING_STEP_DEG
  const next = cycleSearchEngine(current.value.key, step)
  searchEngineKey.value = next.key
  announceEngine(next)
  if (open.value)
    activeIndex.value = currentIndexOf()
}

/**
 * 跳转到搜索结果。
 *
 * `newTab` 由调用方决定：
 * - 设置页的预览（`props.openInNewTab`）永远开新标签页；
 * - 新标签页上按住 <kbd>Ctrl</kbd>/<kbd>⌘</kbd> 回车、或中键点搜索按钮时开新标签页，
 *   与 Chrome 地址栏的行为一致（README 里承诺过这两条，必须真的做到）。
 */
function submit(newTab = false) {
  dismissRing()
  const url = buildSearchUrl(current.value, query.value)
  if (!url)
    return

  if (newTab || props.openInNewTab)
    window.open(url, '_blank', 'noopener,noreferrer')
  else
    window.location.href = url
}

/** 中键（`auxclick`）走和 Ctrl+回车同一条路：开新标签页 */
function onSubmitAuxClick(event: MouseEvent) {
  if (event.button !== 1)
    return

  event.preventDefault()
  submit(true)
}

function onKeydown(event: KeyboardEvent) {
  // 一敲键就算「在用」：环在第一次按键时亮起，比等到 blur/refocus 更符合直觉，
  // 也保证键盘用户从第一下输入起就看得见焦点。
  engaged.value = true

  // 输入法正在组词时，这些按键是**输入法在用**，不是用户在操作搜索框：
  // 拼音/五笔候选词要靠回车确认、Esc 取消，都会照常派发 keydown。
  // 不挡掉的话，在搜索框里打「知乎」并敲回车选词，会被直接送去搜索 ——
  // 中文用户第一次用就会撞上（浏览器在组词期间会把 isComposing 置为 true）。
  if (event.isComposing)
    return

  switch (event.key) {
    case 'Tab': {
      // 新标签页里 Tab 就是「切引擎」：前后都无限轮换，不再把焦点交给浏览器。
      // Ctrl/Meta/Alt 组合留给浏览器 / 系统（Ctrl+Tab、Alt+Tab 等），不在这里拦。
      if (!props.tabCyclesEngines || event.ctrlKey || event.metaKey || event.altKey)
        return

      event.preventDefault()
      revealRing()
      rotate(event.shiftKey ? -1 : 1)
      break
    }

    case 'ArrowDown':
      dismissRing()
      event.preventDefault()
      if (!open.value)
        openDropdown()
      else
        activeIndex.value = (activeIndex.value + 1) % searchEngines.length
      break

    case 'ArrowUp':
      dismissRing()
      event.preventDefault()
      if (open.value)
        activeIndex.value = (activeIndex.value - 1 + searchEngines.length) % searchEngines.length
      break

    case 'Enter':
      if (open.value && activeIndex.value >= 0) {
        event.preventDefault()
        selectEngine(searchEngines[activeIndex.value].key)
      }
      else {
        // Ctrl / ⌘ + 回车开新标签页，和 Chrome 地址栏一致
        submit(event.ctrlKey || event.metaKey)
      }
      break

    case 'Escape':
      // 三级出口：先关列表 → 再清输入 → 最后把焦点交回页面开头。
      // 组词中的 Esc 已经被上面挡掉了，不会误清输入。
      dismissRing()
      event.preventDefault()
      if (open.value) {
        closeDropdown()
      }
      else if (query.value) {
        query.value = ''
      }
      else {
        emit('exit')
      }
      break
  }
}

/** 焦点离开整个搜索块时收起引擎列表：Tab 被 Tab 轮换占用后，用户多是靠快捷键跳走 */
function onRootFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && rootRef.value?.contains(next))
    return
  closeDropdown()
  dismissRing()
}

function onDocumentClick(event: MouseEvent) {
  if (!open.value)
    return
  if (rootRef.value && !rootRef.value.contains(event.target as Node))
    closeDropdown()
}

function onWindowBlur() {
  dismissRing()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('blur', onWindowBlur)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('blur', onWindowBlur)
  dismissRing()
})

function onInputPointerDown() {
  engaged.value = true
  dismissRing()
}

/** 焦点进入输入框：用户自己走过来的才算「在用」，挂载时那一次不算 */
function onInputFocus() {
  dismissRing()

  if (suppressMountFocus) {
    suppressMountFocus = false
    return
  }

  engaged.value = true
}

/**
 * 初始焦点。
 *
 * `preventScroll` 是必须的：Chrome 聚焦元素时默认会把它滚进视口，
 * 而入场动画此刻正让搜索框带着 12px 的位移，不拦一下会在矮视口上
 * 触发一次多余的滚动。
 *
 * 焦点给的是「打开就能打字」这件事，但**不画焦点环**（见 `engaged`）。
 * 上一版是「焦点环跟着入场一起淡进来，所以打开就在搜索框看得见」：
 * 那让每次开页最亮的视觉元素变成搜索框外那一圈青色光，跟被背景托着的
 * 时钟抢主角。现在静默落焦，用户一动手（输入 / 点击 / 从页面外 Tab 进来）环才亮。
 */
onMounted(() => {
  if (!props.autofocus)
    return

  suppressMountFocus = true
  inputRef.value?.focus({ preventScroll: true })
  // focus 事件是同步派发的；万一某个环境把它推迟到下一个任务，这里也能兜住
  queueMicrotask(() => {
    suppressMountFocus = false
  })
})

/**
 * 交给宿主页面的两个口子。
 *
 * 新标签页需要「用户进入页面的第一次 Tab 落在搜索框里」，但它自己拿不到这个
 * input —— `data-test` 是验证脚本的钩子，不该被产品逻辑依赖。所以由组件这里
 * 暴露「把焦点放回去」和「输入框本体」（宿主用它判断落点是否在搜索框之前）。
 */
defineExpose({
  focusInput: () => inputRef.value?.focus({ preventScroll: true }),
  inputEl: () => inputRef.value,
})

// 引擎被其他页面改掉时，同步下拉高亮
watch(searchEngineKey, () => {
  if (open.value)
    activeIndex.value = currentIndexOf()
})

// 键盘上下移动高亮时，把高亮项滚进可视区（列表限高，放不下所有引擎）
watch(activeIndex, async (index) => {
  if (index < 0)
    return
  await nextTick()
  menuRef.value
    ?.querySelector<HTMLElement>('.engine-option.is-active')
    ?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div
    ref="rootRef"
    class="search-root"
    :class="{ 'has-engine-ring': engineRing }"
    @focusout="onRootFocusOut"
  >
    <div class="search-shell" :class="{ 'is-open': open, 'is-engaged': engaged }">
      <!-- 当前引擎气泡：它同时是搜索框左侧的锚点、引擎环的圆心参照、完整列表的入口。
           刻意不挂 .focus-ring：焦点反馈由 .search-shell:focus-within 统一给，
           气泡本身已经是圆形，再叠一圈 outline 会在胶囊内部鼓出第二层圆。 -->
      <button
        type="button"
        class="engine-trigger"
        :aria-label="`当前搜索引擎：${current.label}`"
        :aria-expanded="open"
        aria-haspopup="listbox"
        :title="`当前搜索引擎：${current.label}，点击展开列表`"
        data-test="engine-trigger"
        @click="open ? closeDropdown() : openDropdown()"
        @keydown.escape.prevent="closeDropdown()"
        @pointerenter="anchorHovered = true"
        @pointerleave="anchorHovered = false"
        @focus="anchorFocused = true"
        @blur="anchorFocused = false"
      >
        <Transition name="engine-anchor">
          <span
            :key="current.key"
            :class="current.icon"
            class="engine-trigger__icon"
            :style="{ color: engineColor(current, isDark) }"
          />
        </Transition>
      </button>

      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="search-input"
        :placeholder="`在 ${current.placeholder} 中搜索`"
        :aria-label="`使用 ${current.label} 搜索`"
        :aria-keyshortcuts="tabCyclesEngines ? 'Alt+/' : undefined"
        autocomplete="off"
        spellcheck="false"
        data-test="search-input"
        @focus="onInputFocus"
        @input="dismissRing"
        @pointerdown="onInputPointerDown"
        @keydown="onKeydown"
      >

      <button
        type="button"
        class="search-submit focus-ring"
        aria-label="搜索"
        :disabled="!query.trim()"
        data-test="search-submit"
        @click="submit()"
        @auxclick="onSubmitAuxClick"
      >
        <span class="i-carbon-search" aria-hidden="true" />
      </button>
    </div>

    <!-- 引擎气泡环：所有引擎气泡绕成一个圆，当前引擎那颗始终落在搜索框左侧的锚点上。
         环本身覆盖在页面上，不占布局；气泡不进 Tab 顺序（tabindex="-1"）：
         键盘仍走输入框里的 Tab 轮换（Shift+Tab 反向，都永久循环、不离开搜索框）；
         离开靠 Esc 或 Alt 区块快捷键。
         鼠标点任意非当前气泡可直接切换；当前气泡的点击透传给下面那个透明触发器
         （点它展开带名字的完整列表）。 -->
    <div
      v-if="engineRing"
      class="engine-ring"
      :class="{
        'is-anchor-hot': anchorHovered || anchorFocused,
        'is-revealed': ringRevealed,
      }"
      :aria-hidden="ringRevealed ? undefined : 'true'"
      role="group"
      aria-label="其他搜索引擎"
    >
      <span
        v-for="item in ringEngines"
        :key="item.engine.key"
        class="engine-bubble"
        :class="{ 'is-current': item.isCurrent }"
        :style="ringBubbleStyle(item.angle, item.revealDelay, item.exitDelay, item.exitX, item.exitY)"
        :role="item.isCurrent ? undefined : 'button'"
        :tabindex="item.isCurrent ? undefined : -1"
        :title="item.isCurrent ? undefined : item.engine.label"
        :aria-label="item.isCurrent ? undefined : `切换到 ${item.engine.label}`"
        :aria-hidden="item.isCurrent ? 'true' : undefined"
        :data-test="`engine-bubble-${item.engine.key}`"
        @mousedown.prevent
        @click="selectEngine(item.engine.key)"
      >
        <span
          :class="item.engine.icon"
          class="engine-bubble__icon"
          :style="{ color: engineColor(item.engine, isDark) }"
        />
      </span>
    </div>

    <span class="sr-only" role="status" aria-live="polite">{{ engineStatus }}</span>

    <!-- 引擎下拉列表 -->
    <Transition name="dropdown">
      <ul
        v-if="open"
        ref="menuRef"
        role="listbox"
        aria-label="选择搜索引擎"
        class="engine-menu"
      >
        <li
          v-for="(engine, index) in searchEngines"
          :key="engine.key"
          role="option"
          :aria-selected="engine.key === current.key"
          class="engine-option"
          :class="index === activeIndex ? 'is-active' : ''"
          :data-test="`engine-option-${engine.key}`"
          @mousedown.prevent
          @mouseenter="activeIndex = index"
          @click="selectEngine(engine.key)"
        >
          <span
            :class="engine.icon"
            class="engine-option__icon"
            :style="{ color: engineColor(engine, isDark) }"
          />
          <span class="engine-option__label">{{ engine.label }}</span>
          <span
            v-if="engine.key === current.key"
            class="i-carbon-checkmark engine-option__check"
          />
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------
   搜索框
   ---------------------------------------------------------------
   这一页上唯一需要「被操作」的控件，所以给它最强的材质：
   半透明玻璃面 + 内高光 + 分层投影。浅色下靠描边和阴影立住，
   深色下靠内高光（--line-inset）勾出玻璃的边缘。
   --------------------------------------------------------------- */
.search-root {
  /* 引擎气泡（锚点 + 环）的几何参数。
     `--engine-anchor-half` 必须和锚点尺寸对得上：环的 left 是用它算的。 */
  --search-shell-border: 1px;
  --search-shell-pad-left: 0.45rem;
  --engine-anchor-size: 2.625rem;
  --engine-anchor-half: 1.3125rem;
  --engine-anchor-icon: 1.25rem;
  --engine-ring-radius: 52px;
  --engine-bubble-size: 2.125rem;
  --engine-bubble-icon: 1.05rem;

  position: relative;
  width: 100%;
  /* 搜索框不再铺满整个版心：1400px 宽的一行里，引擎在左端、放大镜在右端，
     一次「输入 → 提交」要让视线横穿整屏。40rem 够长（放得下长查询），
     又让这行的视觉重量跟时钟对齐。 */
  max-width: min(100%, 40rem);
}

.search-shell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0.4rem 0.4rem var(--search-shell-pad-left);
  border: var(--search-shell-border) solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface-control);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset);
  transition:
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}

/* 焦点高亮只在「用户自己在用」时出现（见 script 里的 engaged）。
   打开页面时的静默焦点不画这一圈：否则每次开页最亮的是搜索框的外光，
   和时钟抢主角。`is-open`（引擎下拉展开）本身就是用户动作，照常高亮。 */
.search-shell.is-engaged:focus-within,
.search-shell.is-open {
  border-color: var(--focus);
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset),
    0 0 0 3px var(--brand-ring);
}

/* ---- 当前引擎气泡（也是圆环的锚点） ----
   占据搜索框左端原来的触发器位置；圆环上的其余气泡以它的圆心为 3 点钟位置排开。 */
.engine-trigger {
  position: relative;
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: var(--engine-anchor-size);
  height: var(--engine-anchor-size);
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface-hover);
  color: var(--text-3);
  cursor: pointer;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow:
    0 0 0 2px var(--brand-ring),
    0 12px 28px -16px var(--brand-ring),
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset);
  transition:
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

/* 玻璃球的高光：和搜索框本身同一套「玻璃 + 一点高光」的语言 */
.engine-trigger::after {
  content: '';
  position: absolute;
  top: 17%;
  left: 21%;
  width: 24%;
  height: 18%;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.9);
  opacity: 0.55;
  pointer-events: none;
}

html.dark .engine-trigger::after {
  opacity: 0.28;
}

/* 焦点环统一由 .search-shell:focus-within 给；圆的描边叠在胶囊里会鼓出第二层圆 */
.engine-trigger:focus {
  outline: none;
}

.engine-trigger:hover {
  background: var(--surface-strong);
  box-shadow:
    0 0 0 2px var(--brand-vivid),
    0 14px 30px -16px var(--brand-ring),
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.engine-trigger:active {
  transform: scale(0.94);
}

.engine-trigger__icon {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  font-size: var(--engine-anchor-icon);
  line-height: 1;
  transform: translate(-50%, -50%);
}

/* 当前引擎切换时图标做一次很短的交叉淡入，避免直接闪替 */
.engine-anchor-enter-active,
.engine-anchor-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    scale var(--dur-fast) var(--ease-out);
}

.engine-anchor-enter-from,
.engine-anchor-leave-to {
  opacity: 0;
  scale: 0.72;
}

/* ---- 引擎气泡环 ----
   环心在锚点气泡圆心左侧一个 radius 处，锚点本身占环的 3 点钟位置。
   容器只负责定位，气泡各自用 inline transform 落到环上的角度；
   角度变化时 transform 有过渡，Tab 轮换读起来就是「整圈转一格」。 */
.engine-ring {
  position: absolute;
  top: 50%;
  /* 锚点圆心相对搜索胶囊边框盒的位置 */
  left: calc(var(--search-shell-border) + var(--search-shell-pad-left) + var(--engine-anchor-half) - var(--engine-ring-radius));
  z-index: var(--z-content);
  width: 0;
  height: 0;
  pointer-events: none;
  animation: rise-in var(--dur-enter) var(--ease-out) calc(var(--beat, 60ms) * 2) both;
}

/* 很淡的一圈轨道，把「气泡是绕圆排的」说出来；只在气泡之间露出来 */
.engine-ring::before {
  content: '';
  position: absolute;
  left: calc(0px - var(--engine-ring-radius));
  top: calc(0px - var(--engine-ring-radius));
  width: calc(var(--engine-ring-radius) + var(--engine-ring-radius));
  height: calc(var(--engine-ring-radius) + var(--engine-ring-radius));
  border: 1px dashed var(--line-strong);
  border-radius: 50%;
  opacity: 0;
  transform: scale(1.08) rotate(-10deg);
  transform-origin: 50% 50%;
  pointer-events: none;
  transition:
    opacity var(--dur-enter) var(--ease-out),
    transform var(--dur-enter) var(--ease-out);
}

.engine-ring.is-revealed::before {
  opacity: 0.32;
  transform: scale(1) rotate(0deg);
}

.engine-bubble {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  place-items: center;
  width: var(--engine-bubble-size);
  height: var(--engine-bubble-size);
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface-hover);
  color: var(--text-2);
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
  opacity: 1;
  scale: 1;
  translate: 0 0;
  filter: none;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset);
  transition:
    width var(--dur-base) var(--ease-out),
    height var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    opacity var(--bubble-dur, var(--dur-base)) var(--ease-out) var(--bubble-delay, 0ms),
    scale var(--bubble-dur, var(--dur-base)) var(--ease-out) var(--bubble-delay, 0ms),
    translate var(--bubble-dur, var(--dur-base)) var(--ease-out) var(--bubble-delay, 0ms),
    filter var(--bubble-dur, var(--dur-base)) var(--ease-out) var(--bubble-delay, 0ms);
}

/*
 * 环收起时只留锚点那颗当前引擎气泡。其余气泡不是简单一起淡掉：
 * 从锚点向外依次散开，沿各自的半径方向飘一小段，同时轻微缩小、模糊、透明。
 * 展开时反向：从外侧略偏的位置收回来并聚焦，读起来更像一次呼吸而不是开关。
 */
.engine-ring:not(.is-revealed) .engine-bubble:not(.is-current) {
  opacity: 0;
  scale: 0.9;
  translate: var(--exit-x, 0px) var(--exit-y, 0px);
  filter: blur(2px);
  pointer-events: none;
  --bubble-dur: var(--dur-enter);
  --bubble-delay: var(--exit-delay, 0ms);
}

/*
 * 展开时从锚点向两侧依次绽放；--reveal-delay 和 --exit-delay 由 ringBubbleStyle 按环上距离给。
 * 两边的延迟方向一致（近的早、远的晚），所以收起时是从锚点向外散开，而不是整圈一起消失。
 */
.engine-ring.is-revealed .engine-bubble:not(.is-current) {
  opacity: 1;
  scale: 1;
  translate: 0 0;
  filter: none;
  --bubble-dur: var(--dur-base);
  --bubble-delay: var(--reveal-delay, 0ms);
}

/* 环出现时当前气泡轻微托起一下，给「环展开了」一个落点 */
.engine-ring.is-revealed .engine-bubble.is-current {
  scale: 1.03;
}

/* 当前引擎那颗永远停在环的 3 点钟（搜索框左侧锚点）：
   它比环上其余气泡大一号、带品牌色描边，并且把点击透传给下面透明的触发器。 */
.engine-bubble.is-current {
  z-index: 1;
  width: var(--engine-anchor-size);
  height: var(--engine-anchor-size);
  border-color: var(--brand-ring);
  cursor: default;
  pointer-events: none;
  box-shadow:
    0 0 0 2px var(--brand-ring),
    0 12px 28px -16px var(--brand-ring),
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset);
}

.engine-bubble.is-current .engine-bubble__icon {
  font-size: var(--engine-anchor-icon);
}

/* 宽屏时触发器本体是透明的；鼠标/键盘落在锚点上时，反馈落在当前气泡上 */
.engine-ring.is-anchor-hot .engine-bubble.is-current {
  background: var(--surface-strong);
  box-shadow:
    0 0 0 3px var(--brand-ring),
    0 16px 34px -18px var(--brand-ring),
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.engine-bubble::after {
  content: '';
  position: absolute;
  top: 17%;
  left: 21%;
  width: 24%;
  height: 18%;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.9);
  opacity: 0.5;
  pointer-events: none;
}

html.dark .engine-bubble::after {
  opacity: 0.25;
}

.engine-bubble:hover {
  background: var(--surface-strong);
  box-shadow:
    var(--shadow-3),
    0 0 0 2px var(--brand-ring),
    inset 0 1px 0 var(--line-inset);
}

.engine-bubble:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}

.engine-bubble__icon {
  position: relative;
  z-index: 1;
  font-size: var(--engine-bubble-icon);
  line-height: 1;
  transition: font-size var(--dur-base) var(--ease-out);
}

/* 减少动态时不要保留逐颗延迟：全局只清 animation-delay，transition-delay 得在这里补上 */
@media (prefers-reduced-motion: reduce) {
  .engine-bubble {
    transition-delay: 0ms !important;
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---- 输入 ---- */
.search-input {
  min-width: 0;
  flex: 1;
  padding: 0.55rem 0.6rem;
  border: 0;
  background: transparent;
  color: var(--text-1);
  font-family: inherit;
  font-size: 0.98rem;
  letter-spacing: 0.005em;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-3);
}

/* ---- 提交 ---- */
.search-submit {
  display: inline-grid;
  flex-shrink: 0;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--brand);
  color: var(--text-on-accent);
  font-size: 1rem;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    opacity var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
}

.search-submit:hover:not(:disabled) {
  background: var(--brand-hover);
  box-shadow: 0 10px 24px -14px var(--brand-ring);
}

.search-submit:active:not(:disabled) {
  transform: scale(0.92);
}

/* 空查询时不是「不可用的灰按钮」，而是安静地退到背景里：
   仍然可见（用户知道这里有搜索），但不抢视线。 */
.search-submit:disabled {
  background: transparent;
  color: var(--text-3);
  box-shadow: none;
  cursor: default;
}

/* ---- 引擎下拉 ----
   z-index 必须高于磁贴带（--z-content），否则磁贴的编辑按钮会盖在菜单上
   （截图里能看到「整理」和磁贴名从菜单里透出来）。
   背景也要足够实：这里是七行文字，糊了就直接不可读。 */
.engine-menu {
  position: absolute;
  top: calc(100% + 0.5rem);
  left: 0;
  right: 0;
  z-index: var(--z-menu);
  max-height: 19rem;
  margin: 0;
  padding: 0.4rem;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-surface);
  background: var(--surface-strong);
  backdrop-filter: blur(28px) saturate(170%);
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  box-shadow:
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.engine-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-inner);
  color: var(--text-2);
  font-size: 0.88rem;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.engine-option:hover {
  background: var(--surface-sunken);
  color: var(--text-1);
}

/* 键盘高亮与鼠标悬停是同一套视觉，指针和键盘用户的反馈一致 */
.engine-option.is-active {
  background: var(--brand-soft);
  color: var(--text-1);
}

.engine-option__icon {
  font-size: 1.15rem;
  line-height: 1;
}

.engine-option__label {
  flex: 1;
}

.engine-option__check {
  color: var(--brand-vivid);
  font-size: 0.9rem;
}

/* ---- 响应式 ----
   环需要左侧留白：宽度不够时先收半径和气泡，再窄就放不下，退回
   「锚点气泡 + 下拉列表」；矮视口同理（环会压到问候语 / 快捷方式行）。 */
/* 环在场时，左边那个按钮只负责点击与焦点：视觉完全由环上的当前气泡承担。
   这样所有气泡可以作为一个整体旋转，锚点位置永远有一颗「选中」气泡。 */
@media (min-width: 1181px) and (min-height: 641px) {
  .has-engine-ring .engine-trigger,
  .has-engine-ring .engine-trigger:hover {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .has-engine-ring .engine-trigger::after {
    display: none;
  }

  .has-engine-ring .engine-trigger__icon {
    opacity: 0;
  }

  .has-engine-ring .engine-trigger:active {
    transform: none;
  }
}

@media (max-width: 1360px) {
  .search-root {
    --engine-ring-radius: 48px;
    --engine-bubble-size: 1.875rem;
    --engine-bubble-icon: 0.95rem;
  }
}

@media (max-width: 1200px) {
  .search-root {
    --engine-ring-radius: 44px;
    --engine-bubble-size: 1.75rem;
    --engine-bubble-icon: 0.9rem;
    --engine-anchor-size: 2.375rem;
    --engine-anchor-half: 1.1875rem;
    --engine-anchor-icon: 1.15rem;
  }
}

@media (max-width: 1180px) {
  .engine-ring {
    display: none;
  }
}

@media (max-height: 640px) {
  .engine-ring {
    display: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .engine-trigger,
  .engine-bubble {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--surface-strong);
  }
}

/* ---- 过渡 ---- */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
  transform-origin: top center;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.985);
}
</style>
