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

// https://github.com/vueuse/vueuse/blob/658444bf9f8b96118dbd06eba411bb6639e24e88/packages/core/useStorage/guess.ts
export function guessSerializerType(rawInit: unknown) {
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

/**
 * 键名迁移（一次性）：产品从 MyTab 改名成 子午 Meridiem，storage 键从 `mytab-*` 换成 `meridiem-*`。
 *
 * 搬迁放在**读路径**而不是启动流程里，是因为下面的 `writeDefaults` 默认开启：
 * 键不存在时 `read()` 会先写一遍默认值。任何「启动后异步迁移」都可能晚这一步，
 * 那时新键已经有默认值了，老数据就被顶掉。放在 getItem 里没有这个竞态：
 * 读到旧键 → 写新键 → 删旧键，两步之间失败也不丢数据（旧键还在）。
 *
 * 旧键全部搬完（已被删掉）之后这块就是空转，可以连同 `legacyKeyOf` 一起删掉。
 */
const STORAGE_PREFIX = 'meridiem-'
const LEGACY_STORAGE_PREFIX = 'mytab-'

/** `meridiem-shortcuts` → `mytab-shortcuts`；不是本产品的键返回 null */
function legacyKeyOf(key: string) {
  return key.startsWith(STORAGE_PREFIX)
    ? `${LEGACY_STORAGE_PREFIX}${key.slice(STORAGE_PREFIX.length)}`
    : null
}

/** 读一个键的原始值（storage.local 里存的就是序列化后的字符串）；键不存在时返回 null */
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

    // 新键还没有值：看看改名前的旧键里有没有，有就搬过来
    const legacyKey = legacyKeyOf(key)
    if (legacyKey) {
      const legacy = await readRaw(legacyKey)
      if (legacy != null) {
        await storage.local.set({ [key]: legacy })
        await storage.local.remove(legacyKey)
        return legacy
      }

      /* 兜底：新标签页和设置页可能同时首读。另一个页面若刚搬完并删掉旧键，
         而我读旧键时它已经没了 —— 不复查就会当成「没有值」写回默认值，
         把刚搬过去的数据顶掉。旧键先写后删，所以这里必然已有新键。 */
      return await readRaw(key)
    }

    return null
  },
}

/**
 * https://github.com/vueuse/vueuse/blob/658444bf9f8b96118dbd06eba411bb6639e24e88/packages/core/useStorageAsync/index.ts
 *
 * @param key
 * @param initialValue
 * @param options
 */
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
