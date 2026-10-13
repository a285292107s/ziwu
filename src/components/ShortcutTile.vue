<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRealFavicon } from '~/composables/useFavicon'
import {
  faviconUrl,
  shortcutDomain,
  shortcutInitial,
} from '~/logic/shortcuts'
import type { Shortcut } from '~/logic/shortcuts'

const props = defineProps<{
  shortcut: Shortcut
  /** 由父组件统一分配的回退配色，保证同一屏内不撞色 */
  accent: string
  /** 编辑模式下显示删除/排序操作 */
  editing: boolean
  index: number
  total: number
  /**
   * 点磁贴是否开新标签页。
   *
   * 默认 false（同标签页）。新标签页上这与搜索框行为一致，也是 Chrome 官方新标签页的行为。
   * 但「设置页 / 侧边栏」这类辅助界面要传 true：同标签页跳转会把这些界面自己顶掉。
   *
   * 同标签页时**刻意不写 target 属性**（而不是写 target="_self"），
   * 这样 Ctrl/⌘+点击、中键点击仍然是浏览器原生的「开新标签页」。
   */
  openInNewTab?: boolean
}>()

const emit = defineEmits<{
  (e: 'move', from: number, to: number): void
  (e: 'edit', shortcut: Shortcut): void
  /**
   * 传整个 Shortcut 而不是 id。
   * 之前这里传的是 id 字符串，而父组件的处理函数按对象读 `shortcut.id`，
   * 结果 `findIndex` 永远返回 -1 → 删除静默失效（按钮点了没反应、也不报错）。
   * 模板里的事件类型不匹配 tsc 是查不出来的，靠 e2e 才抓到的。
   */
  (e: 'remove', shortcut: Shortcut): void
}>()

const domain = computed(() => shortcutDomain(props.shortcut.url))
const icon = computed(() => faviconUrl(props.shortcut.url, 64))
const initial = computed(() => shortcutInitial(props.shortcut.name, props.shortcut.url))

/**
 * `/_favicon/` 对没缓存过图标的站点会返回通用灰色地球（不是 404），
 * 所以这里要主动判定，判定为占位图就回退到首字母。
 * 见 composables/useFavicon.ts。
 */
const { showIcon, resolve } = useRealFavicon(() => props.shortcut.url)

// 地址变了要重新判定
watch(() => props.shortcut.url, () => resolve())

/**
 * 把「已经在这一端了」挡在这里，而不是用 :disabled。
 *
 * :disabled 的按钮拿不住焦点：键盘用户一路把磁贴按到最前，焦点会掉回 body，
 * 想再往右挪就得从头 Tab 一遍。改成 aria-disabled + 提前 return ——
 * 读屏软件照样念「不可用」，外观和光标也不变，但焦点留在原地。
 */
function moveBy(step: -1 | 1) {
  const target = props.index + step
  if (target < 0 || target >= props.total)
    return

  emit('move', props.index, target)
}
</script>

<template>
  <div
    class="tile"
    :class="editing ? 'is-editing' : ''"
    :data-test="`shortcut-tile-${shortcut.id}`"
    :style="{ '--tile-accent': accent }"
  >
    <a
      :href="editing ? undefined : shortcut.url"
      :target="openInNewTab ? '_blank' : undefined"
      :rel="openInNewTab ? 'noreferrer' : undefined"
      :title="editing ? undefined : `${shortcut.name} · ${domain}`"
      :aria-label="editing ? undefined : `${shortcut.name}（${domain}）`"
      :tabindex="editing ? -1 : 0"
      class="tile-face focus-ring"
      draggable="false"
      @click="editing ? $event.preventDefault() : undefined"
    >
      <!-- 磁贴的配色由站点决定（同屏不撞色，见 logic/shortcuts.ts），
           是「识别线索」而不是页面装饰，所以不参与全站单强调色约束。 -->
      <span class="tile-aurora" aria-hidden="true" />

      <img
        v-if="showIcon && icon"
        :src="icon"
        alt=""
        aria-hidden="true"
        class="tile-icon"
        loading="lazy"
        decoding="async"
      >
      <span
        v-else
        aria-hidden="true"
        class="tile-initial"
      >{{ initial }}</span>
    </a>

    <span class="tile-name">
      {{ shortcut.name }}
    </span>

    <!-- 编辑模式：排序 + 编辑 + 删除。
         分成 2x2 而不是排成一行：一行四个按钮会超出磁贴栏宽（5.5rem），
         实测会横向溢出到相邻磁贴下面。
         排序按钮另外做了「悬停才显形」：4 个按钮一直亮着太吵，
         但它们仍在 DOM 里、仍可 Tab 聚焦，只是平时透明。 -->
    <div
      v-if="editing"
      class="tile-actions"
      :data-test="`tile-actions-${shortcut.id}`"
    >
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :aria-disabled="index === 0"
        :aria-label="`将 ${shortcut.name} 前移`"
        :data-test="`tile-left-${shortcut.id}`"
        @click="moveBy(-1)"
      >
        <span class="i-carbon-arrow-left" />
      </button>
      <button
        type="button"
        class="tile-action focus-ring"
        aria-label="编辑这个快捷方式"
        :data-test="`tile-edit-${shortcut.id}`"
        @click="emit('edit', shortcut)"
      >
        <span class="i-carbon-edit" />
      </button>
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :aria-disabled="index === total - 1"
        :aria-label="`将 ${shortcut.name} 后移`"
        :data-test="`tile-right-${shortcut.id}`"
        @click="moveBy(1)"
      >
        <span class="i-carbon-arrow-right" />
      </button>
      <button
        type="button"
        class="tile-action tile-action--danger focus-ring"
        aria-label="删除这个快捷方式"
        :data-test="`tile-delete-${shortcut.id}`"
        @click="emit('remove', shortcut)"
      >
        <span class="i-carbon-close" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  --tile-glow: color-mix(in srgb, var(--tile-accent) 42%, transparent);
}

