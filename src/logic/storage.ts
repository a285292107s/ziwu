import { DEFAULT_SEARCH_ENGINE_KEY } from './searchEngines'
import { defaultShortcuts } from './shortcuts'
import type { Shortcut } from './shortcuts'
import { THEME_MIRROR_KEY } from './themeBoot'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'

/**
 * storage 键名前缀是 `meridiem-`（产品名 子午 Meridiem）。
 * 改名前 `mytab-*` 里的数据由 `useWebExtensionStorage` 的读路径自动搬迁一次，
 * 规则见那个文件里的 STORAGE_PREFIX / LEGACY_STORAGE_PREFIX。
 *
 * `scripts/*.mjs` 的截图与对比度脚本直接按这些键读写 storage，改键名时两边要一起改。
 */

/**
 * 新标签页显示的问候语。
 * 写入 browser.storage.local，新标签页与设置页之间会自动实时同步。
 */
export const { data: greeting, dataReady: greetingReady } = useWebExtensionStorage('meridiem-greeting', '你好，欢迎回来')

/**
 * 新标签页搜索框当前选中的搜索引擎（存的是 `SearchEngine.key`）。
 * 读写这个值会触发 `storage.onChanged`，所以多个新标签页 / 设置页之间自动同步。
 */
export const { data: searchEngineKey, dataReady: searchEngineReady } = useWebExtensionStorage(
  'meridiem-search-engine',
  DEFAULT_SEARCH_ENGINE_KEY,
)

/**
 * 快捷方式磁贴。
 *
 * `mergeDefaults: false`：默认值只在 storage 里**没有这个键**时写入一次。
 * 否则用户把磁贴全删光之后，`mergeDefaults` 会把预置站点又塞回来，
 * 变成「删不掉」的诡异行为。
 */
export const { data: shortcuts, dataReady: shortcutsReady } = useWebExtensionStorage<Shortcut[]>(
  'meridiem-shortcuts',
  defaultShortcuts(),
  { mergeDefaults: false },
)

/**
 * 主题：只有 'light' / 'dark' 两态（右上角按钮直接切换）。
 *
 * 初始值先取 `localStorage` 里的**同步镜像**（`useTheme()` 每次主题变化都会写它，
 * 见 composables/useTheme.ts），没有再退回系统偏好。
 *
 * 为什么不能直接用系统偏好：`chrome.storage.local` 是异步的，而 `useTheme()` 的
 * watch 是 `immediate` 的 —— 挂载那一刻它就会按**初始值**去设置 `<html>` 上的类。
 * 如果初始值取系统偏好，那么「用户存了深色、系统是浅色」的场景会在挂载瞬间
 * 把首帧脚本（src/newtab/theme-boot.js）刚放好的 dark 改成 light，
 * 几十毫秒后再被 storage 的返回值改回来 —— 白屏闪一下又回来了。
 * 镜像和首帧脚本读的是同一个键，两边对得上，这一段抖动就消失了。
 */
export type ThemeMode = 'light' | 'dark'

function initialThemeMode(): ThemeMode {
  if (typeof window !== 'undefined') {
    try {
      const mirrored = window.localStorage.getItem(THEME_MIRROR_KEY)
      if (mirrored === 'dark' || mirrored === 'light')
        return mirrored
    }
    catch {
      // localStorage 不可用（隐私设置/企业策略）时静默退回系统偏好
    }

    if (typeof window.matchMedia === 'function')
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return 'light'
}

export const { data: themeMode, dataReady: themeModeReady } = useWebExtensionStorage<ThemeMode>(
  'meridiem-theme',
  initialThemeMode(),
)
