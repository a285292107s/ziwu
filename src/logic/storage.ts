import { DEFAULT_SEARCH_ENGINE_KEY } from './searchEngines'
import { defaultShortcuts } from './shortcuts'
import type { Shortcut } from './shortcuts'
import { THEME_MIRROR_KEY } from './themeBoot'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'

export const { data: greeting, dataReady: greetingReady } = useWebExtensionStorage('meridiem-greeting', '你好，欢迎回来')

export const { data: searchEngineKey, dataReady: searchEngineReady } = useWebExtensionStorage(
  'meridiem-search-engine',
  DEFAULT_SEARCH_ENGINE_KEY,
)

export const { data: shortcuts, dataReady: shortcutsReady } = useWebExtensionStorage<Shortcut[]>(
  'meridiem-shortcuts',
  defaultShortcuts(),
  { mergeDefaults: false },
)

export type ThemeMode = 'light' | 'dark'

function initialThemeMode(): ThemeMode {
  if (typeof window !== 'undefined') {
    try {
      const mirrored = window.localStorage.getItem(THEME_MIRROR_KEY)
      if (mirrored === 'dark' || mirrored === 'light')
        return mirrored
    }
    catch {
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
