/**
 * 备份文件的读写与落盘。
 *
 * 这一层负责「碰环境」的部分：触发浏览器下载、读用户选中的文件、把解析结果写进 storage。
 * 纯数据变换全在 `logic/transfer.ts`（那个模块不碰 DOM / storage，方便单独喂参数验证）。
 *
 * 写 storage 走的是和设置页其它控件**同一批 ref**（`logic/storage.ts` 导出的
 * `greeting` / `searchEngineKey` / `themeMode` / `shortcuts`），所以导入完成后
 * 新标签页会通过 `storage.onChanged` 自动同步，这里不需要额外通知谁。
 */
import { greeting, searchEngineKey, shortcuts, themeMode } from '~/logic/storage'
import { useShortcuts } from '~/composables/useShortcuts'
import {
  backupFileName,
  buildBackupFile,
  serializeBackup,
} from '~/logic/transfer'
import type { BackupPayload } from '~/logic/transfer'

export function useTransfer() {
  const { writeSites } = useShortcuts()

  /**
   * 导出并触发下载。
   *
   * 用 `Blob` + 临时 `<a download>` 而不是 `chrome.downloads`：
   * 后者要额外申请 `downloads` 权限（用户会看到「读取下载内容」这类吓人的提示），
   * 而这里只是一次用户主动点击触发的保存，用原生下载就够了。
   */
  function exportBackup(): { fileName: string, shortcutCount: number } {
    const now = new Date()
    const file = buildBackupFile({
      greeting: greeting.value ?? '',
      searchEngineKey: searchEngineKey.value,
      themeMode: themeMode.value,
      shortcuts: shortcuts.value ?? [],
      now,
    })

    const fileName = backupFileName(now)
    const blob = new Blob([serializeBackup(file)], { type: 'application/json' })
    const href = URL.createObjectURL(blob)

    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()

    // 立刻 revoke 会让部分浏览器还没开始读就失效，让出一轮事件循环再回收
    setTimeout(() => URL.revokeObjectURL(href), 0)

    return { fileName, shortcutCount: file.shortcuts.length }
  }

  /**
   * 把解析出来的备份写进 storage。
   *
   * 设置项为 `null` 表示「这份备份没带这一项」，保持本机原值不动 ——
   * 不把缺失当成「清空」，否则一份手工删过字段的备份会把用户问候语抹掉。
   *
   * `mode` 直接透传给 `writeSites`，语义见那里的 `WriteMode`。
   */
  function applyBackup(
    payload: BackupPayload,
    mode: 'merge' | 'replace',
  ): { added: number, skipped: number, settings: number } {
    let settings = 0

    if (payload.greeting !== null) {
      greeting.value = payload.greeting
      settings++
    }
    if (payload.searchEngineKey !== null) {
      searchEngineKey.value = payload.searchEngineKey
      settings++
    }
    if (payload.themeMode !== null) {
      themeMode.value = payload.themeMode
      settings++
    }

    const result = writeSites(payload.shortcuts, mode)

    return { ...result, settings }
  }

  /** 读一个用户选中的文件；只读文本，不做解析（解析在 `logic/transfer.ts`） */
  async function readBackupFile(file: File): Promise<string> {
    return await file.text()
  }

  return { exportBackup, applyBackup, readBackupFile }
}
