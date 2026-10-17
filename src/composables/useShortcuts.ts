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
import type { Shortcut, ShortcutSeed } from '~/logic/shortcuts'

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

  /**
   * 批量写入的两种语义。
   *
   * `merge` 用于「把另一台机器的备份并进来」：保留本机已有的磁贴与原顺序，
   * 只把网址还没出现过的补到末尾。
   * `replace` 用于「用备份完整还原」：本机磁贴整份换成备份里的，顺序也照备份来。
   */
  type WriteMode = 'merge' | 'replace'

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
   * 批量写入站点（设置页的「导入备份」走这里）。
   *
   * 入参是**不带 id** 的裸站点（见 `ShortcutSeed`），id 在这里现造：
   * 备份里的 id 属于导出它的那台机器，照抄会让「合并」出现两条同 id 的磁贴，
   * 之后删一个会连带动到另一个。
   *
   * 两种语义见 `WriteMode`。无论哪种，都先过 `normalizeUrl`，
   * 已存在的按规范化网址（去掉结尾斜杠）比对，所以
   * `https://taobao.com` 与 `https://taobao.com/` 不会被当成两个站点。
   */
  function writeSites(
    sites: readonly ShortcutSeed[],
    mode: WriteMode,
  ): { added: number, skipped: number } {
    const current = list.value
    const base = mode === 'replace' ? [] : current
    const existing = new Set(base.map(item => item.url.replace(/\/$/, '')))
    const next = [...base]

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

    if (mode === 'replace') {
      // 覆盖模式即便「新的和旧的完全一样」也要落盘：目标是「和备份一致」，
      // 顺序也得对齐，否则用户看不出还原起了作用。
      persist(next)
    }
    else if (added > 0) {
      // 合并模式没有新站点时**不写**：白写一次会让其它标签页收到一轮
      // 无意义的 storage.onChanged，磁贴白白重渲染一次。
      persist(next)
    }

    return { added, skipped }
  }

  return { list, add, update, remove, insertAt, move, writeSites }
}
