<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { useTheme } from '~/composables/useTheme'
import { useTransfer } from '~/composables/useTransfer'
import { engineColor, searchEngines } from '~/logic/searchEngines'
import { greeting, searchEngineKey } from '~/logic/storage'
import { BACKUP_FORMAT, GREETING_MAX_LENGTH, parseBackupFile } from '~/logic/transfer'

const { isDark, themeLabel, themeIcon, toggleTheme } = useTheme()
const { list } = useShortcuts()
const { exportBackup, applyBackup, readBackupFile } = useTransfer()

const importOpen = ref(false)
const importText = ref('')
const importFileName = ref('')
const importError = ref('')
const importStatus = ref('')
const importMode = ref<'merge' | 'replace'>('merge')
const fileInput = ref<HTMLInputElement | null>(null)
let statusTimer: number | undefined

const parsed = computed(() => {
  const text = importText.value.trim()

  return text ? parseBackupFile(text) : null
})

const parseError = computed(() => (parsed.value && !parsed.value.ok ? parsed.value.error : ''))

const parseWarnings = computed(() => (parsed.value?.ok ? parsed.value.warnings : []))

const backupSummary = computed(() => {
  const result = parsed.value
  if (!result?.ok)
    return ''

  const parts = [`${result.payload.shortcuts.length} 个站点`]
  if (result.payload.greeting !== null)
    parts.push('问候语')
  if (result.payload.searchEngineKey !== null)
    parts.push('默认搜索引擎')
  if (result.payload.themeMode !== null)
    parts.push('主题')

  return parts.join(' · ')
})

const canSubmit = computed(() => parsed.value?.ok === true)

const replaceHint = computed(() => {
  const result = parsed.value
  if (!result?.ok || importMode.value !== 'replace')
    return ''

  const kept = result.payload.shortcuts.length

  if (kept === 0)
    return `这份备份里没有站点，覆盖后本机的 ${list.value.length} 个磁贴会被全部清空`

  if (list.value.length > kept)
    return `覆盖后有 ${list.value.length - kept} 个本机磁贴会被删除（备份里没有它们）`

  return ''
})

function reportBackupResult(
  result: { added: number, skipped: number, settings: number },
  mode: 'merge' | 'replace',
  warnings: readonly string[],
) {
  const parts: string[] = []

  if (mode === 'replace')
    parts.push(`已用备份替换磁贴，现在共 ${result.added} 个站点`)
  else if (result.added > 0)
    parts.push(`已添加 ${result.added} 个站点`)
  else
    parts.push('没有新增站点：备份里的网址都已经在页面上了')

  if (result.skipped > 0)
    parts.push(`跳过 ${result.skipped} 个（${mode === 'replace' ? '重复或地址无效' : '已存在或地址无效'}）`)

  if (result.settings > 0)
    parts.push(`另有 ${result.settings} 项设置已恢复`)

  parts.push(...warnings)

  importStatus.value = parts.join('，')

  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    importStatus.value = ''
  }, 8000)
}

function reportExportResult(result: { fileName: string, shortcutCount: number }) {
  importStatus.value = `已导出 ${result.shortcutCount} 个站点到 ${result.fileName}`

  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    importStatus.value = ''
  }, 8000)
}

function onExport() {
  reportExportResult(exportBackup())
}

function openImport() {
  importText.value = ''
  importFileName.value = ''
  importError.value = ''
  importMode.value = 'merge'
  importOpen.value = true
}

function closeImport() {
  importOpen.value = false
}

async function onPickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  input.value = ''

  if (!file)
    return

  importError.value = ''
  try {
    importText.value = await readBackupFile(file)
    importFileName.value = file.name
  }
  catch {
    importError.value = `读不到「${file.name}」，换一个文件试试`
  }
}

