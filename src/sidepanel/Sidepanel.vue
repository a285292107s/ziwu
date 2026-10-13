<script setup lang="ts">
import { useTheme } from '~/composables/useTheme'

/**
 * 侧边栏。
 *
 * 直接复用新标签页那套快捷方式组件（自己带增删改 / 排序 / 撤销），
 * 所以侧边栏天然就是一个「随手管理 + 快速打开」的面板，不需要另写一套。
 */

const { isDark, themeIcon, toggleTheme } = useTheme()

function openOptionsPage() {
  browser.runtime.openOptionsPage()
}
</script>

<template>
  <main class="sidepanel">
    <header class="sidepanel__head">
      <span class="sidepanel__mark" aria-hidden="true">M</span>
      <span class="sidepanel__title">子午 Meridiem</span>

      <button
        type="button"
        class="sidepanel__icon-button focus-ring"
        :aria-label="`当前${isDark ? '深色' : '浅色'}主题，点击切换`"
        @click="toggleTheme"
      >
        <span :class="themeIcon" class="text-sm" aria-hidden="true" />
      </button>

      <button
        type="button"
        class="sidepanel__icon-button focus-ring"
        aria-label="打开设置"
        @click="openOptionsPage"
      >
        <span class="i-carbon-settings text-sm" aria-hidden="true" />
      </button>
    </header>

    <!-- 侧边栏里点磁贴开新标签页：同标签页跳转会把侧边栏自己顶掉 -->
    <ShortcutGrid open-in-new-tab />
  </main>
</template>

<style scoped>
.sidepanel {
  min-height: 100vh;
  padding: 1rem 0.9rem 2rem;
  color: var(--text-1);
  background: var(--bg-base);
}

.sidepanel__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.sidepanel__mark {
  display: grid;
  place-items: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--radius-inner);
  background: var(--brand);
  color: var(--text-on-accent);
  font-family: var(--font-display);
  font-size: 0.78rem;
  font-weight: 700;
}

.sidepanel__title {
  flex: 1;
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 600;
}

.sidepanel__icon-button {
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.sidepanel__icon-button:hover {
  border-color: var(--line-strong);
  background: var(--surface-hover);
  color: var(--text-1);
}
</style>
