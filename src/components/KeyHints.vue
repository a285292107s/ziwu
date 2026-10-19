<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { keyHints } from '~/logic/keyHints'
import type { KeyHintConfig } from '~/logic/keyHints'

const props = defineProps<{ visible: boolean }>()

interface PositionedHint {
  config: KeyHintConfig
  x: number
  y: number
  transform: string
}

const hints = ref<PositionedHint[]>([])
let measureFrame = 0

function isVisibleInViewport(target: HTMLElement, rect: DOMRect) {
  if (rect.width < 2 || rect.height < 2)
    return false

  const style = getComputedStyle(target)
  if (style.visibility === 'hidden' || Number(style.opacity) < 0.01)
    return false

  const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
  const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
  return (visibleWidth * visibleHeight) / (rect.width * rect.height) >= 0.5
}

function measure() {
  const found: PositionedHint[] = []

  for (const config of keyHints) {
    const target = document.querySelector<HTMLElement>(config.selector)
    if (!target)
      continue

    const rect = target.getBoundingClientRect()
    if (!isVisibleInViewport(target, rect))
      continue

    const gap = 8
    let x = rect.left
    let y = rect.bottom + gap
    let transform = ''

    switch (config.placement) {
      case 'above':
        y = rect.top - gap
        transform = 'translateY(-100%)'
        break
      case 'right':
        x = rect.right + gap
        y = rect.top + rect.height / 2
        transform = 'translateY(-50%)'
        break
      case 'left':
        x = rect.left - gap
        y = rect.top + rect.height / 2
        transform = 'translate(-100%, -50%)'
        break
      case 'below':
      default:
        break
    }

    const reserve = 180
    if (config.placement === 'left')
      x = Math.max(x, reserve)
    else
      x = Math.min(Math.max(x, 8), window.innerWidth - reserve)
    y = Math.min(Math.max(y, 8), window.innerHeight - 40)

    found.push({
      config,
      x: Math.round(x),
      y: Math.round(y),
      transform,
    })
  }

  hints.value = found
}

function scheduleMeasure() {
  if (measureFrame)
    cancelAnimationFrame(measureFrame)
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    measure()
  })
}

watch(() => props.visible, async (visible) => {
  if (!visible)
    return
  await nextTick()
  scheduleMeasure()
})

function onViewportChange() {
  if (props.visible)
    scheduleMeasure()
}

onMounted(() => {
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  if (measureFrame)
    cancelAnimationFrame(measureFrame)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="key-hints">
      <div v-if="visible" class="key-hints" aria-hidden="true">
        <span
          v-for="hint in hints"
          :key="hint.config.action"
          class="key-hint"
          :style="{ left: `${hint.x}px`, top: `${hint.y}px`, transform: hint.transform }"
        >
          <kbd class="kbd">{{ hint.config.key === '/' ? '/' : hint.config.key.toUpperCase() }}</kbd>
          <span class="key-hint__label">{{ hint.config.label }}</span>
          <span v-if="hint.config.detail" class="key-hint__detail">{{ hint.config.detail }}</span>
        </span>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.key-hints {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  pointer-events: none;
}

.key-hint {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.55rem 0.3rem 0.4rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface-strong);
  color: var(--text-2);
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  box-shadow:
    var(--shadow-2),
    inset 0 1px 0 var(--line-inset);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
}

.key-hint .kbd {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  padding: 0.04rem 0.28rem;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: var(--surface-sunken);
  color: var(--text-1);
}

.key-hint__label {
  color: var(--text-1);
}

.key-hint__detail {
  color: var(--text-3);
  font-weight: 500;
  letter-spacing: 0.04em;
}

.key-hints-enter-active,
.key-hints-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}

.key-hints-enter-from,
.key-hints-leave-to {
  opacity: 0;
}

@media (prefers-reduced-transparency: reduce) {
  .key-hint {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--surface-strong);
  }
}
</style>
