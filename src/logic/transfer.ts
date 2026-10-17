/**
 * 子午 Meridiem 自己的备份文件格式（`.json`）。
 *
 * 这是本产品**唯一**的导入导出格式：设置页「导出备份」写出的文件，
 * 只有设置页「导入备份」能读回来。和其它新标签页的备份结构（iTab 的 `navConfig`
 * 之类）**不做任何兼容**，原因有三个，都是实测出来的：
 *
 * 1. **猜不全**。别人的结构里，站点可能藏在文件夹、分组、列表里，磁贴还可能是
 *    日历 / 倒数日 / 计算器这类组件。靠 `children` / `items` 之类的字段名去递归猜，
 *    每遇到一个新版本就得再猜一次，而且猜错了用户看不出来（好端端的站点被静默丢掉）。
 * 2. **装不下**。子午的设置不只有站点：还有问候语、默认引擎、主题。借来的格式里
 *    没有这些字段的位置，导入一次站点就等于丢掉全部设置。
 * 3. **说不清**。文件头没有身份标识，就只能靠「有没有 url 字段」来判断，
 *    于是随便一个 JSON 都会被当成备份试着解析，报错也只能说「格式不对」。
 *
 * 自己的格式把这三件事一次解决：文件头带 `format` + `version` 做身份校验，
 * 结构里显式给每个设置项留位置，解析失败时能指名道姓说清哪一段不对。
 *
 * 纯函数层：不碰 Vue / DOM / storage（所以这里**不 import `storage.ts`**，
 * 那个模块在引入时就会去读 webextension storage）。文件读写与落盘见
 * `composables/useTransfer.ts`。
 */
import { searchEngines } from './searchEngines'
import { sanitizeShortcuts } from './shortcuts'
import type { ShortcutSeed } from './shortcuts'

/** 文件身份标识：导入时靠它一眼认出「这是不是子午的备份」 */
export const BACKUP_FORMAT = 'meridiem.backup'

/**
 * 当前格式版本。
 * 兼容性规则：新增可选字段不升版本；改变已有字段的含义或删字段时才 +1，
 * 并在 `parseBackupFile` 里按版本分支处理。
 */
export const BACKUP_VERSION = 1

/** 写进文件的展示名，方便用户直接打开 JSON 时认出这是什么 */
export const BACKUP_APP = '子午 Meridiem'

/**
 * 问候语长度上限。
 * 这里是**唯一真源**：设置页输入框的 `maxlength` 与导入时的截断都用它，
 * 否则导入一份超长问候语能绕开输入框限制，写进 storage 后编辑框显示不全。
 */
export const GREETING_MAX_LENGTH = 40

/**
 * 主题两态。
 * 与 `logic/storage.ts` 的 `ThemeMode` 是同一组取值 —— 这里另立一个名字是为了
 * 让本模块保持纯净（见文件头说明），不是两套语义。
 */
export type BackupThemeMode = 'light' | 'dark'

/** 备份文件的结构，也是导出时写盘的内容 */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  app: string
  /** ISO 时间戳，仅供人看，解析时不参与判断 */
  exportedAt: string
  settings: {
    greeting: string
    searchEngineKey: string
    themeMode: BackupThemeMode
  }
  /** 只存名称与网址；**id 刻意不导出**，理由见 `parseBackupFile` */
  shortcuts: ShortcutSeed[]
}

/** 导出时的输入 */
export interface BackupInput {
  greeting: string
  searchEngineKey: string
  themeMode: BackupThemeMode
  shortcuts: readonly ShortcutSeed[]
  /** 便于复现/验证；默认取当前时间 */
  now?: Date
}

/**
 * 解析出来的可落盘内容。
 *
 * 每个设置项都可能为 `null`，含义是「这份备份没带这一项」——导入时保持本机原值不动，
 * 而不是把本机设置清空。少数字段缺失（比如手工删过 setting 的手改文件）不该
 * 连带把用户的问候语抹掉。
 */
export interface BackupPayload {
  greeting: string | null
  searchEngineKey: string | null
  themeMode: BackupThemeMode | null
  shortcuts: ShortcutSeed[]
}

export type BackupParseResult =
  | { ok: true, payload: BackupPayload, warnings: string[] }
  | { ok: false, error: string }

/** 组装一份备份。导出前也过 `sanitizeShortcuts`：storage 可能被手改过，脏数据不该写进文件 */
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

/** 落盘用的文本：缩进两格 + 结尾换行，diff 友好、`cat` 出来也能看 */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * 生成文件名：`meridiem-backup-2026-10-15-1634.json`。
 *
 * 用**本地时间**而不是 ISO 的 UTC 时间：文件名是给人认的，
 * 用户对着「我下午 4 点导的那份」找文件，不该看到 08:34 这个 UTC 数字。
 */
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

  return `meridiem-backup-${stamp}.json`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 解析备份文本。
 *
 * 这里返回结构化结果而不是抛异常：调用方要把失败原因原样显示给用户，
 * 而「为什么失败」有好几种（不是 JSON / 不是子午的文件 / 版本太新 / 内容为空），
 * 用异常表达会逼调用方去解析 message。
 *
 * 逐层校验而不是「解出来就用」：文件可能被手改、被编辑器截断、被同步工具搞坏，
 * 任何一处类型不对都只该丢掉那一项，而不是让整个新标签页读进一个坏对象。
 */
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
      error: `这不是子午 Meridiem 的备份文件：缺少标识 "format": "${BACKUP_FORMAT}"`,
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

  /* ---------------- 站点 ---------------- */
  const rawShortcuts = raw.shortcuts
  if (rawShortcuts !== undefined && !Array.isArray(rawShortcuts))
    warnings.push('"shortcuts" 不是数组，已忽略')

  const declared = Array.isArray(rawShortcuts) ? rawShortcuts : []
  // 复用 storage 的清洗规则：补协议、挡掉 javascript: 之类的危险协议、
  // 按规范化网址去重、丢弃非法项。导入路径与读 storage 走同一套判定，
  // 不会出现「能存进去但读出来被过滤掉」的站点。
  const shortcuts = sanitizeShortcuts(declared).map(({ name, url }) => ({ name, url }))

  if (declared.length > shortcuts.length)
    warnings.push(`有 ${declared.length - shortcuts.length} 条站点地址无效或重复，已跳过`)

  /* ---------------- 设置 ---------------- */
  const settings = isPlainObject(raw.settings) ? raw.settings : {}

  const greeting = typeof settings.greeting === 'string'
    ? settings.greeting.slice(0, GREETING_MAX_LENGTH)
    : null

  // 引擎 key 必须还在目录里：备份可能来自删过某个引擎的版本，
  // 直接写进 storage 会让新标签页的默认引擎指向一个不存在的条目。
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

  /* ---------------- 空文件 ---------------- */
  if (shortcuts.length === 0 && greeting === null && searchEngineKey === null && themeMode === null) {
    return {
      ok: false,
      error: '这份备份里没有任何可以导入的内容（站点与设置都是空的）',
    }
  }

  return {
    ok: true,
    // id 在这里不生成，交给 `useShortcuts().writeSites()` 现造：
    // 备份文件里的 id 属于导出那台机器，直接采信会让「合并导入」出现两个同 id 的磁贴，
    // 之后删一个会连带动到另一个、排序也会错位。
    payload: { greeting, searchEngineKey, themeMode, shortcuts },
    warnings,
  }
}
