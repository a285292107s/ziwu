<script setup lang="ts">
import { useTheme } from '~/composables/useTheme'

/**
 * 工具栏弹窗。
 *
 * 弹窗空间很小，只放「最常做的两件事」：打开设置、切换主题。
 * 不做成第二个设置页，避免和新标签页/设置页三处维护同一套 UI。
 */

const { isDark, themeIcon, toggleTheme } = useTheme()

function openOptionsPage() {
  browser.runtime.openOptionsPage()
}
</script>

<template>
  <main class="popup">
    <div class="popup__head">
      <span class="popup__mark" aria-hidden="true">M</span>
      <div>
        <div class="popup__title">
          子午 Meridiem
        </div>
        <div class="popup__sub">
          新标签页
        </div>
      </div>
    </div>

    <div class="popup__actions">
      <button
        type="button"
        class="popup__button primary-control focus-ring"
        data-test="popup-open-options"
        @click="openOptionsPage"
      >
        <span class="i-carbon-settings text-sm" aria-hidden="true" />
        打开设置
      </button>

      <button
        type="button"
        class="popup__button ghost-control focus-ring"
        :aria-pressed="isDark"
        :aria-label="`当前${isDark ? '深色' : '浅色'}主题，点击切换`"
        @click="toggleTheme"
      >
        <span :class="themeIcon" class="text-sm" aria-hidden="true" />
        {{ isDark ? '浅色' : '深色' }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.popup {
  width: 250px;
  padding: 1rem;
  color: var(--text-1);
  background: var(--bg-base);
}

.popup__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.9rem;
}

.popup__mark {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-inner);
  background: var(--brand);
  color: var(--text-on-accent);
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
}

.popup__title {
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.2;
}

.popup__sub {
  font-size: 0.72rem;
  color: var(--text-2);
}

.popup__actions {
  display: flex;
  gap: 0.5rem;
}

/* 弹窗只有 250px 宽，两个按钮并排：配色与交互沿用全局控件，
   这里只把尺寸压到弹窗需要的一档，否则「打开设置」会被挤成两行。 */
.popup__button {
  flex: 1;
  padding: 0.5rem 0.6rem;
  font-size: 0.78rem;
}
</style>
