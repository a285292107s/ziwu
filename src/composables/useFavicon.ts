import { ref } from 'vue'
import { dropFaviconCache, readFaviconCache, writeFaviconCache } from '~/logic/faviconCache'
import { FAVICON_PROBE_URL, faviconUrl } from '~/logic/shortcuts'

let placeholderHash: string | null = null
let calibrating: Promise<string | null> | null = null

const inFlight = new Map<string, Promise<LoadResult>>()

type LoadResult =
  | { kind: 'icon', data: string | null }
  | { kind: 'monogram' }

interface Fingerprint {
  hash: string
  opaque: number
  dataUrl: string | null
}

function toDataUrl(img: HTMLImageElement): string | null {
  try {
    const size = Math.max(1, Math.min(64, img.naturalWidth || 64))
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx)
      return null

    ctx.drawImage(img, 0, 0, size, size)
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}

function fingerprint(url: string): Promise<Fingerprint | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }

        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        let hash = 2166136261
        let opaque = 0
        for (let i = 0; i < data.length; i++) {
          hash ^= data[i]
          hash = Math.imul(hash, 16777619)
          if (i % 4 === 3 && data[i] > 10)
            opaque++
        }
        resolve({
          hash: (hash >>> 0).toString(16),
          opaque: opaque / 1024,
          dataUrl: toDataUrl(img),
        })
      }
      catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function calibrate(probeUrl: string): Promise<string | null> {
  if (placeholderHash !== null)
    return Promise.resolve(placeholderHash)
  if (calibrating)
    return calibrating

  calibrating = fingerprint(probeUrl).then((result) => {
    placeholderHash = result?.hash ?? null
    return placeholderHash
  })

  return calibrating
}

function loadFavicon(iconUrl: string, probeIconUrl: string): Promise<LoadResult> {
  const running = inFlight.get(iconUrl)
  if (running)
    return running

  const task = (async (): Promise<LoadResult> => {
    const [probe, actual] = await Promise.all([
      calibrate(probeIconUrl),
      fingerprint(iconUrl),
    ])

    if (!actual)
      return { kind: 'monogram' }

    if (actual.opaque < 0.02)
      return { kind: 'monogram' }

    if (probe && actual.hash === probe)
      return { kind: 'monogram' }

    return { kind: 'icon', data: actual.dataUrl }
  })().finally(() => {
    inFlight.delete(iconUrl)
  })

  inFlight.set(iconUrl, task)

  return task
}

export function useRealFavicon(pageUrl: () => string | null) {
  const showIcon = ref(false)
  const iconSrc = ref<string | null>(null)

  function resolve(): Promise<void> {
    const target = pageUrl()

    if (!target) {
      showIcon.value = false
      iconSrc.value = null
      return Promise.resolve()
    }

    const hit = readFaviconCache(target)
    if (hit) {
      showIcon.value = !!hit.entry.data
      iconSrc.value = hit.entry.data ?? null
      if (hit.fresh)
        return Promise.resolve()
    }
    else {
      showIcon.value = false
      iconSrc.value = null
    }

    return load(target)
  }

  async function load(target: string): Promise<void> {
    const probeIcon = faviconUrl(FAVICON_PROBE_URL, 64)
    const icon = faviconUrl(target, 64)
    if (!probeIcon || !icon)
      return

    const result = await loadFavicon(icon, probeIcon)

    if (pageUrl() !== target)
      return

    if (result.kind === 'icon') {
      showIcon.value = true
      iconSrc.value = result.data ?? icon
      if (result.data)
        writeFaviconCache(target, result.data)
      return
    }

    const known = readFaviconCache(target)
    if (known?.entry.data) {
      showIcon.value = true
      iconSrc.value = known.entry.data
      writeFaviconCache(target, known.entry.data)
      return
    }

    showIcon.value = false
    iconSrc.value = null
    writeFaviconCache(target)
  }

  function onIconError() {
    const target = pageUrl()
    showIcon.value = false
    iconSrc.value = null
    if (target)
      dropFaviconCache(target)
  }

  resolve()

  return { showIcon, iconSrc, resolve, onIconError }
}
