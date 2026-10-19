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

export function useShortcuts() {
  const list = computed<Shortcut[]>(() => sanitizeShortcuts(shortcuts.value))

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

  function insertAt(shortcut: Shortcut, index: number) {
    const next = [...list.value]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, shortcut)
    persist(next)
  }

  function move(from: number, to: number) {
    persist(moveItem(list.value, from, to))
  }

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
      persist(next)
    }
    else if (added > 0) {
      persist(next)
    }

    return { added, skipped }
  }

  return { list, add, update, remove, insertAt, move, writeSites }
}
