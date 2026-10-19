import { StorageSerializers } from '@vueuse/core'
import { pausableWatch, toValue, tryOnScopeDispose } from '@vueuse/shared'
import { ref, shallowRef } from 'vue-demi'
import { storage } from 'webextension-polyfill'

import type {
  StorageLikeAsync,
  UseStorageAsyncOptions,
} from '@vueuse/core'
import type { MaybeRefOrGetter, RemovableRef } from '@vueuse/shared'
import type { Ref } from 'vue-demi'
import type { Storage } from 'webextension-polyfill'

export type WebExtensionStorageOptions<T> = UseStorageAsyncOptions<T>

function guessSerializerType(rawInit: unknown) {
  return rawInit == null
    ? 'any'
    : rawInit instanceof Set
      ? 'set'
      : rawInit instanceof Map
        ? 'map'
        : rawInit instanceof Date
          ? 'date'
          : typeof rawInit === 'boolean'
            ? 'boolean'
            : typeof rawInit === 'string'
              ? 'string'
              : typeof rawInit === 'object'
                ? 'object'
                : Number.isNaN(rawInit)
                  ? 'any'
                  : 'number'
}

const STORAGE_PREFIX = 'meridiem-'
const LEGACY_STORAGE_PREFIX = 'mytab-'

function legacyKeyOf(key: string) {
  return key.startsWith(STORAGE_PREFIX)
    ? `${LEGACY_STORAGE_PREFIX}${key.slice(STORAGE_PREFIX.length)}`
    : null
}

async function readRaw(key: string) {
  const stored = await storage.local.get(key)

  return (stored[key] ?? null) as string | null
}

const storageInterface: StorageLikeAsync = {
  removeItem(key: string) {
    return storage.local.remove(key)
  },

  setItem(key: string, value: string) {
    return storage.local.set({ [key]: value })
  },

  async getItem(key: string) {
    const current = await readRaw(key)
    if (current != null)
      return current

    const legacyKey = legacyKeyOf(key)
    if (legacyKey) {
      const legacy = await readRaw(legacyKey)
      if (legacy != null) {
        await storage.local.set({ [key]: legacy })
        await storage.local.remove(legacyKey)
        return legacy
      }

      return await readRaw(key)
    }

    return null
  },
}

export function useWebExtensionStorage<T>(
  key: string,
  initialValue: MaybeRefOrGetter<T>,
  options: WebExtensionStorageOptions<T> = {},
): { data: RemovableRef<T>, dataReady: Promise<T> } {
  const {
    flush = 'pre',
    deep = true,
    listenToStorageChanges = true,
    writeDefaults = true,
    mergeDefaults = false,
    shallow,
    eventFilter,
    onError = (e) => {
      console.error(e)
    },
  } = options

  const rawInit: T = toValue(initialValue)
  const type = guessSerializerType(rawInit)

  const data = (shallow ? shallowRef : ref)(initialValue) as Ref<T>
  const serializer = options.serializer ?? StorageSerializers[type]

  async function read(event?: { key: string, newValue: string | null }) {
    if (event && event.key !== key)
      return

    try {
      const rawValue = event ? event.newValue : await storageInterface.getItem(key)
      if (rawValue == null) {
        data.value = rawInit
        if (writeDefaults && rawInit !== null)
          await storageInterface.setItem(key, await serializer.write(rawInit))
      }
      else if (mergeDefaults) {
        const value = await serializer.read(rawValue) as T
        if (typeof mergeDefaults === 'function')
          data.value = mergeDefaults(value, rawInit)
        else if (type === 'object' && !Array.isArray(value))
          data.value = { ...(rawInit as Record<keyof unknown, unknown>), ...(value as Record<keyof unknown, unknown>) } as T
        else data.value = value
      }
      else {
        data.value = await serializer.read(rawValue) as T
      }
    }
    catch (error) {
      onError(error)
    }
  }

  const dataReadyPromise = new Promise<T>((resolve, reject) => {
    read().then(() => resolve(data.value)).catch(reject)
  })

  async function write() {
    try {
      await (
        data.value == null
          ? storageInterface.removeItem(key)
          : storageInterface.setItem(key, await serializer.write(data.value))
      )
    }
    catch (error) {
      onError(error)
    }
  }

  const { pause: pauseWatch, resume: resumeWatch } = pausableWatch(
    data,
    write,
    {
      flush,
      deep,
      eventFilter,
    },
  )

  if (listenToStorageChanges) {
    const listener = async (changes: Record<string, Storage.StorageChange>) => {
      try {
        pauseWatch()
        for (const [key, change] of Object.entries(changes)) {
          await read({
            key,
            newValue: change.newValue as string | null,
          })
        }
      }
      finally {
        resumeWatch()
      }
    }

    storage.onChanged.addListener(listener)

    tryOnScopeDispose(() => {
      storage.onChanged.removeListener(listener)
    })
  }

  return {
    data: data as RemovableRef<T>,
    dataReady: dataReadyPromise,
  }
}
