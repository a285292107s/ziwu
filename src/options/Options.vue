<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { useTheme } from '~/composables/useTheme'
import { engineColor, searchEngines } from '~/logic/searchEngines'
import { parseSitesJson } from '~/logic/siteImport'
import type { ImportedSite } from '~/logic/siteImport'
import { greeting, searchEngineKey } from '~/logic/storage'

/**
 * 设置页。
 *
 * 复用新标签页的组件而不是另写一套：
 * - `SearchBox` 用来**即时预览**当前选中的搜索引擎（改完立刻试一下，不用回新标签页）
 * - `ShortcutGrid` 就是新标签页那套完整的增删改 / 排序 / 撤销组件，设置页直接复用
 *
 * 所有设置都写 storage，新标签页通过 storage.onChanged 自动同步，
 * 所以这里不需要「保存」按钮。
 */

const { isDark, themeLabel, themeIcon, toggleTheme } = useTheme()
const { importSites } = useShortcuts()

/* ---------------------------------------------------------------
   批量导入站点
   ---------------------------------------------------------------
   个人站点是**本机数据**，不进源码：仓库里的清单会被打包进扩展产物、
   推上远端，而书签（尤其是自家后台、内网地址、带账号参数的链接）属于隐私。

   所以这里只保留一条路径 ——「粘贴配置导入」：
   解析出的站点写进 `browser.storage.local` 的 `meridiem-shortcuts` 键，
   只留在当前这台机器上，不经过构建、不写入任何文件。
   --------------------------------------------------------------- */
const importOpen = ref(false)
const importText = ref('')
const importError = ref('')
const importStatus = ref('')
let statusTimer: number | undefined

/** 把「加了几条、跳了几条」讲清楚，否则用户看不出有没有生效 */
function reportImportResult(result: { added: number, skipped: number }) {
  importStatus.value = result.added > 0
    ? `已添加 ${result.added} 个站点${result.skipped > 0 ? `，跳过 ${result.skipped} 个（已存在或无效）` : ''}`
    : `没有新增：这 ${result.skipped} 个站点都已经在页面上了`

  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    importStatus.value = ''
  }, 6000)
}

function openImport() {
  importText.value = ''
  importError.value = ''
  importOpen.value = true
}

function closeImport() {
  importOpen.value = false
}

function submitImport() {
  const text = importText.value.trim()
  if (!text) {
    importError.value = '先粘贴 iTab 备份内容'
    return
  }

  let sites: ImportedSite[]
  try {
    sites = parseSitesJson(text)
  }
  catch {
    importError.value = '这段内容不是合法的 JSON，请粘贴完整的 iTab 备份'
    return
  }

  if (sites.length === 0) {
    importError.value = '没有找到网站，确认粘贴的是 iTab 备份（包含 navConfig 或站点数组）'
    return
  }

  reportImportResult(importSites(sites))
  closeImport()
}

function onWindowKeydown(event: KeyboardEvent) {
  if (importOpen.value && event.key === 'Escape')
    closeImport()
}

window.addEventListener('keydown', onWindowKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.clearTimeout(statusTimer)
})
</script>

