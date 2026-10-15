import { DEFAULT_SEARCH_ENGINE_KEY } from './searchEngines'
import { defaultShortcuts } from './shortcuts'
import type { Shortcut } from './shortcuts'
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
 * 初始值取系统偏好，这样首次打开时观感是对的；
 * 一旦用户手动切过，就完全按用户的选择走，不再跟随系统。
 */
export type ThemeMode = 'light' | 'dark'

function initialThemeMode(): ThemeMode {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

  return 'light'
}

export const { data: themeMode, dataReady: themeModeReady } = useWebExtensionStorage<ThemeMode>(
  'meridiem-theme',
  initialThemeMode(),
)