/* ---------------------------------------------------------------
   磁贴表面
   ---------------------------------------------------------------
   三档视觉一起决定「材质」：内层高光（inset 1px）让边缘有玻璃的厚度、
   外层投影把它从背景上抬起来、底部一层极淡的站点色让每块磁贴
   带一点归属感而不至于变成彩色贴纸。
   --------------------------------------------------------------- */
.tile-face {
  position: relative;
  display: grid;
  place-items: center;
  width: 3.75rem;
  height: 3.75rem;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-tile);
  background: var(--surface);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow:
    var(--shadow-tile),
    inset 0 1px 0 var(--line-inset);
  transition:
    transform var(--dur-base) var(--ease-spring),
    box-shadow var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out);
}

/* 站点色在磁贴上的「存在感」。
   浅色主题只在底缘压一条很窄的抬高光：大团站点色晕铺在半透明浅色玻璃上
   会变成一块洗不掉的污渍（第一轮截图里 GitHub 底下那团赭黄就是这么来的）。
   深色主题的深底吃得住颜色，可以给一圈完整的晕，让磁贴有体积感。
   两个主题的写法放在 main.css 的 token 里，见 `--tile-aurora`。 */
.tile-aurora {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--tile-aurora);
  transition: opacity var(--dur-base) var(--ease-out);
}

a.tile-face:hover {
  transform: translateY(-4px);
  border-color: color-mix(in srgb, var(--tile-accent) 42%, var(--line));
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-tile-hover),
    inset 0 1px 0 var(--line-inset);
}

a.tile-face:hover .tile-aurora {
  opacity: 1;
}

a.tile-face:active {
  transform: translateY(-1px) scale(0.97);
  transition-duration: var(--dur-fast);
}

.tile.is-editing .tile-face {
  cursor: default;
}

.tile-icon {
  position: relative;
  width: 1.75rem;
  height: 1.75rem;
  object-fit: contain;
}

/* 首字母回退：中性徽标 + 一圈站点色细环。
   试过三种做法，最后选这个：
   1. 实心站点色块 + 白字：整排糖果色，把页面调性拖走，而且和真实 favicon
      （有的透明、有的深色）混在一排里重量对不齐。
   2. 低饱和站点色底 + 同色字：小尺寸下淡色底会糊成一块，字形对比度
      实测最低只有 3.55:1，低于 AA。
   3. 中性底 + 中性字形 + 站点色细环（当前）：字形对磁贴底 11:1 以上，
      颜色以「一圈线 + 一圈光晕」的身份出现，安静但认得出。 */
.tile-initial {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border: 1.5px solid color-mix(in srgb, var(--tile-accent) 62%, transparent);
  border-radius: var(--radius-inner);
  background: var(--surface-strong);
  color: var(--text-1);
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  transition:
    background var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out);
}

a.tile-face:hover .tile-initial {
  border-color: var(--tile-accent);
  background: var(--tile-accent);
  color: var(--tile-ink);
}

.tile-name {
  max-width: 5.5rem;
  overflow: hidden;
  color: var(--text-2);
  font-size: 0.73rem;
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur-base) var(--ease-out);
}

a.tile-face:hover ~ .tile-name {
  color: var(--text-1);
}

.tile.is-editing .tile-name {
  color: var(--text-3);
}

/* ---- 编辑模式的小按钮 ----
   2x2 排布，整体宽度锁在磁贴栏宽以内（2 个 1.5rem 按钮 + 间距）。 */
.tile-actions {
  display: grid;
  grid-template-columns: repeat(2, 1.5rem);
  gap: 0.2rem;
  justify-content: center;
}

.tile-action {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--surface-strong);
  color: var(--text-2);
  font-size: 0.78rem;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

/* 排序按钮平时隐藏，但**必须留在 Tab 顺序里** —— 「整理」模式下的键盘用户
   就靠这两个按钮排序（README 也是这么写的）。
   所以这里用 opacity 而不是 visibility：visibility: hidden 的元素不进 Tab 顺序，
   焦点永远到不了它身上，写成 :focus-visible 的显形规则其实是句死代码。
   配 pointer-events: none 是为了触屏：那儿没有 hover，别让手指点到看不见的按钮。
   WCAG 2.4.7（焦点可见）也守得住 —— 焦点一落到这个格子里，两个按钮立刻显形，
   用户不会「走过一个看不见的按钮」。 */
.tile-action--reorder {
  opacity: 0;
  pointer-events: none;
}

.tile:hover .tile-action--reorder {
  opacity: 1;
  pointer-events: auto;
}

/* 键盘聚焦时不走过渡：焦点环必须当场可见，不能等它淡进来 */
.tile:focus-within .tile-action--reorder {
  opacity: 1;
  pointer-events: auto;
  transition: none;
}

.tile-action:hover:not([aria-disabled='true']) {
  border-color: var(--brand);
  background: var(--brand);
  color: var(--text-on-accent);
}

.tile-action:active:not([aria-disabled='true']) {
  transform: scale(0.9);
}

/* 到头了的那个方向：不用 :disabled（那会丢焦点，见 moveBy），
   外观照旧压暗 —— 禁用态不用 opacity 压：那会把里面的图标一起拉淡，
   在浅色底上掉到 2:1 以下。改成直接换成更弱的文字色。 */
.tile-action[aria-disabled='true'] {
  color: var(--text-3);
  cursor: not-allowed;
}

.tile-action--danger:hover:not([aria-disabled='true']) {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--danger-ink);
}
</style>