<template>
  <main class="settings-root">
    <div class="settings-shell">
      <header class="settings-header">
        <h1 class="settings-title">
          子午 Meridiem 设置
        </h1>
        <p class="settings-lede">
          改动会立即生效，已打开的新标签页会自动同步。
        </p>
      </header>

      <!-- ---------------- 外观 ---------------- -->
      <section class="settings-card" aria-labelledby="sec-appearance">
        <h2 id="sec-appearance" class="settings-card__title">
          外观
        </h2>

        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__label">主题</span>
            <span class="settings-row__hint">当前为{{ themeLabel }}</span>
          </div>
          <button
            type="button"
            class="switch-control ghost-control focus-ring"
            :aria-pressed="isDark"
            data-test="options-theme-toggle"
            @click="toggleTheme"
          >
            <span :class="themeIcon" class="text-sm" aria-hidden="true" />
            <span>切换到{{ isDark ? '浅色' : '深色' }}</span>
          </button>
        </div>
      </section>

      <!-- ---------------- 搜索 ---------------- -->
      <section class="settings-card" aria-labelledby="sec-search">
        <h2 id="sec-search" class="settings-card__title">
          默认搜索引擎
        </h2>
        <p class="settings-card__desc">
          新标签页按 <kbd class="kbd">Tab</kbd> 可以在这些引擎之间快速轮换。
        </p>

        <div class="engine-picker" role="radiogroup" aria-label="默认搜索引擎">
          <button
            v-for="engine in searchEngines"
            :key="engine.key"
            type="button"
            role="radio"
            :aria-checked="engine.key === searchEngineKey"
            class="engine-card focus-ring"
            :class="{ 'is-selected': engine.key === searchEngineKey }"
            :style="{ '--engine-color': engineColor(engine, isDark) }"
            :data-test="`engine-option-${engine.key}`"
            @click="searchEngineKey = engine.key"
          >
            <span :class="engine.icon" class="engine-card__icon text-lg" aria-hidden="true" />
            <span class="engine-card__label">{{ engine.label }}</span>
          </button>
        </div>

        <div class="preview">
          <span class="preview__label">试一下</span>
          <!-- 预览里开新标签页：同标签页跳转会把设置页自己顶掉（与磁贴同理） -->
          <SearchBox open-in-new-tab />
        </div>
      </section>

      <!-- ---------------- 问候语 ---------------- -->
      <section class="settings-card" aria-labelledby="sec-greeting">
        <h2 id="sec-greeting" class="settings-card__title">
          问候语
        </h2>

        <label class="field">
          <span class="field__label">显示在时钟下方</span>
          <input
            v-model="greeting"
            class="dialog-input focus-ring"
            placeholder="你好，欢迎回来"
            maxlength="40"
            data-test="options-greeting"
          >
        </label>
        <p class="settings-card__desc">
          留空则不显示。{{ greeting.length }}/40
        </p>
      </section>

      <!-- ---------------- 快捷方式 ---------------- -->
      <section class="settings-card settings-card--flush" aria-labelledby="sec-shortcuts">
        <h2 id="sec-shortcuts" class="settings-card__title">
          快捷方式
        </h2>
        <p class="settings-card__desc">
          按住图标拖到新位置即可排序；点「整理」可以编辑或删除；按 <kbd class="kbd">N</kbd> 快速添加。
        </p>

        <div class="import-bar">
          <button
            type="button"
            class="ghost-control focus-ring"
            data-test="open-import"
            @click="openImport"
          >
            <span class="i-carbon-paste" aria-hidden="true" />
            粘贴配置导入
          </button>
        </div>

        <p class="settings-card__desc">
          导入的站点只保存在本机浏览器 storage 里，不会写进源码或构建产物。
        </p>

        <p
          v-if="importStatus"
          class="import-status"
          role="status"
          data-test="import-status"
        >
          {{ importStatus }}
        </p>

        <div class="shortcuts-host">
          <!-- 设置页里点磁贴开新标签页：同标签页跳转会把设置页自己顶掉 -->
          <ShortcutGrid open-in-new-tab />
        </div>
      </section>
    </div>

    <!-- 粘贴导入对话框 -->
    <Teleport to="body">
      <Transition name="dialog">
        <div
          v-if="importOpen"
          class="import-backdrop"
          @click.self="closeImport"
        >
          <div
            class="import-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
          >
            <h3 id="import-dialog-title" class="import-title">
              导入站点
            </h3>
            <p class="import-desc">
              粘贴 iTab 的备份 JSON（含 <code class="import-code">navConfig</code> 即可）。
              里面的文件夹会被展开成平铺磁贴，已经存在的网址自动跳过。
            </p>

            <textarea
              v-model="importText"
              class="dialog-input import-textarea"
              rows="9"
              spellcheck="false"
              aria-label="iTab 备份内容"
              placeholder="{&quot;navConfig&quot;:[{&quot;name&quot;:&quot;主页&quot;,&quot;children&quot;:[{&quot;name&quot;:&quot;GitHub&quot;,&quot;url&quot;:&quot;https://github.com/&quot;}]}]}"
              data-test="import-textarea"
            />

            <p
              v-if="importError"
              class="import-error"
              role="alert"
              data-test="import-error"
            >
              {{ importError }}
            </p>

            <div class="import-actions">
              <button type="button" class="ghost-control focus-ring" @click="closeImport">
                取消
              </button>
              <button
                type="button"
                class="primary-control focus-ring"
                data-test="import-submit"
                @click="submitImport"
              >
                导入
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>

