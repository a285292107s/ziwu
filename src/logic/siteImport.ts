/**
 * 把 iTab 备份（`navConfig`）里的站点提取成子午 Meridiem 的磁贴数据。
 *
 * 纯函数，不碰 storage / Vue：设置页的「粘贴配置导入」与
 * `presetSites.ts` 的内置清单共用同一套规则。
 *
 * 规则只有三条：
 * 1. 只认 https / http（`normalizeUrl` 负责补协议、挡掉 `itab://add` 这类内部地址）；
 * 2. 组件磁贴（日历 / 倒数日 / 计算器 / 壁纸）不是网站，跳过；
 * 3. 按规范化后的网址去重，保留第一次出现的名字。
 */
import { normalizeUrl, shortcutDomain } from './shortcuts'

export interface ImportedSite {
  name: string
  url: string
}

/** 可能装着子项（文件夹、分组、列表）的字段名 */
const CONTAINER_KEYS = ['navConfig', 'children', 'sites', 'items', 'list'] as const

/**
 * 递归提取站点。
 *
 * 文件夹（`type: 'folder'`）在这里被**扁平化**：子午 Meridiem 没有文件夹，
 * 与其丢掉用户收在文件夹里的站点，不如让它们直接落到同一屏。
 */
export function extractSitesFromConfig(raw: unknown): ImportedSite[] {
  const out: ImportedSite[] = []
  const seen = new Set<string>()

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node)
        visit(item)

      return
    }

    if (!node || typeof node !== 'object')
      return

    const record = node as Record<string, unknown>

    // 组件磁贴（日历 / 倒数日 / 计算器 / 壁纸）没有 url，即使有也不该被当成网站
    if (record.type !== 'component' && typeof record.url === 'string') {
      const safeUrl = normalizeUrl(record.url)
      if (safeUrl) {
        const key = safeUrl.replace(/\/$/, '')
        if (!seen.has(key)) {
          seen.add(key)
          const name = typeof record.name === 'string' ? record.name.trim() : ''
          out.push({ name: name || shortcutDomain(safeUrl), url: safeUrl })
        }
      }
    }

    for (const key of CONTAINER_KEYS) {
      if (key in record)
        visit(record[key])
    }
  }

  visit(raw)

  return out
}

/**
 * 解析粘贴进来的文本。
 *
 * 语法错误不在这里吞掉：调用方要把 `JSON.parse` 的报错翻成一句人话给用户看。
 */
export function parseSitesJson(text: string): ImportedSite[] {
  const parsed: unknown = JSON.parse(text)

  return extractSitesFromConfig(parsed)
}
