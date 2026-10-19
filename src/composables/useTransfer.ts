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

    setTimeout(() => URL.revokeObjectURL(href), 0)

    return { fileName, shortcutCount: file.shortcuts.length }
  }

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

  async function readBackupFile(file: File): Promise<string> {
    return await file.text()
  }

  return { exportBackup, applyBackup, readBackupFile }
}
