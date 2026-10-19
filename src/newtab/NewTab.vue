<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref } from 'vue'
import KeyHints from '~/components/KeyHints.vue'
import SkyBackdrop from '~/components/SkyBackdrop.vue'
import { paletteFor, phaseForHour } from '~/logic/ambience'
import { keyHints } from '~/logic/keyHints'
import type { KeyHintAction } from '~/logic/keyHints'
import { PAGE_BEAT_MS } from '~/logic/motion'
import { parseSkyOverride } from '~/logic/sky'
import { useTheme } from '~/composables/useTheme'
import { greeting } from '~/logic/storage'

const { isDark, setTheme } = useTheme()

const skyOverride = parseSkyOverride(window.location.search)

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

const phase = computed(() => phaseForHour(now.value.getHours()))
const palette = computed(() => paletteFor(phase.value, isDark.value))

const backdropStyle = computed(() => ({
  '--amb-from': palette.value.from,
  '--amb-to': palette.value.to,
  '--amb-glow': palette.value.glow,
}))

const beatStyle = { '--beat': `${PAGE_BEAT_MS}ms` }

interface SearchBoxApi { focusInput: () => void, inputEl: () => HTMLInputElement | null }
interface ShortcutGridApi {
  focusGrid: () => void
  toggleEditing: () => void
  openCreate: () => void
  isKeyboardLocked: () => boolean
}
const search = ref<SearchBoxApi | null>(null)
const shortcutGrid = ref<ShortcutGridApi | null>(null)
const settingsButton = ref<HTMLButtonElement | null>(null)
const greetingInput = ref<HTMLInputElement | null>(null)
let firstEntryPending = true
let restoringBlankFocus = false

function onFirstEnterFocus(event: FocusEvent) {
  if (restoringBlankFocus || !firstEntryPending || event.relatedTarget)
    return

  const target = event.target
  if (!(target instanceof HTMLElement) || !target.matches(':focus-visible'))
    return

  firstEntryPending = false

  const input = search.value?.inputEl()
  if (!input || target === input || target.contains(input) || input.contains(target))
    return

  if (!(input.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING))
    return

  search.value?.focusInput()
}

onMounted(() => document.addEventListener('focusin', onFirstEnterFocus))
onBeforeUnmount(() => document.removeEventListener('focusin', onFirstEnterFocus))

function pageHasNoFocusedControl() {
  const active = document.activeElement
  return active === document.body || active === document.documentElement
}

function focusSearchFromBlank() {
  const input = search.value?.inputEl()
  if (!input)
    return false

  restoringBlankFocus = true
  input.focus()
  restoringBlankFocus = false
  return true
}

const editingGreeting = ref(false)

function openOptionsPage() {
  browser.runtime.openOptionsPage()
}

const hintsVisible = ref(false)

function focusPageStart() {
  settingsButton.value?.focus()
}

function toggleTheme() {
  setTheme(isDark.value ? 'light' : 'dark')
}

async function startGreetingEdit() {
  editingGreeting.value = true
  await nextTick()
  greetingInput.value?.focus()
  greetingInput.value?.select()
}

const shortcutActions: Record<KeyHintAction, () => void> = {
  settings: openOptionsPage,
  theme: toggleTheme,
  greeting: startGreetingEdit,
  search: () => search.value?.focusInput(),
  grid: () => shortcutGrid.value?.focusGrid(),
  manage: () => shortcutGrid.value?.toggleEditing(),
  add: () => shortcutGrid.value?.openCreate(),
}

function shortcutLocked() {
  return shortcutGrid.value?.isKeyboardLocked() ?? false
}

function onWindowKeydown(event: KeyboardEvent) {
  if (
    event.key === 'Tab'
    && !event.altKey && !event.ctrlKey && !event.metaKey
    && !shortcutLocked()
    && pageHasNoFocusedControl()
  ) {
    if (focusSearchFromBlank()) {
      event.preventDefault()
      return
    }
  }

  if (event.key === 'Alt') {
    if (event.repeat)
      return
    if (shortcutLocked()) {
      hintsVisible.value = false
      return
    }
    hintsVisible.value = true
    event.preventDefault()
    return
  }

  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return
  if (event.isComposing || event.repeat)
    return

  const hint = keyHints.find(item => item.key === event.key.toLowerCase())
  if (!hint || shortcutLocked())
    return

  event.preventDefault()
  shortcutActions[hint.action]()
}

