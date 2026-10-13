import { defineConfig } from 'unocss/vite'
import { presetAttributify, presetIcons, presetUno, transformerDirectives } from 'unocss'
import { searchEngines } from './src/logic/searchEngines'

/**
 * 写在数据里 / 由 JS 计算出来的图标类名，静态扫描可能看不到，
 * 这里显式列出，避免出现「图标是空白」这类静默失败。
 */
const dynamicIcons = [
  // 搜索引擎图标（模板中是 :class="engine.icon"）
  ...searchEngines.map(engine => engine.icon),
  // 主题切换按钮的图标（在 useTheme() 里按当前主题计算）
  'i-carbon-sun',
  'i-carbon-moon',
]

export default defineConfig({
  presets: [
    // dark: 'class' → 由 useTheme() 在 <html> 上挂 .dark，实现浅色/深色切换。
    // 默认是 'media'，那样只能跟随系统，点按钮切不动。
    presetUno({ dark: 'class' }),
    presetAttributify(),
    presetIcons(),
  ],
  transformers: [
    transformerDirectives(),
  ],
  safelist: dynamicIcons,
})