function submitImport() {
  const result = parsed.value
  if (!result?.ok) {
    importError.value = result?.error ?? '先选择备份文件，或把文件内容粘贴进来'
    return
  }

  reportBackupResult(applyBackup(result.payload, importMode.value), importMode.value, result.warnings)
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
          子午 Ziwu 设置
        </h1>
        <p class="settings-lede">
          改动会立即生效，已打开的新标签页会自动同步。
        </p>
      </header>

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

      <section class="settings-card" aria-labelledby="sec-search">
        <h2 id="sec-search" class="settings-card__title">
          默认搜索引擎
        </h2>
        <p class="settings-card__desc">
          新标签页搜索框聚焦时，按 <kbd class="kbd">Tab</kbd> 展开引擎环并在这些引擎之间快速轮换，停手后环会收起；按 <kbd class="kbd">Esc</kbd> 退出搜索框。
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
          <SearchBox open-in-new-tab :engine-ring="false" />
        </div>
      </section>

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
            :maxlength="GREETING_MAX_LENGTH"
            data-test="options-greeting"
          >
        </label>
        <p class="settings-card__desc">
          留空则不显示。{{ greeting.length }}/{{ GREETING_MAX_LENGTH }}
        </p>
      </section>

      <section class="settings-card settings-card--flush" aria-labelledby="sec-shortcuts">
        <h2 id="sec-shortcuts" class="settings-card__title">
          快捷方式
        </h2>
        <p class="settings-card__desc">
          按住图标拖到新位置即可排序；点「整理」可以编辑或删除；按 <kbd class="kbd">N</kbd> 快速添加。
        </p>

        <div class="shortcuts-host">
          <ShortcutGrid open-in-new-tab />
        </div>
      </section>

      <section class="settings-card" aria-labelledby="sec-backup">
        <h2 id="sec-backup" class="settings-card__title">
          备份与恢复
        </h2>
        <p class="settings-card__desc">
          导出成一个 JSON 文件，换台机器时再导入回来。当前共
          <strong>{{ list.length }}</strong> 个站点。
        </p>

        <div class="backup-bar">
          <button
            type="button"
            class="ghost-control focus-ring"
            data-test="export-backup"
            @click="onExport"
          >
            <span class="i-carbon-download" aria-hidden="true" />
            导出备份
          </button>
          <button
            type="button"
            class="ghost-control focus-ring"
            data-test="open-import"
            @click="openImport"
          >
            <span class="i-carbon-upload" aria-hidden="true" />
            导入备份
          </button>
        </div>

        <p class="settings-card__desc">
          备份文件里带着站点、问候语、默认搜索引擎与主题。站点只保存在本机浏览器
          storage 里，导出与导入都不经过源码或构建产物。
        </p>

        <p
          v-if="importStatus"
          class="backup-status"
          role="status"
          data-test="import-status"
        >
          {{ importStatus }}
        </p>
      </section>
    </div>

    <Teleport to="body">
      <Transition name="dialog">
        <div
          v-if="importOpen"
          class="backup-backdrop"
          @click.self="closeImport"
        >
          <div
            class="backup-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
          >
            <h3 id="import-dialog-title" class="backup-title">
              导入备份
            </h3>
            <p class="backup-desc">
              选择由子午「导出备份」生成的 <code class="backup-code">.json</code> 文件，
              也可以直接把文件内容粘贴到下面。
            </p>

            <div class="backup-pick">
              <button
                type="button"
                class="ghost-control focus-ring"
                data-test="pick-file"
                @click="fileInput?.click()"
              >
                <span class="i-carbon-document" aria-hidden="true" />
                选择文件
              </button>
              <span v-if="importFileName" class="backup-filename">{{ importFileName }}</span>
              <input
                ref="fileInput"
                type="file"
                accept=".json,application/json"
                class="backup-file"
                data-test="import-file"
                @change="onPickFile"
              >
            </div>

            <textarea
              v-model="importText"
              class="dialog-input backup-textarea"
              rows="8"
              spellcheck="false"
              aria-label="备份文件内容"
              :placeholder="`{&quot;format&quot;:&quot;${BACKUP_FORMAT}&quot;,&quot;version&quot;:1, ...}`"
              data-test="import-textarea"
            />

            <p v-if="canSubmit" class="backup-summary" data-test="import-summary">
              识别到 {{ backupSummary }}
            </p>

            <ul
              v-if="parseWarnings.length"
              class="backup-warnings"
              data-test="import-warnings"
            >
              <li v-for="warning in parseWarnings" :key="warning">
                {{ warning }}
              </li>
            </ul>

            <p
              v-if="parseError || importError"
              class="backup-error"
              role="alert"
              data-test="import-error"
            >
              {{ parseError || importError }}
            </p>

            <fieldset class="backup-modes">
              <legend class="backup-modes__legend">
                磁贴怎么处理
              </legend>
              <label class="backup-mode">
                <input
                  v-model="importMode"
                  type="radio"
                  value="merge"
                  data-test="import-mode-merge"
                >
                <span>
                  <strong>合并</strong>：保留现有磁贴与顺序，只补上还没有的站点
                </span>
              </label>
              <label class="backup-mode">
                <input
                  v-model="importMode"
                  type="radio"
                  value="replace"
                  data-test="import-mode-replace"
                >
                <span>
                  <strong>覆盖</strong>：现有磁贴整份替换成备份里的，顺序也照备份来
                </span>
              </label>
              <p
                v-if="replaceHint"
                class="backup-mode__hint"
                data-test="replace-hint"
              >
                {{ replaceHint }}
              </p>
            </fieldset>

            <div class="backup-actions">
              <button type="button" class="ghost-control focus-ring" @click="closeImport">
                取消
              </button>
              <button
                type="button"
                class="primary-control focus-ring"
                :disabled="!canSubmit"
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

.switch-control {
  gap: 0.45rem;
  padding: 0.45rem 0.9rem;
  font-size: 0.8rem;
}

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

.backup-bar {
  margin-top: 0.9rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.backup-status {
  margin: 0.7rem 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--text-2);
}

.backup-backdrop {
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

.backup-panel {
  width: min(100%, 34rem);
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  padding: 1.4rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-surface);
  background: var(--bg-base);
  color: var(--text-1);
  box-shadow:
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.backup-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.02rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.backup-desc {
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--text-2);
}

.backup-code {
  padding: 0.05rem 0.3rem;
  border-radius: 6px;
  background: var(--surface-sunken);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.backup-pick {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.9rem;
}

.backup-file {
  display: none;
}

.backup-filename {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-2);
}

.backup-textarea {
  margin-top: 0.7rem;
  min-height: 8rem;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 0.76rem;
  line-height: 1.6;
}

.backup-summary {
  margin: 0.55rem 0 0;
  font-size: 0.75rem;
  color: var(--text-2);
}

.backup-warnings {
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.7rem 0.5rem 1.5rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-inner);
  background: var(--surface-sunken);
  font-size: 0.74rem;
  line-height: 1.6;
  color: var(--text-2);
  list-style: disc;
}

.backup-error {
  margin: 0.55rem 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--danger-text);
}

.backup-modes {
  margin: 1rem 0 0;
  padding: 0.75rem 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-inner);
  background: var(--surface-strong);
}

.backup-modes__legend {
  padding: 0 0.35rem;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

.backup-mode {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--text-2);
  cursor: pointer;
}

.backup-mode:first-of-type {
  margin-top: 0.15rem;
}

.backup-mode input {
  margin-top: 0.2rem;
  flex: none;
  accent-color: var(--brand);
}

.backup-mode strong {
  font-weight: 600;
  color: var(--text-1);
}

.backup-mode__hint {
  margin: 0.5rem 0 0 1.4rem;
  font-size: 0.74rem;
  line-height: 1.55;
  color: var(--danger-text);
}

.backup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.1rem;
}

.backup-actions .primary-control:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.backup-actions .primary-control:disabled:hover {
  background: var(--brand);
  box-shadow: none;
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-active .backup-panel,
.dialog-leave-active .backup-panel {
  transition:
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .backup-panel,
.dialog-leave-to .backup-panel {
  transform: translateY(8px) scale(0.975);
  opacity: 0;
}
</style>
