import { computed, watch } from 'vue'
import { themeMode } from '~/logic/storage'
import { THEME_MIRROR_KEY } from '~/logic/themeBoot'

export function useTheme() {
  const isDark = computed(() => themeMode.value === 'dark')

  watch(isDark, (dark) => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.classList.toggle('light', !dark)
    root.style.colorScheme = dark ? 'dark' : 'light'

    try {
      window.localStorage.setItem(THEME_MIRROR_KEY, dark ? 'dark' : 'light')
    }
    catch (error) {
      void error
    }
  }, { immediate: true })

  function toggleTheme() {
    themeMode.value = isDark.value ? 'light' : 'dark'
  }

  function setTheme(mode: 'light' | 'dark') {
    themeMode.value = mode
  }

  const themeLabel = computed(() => (isDark.value ? '深色' : '浅色'))

  const themeIcon = computed(() => (isDark.value ? 'i-carbon-sun' : 'i-carbon-moon'))

  return { isDark, themeLabel, themeIcon, toggleTheme, setTheme }
}
