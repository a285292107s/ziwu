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
}>(), {
  openInNewTab: false,
})

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
 * Tab 轮换引擎时的「已走过几个」。
 * -1 表示还没开始走（每次输入框重新获得焦点都会重置），
 * 走到最后一个引擎时再按 Tab 就把焦点让给浏览器。
 *
 * 名字不要叫 tabIndex：那会撞上全局的 `tabIndex`，编译后赋值落到全局变量上，
 * 计数永远停在初值，Tab 就再也出不去（这个 bug 实测过）。
 */
const tabsRotated = ref(-1)

/** 当前引擎；storage 里存的是旧 key 时自动回退到默认引擎 */
const current = computed(() => getSearchEngine(searchEngineKey.value))

function currentIndexOf() {
  return searchEngines.findIndex(engine => engine.key === current.value.key)
}

function openDropdown() {
  open.value = true
  activeIndex.value = currentIndexOf()
}

function closeDropdown() {
  open.value = false
  activeIndex.value = -1
}

function selectEngine(key: string) {
  // 写入 browser.storage.local，其他新标签页 / 设置页会自动同步
  searchEngineKey.value = key
  closeDropdown()
  inputRef.value?.focus()
}

/** 轮换引擎，step 可为负 */
function rotate(step: number) {
  searchEngineKey.value = cycleSearchEngine(current.value.key, step).key
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
  // 输入法正在组词时，这些按键是**输入法在用**，不是用户在操作搜索框：
  // 拼音/五笔候选词要靠回车确认、Esc 取消，都会照常派发 keydown。
  // 不挡掉的话，在搜索框里打「知乎」并敲回车选词，会被直接送去搜索 ——
  // 中文用户第一次用就会撞上（浏览器在组词期间会把 isComposing 置为 true）。
  if (event.isComposing)
    return

  switch (event.key) {
    case 'Tab': {
      // Tab / Shift+Tab 在引擎之间前后轮换。
      //
      // 关键细节：preventDefault() 一定要在「确定要拦截」之后才调用。
      // 之前写成先 preventDefault、再在轮换走完时 return，结果那一次 Tab
      // 既没轮换、也没让浏览器移焦点（preventDefault 已经生效了），
      // 焦点永远出不去。现在把判断放在前面，出口那一次压根不拦。
      const last = searchEngines.length - 1

      if (event.shiftKey) {
        // 反向：走回起点后放手，焦点退回引擎按钮
        if (tabsRotated.value <= 0) {
          tabsRotated.value = -1
          return
        }
        event.preventDefault()
        tabsRotated.value -= 1
        rotate(-1)
        return
      }

      // 正向：走完一轮后放手，焦点交给浏览器（下一个是搜索按钮，再往下是磁贴）
      if (tabsRotated.value >= last) {
        tabsRotated.value = -1
        return
      }
      event.preventDefault()
      tabsRotated.value += 1
      rotate(1)
      break
    }

    case 'ArrowDown':
      event.preventDefault()
      if (!open.value)
        openDropdown()
      else
        activeIndex.value = (activeIndex.value + 1) % searchEngines.length
      break

    case 'ArrowUp':
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
      if (open.value)
        closeDropdown()
      // 组词中的 Esc 已经被上面挡掉了，走到这里是「清空输入」
      else
        query.value = ''
      break
  }
}

function onDocumentClick(event: MouseEvent) {
  if (!open.value)
    return
  if (rootRef.value && !rootRef.value.contains(event.target as Node))
    closeDropdown()
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onUnmounted(() => document.removeEventListener('click', onDocumentClick))

// 引擎被其他页面改掉时，同步下拉高亮
watch(searchEngineKey, () => {
  if (open.value)
    activeIndex.value = currentIndexOf()
})

// 键盘上下移动高亮时，把高亮项滚进可视区（列表限高，7 个引擎放不下）
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
  <div ref="rootRef" class="search-root">
    <div class="search-shell" :class="{ 'is-open': open }">
      <!-- 引擎切换：图标 + 下拉箭头。左侧留出内边距形成控件的「起点」 -->
      <!-- 这个按钮刻意不挂 .focus-ring：它是搜索框这个整体的左半边，
           自己再画一圈 outline 会在胶囊内部鼓出一个圆形描边
           （截图里看得很明显）。焦点反馈由 .search-shell:focus-within 统一给，
           Tab 走到这里时整个胶囊亮起来，比局部描边更清楚。 -->
      <button
        type="button"
        class="engine-trigger"
        :aria-label="`当前搜索引擎：${current.label}`"
        :aria-expanded="open"
        aria-haspopup="listbox"
        data-test="engine-trigger"
        @click="open ? closeDropdown() : openDropdown()"
      >
        <span
          :class="current.icon"
          class="engine-trigger__icon"
          :style="{ color: engineColor(current, isDark) }"
        />
        <span
          class="i-carbon-chevron-down engine-trigger__caret"
          :class="{ 'is-flipped': open }"
        />
      </button>

      <span class="search-divider" aria-hidden="true" />

      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="search-input"
        :placeholder="`在 ${current.placeholder} 中搜索`"
        :aria-label="`使用 ${current.label} 搜索`"
        autocomplete="off"
        spellcheck="false"
        data-test="search-input"
        @focus="tabsRotated = -1"
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
  padding: 0.4rem 0.4rem 0.4rem 0.45rem;
  border: 1px solid var(--line-strong);
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

.search-shell:focus-within,
.search-shell.is-open {
  border-color: var(--focus);
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset),
    0 0 0 3px var(--brand-ring);
}

/* ---- 引擎切换 ---- */
.engine-trigger {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.1rem;
  height: 2.35rem;
  padding: 0 0.5rem 0 0.6rem;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

/* 引擎按钮自己不再画焦点环：它是搜索框这个整体的左半边，
   再叠一圈 outline 会撑大整个胶囊（截图里能看到左边鼓出一块）。
   焦点反馈统一交给 .search-shell:focus-within。 */
.engine-trigger:focus {
  outline: none;
}

.engine-trigger:hover {
  background: var(--surface-sunken);
  color: var(--text-1);
}

.engine-trigger__icon {
  font-size: 1.05rem;
  line-height: 1;
}

.engine-trigger__caret {
  font-size: 0.75rem;
  transition: transform var(--dur-base) var(--ease-out);
}

.engine-trigger__caret.is-flipped {
  transform: rotate(180deg);
}

.search-divider {
  flex-shrink: 0;
  width: 1px;
  height: 1.35rem;
  background: var(--line);
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