function onWindowKeyup(event: KeyboardEvent) {
  if (event.key !== 'Alt')
    return
  hintsVisible.value = false
  event.preventDefault()
}

function hideHints() {
  hintsVisible.value = false
}

function onVisibilityChange() {
  if (document.hidden)
    hideHints()
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('keyup', onWindowKeyup)
  window.addEventListener('blur', hideHints)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('blur', hideHints)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <main
    class="newtab-root"
    :style="[backdropStyle, beatStyle]"
    :data-phase="phase"
  >
    <SkyBackdrop :dark="isDark" :override="skyOverride" />

    <div class="vignette" aria-hidden="true" />

    <div class="grain" aria-hidden="true" />

    <header class="masthead">
      <span class="brand">
        <span class="brand__tick" aria-hidden="true" />
        <span class="brand__word" lang="zh-Hans">子午</span>
        <span class="brand__latin" lang="en">Ziwu</span>
      </span>

      <div class="masthead__controls">
        <button
          ref="settingsButton"
          type="button"
          class="ghost-control focus-ring"
          aria-keyshortcuts="Alt+S"
          data-test="open-options"
          @click="openOptionsPage"
        >
          <span class="i-carbon-settings-adjust" aria-hidden="true" />
          设置
        </button>

        <div class="theme-switch" role="group" aria-label="主题" aria-keyshortcuts="Alt+T">
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

    <div class="shell">
      <section class="hero">
        <div class="clock-block">
          <h1 class="clock" data-test="clock">
            <span class="clock__main">{{ clockMain }}</span>
            <span class="clock__seconds" aria-hidden="true">{{ clockSeconds }}</span>
          </h1>
          <p class="clock-date" data-test="clock-date">
            {{ date }}
          </p>
        </div>

        <div class="greeting-block">
          <div
            v-if="!editingGreeting"
            class="greeting focus-ring"
            title="点击编辑"
            tabindex="0"
            role="button"
            aria-keyshortcuts="Alt+H"
            data-test="greeting"
            @click="editingGreeting = true"
            @keydown.enter.prevent="editingGreeting = true"
            @keydown.space.prevent="editingGreeting = true"
          >
            {{ greeting }}
          </div>
          <input
            v-else
            ref="greetingInput"
            v-model="greeting"
            class="greeting-input"
            aria-label="编辑问候语"
            aria-keyshortcuts="Alt+H"
            data-test="greeting-input"
            @blur="editingGreeting = false"
            @keyup.enter="editingGreeting = false"
          >
        </div>

        <SearchBox
          ref="search"
          autofocus
          tab-cycles-engines
          @exit="focusPageStart"
        />
      </section>

      <div class="shortcuts-band">
        <ShortcutGrid ref="shortcutGrid" keyboard-shortcuts />
      </div>
    </div>

    <KeyHints :visible="hintsVisible" />
  </main>
</template>

<style scoped>
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

.vignette {
  position: fixed;
  inset: 0;
  z-index: var(--z-ambience);
  pointer-events: none;
  background: radial-gradient(128% 96% at 50% 38%, transparent 46%, var(--bg-deep) 132%);
  opacity: 0.5;
}

.grain {
  position: fixed;
  inset: 0;
  z-index: var(--z-grain);
  pointer-events: none;
  opacity: var(--grain-opacity, 0.4);
  mix-blend-mode: soft-light;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E");
}

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
  gap: 0.42rem;
  font-family: var(--font-display);
  color: var(--text-1);
}

.brand__tick {
  width: 0.85rem;
  height: 2px;
  border-radius: 2px;
  background: var(--brand-vivid);
}

.brand__word {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1;
}

.brand__latin {
  font-size: 0.58rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  line-height: 1;
  color: var(--text-2);
}

.masthead__controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

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

.hero :deep(.search-shell) {
  animation: rise-in var(--dur-enter) var(--ease-out) calc(var(--beat) * 2) both;
}

.hero :deep(.search-root) {
  margin-top: clamp(1.85rem, 4.5vh, 2.75rem);
}

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
