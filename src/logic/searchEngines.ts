export interface SearchEngine {
  key: string
  label: string
  icon: string
  color: string
  colorDark: string
  urlTemplate: string
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

export const DEFAULT_SEARCH_ENGINE_KEY = searchEngines[0].key

export function getSearchEngine(key: string | null | undefined): SearchEngine {
  return searchEngines.find(engine => engine.key === key)
    ?? searchEngines.find(engine => engine.key === DEFAULT_SEARCH_ENGINE_KEY)!
}

export function buildSearchUrl(engine: SearchEngine | null | undefined, query: string): string | null {
  if (!engine)
    return null

  const keyword = query.trim()
  if (!keyword)
    return null

  return engine.urlTemplate.replace('{q}', encodeURIComponent(keyword))
}

export function cycleSearchEngine(currentKey: string, step: number): SearchEngine {
  const currentIndex = searchEngines.findIndex(engine => engine.key === currentKey)
  const baseIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = (baseIndex + step % searchEngines.length + searchEngines.length) % searchEngines.length

  return searchEngines[nextIndex]
}

export function engineColor(engine: SearchEngine, dark: boolean): string {
  return dark ? engine.colorDark : engine.color
}
