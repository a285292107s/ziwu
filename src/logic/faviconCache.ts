export const FAVICON_CACHE_KEY = 'meridiem-favicon-cache-v1'

const FAVICON_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

const FAVICON_MISS_TTL = 6 * 60 * 60 * 1000
const MAX_ENTRIES = 200

const MAX_DATA_LENGTH = 64 * 1024

const MAX_TOTAL_BYTES = 256 * 1024

export interface FaviconCacheEntry {
  data?: string
  at: number
}

export interface FaviconCacheHit {
  entry: FaviconCacheEntry
  fresh: boolean
}

type CacheRecord = Record<string, FaviconCacheEntry>

let mirror: CacheRecord | null = null

function faviconStore(): Storage | null {
  try {
    if (typeof localStorage === 'undefined')
      return null
    return localStorage
  }
  catch {
    return null
  }
}

function sanitizeEntry(value: unknown): FaviconCacheEntry | null {
  if (!value || typeof value !== 'object')
    return null

  const { data, at } = value as { data?: unknown, at?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at))
    return null

  if (data === undefined)
    return { at }

  if (typeof data !== 'string' || !isUsableIconData(data))
    return null

  return { data, at }
}

function isUsableIconData(data: string): boolean {
  return data.startsWith('data:image/') && data.length <= MAX_DATA_LENGTH
}

function faviconCacheKey(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    return url.origin
  }
  catch {
    return null
  }
}

function parseRecord(raw: string | null): CacheRecord {
  const out: CacheRecord = {}

  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = sanitizeEntry(value)
        if (entry)
          out[key] = entry
      }
    }
  }
  catch {
  }

  return out
}

function loadMirror(): CacheRecord {
  if (mirror)
    return mirror

  const store = faviconStore()
  mirror = store ? parseRecord(store.getItem(FAVICON_CACHE_KEY)) : {}

  return mirror
}

function trim(record: CacheRecord): CacheRecord {
  const entries = Object.entries(record)
    .sort((a, b) => b[1].at - a[1].at)

  const kept: CacheRecord = {}
  let bytes = 2
  let count = 0

  for (const [key, entry] of entries) {
    if (count >= MAX_ENTRIES)
      break

    const size = key.length + (entry.data?.length ?? 0) + 32
    if (count > 0 && bytes + size > MAX_TOTAL_BYTES)
      break

    kept[key] = entry
    bytes += size
    count++
  }

  return kept
}

function storeRecord(store: Storage, record: CacheRecord): boolean {
  try {
    store.setItem(FAVICON_CACHE_KEY, JSON.stringify(record))
    return true
  }
  catch {
    return false
  }
}

function flush(record: CacheRecord): void {
  const store = faviconStore()
  let next = trim(record)

  if (store && !storeRecord(store, next)) {
    const sorted = Object.entries(next).sort((a, b) => b[1].at - a[1].at)
    next = Object.fromEntries(sorted.slice(0, Math.max(1, sorted.length >> 1)))
    storeRecord(store, next)
  }

  mirror = next
}

function commit(mutate: (record: CacheRecord) => void): void {
  const store = faviconStore()
  const base = store ? parseRecord(store.getItem(FAVICON_CACHE_KEY)) : { ...loadMirror() }
  mutate(base)
  flush(base)
}

export function readFaviconCache(pageUrl: string): FaviconCacheHit | null {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return null

  const entry = loadMirror()[key]
  if (!entry)
    return null

  const ttl = entry.data ? FAVICON_CACHE_TTL : FAVICON_MISS_TTL
  const age = Date.now() - entry.at

  return { entry, fresh: age >= 0 && age < ttl }
}

export function dropFaviconCache(pageUrl: string): void {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return

  commit((record) => {
    delete record[key]
  })
}

export function writeFaviconCache(pageUrl: string, data?: string): void {
  const key = faviconCacheKey(pageUrl)
  if (!key)
    return

  if (data !== undefined && !isUsableIconData(data))
    return

  const at = Date.now()

  commit((record) => {
    if (data === undefined && record[key]?.data)
      return

    record[key] = data === undefined ? { at } : { data, at }
  })
}
