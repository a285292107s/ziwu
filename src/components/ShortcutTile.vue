<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRealFavicon } from '~/composables/useFavicon'
import {
  shortcutDomain,
  shortcutInitial,
} from '~/logic/shortcuts'
import type { Shortcut } from '~/logic/shortcuts'

const props = withDefaults(defineProps<{
  shortcut: Shortcut
  accent: string
  editing: boolean
  index: number
  total: number
  openInNewTab?: boolean
  tabIndex?: number
  active?: boolean
}>(), {
  openInNewTab: false,
  tabIndex: 0,
  active: false,
})

const emit = defineEmits<{
  (e: 'move', from: number, to: number): void
  (e: 'edit', shortcut: Shortcut): void
  (e: 'remove', shortcut: Shortcut): void
}>()

const domain = computed(() => shortcutDomain(props.shortcut.url))
const initial = computed(() => shortcutInitial(props.shortcut.name, props.shortcut.url))

const { showIcon, iconSrc, resolve, onIconError } = useRealFavicon(() => props.shortcut.url)

watch(() => props.shortcut.url, () => resolve())

function moveBy(step: -1 | 1) {
  const target = props.index + step
  if (target < 0 || target >= props.total)
    return

  emit('move', props.index, target)
}
</script>

<template>
  <div
    class="tile"
    :class="editing ? 'is-editing' : ''"
    :data-test="`shortcut-tile-${shortcut.id}`"
    :style="{ '--tile-accent': accent }"
  >
    <a
      :href="editing ? undefined : shortcut.url"
      :target="openInNewTab ? '_blank' : undefined"
      :rel="openInNewTab ? 'noreferrer' : undefined"
      :title="editing ? undefined : `${shortcut.name} · ${domain}`"
      :aria-label="editing ? undefined : `${shortcut.name}（${domain}）`"
      :tabindex="tabIndex"
      class="tile-face focus-ring"
      draggable="false"
      @click="editing ? $event.preventDefault() : undefined"
    >
      <span class="tile-aurora" aria-hidden="true" />

      <img
        v-if="showIcon && iconSrc"
        :src="iconSrc"
        alt=""
        aria-hidden="true"
        class="tile-icon"
        loading="lazy"
        decoding="async"
        @error="onIconError"
      >
      <span
        v-else
        aria-hidden="true"
        class="tile-initial"
      >{{ initial }}</span>
    </a>

    <span class="tile-name">
      {{ shortcut.name }}
    </span>

    <div
      v-if="editing"
      class="tile-actions"
      :data-test="`tile-actions-${shortcut.id}`"
    >
      <button
        type="button"
        class="tile-action focus-ring"
        :tabindex="active ? 0 : -1"
        aria-label="编辑这个快捷方式"
        :data-test="`tile-edit-${shortcut.id}`"
        @click="emit('edit', shortcut)"
      >
        <span class="i-carbon-edit" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">编辑</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--danger focus-ring"
        :tabindex="active ? 0 : -1"
        aria-label="删除这个快捷方式"
        :data-test="`tile-delete-${shortcut.id}`"
        @click="emit('remove', shortcut)"
      >
        <span class="i-carbon-close" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">删除</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :tabindex="active ? 0 : -1"
        :aria-disabled="index === 0"
        :aria-label="`将 ${shortcut.name} 前移`"
        :data-test="`tile-left-${shortcut.id}`"
        @click="moveBy(-1)"
      >
        <span class="i-carbon-arrow-left" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">{{ index === 0 ? '已到最前' : '前移' }}</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :tabindex="active ? 0 : -1"
        :aria-disabled="index === total - 1"
        :aria-label="`将 ${shortcut.name} 后移`"
        :data-test="`tile-right-${shortcut.id}`"
        @click="moveBy(1)"
      >
        <span class="i-carbon-arrow-right" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">{{ index === total - 1 ? '已到最后' : '后移' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  --tile-glow: color-mix(in srgb, var(--tile-accent) 42%, transparent);
}

.tile-face {
  position: relative;
  display: grid;
  place-items: center;
  width: 3.75rem;
  height: 3.75rem;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-tile);
  background: var(--surface);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow:
    var(--shadow-tile),
    inset 0 1px 0 var(--line-inset);
  transition:
    transform var(--dur-base) var(--ease-spring),
    box-shadow var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}

.tile-aurora {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--tile-aurora);
  transition: opacity var(--dur-base) var(--ease-out);
}

a.tile-face:hover {
  transform: translateY(-5px);
  border-color: color-mix(in srgb, var(--tile-accent) 42%, var(--line));
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-tile-hover),
    inset 0 1px 0 var(--line-inset);
}

a.tile-face:hover .tile-aurora {
  opacity: 1;
}

a.tile-face:hover .tile-icon,
a.tile-face:hover .tile-initial {
  transform: scale(1.05);
}

a.tile-face:active {
  transform: translateY(-1px);
  transition-duration: var(--dur-fast);
}

a.tile-face:active .tile-icon,
a.tile-face:active .tile-initial {
  transform: scale(0.94);
}

.tile.is-editing .tile-face {
  cursor: default;
}

.tile-icon {
  position: relative;
  width: 1.75rem;
  height: 1.75rem;
  object-fit: contain;
  transition: transform var(--dur-base) var(--ease-spring);
}

.tile-initial {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border: 1.5px solid color-mix(in srgb, var(--tile-accent) 62%, transparent);
  border-radius: var(--radius-inner);
  background: var(--surface-strong);
  color: var(--text-1);
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  transition:
    transform var(--dur-base) var(--ease-spring),
    background var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out);
}

a.tile-face:hover .tile-initial {
  border-color: var(--tile-accent);
  background: var(--tile-accent);
  color: var(--tile-ink);
}

.tile-name {
  max-width: 5.5rem;
  overflow: hidden;
  color: var(--text-2);
  font-size: 0.73rem;
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur-base) var(--ease-out);
}

a.tile-face:hover ~ .tile-name {
  color: var(--text-1);
}

.tile.is-editing .tile-name {
  color: var(--text-3);
}

.tile-actions {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(2, 1.5rem);
  gap: 0.2rem;
  justify-content: center;
}

.tile-action {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface-strong);
  color: var(--text-2);
  font-size: 0.78rem;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.tile-action--reorder {
  opacity: 0;
  pointer-events: none;
}

.tile:hover .tile-action--reorder {
  opacity: 1;
  pointer-events: auto;
}

.tile:focus-within .tile-action--reorder {
  opacity: 1;
  pointer-events: auto;
  transition: none;
}

.tile-action:hover:not([aria-disabled='true']) {
  border-color: var(--brand);
  background: var(--brand);
  color: var(--text-on-accent);
}

.tile-action:active:not([aria-disabled='true']) {
  transform: scale(0.9);
}

.tile-action[aria-disabled='true'] {
  color: var(--text-3);
  cursor: not-allowed;
}

.tile-action--danger:hover:not([aria-disabled='true']) {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--danger-ink);
}

.tile-tip {
  position: absolute;
  bottom: calc(100% + 0.4rem);
  left: 50%;
  z-index: calc(var(--z-toast) + 2);
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-base);
  color: var(--text-1);
  font-size: 0.66rem;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateX(-50%) translateY(3px);
  box-shadow: var(--shadow-2);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.tile-action:hover .tile-tip,
.tile-action:focus-visible .tile-tip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.tile-action:focus-visible .tile-tip {
  transition: none;
}

@media (forced-colors: active) {
  .tile-tip {
    border: 1px solid CanvasText;
    background: Canvas;
    color: CanvasText;
  }
}
</style>
