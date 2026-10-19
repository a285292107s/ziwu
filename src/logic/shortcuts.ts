import { DEFAULT_SITES } from './defaultSites'

export interface Shortcut {
  id: string
  name: string
  url: string
}

export interface ShortcutSeed {
  name: string
  url: string
}

export function createId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function')
    return c.randomUUID()

  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw)
    return null

  const schemeMatch = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i.exec(raw)
  if (schemeMatch) {
    const [, scheme, rest] = schemeMatch
    const looksLikePort = /^\d+(?:\/|$)/.test(rest)

    if (!looksLikePort) {
      if (scheme.toLowerCase() !== 'http' && scheme.toLowerCase() !== 'https')
        return null

      try {
        return new URL(raw).href
      }
      catch {
        return null
      }
    }
  }

  const hostPart = raw.split('/')[0]
  const isLocal = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(hostPart)
  const candidate = `${isLocal ? 'http' : 'https'}://${raw}`

  try {
    const parsed = new URL(candidate)
    if (!parsed.hostname)
      return null
    if (!isLocal && !parsed.hostname.includes('.'))
      return null

    return parsed.href
  }
  catch {
    return null
  }
}

export function shortcutDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  }
  catch {
    return url
  }
}

export function faviconUrl(pageUrl: string, size = 64): string | null {
  try {
    const api = (globalThis as {
      browser?: { runtime?: { getURL?: (path: string) => string } }
      chrome?: { runtime?: { getURL?: (path: string) => string } }
    }).browser ?? (globalThis as {
      chrome?: { runtime?: { getURL?: (path: string) => string } }
    }).chrome

    const getURL = api?.runtime?.getURL
    if (typeof getURL !== 'function')
      return null

    const target = new URL(pageUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:')
      return null

    return `${getURL('/_favicon/')}?pageUrl=${encodeURIComponent(target.href)}&size=${size}`
  }
  catch {
    return null
  }
}

export const FAVICON_PROBE_URL = 'https://meridiem-favicon-probe.invalid/'

export const SHORTCUT_ACCENTS = [
  '#0f766e',
  '#2563a8',
  '#6d4bb5',
  '#a83a74',
  '#b3392f',
  '#a55a26',
  '#8d7318',
  '#2d7a44',
  '#1e6a86',
  '#3f4fbb',
  '#8b3f9e',
  '#b03a8f',
  '#a63a54',
  '#8a5a3b',
  '#196f56',
  '#465a73',
] as const

export const SHORTCUT_ACCENTS_DARK = [
  '#2dd4bf',
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#4ade80',
  '#38bdf8',
  '#818cf8',
  '#c084fc',
  '#e879f9',
  '#fda4af',
  '#c9a27a',
  '#34d399',
  '#94a3b8',
] as const

function hashSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0

  return hash
}

export function assignShortcutAccents(seeds: string[], dark = false): string[] {
  const palette: readonly string[] = dark ? SHORTCUT_ACCENTS_DARK : SHORTCUT_ACCENTS
  const size = palette.length
  const used = new Set<number>()
  const out: string[] = []

  for (const seed of seeds) {
    let index = hashSeed(seed) % size

    for (let step = 0; step < size; step++) {
      const candidate = (index + step) % size
      if (!used.has(candidate)) {
        index = candidate
        break
      }
    }

    used.add(index)
    out.push(palette[index])
  }

  return out
}

export function shortcutInitial(name: string, url: string): string {
  const source = (name || shortcutDomain(url) || '?').trim()
  if (!source)
    return '?'

  const chars = Array.from(source)
  const first = chars.find(char => /[\p{L}\p{N}]/u.test(char))

  return (first ?? chars[0] ?? '?').toUpperCase()
}

export function createShortcut(name: string, rawUrl: string): Shortcut | null {
  const url = normalizeUrl(rawUrl)
  if (!url)
    return null

  return {
    id: createId(),
    name: name.trim() || shortcutDomain(url),
    url,
  }
}

export function sanitizeShortcuts(raw: unknown): Shortcut[] {
  if (!Array.isArray(raw))
    return []

  const out: Shortcut[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (!item || typeof item !== 'object')
      continue

    const { id, name, url } = item as Partial<Shortcut>
    if (typeof url !== 'string')
      continue

    const safeUrl = normalizeUrl(url)
    if (!safeUrl)
      continue

    const dedupeKey = safeUrl.replace(/\/$/, '')
    if (seen.has(dedupeKey))
      continue
    seen.add(dedupeKey)

    out.push({
      id: typeof id === 'string' && id ? id : createId(),
      name: typeof name === 'string' && name.trim() ? name.trim() : shortcutDomain(safeUrl),
      url: safeUrl,
    })
  }

  return out
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length)
    return next

  const clamped = Math.max(0, Math.min(next.length - 1, to))
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)

  return next
}

export function defaultShortcuts(): Shortcut[] {
  return DEFAULT_SITES
    .map(site => createShortcut(site.name, site.url))
    .filter((item): item is Shortcut => item !== null)
}
