export interface DefaultSite {
  name: string
  url: string
}

export const DEFAULT_SITES: DefaultSite[] = [
  { name: 'GitHub', url: 'https://github.com/' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { name: '掘金', url: 'https://juejin.cn/' },
  { name: 'MDN', url: 'https://developer.mozilla.org/zh-CN/' },
  { name: '维基百科', url: 'https://zh.wikipedia.org/' },
]
