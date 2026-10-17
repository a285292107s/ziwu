<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRealFavicon } from '~/composables/useFavicon'
import {
  shortcutDomain,
  shortcutInitial,
} from '~/logic/shortcuts'
import type { Shortcut } from '~/logic/shortcuts'

const props = withDefaults(defineProps<{
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
  /**
   * 网格方向键导航的 roving tabindex：只有当前格是 Tab 停靠点。
   * 普通模式下由父组件按 activeCell 计算；编辑模式下磁贴面本身退出 Tab 顺序。
   */
  tabIndex?: number
  /** 是否是当前磁贴：编辑模式下只有它的四个操作按钮进入 Tab 顺序 */
  active?: boolean
}>(), {
  openInNewTab: false,
  tabIndex: 0,
  active: false,
})

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
const initial = computed(() => shortcutInitial(props.shortcut.name, props.shortcut.url))

/**
 * `/_favicon/` 对没缓存过图标的站点会返回通用灰色地球（不是 404），
 * 所以这里要主动判定，判定为占位图就回退到首字母。
 * 判定结果与图标字节会被持久缓存，所以第二次开新标签页不再重新拉取。
 * 见 composables/useFavicon.ts。
 *
 * 图标的 src 也由它给（可能是 `data:`，也可能是没缓存住时的 `/_favicon/` 地址），
 * 组件不再自己去拼地址 —— 两处各拼一次就会出现「判定用 A、显示用 B」的错配。
 */
const { showIcon, iconSrc, resolve, onIconError } = useRealFavicon(() => props.shortcut.url)

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
      :tabindex="tabIndex"
      class="tile-face focus-ring"
      draggable="false"
      @click="editing ? $event.preventDefault() : undefined"
    >
      <!-- 磁贴的配色由站点决定（同屏不撞色，见 logic/shortcuts.ts），
           是「识别线索」而不是页面装饰，所以不参与全站单强调色约束。 -->
      <span class="tile-aurora" aria-hidden="true" />

      <!-- 图标解不开时退回首字母：缓存里的坏数据会让浏览器只画一个空白方框，
           比首字母难看得多。见 useFavicon.ts 的 onIconError。 -->
      <img
        v-if="showIcon && iconSrc"
        :src="iconSrc"
        alt=""
        aria-hidden="true"
        class="tile-icon"
        loading="lazy"
        decoding="async"
        @error="onIconError"
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

    <!-- 编辑模式：编辑 / 删除 + 排序。
         分成 2x2 而不是排成一行：一行四个按钮会超出磁贴栏宽（5.5rem），
         实测会横向溢出到相邻磁贴下面。

         两行按「干什么」分组，而不是按原来的从左到右数：
         第一行是「改这块磁贴」（编辑 / 删除），第二行是「把它挪个位置」（左移 / 右移）。
         左、右两个箭头必须并排在同一行 —— 它们是一对方向相反的兄弟，
         分到上下两行（原来的 左/编辑 上、右/删除 下）之后方向关系是断的，
         眼睛得先把四宫格读一遍才知道哪个是左、哪个是右。

         排序按钮另外做了「悬停才显形」：4 个按钮一直亮着太吵，
         但它们仍在 DOM 里、仍可 Tab 聚焦，只是平时透明。 -->
    <div
      v-if="editing"
      class="tile-actions"
      :data-test="`tile-actions-${shortcut.id}`"
    >
      <button
        type="button"
        class="tile-action focus-ring"
        :tabindex="active ? 0 : -1"
        aria-label="编辑这个快捷方式"
        :data-test="`tile-edit-${shortcut.id}`"
        @click="emit('edit', shortcut)"
      >
        <span class="i-carbon-edit" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">编辑</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--danger focus-ring"
        :tabindex="active ? 0 : -1"
        aria-label="删除这个快捷方式"
        :data-test="`tile-delete-${shortcut.id}`"
        @click="emit('remove', shortcut)"
      >
        <span class="i-carbon-close" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">删除</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :tabindex="active ? 0 : -1"
        :aria-disabled="index === 0"
        :aria-label="`将 ${shortcut.name} 前移`"
        :data-test="`tile-left-${shortcut.id}`"
        @click="moveBy(-1)"
      >
        <span class="i-carbon-arrow-left" aria-hidden="true" />
        <!-- 到头了就把提示换成原因：按钮压暗只是「看起来不能点」，
             这里补一句为什么，省得用户以为按钮坏了 -->
        <span class="tile-tip" aria-hidden="true">{{ index === 0 ? '已到最前' : '前移' }}</span>
      </button>
      <button
        type="button"
        class="tile-action tile-action--reorder focus-ring"
        :tabindex="active ? 0 : -1"
        :aria-disabled="index === total - 1"
        :aria-label="`将 ${shortcut.name} 后移`"
        :data-test="`tile-right-${shortcut.id}`"
        @click="moveBy(1)"
      >
        <span class="i-carbon-arrow-right" aria-hidden="true" />
        <span class="tile-tip" aria-hidden="true">{{ index === total - 1 ? '已到最后' : '后移' }}</span>
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