<style scoped>
.settings-root {
  min-height: 100vh;
  padding: 3rem 1.25rem 4rem;
  color: var(--text-1);
  background: var(--bg-base);
}

.settings-shell {
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.settings-header {
  margin-bottom: 0.25rem;
}

.settings-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.settings-lede {
  margin: 0.4rem 0 0;
  font-size: 0.82rem;
  color: var(--text-2);
}

.settings-card {
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-surface);
  background: var(--surface);
}

.settings-card--flush {
  /* 磁贴网格自带内边距，这里不再套一层 */
  padding-bottom: 1.5rem;
}

.settings-card__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-2);
}

.settings-card__desc {
  margin: 0.55rem 0 0;
  font-size: 0.78rem;
  line-height: 1.6;
  color: var(--text-2);
}

.settings-row {
  margin-top: 0.9rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.settings-row__text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.settings-row__label {
  font-size: 0.9rem;
}

.settings-row__hint {
  font-size: 0.75rem;
  color: var(--text-2);
}

/* 主题切换：外形与交互沿用全局幽灵按钮，这里只保留设置页的一档尺寸 */
.switch-control {
  gap: 0.45rem;
  padding: 0.45rem 0.9rem;
  font-size: 0.8rem;
}

/* ---- 引擎选择 ---- */
.engine-picker {
  margin-top: 0.9rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
  gap: 0.5rem;
}

.engine-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 0.7rem 0.4rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-inner);
  background: var(--surface-strong);
  color: var(--text-2);
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.engine-card:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.engine-card__icon {
  color: var(--engine-color);
}

.engine-card.is-selected {
  border-color: var(--engine-color);
  background: color-mix(in srgb, var(--engine-color) 8%, var(--surface-strong));
  box-shadow: 0 0 0 1px var(--engine-color) inset;
}

.engine-card.is-selected .engine-card__label {
  font-weight: 600;
  color: var(--text-1);
}

.preview {
  margin-top: 1.1rem;
  padding-top: 1.1rem;
  border-top: 1px dashed var(--line);
}

.preview__label {
  display: block;
  margin-bottom: 0.6rem;
  font-family: var(--font-display);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

/* ---- 输入 ---- */
.field {
  display: block;
  margin-top: 0.9rem;
}

.field__label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.78rem;
  color: var(--text-2);
}

.shortcuts-host {
  margin-top: 1rem;
}

/* ---- 批量导入 ---- */
.import-bar {
  margin-top: 0.9rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.import-status {
  margin: 0.6rem 0 0;
  font-size: 0.75rem;
  color: var(--text-2);
}

.import-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--scrim);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.import-panel {
  width: min(100%, 32rem);
  padding: 1.4rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-surface);
  background: var(--bg-base);
  color: var(--text-1);
  box-shadow:
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.import-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.02rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.import-desc {
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--text-2);
}

.import-code {
  padding: 0.05rem 0.3rem;
  border-radius: 6px;
  background: var(--surface-sunken);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

/* 粘贴区：等宽字体让 JSON 的层级看得出来，纵向可拉但不能横着撑破面板 */
.import-textarea {
  margin-top: 0.9rem;
  min-height: 9rem;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 0.76rem;
  line-height: 1.6;
}

.import-error {
  margin: 0.55rem 0 0;
  font-size: 0.75rem;
  color: var(--danger-text);
}

.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-active .import-panel,
.dialog-leave-active .import-panel {
  transition:
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .import-panel,
.dialog-leave-to .import-panel {
  opacity: 0;
  transform: translateY(8px) scale(0.975);
}
</style>
