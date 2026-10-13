/**
 * 搜索引擎目录。
 *
 * 这个模块是**纯数据 + 纯函数**，不依赖 `browser` / Vue / storage，
 * 因此可以被单元测试直接引入，也可以在 `unocss.config.ts` 里安全导入（用于 safelist）。
 * 新增引擎时只需在 `searchEngines` 数组里加一项。
 */

export interface SearchEngine {
  /** 稳定标识，会写入 browser.storage.local，不要随意改名 */
  key: string
  /** 下拉列表与按钮上显示的名称 */
  label: string
  /** UnoCSS 图标类名，格式为 `i-<集合>-<图标>` */
  icon: string
  /** 品牌主色（浅色主题下使用） */
  color: string
  /**
   * 深色主题下的品牌色。
   * 多数品牌色是为白底设计的（例如 GitHub 的近黑 #24292f），
   * 直接放到深色背景上会看不见，所以每个引擎都给出深色变体。
   */
  colorDark: string
  /** 搜索地址模板，`{q}` 会被替换为 URL 编码后的关键词 */
  urlTemplate: string
  /** 输入框占位符中使用的名称，如「在 Google 中搜索」 */
  placeholder: string
}

export const searchEngines: SearchEngine[] = [
  {
    key: 'google',
    label: 'Google',
    icon: 'i-simple-icons-google',
    color: '#4285f4',
    colorDark: '#8ab4f8',
    urlTemplate: 'https://www.google.com/search?q={q}',
    placeholder: 'Google',
  },
  {
    key: 'baidu',
    label: '百度',
    icon: 'i-simple-icons-baidu',
    color: '#2932e1',
    colorDark: '#8f9bff',
    urlTemplate: 'https://www.baidu.com/s?wd={q}',
    placeholder: '百度',
  },
  {
    key: 'bing',
    label: 'Bing',
    icon: 'i-cib-bing',
    color: '#008373',
    colorDark: '#4dd4c0',
    urlTemplate: 'https://www.bing.com/search?q={q}',
    placeholder: 'Bing',
  },
  {
    key: 'duckduckgo',
    label: 'DuckDuckGo',
    icon: 'i-simple-icons-duckduckgo',
    color: '#de5833',
    colorDark: '#ff8a65',
    urlTemplate: 'https://duckduckgo.com/?q={q}',
    placeholder: 'DuckDuckGo',
  },
  {
    key: 'zhihu',
    label: '知乎',
    icon: 'i-simple-icons-zhihu',
    color: '#0084ff',
    colorDark: '#5eb0ff',
    urlTemplate: 'https://www.zhihu.com/search?type=content&q={q}',
    placeholder: '知乎',
  },
  {
    key: 'bilibili',
    label: '哔哩哔哩',
    icon: 'i-simple-icons-bilibili',
    color: '#00aeec',
    colorDark: '#5fd0f5',
    urlTemplate: 'https://search.bilibili.com/all?keyword={q}',
    placeholder: '哔哩哔哩',
  },
  {
    key: 'github',
    label: 'GitHub',
    icon: 'i-simple-icons-github',
    color: '#24292f',
    colorDark: '#e6edf3',
    urlTemplate: 'https://github.com/search?q={q}',
    placeholder: 'GitHub',
  },
]

/** 默认引擎：目录里的第一项 */
export const DEFAULT_SEARCH_ENGINE_KEY = searchEngines[0].key

/**
 * 按 key 查引擎。
 * 找不到时回退到默认引擎：storage 里可能存着旧版本遗留的 key，
 * 这样改目录（删掉某个引擎）也不会把新标签页搞崩。
 */
export function getSearchEngine(key: string | null | undefined): SearchEngine {
  return searchEngines.find(engine => engine.key === key)
    ?? searchEngines.find(engine => engine.key === DEFAULT_SEARCH_ENGINE_KEY)!
}

/**
 * 由引擎 + 关键词拼出搜索地址。
 * 关键词为空白时返回 `null`，调用方据此判断「不跳转」。
 */
export function buildSearchUrl(engine: SearchEngine | null | undefined, query: string): string | null {
  if (!engine)
    return null

  const keyword = query.trim()
  if (!keyword)
    return null

  return engine.urlTemplate.replace('{q}', encodeURIComponent(keyword))
}

/** 在目录中相对当前位置移动 `step` 步（支持负数），用于 Tab / 方向键轮换。 */
export function cycleSearchEngine(currentKey: string, step: number): SearchEngine {
  const currentIndex = searchEngines.findIndex(engine => engine.key === currentKey)
  // 当前 key 无效时从第 0 项开始算，保证结果始终合法
  const baseIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = (baseIndex + step % searchEngines.length + searchEngines.length) % searchEngines.length

  return searchEngines[nextIndex]
}

/**
 * 按主题取引擎品牌色。
 * 深色主题下换成更亮的一档，否则 GitHub 这类近黑色在深底上会看不见。
 */
export function engineColor(engine: SearchEngine, dark: boolean): string {
  return dark ? engine.colorDark : engine.color
}