/* 悬停：磁贴抬起来一点，**图标自己再站直一点**。
   抬升量从 -4px 提到 -5px —— 这不是随手加的：入场那一套动作的位移是
   20px（玻璃面）+ 10px（图标）+ 15% 的过冲，而交互反馈原来只有 -4px，
   **手指的力道反而比「页面自己动」还轻**，层级是反的。

   放大只给 5%：两个缩放是**相乘**的 —— 入场动画占
   `scale` 独立属性、悬停占 `transform`，两者不互相覆盖而是叠加。
   新标签页刚打开时指针常常正好停在页面中央，那一格如果在波里，
   顶点处就是 1.15 × 悬停倍数；放大越多，那一格越显眼。

   为什么「放大」写在图标上而不是磁贴面上：`.tile-face` 带 backdrop-filter，
   缩放它就得让合成器每帧按新尺寸重新采样背后的 WebGL 天空 ——
   这正是入场那一层把 `scale` 拿掉的原因，没道理在 hover 上再加回来。
   图标没有 backdrop，放大它是免费的，而且「图标精神了一点」本来
   就比「整块玻璃变大」更像一次应答。

   图标这条走 `transform` 而不是 `scale`：入场那条动画占着 `scale` 通道，
   在它跑完之前**动画来源在层叠里压过普通声明** —— 写在 `scale` 上的
   hover 会在入场那一小段时间里静默失效。`transform` 是空着的，
   所以悬停应答从入场的第一帧起就成立；代价就是上面那句「相乘」。
   两者只能选一个，这里选了「应答永远在」。 */
a.tile-face:hover {
  transform: translateY(-5px);
  border-color: color-mix(in srgb, var(--tile-accent) 42%, var(--line));
  background: var(--surface-hover);
  box-shadow:
    var(--shadow-tile-hover),
    inset 0 1px 0 var(--line-inset);
}

a.tile-face:hover .tile-aurora {
  opacity: 1;
}

a.tile-face:hover .tile-icon,
a.tile-face:hover .tile-initial {
  transform: scale(1.05);
}

a.tile-face:active {
  transform: translateY(-1px);
  transition-duration: var(--dur-fast);
}

a.tile-face:active .tile-icon,
a.tile-face:active .tile-initial {
  transform: scale(0.94);
}

.tile.is-editing .tile-face {
  cursor: default;
}

.tile-icon {
  position: relative;
  width: 1.75rem;
  height: 1.75rem;
  object-fit: contain;
  /* 只有 hover / active 的“站直一点”走这条 transition；
     入场动画占的是 scale/rotate/translate，两者互不干扰。 */
  transition: transform var(--dur-base) var(--ease-spring);
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
    transform var(--dur-base) var(--ease-spring),
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
   2x2 排布，整体宽度锁在磁贴栏宽以内（2 个 1.5rem 按钮 + 间距）。

   顺序即「分组」：DOM 依次是 编辑 / 删除 / 前移 / 后移，按两列折行之后
   正好是「改这块磁贴」在上、「挪它的位置」在下。

   这里刻意**不给按钮设 position**：气泡（.tile-tip）要相对整个 2x2 方块
   定位，而不是相对它自己那个按钮 —— 按钮一旦成为定位祖先，第二行按钮的气泡
   就会弹在第一行按钮身上（实测「后移」的提示正好糊住「删除」）。
   把定位祖先让给 .tile-actions，四个气泡就都落在方块上方，谁也盖不住谁。 */
.tile-actions {
  position: relative;
  z-index: 2;
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

/* ---- 气泡提示（tips） ----
   四个小按钮只有图标，而「铅笔 / ✕ / ← / →」在 1.5rem 的格子里说不清
   「点了会怎样」—— 尤其两个箭头，是移到隔壁还是移到头，只能靠试。
   于是鼠标停上去、键盘 Tab 聚焦时弹一句中文。

   气泡是**纯视觉**的补充：`aria-hidden`，读屏软件念按钮自己的 aria-label
   就够了，不该被念两遍；上不了屏的浏览器也只是少一句提示，不影响操作。

   位置固定在 2x2 方块正上方，**不是各自按钮的上方**：四个按钮挨得太近
   （间距 0.2rem），按按钮定位的话下面那行的气泡会正好糊住上面那行的按钮。
   统一放到方块外，谁也盖不住谁。代价是四种状态的提示位置一样，
   但提示本来就是「跟着操作走的文字」，位置固定反而更好读。

   `--z-toast + 2`：压过相邻磁贴和其它浮层。
   pointer-events: none 是必须的：气泡一旦吃鼠标，鼠标从按钮挪到气泡上时
   按钮就丢了 hover，气泡闪一下消失、鼠标回到按钮又出来 —— 会抖。 */
.tile-tip {
  position: absolute;
  bottom: calc(100% + 0.4rem);
  left: 50%;
  z-index: calc(var(--z-toast) + 2);
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-base);
  color: var(--text-1);
  font-size: 0.66rem;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  /* 位移写进 transform：气泡是「从按钮上长出来」的，不是凭空出现 */
  transform: translateX(-50%) translateY(3px);
  box-shadow: var(--shadow-2);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

/* 鼠标停上去就显形。
   不区分「能不能点」：到头的那两个按钮提示的是「已到最前 / 已到最后」，
   禁用方向更该说清楚，而不是干脆不给提示。 */
.tile-action:hover .tile-tip,
/* 键盘用户同样看得到（气泡对 Tab 聚焦显形，和 hover 一样）。
   键盘上指不到按钮，这句提示就是「这个按钮是干什么的」的唯一线索。 */
.tile-action:focus-visible .tile-tip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* 键盘聚焦时不走过渡：提示和焦点环都必须当场可见，不能等它淡进来 */
.tile-action:focus-visible .tile-tip {
  transition: none;
}

/* ---- 高对比度 / 强制色模式 ----
   Windows 高对比度下 background 会被系统覆盖成主题色，
   气泡的边框得跟着走，否则文字和底同色 —— 等于看不见。 */
@media (forced-colors: active) {
  .tile-tip {
    border: 1px solid CanvasText;
    background: Canvas;
    color: CanvasText;
  }
}
</style>
