import { searchEngines } from './searchEngines'
import { sanitizeShortcuts } from './shortcuts'
import type { ShortcutSeed } from './shortcuts'

export const BACKUP_FORMAT = 'meridiem.backup'

export const BACKUP_VERSION = 1

export const BACKUP_APP = '子午 Ziwu'

export const GREETING_MAX_LENGTH = 40

export type BackupThemeMode = 'light' | 'dark'

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  app: string
  exportedAt: string
  settings: {
    greeting: string
    searchEngineKey: string
    themeMode: BackupThemeMode
  }
  shortcuts: ShortcutSeed[]
}

export interface BackupInput {
  greeting: string
  searchEngineKey: string
  themeMode: BackupThemeMode
  shortcuts: readonly ShortcutSeed[]
  now?: Date
}

export interface BackupPayload {
  greeting: string | null
  searchEngineKey: string | null
  themeMode: BackupThemeMode | null
  shortcuts: ShortcutSeed[]
}

export type BackupParseResult =
  | { ok: true, payload: BackupPayload, warnings: string[] }
  | { ok: false, error: string }

export function buildBackupFile(input: BackupInput): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: BACKUP_APP,
    exportedAt: (input.now ?? new Date()).toISOString(),
    settings: {
      greeting: input.greeting.slice(0, GREETING_MAX_LENGTH),
      searchEngineKey: input.searchEngineKey,
      themeMode: input.themeMode,
    },
    shortcuts: sanitizeShortcuts(input.shortcuts).map(({ name, url }) => ({ name, url })),
  }
}

export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export function backupFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('')

  return `ziwu-backup-${stamp}.json`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseBackupFile(text: string): BackupParseResult {
  const trimmed = text.trim()
  if (!trimmed)
    return { ok: false, error: '还没有内容：先选择备份文件，或把文件内容粘贴进来' }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  }
  catch {
    return { ok: false, error: '这不是合法的 JSON。请选择由子午「导出备份」生成的 .json 文件' }
  }

  if (!isPlainObject(raw))
    return { ok: false, error: '备份文件的最外层应该是一个对象（以 { 开头）' }

  if (raw.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      error: `这不是子午 Ziwu 的备份文件：缺少标识 "format": "${BACKUP_FORMAT}"`,
    }
  }

  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)
    return { ok: false, error: '备份文件缺少有效的 "version" 字段，可能已被截断或改坏' }

  if (raw.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `备份来自更新的版本（v${raw.version}），当前只认到 v${BACKUP_VERSION}，请先升级扩展`,
    }
  }

  const warnings: string[] = []

  const rawShortcuts = raw.shortcuts
  if (rawShortcuts !== undefined && !Array.isArray(rawShortcuts))
    warnings.push('"shortcuts" 不是数组，已忽略')

  const declared = Array.isArray(rawShortcuts) ? rawShortcuts : []
  const shortcuts = sanitizeShortcuts(declared).map(({ name, url }) => ({ name, url }))

  if (declared.length > shortcuts.length)
    warnings.push(`有 ${declared.length - shortcuts.length} 条站点地址无效或重复，已跳过`)

  const settings = isPlainObject(raw.settings) ? raw.settings : {}

  const greeting = typeof settings.greeting === 'string'
    ? settings.greeting.slice(0, GREETING_MAX_LENGTH)
    : null

  const rawEngineKey = typeof settings.searchEngineKey === 'string' ? settings.searchEngineKey : null
  let searchEngineKey: string | null = null
  if (rawEngineKey !== null) {
    if (searchEngines.some(engine => engine.key === rawEngineKey))
      searchEngineKey = rawEngineKey
    else
      warnings.push(`默认引擎「${rawEngineKey}」不在当前版本里，已忽略`)
  }

  const themeMode = settings.themeMode === 'light' || settings.themeMode === 'dark'
    ? settings.themeMode
    : null

  if (themeMode === null && settings.themeMode !== undefined)
    warnings.push('主题取值不是 light / dark，已忽略')

  if (shortcuts.length === 0 && greeting === null && searchEngineKey === null && themeMode === null) {
    return {
      ok: false,
      error: '这份备份里没有任何可以导入的内容（站点与设置都是空的）',
    }
  }

  return {
    ok: true,
    payload: { greeting, searchEngineKey, themeMode, shortcuts },
    warnings,
  }
}
