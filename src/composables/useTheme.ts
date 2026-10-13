import { computed, watch } from 'vue'
import { themeMode } from '~/logic/storage'

/**
 * 主题：只有 light / dark 两态，右上角按钮一键互换。
 *
 * 初始值在 `logic/storage.ts` 里按系统偏好决定，所以首次打开观感是对的；
 * 用户手动切过之后就不再跟随系统（两态模型下没有「跟随系统」这个选项）。
 *
 * UnoCSS 配的是 `dark: 'class'`，所以这里往 <html> 上挂/摘 `dark` 类。
 * 同时挂 `color-scheme`，让滚动条和原生表单控件一起变色。
 */
export function useTheme() {
  const isDark = computed(() => themeMode.value === 'dark')

  watch(isDark, (dark) => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, { immediate: true })

  /** 浅色 ⇄ 深色 */
  function toggleTheme() {
    themeMode.value = isDark.value ? 'light' : 'dark'
  }

  /**
   * 直接指定主题。
   * 新标签页右上角是「浅色 / 深色」两格显式开关，
   * 每格点下去要落到确定的状态，所以需要显式设置而不是取反。
   */
  function setTheme(mode: 'light' | 'dark') {
    themeMode.value = mode
  }

  /** 当前主题的中文名，用于按钮的 title / aria-label */
  const themeLabel = computed(() => (isDark.value ? '深色' : '浅色'))

  /**
   * 按钮图标显示的是「**将要切换到**的主题」，而不是当前主题：
   * 处在浅色时显示月亮（点一下变深色），处在深色时显示太阳。
   */
  const themeIcon = computed(() => (isDark.value ? 'i-carbon-sun' : 'i-carbon-moon'))

  return { isDark, themeLabel, themeIcon, toggleTheme, setTheme }
}
