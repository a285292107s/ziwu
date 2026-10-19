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
  openInNewTab?: boolean
  autofocus?: boolean
  engineRing?: boolean
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
const menuRef = ref<HTMLElement | null>(null)

const open = ref(false)
const activeIndex = ref(-1)
const engaged = ref(false)

let suppressMountFocus = false
const current = computed(() => getSearchEngine(searchEngineKey.value))

function currentIndexOf() {
  return searchEngines.findIndex(engine => engine.key === current.value.key)
}

const RING_STEP_DEG = 360 / searchEngines.length
const RING_REVEAL_STAGGER_MS = 30
const ringPhase = ref(-currentIndexOf() * RING_STEP_DEG)

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
      exitDelay: ringDistance * 36,
      exitX: Math.cos(rad) * drift,
      exitY: Math.sin(rad) * drift - 4,
      isCurrent: index === currentIndex,
    }
  })
})

watch(() => current.value.key, () => {
  const target = -currentIndexOf() * RING_STEP_DEG
  const delta = ((target - ringPhase.value) % 360 + 540) % 360 - 180
  if (Math.abs(delta) > 0.001)
    ringPhase.value += delta
})

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

const anchorHovered = ref(false)
const anchorFocused = ref(false)

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
  dismissRing()
  searchEngineKey.value = key
  announceEngine(getSearchEngine(key))
  closeDropdown()
  inputRef.value?.focus()
}

function rotate(step: number) {
  ringPhase.value -= step * RING_STEP_DEG
  const next = cycleSearchEngine(current.value.key, step)
  searchEngineKey.value = next.key
  announceEngine(next)
  if (open.value)
    activeIndex.value = currentIndexOf()
}

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

function onSubmitAuxClick(event: MouseEvent) {
  if (event.button !== 1)
    return

  event.preventDefault()
  submit(true)
}

function onKeydown(event: KeyboardEvent) {
  engaged.value = true

  if (event.isComposing)
    return

  switch (event.key) {
    case 'Tab': {
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
        submit(event.ctrlKey || event.metaKey)
      }
      break

    case 'Escape':
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

function onInputFocus() {
  dismissRing()

  if (suppressMountFocus) {
    suppressMountFocus = false
    return
  }

  engaged.value = true
}

onMounted(() => {
  if (!props.autofocus)
    return

  suppressMountFocus = true
  inputRef.value?.focus({ preventScroll: true })
  queueMicrotask(() => {
    suppressMountFocus = false
  })
})

defineExpose({
  focusInput: () => inputRef.value?.focus({ preventScroll: true }),
  inputEl: () => inputRef.value,
})

watch(searchEngineKey, () => {
  if (open.value)
    activeIndex.value = currentIndexOf()
})

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
.search-root {
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

.search-shell.is-engaged:focus-within,
.search-shell.is-open {
  border-color: var(--focus);
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset),
    0 0 0 3px var(--brand-ring);
}

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

.engine-ring {
  position: absolute;
  top: 50%;
  left: calc(var(--search-shell-border) + var(--search-shell-pad-left) + var(--engine-anchor-half) - var(--engine-ring-radius));
  z-index: var(--z-content);
  width: 0;
  height: 0;
  pointer-events: none;
  animation: rise-in var(--dur-enter) var(--ease-out) calc(var(--beat, 60ms) * 2) both;
}

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

.engine-ring:not(.is-revealed) .engine-bubble:not(.is-current) {
  opacity: 0;
  scale: 0.9;
  translate: var(--exit-x, 0px) var(--exit-y, 0px);
  filter: blur(2px);
  pointer-events: none;
  --bubble-dur: var(--dur-enter);
  --bubble-delay: var(--exit-delay, 0ms);
}

.engine-ring.is-revealed .engine-bubble:not(.is-current) {
  opacity: 1;
  scale: 1;
  translate: 0 0;
  filter: none;
  --bubble-dur: var(--dur-base);
  --bubble-delay: var(--reveal-delay, 0ms);
}

.engine-ring.is-revealed .engine-bubble.is-current {
  scale: 1.03;
}

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

.search-submit:disabled {
  background: transparent;
  color: var(--text-3);
  box-shadow: none;
  cursor: default;
}

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
