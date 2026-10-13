import { computed } from 'vue'
import { shortcuts } from '~/logic/storage'
import {
  createId,
  createShortcut,
  moveItem,
  normalizeUrl,
  sanitizeShortcuts,
  shortcutDomain,
} from '~/logic/shortcuts'
import type { ImportedSite } from '~/logic/siteImport'
import type { Shortcut } from '~/logic/shortcuts'

/**
 * 磁贴的读写入口。
 *
 * 组件不直接碰 `shortcuts` ref，所有写操作都经过这里，好处：
 * 1. 读出来的数据一定过了 `sanitizeShortcuts`（storage 可能被手改或残留旧格式）；
 * 2. 写回去的排序 / 字段格式统一，不会出现半成品数据。
 */
export function useShortcuts() {
  /** 过滤 + 去重后的安全列表 */
  const list = computed<Shortcut[]>(() => sanitizeShortcuts(shortcuts.value))

  /** 过滤后的数据与原数据不一致 → 说明 storage 里有脏数据，需要落盘清理 */
  function persist(next: Shortcut[]) {
    shortcuts.value = next
  }

  function add(name: string, url: string): Shortcut | null {
    const created = createShortcut(name, url)
    if (!created)
      return null

    persist([...list.value, created])

    return created
  }

  function update(id: string, name: string, url: string): boolean {
    const normalized = normalizeUrl(url)
    if (!normalized)
      return false

    persist(list.value.map(item => item.id === id
      ? { ...item, name: name.trim() || shortcutDomain(normalized), url: normalized }
      : item))

    return true
  }

  function remove(id: string) {
    persist(list.value.filter(item => item.id !== id))
  }

  /**
   * 把一条记录插回指定位置（用于撤销删除）。
   *
   * 注意不要在组件里写 `list.value = ...`：`list` 是只读 computed，
   * 赋值只会静默失败（Vue 会警告但不会报错），撤销功能就假死了。
   * 所有写入必须走这里。
   */
  function insertAt(shortcut: Shortcut, index: number) {
    const next = [...list.value]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, shortcut)
    persist(next)
  }

  function move(from: number, to: number) {
    persist(moveItem(list.value, from, to))
  }

  /**
   * 批量导入站点（iTab 备份 / 内置预置清单都走这里）。
   *
   * 语义是**合并**而不是覆盖：保留用户已有的磁贴与它们的顺序，
   * 只把「网址还没出现过」的补到末尾。
   * 已存在的按规范化网址（去掉结尾斜杠）比对，所以
   * `https://taobao.com` 与 `https://taobao.com/` 不会被当成两个站点。
   */
  function importSites(sites: readonly ImportedSite[]): { added: number, skipped: number } {
    const existing = new Set(list.value.map(item => item.url.replace(/\/$/, '')))
    const next = [...list.value]

    let added = 0
    let skipped = 0

    for (const site of sites) {
      const url = normalizeUrl(site.url)
      if (!url) {
        skipped++
        continue
      }

      const key = url.replace(/\/$/, '')
      if (existing.has(key)) {
        skipped++
        continue
      }

      existing.add(key)
      next.push({
        id: createId(),
        name: site.name.trim() || shortcutDomain(url),
        url,
      })
      added++
    }

    if (added > 0)
      persist(next)

    return { added, skipped }
  }

  /** 清掉 storage 里的脏数据（重复项、非法 URL 等） */
  function cleanup() {
    if (list.value.length !== (shortcuts.value?.length ?? 0))
      persist(list.value)
  }

  return { list, add, update, remove, insertAt, move, importSites, cleanup }
}
