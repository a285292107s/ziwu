<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTheme } from '~/composables/useTheme'
import { useShortcuts } from '~/composables/useShortcuts'
import { PAGE_BEAT_MS } from '~/logic/motion'
import { shortcutsReady } from '~/logic/storage'
import {
  assignShortcutAccents,
  moveItem,
  normalizeUrl,
  shortcutDomain,
} from '~/logic/shortcuts'
import type { Shortcut } from '~/logic/shortcuts'

/**
 * 点磁贴是否开新标签页。
 *
 * 默认 false（同标签页），与新标签页上的搜索框保持一致。
 * 设置页 / 侧边栏传 true：那里同标签页跳转会把界面自己顶掉。
 */
const props = withDefaults(defineProps<{ openInNewTab?: boolean }>(), {
  openInNewTab: false,
})

const { list, add, update, remove, insertAt, move } = useShortcuts()
const { isDark } = useTheme()

/**
 * 同一屏内不撞色的配色表（与 list 顺序一一对应）。
 * 详见 logic/shortcuts.ts 的 assignShortcutAccents()。
 *
 * 取色按 **站点 id** 而不是下标：拖动排序时磁贴会换位置，
 * 按下标取色会让颜色跟着格子跑（一屏颜色乱跳），按 id 取则
 * 「知乎永远是同一个色」，拖完也不会变。
 */
const accentById = computed(() => {
  const colors = assignShortcutAccents(list.value.map(item => shortcutDomain(item.url)), isDark.value)
  const map = new Map<string, string>()
  list.value.forEach((item, index) => map.set(item.id, colors[index]))
  return map
})

function accentOf(id: string): string {
  return accentById.value.get(id) ?? ''
}

const editing = ref(false)

/* ---------------------------------------------------------------
   新增 / 编辑对话框
   --------------------------------------------------------------- */
const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const formName = ref('')
const formUrl = ref('')
const formError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
/** 打开对话框前的焦点元素，关闭后要还回去 */
let lastFocused: HTMLElement | null = null

const dialogTitle = computed(() => dialogMode.value === 'create' ? '添加快捷方式' : '编辑快捷方式')

function openCreate() {
  dialogMode.value = 'create'
  editingId.value = null
  formName.value = ''
  formUrl.value = ''
  formError.value = ''
  openDialog()
}

function openEdit(shortcut: Shortcut) {
  dialogMode.value = 'edit'
  editingId.value = shortcut.id
  formName.value = shortcut.name
  formUrl.value = shortcut.url
  formError.value = ''
  openDialog()
}

async function openDialog() {
  lastFocused = document.activeElement as HTMLElement | null
  dialogOpen.value = true
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function closeDialog() {
  dialogOpen.value = false
  formError.value = ''
  // 焦点归还，键盘用户不会被丢在页面角落
  nextTick(() => lastFocused?.focus?.())
}

function submitForm() {
  const rawUrl = formUrl.value.trim()

  if (!rawUrl) {
    formError.value = '请填写网址'
    return
  }

  if (!normalizeUrl(rawUrl)) {
    formError.value = '这个网址看起来不对，试试 example.com 这样的格式'
    return
  }

  const ok = dialogMode.value === 'create'
    ? Boolean(add(formName.value, rawUrl))
    : update(editingId.value!, formName.value, rawUrl)

  if (!ok) {
    formError.value = '保存失败，请检查网址'
    return
  }

  // 名字留空时后端会用域名兜底，这里同步给用户看一眼
  closeDialog()
}

/** 对话框内的键盘处理：Escape 关闭 + 简单焦点循环 */
function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeDialog()
    return
  }

  if (event.key !== 'Tab' || !dialogEl.value)
    return

  const focusable = dialogEl.value.querySelectorAll<HTMLElement>(
    'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  )
  const items = Array.from(focusable).filter(el => !el.hasAttribute('disabled'))
  if (items.length === 0)
    return

  const first = items[0]
  const last = items[items.length - 1]

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/* ---------------------------------------------------------------
   删除 + 撤销
   --------------------------------------------------------------- */
interface PendingRemoval { shortcut: Shortcut, index: number }
const pendingRemoval = ref<PendingRemoval | null>(null)
let undoTimer: number | undefined

function removeWithUndo(shortcut: Shortcut) {
  const index = list.value.findIndex(item => item.id === shortcut?.id)
  if (index === -1)
    return

  remove(shortcut.id)
  pendingRemoval.value = { shortcut, index }

  window.clearTimeout(undoTimer)
  undoTimer = window.setTimeout(() => {
    pendingRemoval.value = null
  }, 5000)
}

function undoRemoval() {
  const pending = pendingRemoval.value
  if (!pending)
    return

  // 必须走 insertAt()：`list` 是只读 computed，直接赋值会静默失败
  insertAt(pending.shortcut, pending.index)

  pendingRemoval.value = null
  window.clearTimeout(undoTimer)
}

/* ---------------------------------------------------------------
   按住图标拖动排序：鼠标 / 触屏 / 触控笔统一走指针事件
   ---------------------------------------------------------------
   不用 HTML5 的 dragstart / drop：触屏浏览器根本不派发这些事件
   （手机上图标永远排不了序），而且必须先点「整理」进编辑模式才拖得动。

   输入按「精度」分两类，不按设备分：
   - **手指**（`pointerType === 'touch'`）：门槛更久、**任何模式**都要先按住、
     卡片抬到指尖上方。手指点不准、容易慢点击、还挡视线；
     顺带也保证了「想滚页面」不会变成「拖图标」（设置页 / 侧边栏那种长列表里
     尤其明显，iOS 整理主屏也是这个规矩）。
   - **精度输入**（鼠标 / 触控笔）：门槛短、卡片不抬（笔尖要对得准）；
     「整理」模式里磁贴不是链接、没有误打开站点的风险，位移几像素就开拖。
     长按成立之前**移动不取消手势** —— 桌面上「按下顺手就拖」最自然，
     而取消的后果是「拖动没发生、松手还变成一次点击」。
   - 判定成「拖动」的唯一标准是**真的挪过窝**（或真的换过格子）：
     只按住没动的，松手仍然照常打开站点 —— 打开站点是这里的主操作，
     不能被一个迟疑的长按吃掉。

   顺序只在拖动期间改本地副本（`order`），松手才写一次 storage ——
   否则每滑过一格就写一次盘。
   --------------------------------------------------------------- */

/** 鼠标 / 触控笔按住多久算「按住」：这俩是精度输入，按下去就是有意的 */
const HOLD_MOUSE_MS = 220
/**
 * 手指要更久一点。
 * 手指的「慢点击」很常见（按住两百多毫秒再抬手），门槛按鼠标那套定的话，
 * 这些点击会先被判成拖动、然后被 click 守卫吃掉 —— 打开站点是这个组件的
 * 主操作，宁可让拖动多等一会儿。
 */
const HOLD_TOUCH_MS = 350
/** 长按生效前允许的抖动（手指按在屏幕上几乎一定会位移几个像素） */
const HOLD_SLOP_PX = 10
/** 鼠标在「整理」模式下位移多少像素开始拖（那儿磁贴不是链接，不用等长按） */
const EDIT_SLOP_PX = 8
/**
 * 拖过这么多像素，这次手势就不再算「点击」了。
 * 按住了但没挪窝 → 松手仍然照常打开站点（见 onPointerUp）。
 */
const MOVE_SLOP_PX = 12
/**
 * 按得比这还久、又一直没挪窝 → 认为用户是在「拿起再放下」，不当作点击。
 * 短一点的「慢点击」照旧要能打开站点，但一个人真心按住不放，松手时
 * 把他带去别的网页就很唐突了。
 */
const LONG_HOLD_MS = 600
/** 拖动结束后要挡掉紧随其后的那次 click，否则松手会顺手打开站点 */
const CLICK_GUARD_MS = 400
/**
 * 触屏 / 触控笔把卡片往上抬这么多。
 * 手指本身就盖住指尖周围一厘米多，图标压在指头底下等于看不见。
 * 触控笔不抬：笔尖是精度输入，用户盯着的是笔尖，抬起来反而对不准。
 */
const TOUCH_LIFT_PX = 24
/**
 * 换格的迟滞：落点要「明确」偏向隔壁才换。
 * 没有它的话，指针停在两格中间时会左右横跳，看着像抽搐。
 */
const HYSTERESIS_PX = 8
/** 指针离视口上下边缘这么近就开始自动滚动 */
const AUTOSCROLL_ZONE_PX = 76
/** 自动滚动最快每帧这么多像素（越靠边越快） */
const AUTOSCROLL_MAX_PX = 14

/** 系统关了动效就别做缩放 / 旋转 / 落位动画，只保留「东西跟着手走」这件事 */
let motionQuery: MediaQueryList | null | undefined
function prefersReducedMotion(): boolean {
  // 拖动时每次 pointermove 都会问一次，别每次都新建一个 MediaQueryList
  if (motionQuery === undefined)
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null

  return motionQuery?.matches ?? false
}

interface DragSession {
  pointerId: number
  /**
   * 这一路是**手指**吗（`pointerType === 'touch'`）。
   * 触控笔不算：它是精度输入，按下就是有意的，跟鼠标同一套规矩；
   * 手指点不准、容易慢点击、还挡视线，才需要「门槛更久 + 卡片抬起来」。
   */
  finger: boolean
  /** 拖动项在 storage 顺序里的原始下标 */
  from: number
  /** 拖动项当前所在的下标（displayed 里的位置） */
  to: number
  itemId: string
  /** 被拖的磁贴本体，以及它所在的格子 */
  cell: HTMLElement
  tile: HTMLElement
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** 按下点相对图标面中心的偏移：浮起的卡片才不会「跳」到指尖正下方 */
  grabX: number
  grabY: number
  /** 卡片里的图标面相对整张卡片中心的偏移，mountGhost 时量出来 */
  faceDx: number
  faceDy: number
  /** 长按 / 位移阈值满足后才真正开始排序 */
  armed: boolean
  /** 这次手势到底算不算「拖动」：真的挪过窝（或真的换过格子）才算 */
  moved: boolean
  /** 长按真正生效的时刻，用来分辨「慢点击」和「拿起又放下」 */
  armedAt: number
  holdTimer: number | undefined
}

let session: DragSession | null = null
/** 浮起的卡片，是磁贴 DOM 的克隆，直接挂在 body 上（见 mountGhost） */
let ghostEl: HTMLElement | null = null
/** 刚拖过的那一格：它紧跟着的那次 click 不算「点击」（见 onClickCapture） */
let suppressClickIn: HTMLElement | null = null
let suppressTimer: number | undefined
/** 正在播的 FLIP 动画，按格子记着，方便下一次交换时先掐掉 */
const flipAnims = new WeakMap<HTMLElement, Animation>()
/** 自动滚动的 rAF 句柄，0 表示没在跑 */
let autoScrollFrame = 0

/** 拖动期间的本地顺序；null 表示照 storage 里的顺序渲染 */
const order = ref<Shortcut[] | null>(null)
const displayed = computed(() => order.value ?? list.value)
/** 拖动项在 displayed 里的下标，-1 表示当前没有拖动 */
const dragIndex = ref(-1)
const gridEl = ref<HTMLElement | null>(null)
/** 给读屏软件的播报（排序完成后念一遍新位置） */
const announcement = ref('')

function announce(text: string) {
  announcement.value = text
}

/** 左右箭头按钮和拖拽共用这一个出口，顺便播报新位置 */
function moveTo(from: number, to: number) {
  const item = list.value[from]
  move(from, to)
  if (item)
    announce(`「${item.name}」已移到第 ${to + 1} 位`)
}

/** 触屏长按到位时给一点物理反馈；桌面没有这个 API，静默跳过 */
function haptic(duration = 8) {
  const api = navigator as Navigator & { vibrate?: (pattern: number) => boolean }
  try {
    api.vibrate?.(duration)
  }
  catch {
    // 有的环境直接禁用振动并抛错，忽略即可
  }
}

function onTilePointerDown(index: number, event: PointerEvent) {
  if (session || dialogOpen.value || !event.isPrimary)
    return
  // 只认主按钮：鼠标是左键，笔是笔尖接触（笔杆上的按钮是「右键」，那不该拖起来）；
  // 手指没有按钮概念，不看这一项
  if (event.pointerType !== 'touch' && event.button !== 0)
    return
  // 只剩一个磁贴时排序没有意义，不要去抢这次点击
  if (list.value.length < 2)
    return
  // 「整理」模式里的四个小按钮自己处理点击，别顺手把整块磁贴拽走
  if ((event.target as HTMLElement | null)?.closest('button'))
    return

  const cell = event.currentTarget as HTMLElement
  const tile = cell.querySelector<HTMLElement>('.tile')
  if (!tile)
    return

  // 以「图标面」为锚点，而不是整张卡片：卡片上还有站名（整理模式里还有两行按钮），
  // 拿整张卡片的中心当锚点，浮起来的那张就会相对指尖掉下去一截
  const face = tile.querySelector<HTMLElement>('.tile-face') ?? tile
  const rect = face.getBoundingClientRect()

  session = {
    pointerId: event.pointerId,
    finger: event.pointerType === 'touch',
    from: index,
    to: index,
    itemId: list.value[index]?.id ?? '',
    cell,
    tile,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    grabX: event.clientX - (rect.left + rect.width / 2),
    grabY: event.clientY - (rect.top + rect.height / 2),
    faceDx: 0,
    faceDy: 0,
    armed: false,
    moved: false,
    armedAt: 0,
    holdTimer: undefined,
  }

  /**
   * 手指**任何模式**都先「按住」，包括「整理」模式 —— iOS 整理主屏也是这个规矩。
   * 少了这一步，设置页那种长列表里想往下滑，就会变成拖图标（拖动期间页面不许滚）。
   * 鼠标 / 触控笔在「整理」模式里不用等：那儿磁贴不是链接，没有误打开站点的风险，
   * 按一下就拖更快。
   */
  if (session.finger || !editing.value) {
    session.holdTimer = window.setTimeout(
      armDrag,
      session.finger ? HOLD_TOUCH_MS : HOLD_MOUSE_MS,
    )
  }

  /* 这里**刻意不捕获指针**，捕获挪到了 armDrag()。
     原因：`setPointerCapture` 会把这次手势随后的 mouseup / click 一并
     重定向到被捕获的那个格子（li）上，而磁贴是个 `<a>` ——
     click 的 target 于是变成 li，链接默认行为从不触发，
     「点图标打不开站点」就是这么来的（实测 click target=LI.tile-cell，
     而且事后释放捕获也救不回来：mouseup 的目标在派发时就定了）。
     只在真的开始拖之后再捕获，普通点击就完全不受影响。 */

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

/** 进入拖动状态：浮起卡片、冻结文字选中、开始本地重排 */
function armDrag() {
  const active = session
  if (!active || active.armed)
    return

  if (active.holdTimer !== undefined) {
    window.clearTimeout(active.holdTimer)
    active.holdTimer = undefined
  }

  active.armed = true
  active.armedAt = performance.now()
  active.to = active.from
  dragIndex.value = active.from
  order.value = [...list.value]
  // 长按成立之前可能已经挪过一段（鼠标按住顺手就拖，位移不取消手势）：
  // 这段位移要一起算进「这次是拖动，不是点击」，否则松手会被当成点击。
  const armTravel = Math.hypot(active.lastX - active.startX, active.lastY - active.startY)
  if (armTravel > MOVE_SLOP_PX)
    active.moved = true

  // 鼠标拖到一半选出一片蓝底很难看
  document.documentElement.style.userSelect = 'none'
  // CSS 的 touch-action 在手势开始后改就来不及了，只能自己拦 touchmove
  window.addEventListener('touchmove', blockPageScroll, { passive: false })

  /* 指针捕获放在这里，而不是 pointerdown（见 onTilePointerDown 的说明）：
     真的开拖之后，手指/鼠标滑出这一格、甚至滑出窗口，事件也还能收回来。
     代价是这次手势的 mouseup / click 会被重定向到格子上 ——
     所以 onPointerUp 里对「arm 过但没挪窝」的那次点击做了补偿。 */
  try {
    active.cell.setPointerCapture(active.pointerId)
  }
  catch {
    // 少数环境不支持捕获（或指针已经失效），退化成普通事件冒泡也能用
  }

  mountGhost(active)
  haptic()
  scheduleAutoScroll()

  // 切窗口 / 切标签页之后指针事件不会再来了，别把拖动卡在半空中
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function onWindowBlur() {
  if (session)
    cancelDrag()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden' && session)
    cancelDrag()
}

/**
 * 卡片「实际画在哪」的中心点：手指按住的那个点减去抓取偏移，手指再往上抬一截。
 * 命中判定和落位都认这个点，而不是指针裸露的位置 ——
 * 用户盯着的是那张跟着手走的卡片，判定就该跟卡片走。
 */
function ghostAnchor(active: DragSession): { x: number, y: number } {
  return {
    x: active.lastX - active.grabX,
    y: active.lastY - active.grabY - (active.finger ? TOUCH_LIFT_PX : 0),
  }
}

/* ---------------------------------------------------------------
   贴边自动滚动
   ---------------------------------------------------------------
   设置页 / 侧边栏里快捷方式多起来就要滚动，而拖动时手指按在屏幕上、
   没法再去滚页面：指针贴到上下边缘就得自己滚，越靠边越快。

   三个宿主页面（新标签页 / 设置页 / 侧边栏）都是整页滚动，
   所以直接滚 document.scrollingElement；哪天改成内层滚动容器，这里要跟着改。
   --------------------------------------------------------------- */
function scheduleAutoScroll() {
  if (!autoScrollFrame)
    autoScrollFrame = window.requestAnimationFrame(autoScrollStep)
}

/** 当前该滚多快：正数往下，负数往上，0 表示不用滚 */
function autoScrollSpeed(y: number): number {
  if (y < AUTOSCROLL_ZONE_PX)
    return -Math.min(1, (AUTOSCROLL_ZONE_PX - y) / AUTOSCROLL_ZONE_PX)

  const fromBottom = window.innerHeight - y
  if (fromBottom < AUTOSCROLL_ZONE_PX)
    return Math.min(1, (AUTOSCROLL_ZONE_PX - fromBottom) / AUTOSCROLL_ZONE_PX)

  return 0
}

function autoScrollStep() {
  autoScrollFrame = 0
  const active = session
  if (!active?.armed)
    return

  const speed = autoScrollSpeed(active.lastY)
  if (speed === 0)
    return

  const scroller = document.scrollingElement
  if (!scroller)
    return

  const before = scroller.scrollTop
  scroller.scrollTop = before + speed * AUTOSCROLL_MAX_PX
  // 已经滚到头顶 / 底部就别空转 rAF
  if (scroller.scrollTop === before)
    return

  // 页面滚了，指针底下换了一格：重新判一次落点
  updateDropTarget()
  scheduleAutoScroll()
}

/**
 * 长按拖动期间不许页面跟着滚。
 * 光靠 touch-action 不行：手势开始后再改它，浏览器不会重新判定。
 */
function blockPageScroll(event: TouchEvent) {
  if (session?.armed)
    event.preventDefault()
}

/**
 * 浮起的卡片用**磁贴本身的克隆**，而不是另画一个。
 * 这样 favicon 的「真图 / 首字母」判定结果、站点色、圆角阴影全都是同一份，
 * 卡片和它下面那块磁贴长得一模一样，也不必重新算一遍图标。
 */
function mountGhost(active: DragSession) {
  const clone = active.tile.cloneNode(true) as HTMLElement

  // 克隆体纯粹是视觉副本：不能被点、不能被读屏、也不能进 Tab 顺序
  clone.removeAttribute('data-test')
  clone.setAttribute('tabindex', '-1')
  clone.querySelectorAll('[data-test]').forEach(node => node.removeAttribute('data-test'))
  clone.querySelectorAll('[tabindex]').forEach(node => node.setAttribute('tabindex', '-1'))
  clone.querySelector('.tile-actions')?.remove()
  clone.querySelectorAll('img').forEach(node => node.setAttribute('loading', 'eager'))

  // 拖起来的时候只「拿着图标」：站名跟着指尖飘既挡视线，也没人需要在这时候读它。
  // 摘掉之后卡片只剩图标，下面量出来的中心偏移自然也归零。
  clone.querySelector('.tile-name')?.remove()

  ghostEl = document.createElement('div')
  ghostEl.className = 'drag-ghost'
  ghostEl.setAttribute('aria-hidden', 'true')
  ghostEl.append(clone)
  document.body.append(ghostEl)

  // 量一下克隆体里「图标面」相对整张卡片中心的偏移。
  // 整理模式下原磁贴多了两行小按钮，而卡片把按钮摘掉了、要矮一截，
  // 不校正的话浮起的卡片会相对指尖往下掉。
  const ghostRect = ghostEl.getBoundingClientRect()
  const faceRect = clone.querySelector<HTMLElement>('.tile-face')?.getBoundingClientRect()
  if (faceRect) {
    active.faceDx = (faceRect.left + faceRect.width / 2) - (ghostRect.left + ghostRect.width / 2)
    active.faceDy = (faceRect.top + faceRect.height / 2) - (ghostRect.top + ghostRect.height / 2)
  }

  positionGhost(active)
}

function positionGhost(active: DragSession) {
  if (!ghostEl)
    return

  // 让卡片上的图标面停在「手指按住的那个点」（触屏再抬高一截，别被指头盖住）
  const anchor = ghostAnchor(active)
  const x = anchor.x - active.faceDx
  const y = anchor.y - active.faceDy

  // 关掉动效时不要缩放和倾斜：卡片老老实实跟着手走就够了
  const flourish = prefersReducedMotion() ? '' : ' scale(1.06) rotate(-1.5deg)'
  ghostEl.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)${flourish}`
}

function onPointerMove(event: PointerEvent) {
  const active = session
  if (!active || event.pointerId !== active.pointerId)
    return

  active.lastX = event.clientX
  active.lastY = event.clientY

  if (!active.armed) {
    const travel = Math.hypot(event.clientX - active.startX, event.clientY - active.startY)

    // 手指：位移一大就说明用户是在滚页面。拖动期间页面是不许滚的
    // （blockPageScroll），所以「让位给浏览器」只能发生在这里。
    if (active.finger) {
      if (travel > HOLD_SLOP_PX)
        endDrag()
      return
    }

    // 精度输入（鼠标 / 触控笔）在「整理」模式里：那儿磁贴不是链接，
    // 没有误打开站点的风险，位移几像素就直接开拖（开拖后继续往下走，
    // 这一次事件就把浮起的卡片摆好、落点判一次）
    if (!editing.value || travel < EDIT_SLOP_PX) {
      // 其余情况等长按成立。**位移不取消手势**，这条很重要：
      // 桌面上「按下顺手就拖」是最自然的动作，而取消的后果比想象中糟 ——
      // 手势没了，松手还会被当成点击（armed 为 false 不挡 click），
      // 于是「想拖一下」变成「被送去目标站点」。鼠标不会因为手在动就变成
      // 滚页面，所以这里没有必须取消的理由。
      return
    }

    armDrag()
  }

  // 挪过窝了：这次手势不再可能被当成「点击」
  if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > MOVE_SLOP_PX)
    active.moved = true

  positionGhost(active)
  updateDropTarget()
  scheduleAutoScroll()
}

/** 按卡片当前的位置重新判一次落点，需要的话就地换格 */
function updateDropTarget() {
  const active = session
  if (!active?.armed || !order.value)
    return

  const anchor = ghostAnchor(active)
  const target = tileIndexAt(anchor.x, anchor.y, active.to)
  if (target === -1 || target === active.to)
    return

  // 重排前先记下各格子的位置，重排后让它们「滑」过去而不是瞬移
  const before = snapshotCells()
  order.value = moveItem(order.value, active.to, target)
  active.to = target
  active.moved = true
  dragIndex.value = target
  // 每跨过一格给一下轻微的触感，闭着眼也知道自己挪了几格
  haptic(6)
  // 顺序变了 DOM 要等 Vue 刷完才动，量新位置只能放到 nextTick 里
  void nextTick(() => playFlip(before))
}

/**
 * 卡片中心落在哪一格上（-1 表示离得太远，保持原位不动）。
 *
 * 判定分两步：**先选行，再在行内选列**。
 * 直接拿「矩形包含点」来判会有两个毛病：格子之间的缝隙是死区（拖进去不动，
 * 手感发涩），而指针一旦离开网格，最近的格子又可能离得很远（比如拖到网格右侧
 * 的空白处，一下子跳到那一行最后一格）。分行分带 + 行内按水平中心就近取，
 * 既没有死区，也不会被远处的格子抢走。
 *
 * `current` 是当前所在的格子，用它加一点迟滞：指针停在两格中间时不来回横跳。
 */
function tileIndexAt(x: number, y: number, current: number): number {
  const grid = gridEl.value
  if (!grid)
    return -1

  // 这里刻意用布局坐标（offsetLeft/Top）而不是 getBoundingClientRect()：
  // 邻居正在播「滑过去」的动画，getBoundingClientRect() 会带上动画里的位移，
  // 手指没动命中判定就先跳到隔壁格子了。offset* 是纯布局值，不受动画影响。
  const base = grid.getBoundingClientRect()
  const boxes = Array.from(grid.querySelectorAll<HTMLElement>('[data-tile-index]')).map(cell => ({
    index: Number(cell.dataset.tileIndex),
    left: base.left + cell.offsetLeft,
    top: base.top + cell.offsetTop,
    width: cell.offsetWidth,
    height: cell.offsetHeight,
  }))
  if (!boxes.length)
    return -1

  // 同一行的格子 offsetTop 相同，按它分组
  const rows = new Map<number, typeof boxes>()
  for (const box of boxes) {
    const row = rows.get(box.top)
    if (row)
      row.push(box)
    else
      rows.set(box.top, [box])
  }

  const currentBox = boxes.find(box => box.index === current)
  let bestRow: typeof boxes = []
  let bestRowGap = Number.POSITIVE_INFINITY

  for (const row of rows.values()) {
    const top = Math.min(...row.map(box => box.top))
    const bottom = Math.max(...row.map(box => box.top + box.height))
    // 指针在这一行的竖直带里 → 距离 0；否则算到这一行边缘的距离
    const raw = y < top ? top - y : y > bottom ? y - bottom : 0
    const isCurrentRow = currentBox?.top === top
    // 已经在这一行里就别被一像素的抖动赶走
    const gap = isCurrentRow ? Math.max(0, raw - HYSTERESIS_PX) : raw
    // 完全打平时也留在原地（不然正好停在两行之间会来回跳）
    if (gap < bestRowGap || (gap === bestRowGap && isCurrentRow)) {
      bestRowGap = gap
      bestRow = row
    }
  }

  let best = bestRow[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const box of bestRow) {
    const center = box.left + box.width / 2
    const raw = Math.abs(x - center)
    const isCurrent = box.index === current
    const distance = isCurrent ? Math.max(0, raw - HYSTERESIS_PX) : raw
    if (distance < bestDistance || (distance === bestDistance && isCurrent)) {
      bestDistance = distance
      best = box
    }
  }

  return best.index
}

function snapshotCells(): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>()
  gridEl.value?.querySelectorAll<HTMLElement>('[data-shortcut-id]').forEach((cell) => {
    out.set(cell.dataset.shortcutId ?? '', cell.getBoundingClientRect())
  })
  return out
}

/**
 * FLIP：位置换了以后补一段反向位移，让格子滑过去。
 * 被拖的那一格也一起滑（浮起来的卡片在上面，下面的空位跟着走更像真的在搬家）。
 * 用 Web Animations 直接写，不需要额外的动画库。
 */
function playFlip(before: Map<string, DOMRect>) {
  if (prefersReducedMotion())
    return

  gridEl.value?.querySelectorAll<HTMLElement>('[data-shortcut-id]').forEach((cell) => {
    const id = cell.dataset.shortcutId ?? ''
    const from = before.get(id)
    if (!from)
      return

    const to = cell.getBoundingClientRect()
    const dx = from.left - to.left
    const dy = from.top - to.top
    if (dx === 0 && dy === 0)
      return

    // 连着快速拖动时上一次的动画还没播完，先掐掉，
    // 否则两个动画叠在同一个 transform 上会互相拉扯
    flipAnims.get(cell)?.cancel()
    flipAnims.set(cell, cell.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    ))
  })
}

/**
 * 打开一个磁贴指向的站点。
 *
 * 只在「指针捕获吃掉了那次点击」时才用得上（见 onPointerUp）：
 * 普通点击由磁贴自己的 `<a href>` 走浏览器原生行为，不需要经过这里。
 * 打开方式跟链接保持一致：默认同标签页；`openInNewTab`
 * （设置页 / 侧边栏）或按住 Ctrl/⌘ 时开新标签页。
 */
function activateTile(shortcut: Shortcut, event: PointerEvent) {
  const newTab = props.openInNewTab || event.ctrlKey || event.metaKey
  if (newTab) {
    window.open(shortcut.url, '_blank', 'noopener')
    return
  }

  window.location.href = shortcut.url
}

function onPointerUp(event: PointerEvent) {
  const active = session
  if (!active || event.pointerId !== active.pointerId)
    return

  const { to, armed, moved, itemId, cell } = active
  const name = order.value?.find(item => item.id === itemId)?.name ?? ''

  // 「按住了但一直没挪窝」不算拖动：短一点的是慢点击，得让它照常打开站点；
  // 按得够久还不动，那是真的拿起来又放下，别把用户带去别的网页
  const dragged = armed && (moved || performance.now() - active.armedAt > LONG_HOLD_MS)

  // 落位动画要在 DOM 还是「拖动中的顺序」时把目标位置量出来，
  // 所以先量、再把卡片从 session 里摘出来（endDrag 就不会顺手删掉它）
  const landing = dragged ? faceLandingPoint(to) : null
  const landed = landing ? detachGhost() : null

  endDrag()

  if (!dragged) {
    /* arm 起来过、但一直没挪窝、也没按到 LONG_HOLD_MS —— 按设计这就是一次
       「慢点击」，该照常打开站点。但指针捕获已经把这次 click 重定向到了格子上，
       链接收不到它，所以在这里手工补一次（语义对齐 `<a>`：默认同标签页，
       Ctrl/⌘ 开新标签页；中键在 pointerdown 就被挡掉了，走的是原生 auxclick）。 */
    if (armed && !moved) {
      const shortcut = list.value.find(item => item.id === itemId)
      if (shortcut)
        activateTile(shortcut, event)
    }
    return
  }

  // 真的拖过：这一格紧跟着的那次 click 不算「点击」，别顺手打开站点。
  // 只挡它自己 —— 用户拖完马上点别的图标是正常的，不能一起吞掉。
  suppressClickIn = cell
  window.clearTimeout(suppressTimer)
  suppressTimer = window.setTimeout(() => {
    suppressClickIn = null
  }, CLICK_GUARD_MS)

  if (landed && landing)
    settleGhost(landed, landing)

  // 放下那一下也轻轻“嗒”一声，动作才完整
  haptic(10)

  // storage 可能被别的标签页动过（新增/删除会让下标错位），
  // 所以落盘前按 id 重新认一次「我在哪、要去哪」，不认下标
  const from = list.value.findIndex(item => item.id === itemId)
  if (from === -1 || list.value.length < 2)
    return

  const target = Math.max(0, Math.min(to, list.value.length - 1))
  if (from === target)
    return

  // 顺序只在这一刻落盘
  move(from, target)
  announce(name ? `「${name}」已移到第 ${target + 1} 位` : '已更新顺序')
}

/**
 * 卡片该落在哪：用布局坐标量（offsetTop/Left + 图标面高度），
 * 不能用 getBoundingClientRect()——那一格可能正在播「滑过去」的动画，
 * 量出来的位置带着动画位移，卡片会朝错的地方收。
 */
function faceLandingPoint(index: number): { x: number, y: number } | null {
  const grid = gridEl.value
  const cell = grid?.querySelector<HTMLElement>(`[data-tile-index="${index}"]`)
  if (!grid || !cell)
    return null

  const base = grid.getBoundingClientRect()
  const faceHeight = cell.querySelector<HTMLElement>('.tile-face')?.offsetHeight ?? cell.offsetHeight

  return {
    x: base.left + cell.offsetLeft + cell.offsetWidth / 2,
    y: base.top + cell.offsetTop + faceHeight / 2,
  }
}

/** 把卡片从 session 手里摘下来：endDrag 之后它还活着，专门用来播落位动画 */
function detachGhost(): HTMLElement | null {
  const el = ghostEl
  ghostEl = null
  return el
}

/**
 * 松手：卡片不是凭空消失，而是「收」进那个空位里，同时淡掉。
 * 这一下大概两三百毫秒，但它决定了这次拖动是「拖完了」还是「东西没了」。
 */
function settleGhost(ghost: HTMLElement, point: { x: number, y: number }) {
  if (prefersReducedMotion()) {
    ghost.remove()
    return
  }

  const from = ghost.style.transform
  const to = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%) scale(1) rotate(0deg)`

  const animation = ghost.animate(
    [
      { transform: from, opacity: 1, offset: 0 },
      { transform: to, opacity: 0, offset: 1 },
    ],
    { duration: 220, easing: springEasing(), fill: 'forwards' },
  )

  animation.finished.then(
    () => ghost.remove(),
    () => ghost.remove(),
  )
}

/**
 * 落位用全站那条弹性曲线（磁贴悬停抬升也是它），卡片会有一点回弹，像真的放下去了。
 * Web Animations 读不到 CSS 变量，所以从 root 上取一次现成值。
 */
function springEasing(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim()
  return value || 'cubic-bezier(0.34, 1.4, 0.64, 1)'
}

function onPointerCancel(event: PointerEvent) {
  if (session && event.pointerId === session.pointerId)
    cancelDrag()
}

/** 收尾：清监听、清计时器、撤掉浮起卡片，本地顺序丢掉（storage 从没被动过） */
function endDrag() {
  const active = session
  session = null

  if (active) {
    if (active.holdTimer !== undefined)
      window.clearTimeout(active.holdTimer)

    try {
      if (active.cell.hasPointerCapture(active.pointerId))
        active.cell.releasePointerCapture(active.pointerId)
    }
    catch {
      // 指针已经抬起时释放会抛错，忽略
    }
  }

  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('touchmove', blockPageScroll)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)

  if (autoScrollFrame) {
    window.cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = 0
  }

  document.documentElement.style.userSelect = ''

  ghostEl?.remove()
  ghostEl = null

  order.value = null
  dragIndex.value = -1
}

/**
 * 取消这次拖动（Esc / 指针被系统收走）。
 *
 * 不能只是「东西消失、列表弹回去」：那样看着像操作失败。
 * 卡片要飞回原位，被挤开的邻居也要滑回去 —— 和落位是同一套动作，只是方向相反。
 */
function cancelDrag() {
  const active = session
  if (!active)
    return

  const ghost = active.armed ? detachGhost() : null
  const before = active.armed ? snapshotCells() : null
  const home = active.from

  endDrag()

  if (!ghost && !before)
    return

  // 顺序要等 Vue 把 storage 的顺序刷回 DOM 之后再量、再滑
  void nextTick(() => {
    if (before)
      playFlip(before)

    if (!ghost)
      return

    const point = faceLandingPoint(home)
    if (point)
      settleGhost(ghost, point)
    else
      ghost.remove()
  })
}

/** 原生 dragstart 一律取消：链接的「拖出去」会和我们的手势打架 */
function onNativeDragStart(event: DragEvent) {
  event.preventDefault()
}

/** 长按拖动期间别让系统菜单（拷贝 / 在新标签页打开）从屏幕中间冒出来 */
function onTileContextMenu(event: MouseEvent) {
  if (session)
    event.preventDefault()
}

/** 拖完那一格补发的 click：拦下来，别让它跳转 */
function onClickCapture(event: MouseEvent) {
  if (!suppressClickIn || event.currentTarget !== suppressClickIn)
    return

  suppressClickIn = null
  window.clearTimeout(suppressTimer)
  event.preventDefault()
  event.stopPropagation()
}

/* ---------------------------------------------------------------
   全局快捷键：按 N 新增（非输入状态下）
   --------------------------------------------------------------- */
function onGlobalKeydown(event: KeyboardEvent) {
  // 拖动中按 Escape 就是「放回去」：卡片飞回原位，storage 没被写过
  if (event.key === 'Escape' && session) {
    event.preventDefault()
    cancelDrag()
    return
  }

  if (dialogOpen.value || session)
    return

  const target = event.target as HTMLElement | null
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (typing || event.metaKey || event.ctrlKey || event.altKey)
    return

  if (event.key === 'n' || event.key === 'N') {
    event.preventDefault()
    openCreate()
  }
}

/* ---------------------------------------------------------------
   磁贴入场：落在页面节拍上的「沉落」
   ---------------------------------------------------------------
   延迟 = 行号 × 一拍 + 行内位置 × 一点点。
   行与行之间退开一整拍：磁贴多到换行、或者窗口收窄（侧边栏那种宽度）时，
   读得出自上而下的层积；PC 全屏这个主场景只有一行，于是退化成一次整行落位 ——
   那是排布决定的事实，不是调参能解决的，见下面「为什么不再模仿横向扫掠」。

   每一格的动作分三层，各干一件事：玻璃面**沉落**（从下方一点、同时显影）→
   图标在自己的磁贴里**合焦**（略小 → 原尺寸）→ 站名补上收尾。
   方向和 hero 共用同一套竖直语汇，横向位移整段删掉了。

   ## 为什么起波锚在挂载时刻，而不是数据就绪
   磁贴带原先跟着 `shortcutsReady` 立刻起波。实测同一份构建连续打开五次，
   起波落在首帧之后十几毫秒到一百多毫秒之间 —— 正好压在问候与搜索框那两拍上，
   也就是**每次打开看到的先后都不一样**。编排的定义是时间轴由人决定；
   让 storage 的往返决定它，等于没有编排。
   现在起波定在 hero 三拍之后，数据晚到就立刻起跑 ——
   数据就绪是**下限**，不是时间轴。节拍本身见 logic/motion.ts 的 PAGE_BEAT_MS。

   ## 为什么不再模仿横向扫掠
   上一版向参考站 motion-reference.takayustudio.jp 的 grid-row-sweep 看齐：
   每格沿水平方向滑入，延迟按行推进、行内只错开一点点。它写在注释里的读法是
   「横带扫掠」，实测却不成立：PC 全屏（1440 / 1920 都量过）时十来个磁贴排成
   **一行**，行项恒为 0，只剩行内那一点点错开，而单格动作的时长比它大一截 ——
   同一时刻大半格子在半空中，屏幕上读到的是「整条带子从左往右洗了一遍」。
   参考站那套成立的前提是它的网格有多行、而且那块网格本身就是页面主角；
   这里两条都不成立。

   比几何更要紧的是**层级**：新标签页的主角是时钟与搜索框，磁贴带在视野下缘，
   用户此刻正看着搜索框打字。上一版给这一带的是整页最大的位移（每格横向几十像素、
   十几格一起扫过整条带宽），比主角还响；竖直沉落的幅度小一个量级，且与 hero 同向，
   这才排得进配角的位置。

   顺带一笔性能账：`.tile-face` 带 backdrop-filter，横向扫掠时十个玻璃面同时在动，
   合成器每帧都要按新位置重采样它背后的 WebGL 天空。位移幅度压下来之后，
   这笔开销跟着掉到可以忽略。

   代价说清楚：PC 全屏下单行排布不会「像一道波」。这是选定的方向，不是没调到 ——
   「只在侧边栏那种宽度才成立的编排」比「在 PC 全屏这个主场景上小声、
   但始终成立的编排」更贵，尤其这块磁贴带每天被打开几十次。

   ## 尾巴必须短，而且尾巴的所有权必须是「内容」
   新标签页是每天要开几十次的东西，入场是**等待**不是表演。
   无论磁贴怎么排，**全场最后结束的必须是内容**（图标 / 站名），
   不能有装饰层把尾巴拖长。这也是高光与波纹那两层被整层删掉的理由之一。

   ## 减少动效时不等这一拍
   起波前那段空档是给编排用的；`prefers-reduced-motion: reduce` 下没有编排可等，
   直接起波（见 scheduleTileWave）。

   ## 为什么要等 `shortcutsReady`
   storage 是异步的，挂载那一刻渲染的是 `defaultShortcuts()` 的种子站，
   异步回来后整个列表会被换掉。如果两轮各自列出场，用户会看到**两波**
   磁贴（先种子站、再是他自己的）。
   所以波要等真列表就位再起，而 `.grid-root` 的幕布（opacity）一直遮到那一刻。
   真正的起波时刻 = max(数据就绪, 锚点)，锚点比「固定延时」多一层好处：
   快的时候不会白等，慢的时候也不会让起波时刻漂到 hero 的拍子上。
   兜底定时器只防「storage 永不返回」这一种病，不是时间轴的一部分。
   --------------------------------------------------------------- */
/** 起波锚点：hero 的第三拍之后（节拍来自 logic/motion.ts，hero 侧见 NewTab.vue） */
const BAND_START_MS = PAGE_BEAT_MS * 3
/** 行与行之间退开一拍 */
const TILE_WAVE_ROW = PAGE_BEAT_MS
/** 行内只留一点点错开：让一整行不是「啪」地同时出现，但不制造方向 */
const TILE_WAVE_COL = 12
/**
 * 折点：延迟涨到这里之后改走缓坡。
 *
 * 硬夹断（`Math.min`）的毛病在磁贴多的时候特别明显：所有越过的格子拿到**同一个延迟**，
 * 于是尾巴上的格子会并轨，一起出现。两段折线让延迟永远单调递增，
 * 只是过了折点走得慢一点，尾巴再长也不会并轨 —— 列表长起来的地方是设置页和侧边栏。
 */
const TILE_WAVE_KNEE = PAGE_BEAT_MS * 3
/** 折点之后的坡度：每格仍按比例往后错，只是走得更慢 */
const TILE_WAVE_TAIL = 0.35

/** 幕布是否已拉开、波是否已起 */
const waveStarted = ref(false)
/** 一行放得下几格。由真实布局量出来，不硬编码 CSS 里的列数 */
const gridCols = ref(1)

/**
 * 起波那一刻**定格**的入场延迟：磁贴 id → 毫秒。
 *
 * 为什么要定格，而不是每次渲染拿当前下标现算：`animation-delay` 一变，动画就会被
 * 重新计时 —— 哪怕它早就跑完了，也会从头再放一遍。延迟若跟着 `displayed` 的下标走，
 * 用户删掉一个磁贴、或者新增一个，后面每一格的延迟都会跟着变，于是半屏磁贴
 * 无缘无故又入场一次。
 *
 * 定格之后，「入场编排」只属于**这个页面被打开的那一次**：
 * 之后无论怎么增删、排序，它都不再插手。
 */
const waveDelays = ref(new Map<string, number>())
/** 「+」那一格（没有 id）的延迟，同样在起波时定格 */
const addTileDelay = ref(0)
/**
 * 起波那一刻的**参演名单**：空状态和「+」格参与过一次，就不再参与第二次。
 *
 * 不能直接绑 `waveStarted`：它是永久为真的，而这两块都是 `v-if` / `v-else`
 * 里会被**销毁重建**的节点。删光最后一条快捷方式 → 空状态整块新建 →
 * 它会在「删除」这个动作之后把四层阶梯又演一遍；从零加第一条又反过来
 * 让新建出来的「+」补播一次入场。两种情况都和用户刚做的事无关。
 */
const emptyEntering = ref(false)
const addCellEntering = ref(false)

/** 第 index 格的入场延迟（毫秒）。只在起波那一刻用得上，见 waveDelays */
function tileWaveDelay(index: number): number {
  const row = Math.floor(index / gridCols.value)
  const col = index % gridCols.value
  const raw = row * TILE_WAVE_ROW + col * TILE_WAVE_COL
  // 折点之后不收口、只放缓（见 TILE_WAVE_KNEE）：延迟必须严格单调，
  // 否则尾巴上的格子会并轨成同一次出现，层积就断了
  return raw <= TILE_WAVE_KNEE
    ? raw
    : TILE_WAVE_KNEE + (raw - TILE_WAVE_KNEE) * TILE_WAVE_TAIL
}

/** 这一格参不参与入场编排（起波之后才出现的磁贴不参与） */
function isEntering(id: string): boolean {
  return waveDelays.value.has(id)
}

/** 这一格的入场延迟；不在编排里的返回 0 */
function enterDelay(id: string): number {
  return waveDelays.value.get(id) ?? 0
}

/**
 * 起波之后才加入列表的磁贴 id（新增、撤销删除）。
 * 它们不排队、不等延迟，立刻做一次短促的落位 ——
 * 那是对「用户刚刚做了一件事」的应答，和页面打开那一次的沉落编排
 * 是两回事，混在一起会让撤销删除看起来像卡了一拍。
 */
const freshIds = ref(new Set<string>())
/** 上一次渲染的 id 清单，用来认出「新来的那一格」 */
let prevIds = new Set<string>()

function startTileWave() {
  if (waveStarted.value)
    return

  const el = gridEl.value
  if (el) {
    // 从布局里读列数：窄屏下网格会换成 auto-fill 等分列，写死列数会算错
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    gridCols.value = Math.max(1, cols)
  }

  // 延迟和「挂动画」必须是同一次 patch ——
  // 动画跑起来之后再改 delay 会把它重新计时，磁贴会当场跳一下
  const frozen = new Map<string, number>()
  list.value.forEach((shortcut, index) => frozen.set(shortcut.id, tileWaveDelay(index)))
  waveDelays.value = frozen
  addTileDelay.value = tileWaveDelay(list.value.length)
  // 参演名单一次定死：这两块之后被销毁重建时不要再演一遍（理由见 emptyEntering）
  emptyEntering.value = list.value.length === 0
  addCellEntering.value = Boolean(el)
  waveStarted.value = true
}

/**
 * 挂载时刻：起波锚点。
 *
 * 用 setup 里的 performance.now() 而不是 onMounted 里的：hero 的 CSS 动画从
 * 首帧起算，两者差一两帧，锚点要跟那条时间轴对齐。
 */
const mountedAt = performance.now()
/** 等锚点的定时器，卸载时清掉 */
let waveTimer: number | undefined

/**
 * 排起波：锚点**之前**就绪的数据要等到锚点，锚点**之后**才就绪的数据立刻起跑。
 *
 * 这一行把 storage 的往返从「时间轴」降级成「下限」—— 磁贴带的起点因此
 * 每次都一样，而慢机器上也不会白等。减少动效时没有编排可等，直接起。
 */
function scheduleTileWave() {
  const wait = prefersReducedMotion()
    ? 0
    : Math.max(0, BAND_START_MS - (performance.now() - mountedAt))
  waveTimer = window.setTimeout(startTileWave, wait)
}

onMounted(() => {
  // 兜底：storage 永不返回时也得拉开幕布，否则磁贴永远不可见。
  // 它只管「病态」这一种情况，不是编排的一部分（正常路径见 scheduleTileWave）。
  const fallback = window.setTimeout(startTileWave, 1200)
  shortcutsReady
    .then(async () => {
      await nextTick()
      scheduleTileWave()
    })
    .catch(() => scheduleTileWave())
    .finally(() => window.clearTimeout(fallback))
})

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  window.clearTimeout(undoTimer)
  window.clearTimeout(suppressTimer)
  window.clearTimeout(waveTimer)
  endDrag()
})

/**
 * 列表空了就自动退出编辑模式，避免停在没有内容的编辑态。
 * 顺便认出「起波之后新来的磁贴」：入场编排只属于页面打开那一次，
 * 之后新增 / 撤销回来的磁贴各自做一次短促落位（见 is-fresh）。
 */
watch(list, (value) => {
  if (waveStarted.value) {
    const fresh = new Set(freshIds.value)
    value.forEach((item) => {
      if (!prevIds.has(item.id))
        fresh.add(item.id)
    })
    freshIds.value = fresh
  }

  prevIds = new Set(value.map(item => item.id))

  if (value.length === 0)
    editing.value = false

  /* 空状态与「+」格都是会被销毁重建的节点：入场参演资格只发一次 ——
     谁在这次重渲染里被销毁，就把谁的名额收回来。否则「删光再加回来」
     会让同一段入场在用户的一次操作之后又演一遍。 */
  if (value.length === 0)
    addCellEntering.value = false
  else
    emptyEntering.value = false
}, { immediate: true })
</script>

<template>
  <section class="grid-root" :class="{ 'is-waved': waveStarted }" aria-labelledby="shortcuts-heading">
    <div class="grid-head" :class="{ 'is-entering': waveStarted }">
      <h2 id="shortcuts-heading" class="grid-title">
        快捷方式
      </h2>

      <span v-if="list.length > 0" class="grid-hint">{{ editing ? '按住图标拖到新位置即可排序' : '按住图标可拖动排序' }}</span>

      <button
        v-if="list.length > 0"
        type="button"
        class="grid-edit focus-ring"
        :aria-pressed="editing"
        data-test="toggle-edit"
        @click="editing = !editing"
      >
        <span :class="editing ? 'i-carbon-checkmark' : 'i-carbon-settings-adjust'" aria-hidden="true" />
        {{ editing ? '完成' : '整理' }}
      </button>
    </div>

    <!-- 空状态：给出明确的下一步，而不是一片空白 -->
    <div
      v-if="list.length === 0"
      class="empty-state"
      :class="{ 'is-entering': emptyEntering }"
      data-test="shortcuts-empty"
    >
      <span class="empty-mark" aria-hidden="true">
        <span class="i-carbon-add" />
      </span>
      <p class="empty-title">
        还没有快捷方式
      </p>
      <p class="empty-hint">
        把你每天都要打开的站点放上来，也可以随时按 <kbd class="kbd">N</kbd> 添加
      </p>
      <button type="button" class="primary-control" data-test="empty-add" @click="openCreate">
        添加第一个
      </button>
    </div>

    <ul
      v-else
      ref="gridEl"
      class="tile-grid"
      :class="{ 'is-sorting': dragIndex !== -1 }"
      data-test="shortcut-grid"
    >
      <li
        v-for="(shortcut, index) in displayed"
        :key="shortcut.id"
        class="tile-cell"
        :class="{
          'is-drag-source': dragIndex === index,
          'is-entering': isEntering(shortcut.id),
          'is-fresh': freshIds.has(shortcut.id),
        }"
        :style="{ '--tile-enter-delay': `${enterDelay(shortcut.id)}ms` }"
        :data-tile-index="index"
        :data-shortcut-id="shortcut.id"
        @pointerdown="onTilePointerDown(index, $event)"
        @dragstart="onNativeDragStart"
        @contextmenu="onTileContextMenu"
        @click.capture="onClickCapture"
      >
        <ShortcutTile
          :shortcut="shortcut"
          :accent="accentOf(shortcut.id)"
          :editing="editing"
          :index="index"
          :total="displayed.length"
          :open-in-new-tab="openInNewTab"
          @move="moveTo"
          @edit="openEdit"
          @remove="removeWithUndo"
        />
      </li>

      <!-- 新增磁贴：与图标同尺寸，位置固定在末尾 -->
      <li
        class="tile-cell"
        :class="{ 'is-entering': addCellEntering }"
        :style="{ '--tile-enter-delay': `${addTileDelay}ms` }"
      >
        <button
          type="button"
          class="add-tile focus-ring"
          aria-label="添加快捷方式"
          data-test="add-shortcut"
          @click="openCreate"
        >
          <span class="i-carbon-add" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <!-- 编辑模式的操作提示。
         标题行那句讲的是「怎么拖」，这句讲的是「不拖的时候怎么办」。
         提一句「按钮上都有提示」：四个小按钮只有图标，不写出来没人会去悬停。 -->
    <p v-if="editing && list.length > 0" class="edit-note">
      不想拖的话，鼠标停在图标上会出现排序按钮（停在按钮上能看到提示），键盘用户用 Tab 也能走到
    </p>

    <!-- 排序结果的播报：视觉上不可见，只念给读屏软件 -->
    <p class="sr-only" role="status" aria-live="polite">
      {{ announcement }}
    </p>

    <!-- 撤销删除。
         必须 Teleport 到 body：.toast 是 position:fixed，而它原本所在的
         .grid-root 挂着 `animation: rise-in ... both`——fill-forwards 的 transform
         动画会一直让这个元素充当 fixed 后代的包含块（NewTab.vue 里那条注释
         说的「动画结束后依然保留 transform 的已结束状态」就是这个），
         于是浮层被钉在磁贴带的底部，而不是视口底部。
         设置页 / 侧边栏复用这个组件时，宿主容器同样可能带 transform，
         挂在 body 上一劳永逸。 -->
    <Teleport to="body">
      <Transition name="toast">
        <div
          v-if="pendingRemoval"
          class="toast focus-ring"
          role="status"
          aria-live="polite"
          data-test="undo-toast"
        >
          <span class="truncate">已删除「{{ pendingRemoval.shortcut.name }}」</span>
          <button type="button" class="toast-undo" data-test="undo-remove" @click="undoRemoval">
            撤销
          </button>
        </div>
      </Transition>
    </Teleport>

    <!-- 新增 / 编辑对话框 -->
    <Teleport to="body">
      <Transition name="dialog">
        <div
          v-if="dialogOpen"
          class="dialog-backdrop"
          @click.self="closeDialog"
        >
          <div
            ref="dialogEl"
            class="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-dialog-title"
            data-test="shortcut-dialog"
            @keydown="onDialogKeydown"
          >
            <h3 id="shortcut-dialog-title" class="dialog-title">
              {{ dialogTitle }}
            </h3>

            <form class="dialog-form" @submit.prevent="submitForm">
              <div class="field">
                <label for="shortcut-name" class="field__label">名称</label>
                <input
                  id="shortcut-name"
                  ref="nameInput"
                  v-model="formName"
                  type="text"
                  class="dialog-input focus-ring"
                  placeholder="例如：GitHub"
                  autocomplete="off"
                  data-test="shortcut-name-input"
                >
              </div>

              <div class="field">
                <label for="shortcut-url" class="field__label">网址</label>
                <input
                  id="shortcut-url"
                  v-model="formUrl"
                  type="text"
                  class="dialog-input focus-ring"
                  placeholder="example.com"
                  autocomplete="off"
                  spellcheck="false"
                  :aria-invalid="Boolean(formError)"
                  aria-describedby="shortcut-url-help"
                  data-test="shortcut-url-input"
                >
                <p id="shortcut-url-help" class="field__help">
                  可以省略 https://，会自动补全
                </p>
                <p
                  v-if="formError"
                  class="field__error"
                  role="alert"
                  data-test="shortcut-form-error"
                >
                  {{ formError }}
                </p>
              </div>

              <div class="dialog-actions">
                <button type="button" class="ghost-control focus-ring" data-test="dialog-cancel" @click="closeDialog">
                  取消
                </button>
                <button type="submit" class="primary-control focus-ring" data-test="dialog-save">
                  {{ dialogMode === 'create' ? '添加' : '保存' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
/* ---------------------------------------------------------------
   磁贴带
   ---------------------------------------------------------------
   标题行刻意压到很小：它是这一块的「扶手」，不是另一个标题。
   真正的视觉主角是上面那只时钟，这里不能跟它抢。
   --------------------------------------------------------------- */
.grid-root {
  width: 100%;
  /* 幕布：真列表还没就位时先不显示。
     挂载那一刻渲染的是种子站，storage 异步回来后整份会被换成用户的磁贴；
     不遮住就会看到「先一批别人的站、再闪成自己的」。
     原来这层幕布是 NewTab.vue 里一个固定 260ms 才开始的动画，现在改成
     按就位信号（见 startTileWave），storage 慢的时候也不会露馅。 */
  opacity: 0;
}

.grid-root.is-waved {
  opacity: 1;
}

.grid-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 1.9rem;
  margin-bottom: 0.9rem;
}

/* 分组标题。
   中文不写 text-transform: uppercase（对汉字没有任何作用，只是机器痕迹），
   字距收到 0.08em：中文小字需要一点字距才好认，但 0.16em 会把「快捷方式」
   拆成互不相干的单字。 */
.grid-title {
  margin: 0;
  font-size: clamp(0.7rem, 0.66rem + 0.18vw, 0.78rem);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

/* 磁贴带标题右边的提示：位置固定，不随磁贴高度抖动。
   两种模式都要显示 —— 「按住图标拖动」是个藏起来的手势，
   不写出来没人会去试。 */
.grid-hint {
  flex: 1;
  min-width: 0;
  margin-left: 0.75rem;
  color: var(--text-3);
  font-size: 0.72rem;
}

.grid-edit {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.28rem 0.6rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-3);
  font-family: inherit;
  font-size: 0.74rem;
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.grid-edit:hover {
  border-color: var(--line);
  background: var(--surface);
  color: var(--text-1);
}

.grid-edit[aria-pressed='true'] {
  border-color: var(--line);
  background: var(--surface-strong);
  color: var(--text-1);
}

/* 网格
   auto-fit + 固定列宽：一行放得下几个就放几个，超出自动换行。
   窄屏下面板只有 350px 左右，固定列宽会在右侧留出一段参差的空档，
   所以小屏改成等分列（1fr），让磁贴自己撑满行宽。 */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, 5.5rem);
  gap: 1.15rem 0.75rem;
  /* 拖动时的命中判定用 offsetLeft/Top 量格子（见 tileIndexAt），
     所以这里要当磁贴的 offsetParent */
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (max-width: 768px) {
  .tile-grid {
    grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
    gap: 1rem 0.5rem;
  }

  /* 小屏一行挤不下，让提示截断，也不要把它整句藏掉：
     触屏用户正是靠这句才知道图标能按住拖 */
  .grid-hint {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.tile-cell {
  display: flex;
  justify-content: center;
  /* 触屏长按不要弹出系统的「拷贝 / 打开链接」菜单，也别把站名选成一片蓝底 */
  -webkit-touch-callout: none;
  user-select: none;
  /* 系统那层蓝色高亮在长按时会一直盖在图标上，和「虚线空位 + 浮起卡片」的
     反馈打架；按下反馈由磁贴自己的 :active 负责，这里不要它 */
  -webkit-tap-highlight-color: transparent;
  /* 允许页面滚动和双指缩放，但不要双击缩放（双击第二下会变成拖动） */
  touch-action: manipulation;
}

/* ---------------------------------------------------------------
   逐格入场：三层编排
   ---------------------------------------------------------------
   延迟全部由 `--tile-enter-delay`（见 script 里的 tileWaveDelay）给：
   行与行之间退开一拍，读出自上而下的层积。
   三层各自再往后错一点，同一格里的东西就分三次落位，顺序是：
   玻璃面沉落 → 图标合焦 → 站名补上收尾。
   **每层的时长与相对延迟只看下面各自的 animation 声明，这里不复述** ——
   复述过的数字必然在下一次调参时变成假的。

   动画只在幕布拉开后才挂 —— 挂早了会在种子站列表上先跑一遍，
   等真列表换上又跑一遍，看着就是「抖了两下」。

   ## 为什么填充模式是 `backwards` 而不是 `both`
   入场需要**延迟期间**就把格子藏起来，所以必须有 backwards 填充。
   但**不需要** forwards：三层编排的结束值都正好等于元素的静止值。
   用 `both` 的代价是实打实的 —— 动画结束后那些值会**一直压着**普通声明，
   而任何非 `none` 的变换属性都会让元素常驻一个层叠上下文和合成层：
   落定态不是 `none`，而是 `translate: 0px` / `scale: 1` 这类「中性值」，
   视觉等价，但层叠上下文照建，hover / active 也会被一条跑完的动画压住。

   这条规则对以后加图层的人是硬的：只有某个关键帧的结束值既不等于静止值、
   又必须在结束后继续生效时，才该改用 `both`。

   同理，下面所有内层动作（图标 / 站名）**只写独立的
   `translate` / `scale` / `rotate` 属性，一律不碰 `transform`** ——
   `transform` 是留给 hover / active 的（`.add-tile` 的悬停位移、
   磁贴图标的悬停放大都在那条通道上）。
   --------------------------------------------------------------- */
.tile-cell.is-entering {
  animation: tile-arrive 200ms var(--ease-out) backwards;
  animation-delay: var(--tile-enter-delay, 0ms);
}

/* 玻璃面：从**下方**沉落，同时显影。
   这一层**刻意不做缩放**：`.tile-face` 带 backdrop-filter，缩放会逼合成器每帧按
   新尺寸重新采样它背后的 WebGL 天空（天空本身还每帧在变），而图标那层已经有更值钱的
   缩放了，两层都缩只会让代价翻倍而观感不变。这一层的职责收窄成「下沉 + 显影」。

   ## 方向：和 hero 同向，幅度比 hero 小
   hero（时钟 / 问候 / 搜索框）都是从下方升上来。磁贴带是这一页的配角、
   又在视野下缘，所以它也走竖直，只是更小一档：一页里两套方向并置
   （一处横移、一处上浮）会让「整页只有一个手势」这件事散掉。
   上一版这里是横向滑入，理由与代价见 script 里「为什么不再模仿横向扫掠」。

   ## 位移走独立的 `translate`，不写进 `transform`
   `.add-tile` 的悬停/按下姿态就在 `transform` 那条通道上，入场动画不能占它。
   用独立属性还能让结束值干净地落回 `none`（配合 `backwards` 填充，见上面那段）。

   ## 起点是「整体不可见」
   起点 opacity 0：延迟期间渲染的是 from 帧，格子必须完全看不见，
   否则会在最终位置先亮一下再跳回去。

   ## 延迟期间把命中也让给下一层
   `pointer-events` 是可做**离散动画**的属性（动画类型 discrete）：写在 from 帧里
   时，延迟期（backwards 填充）整格都不吃指针；0.01% 那一帧翻回 auto，
   动画一开始就恢复命中。没有这一步，延迟期的磁贴是「零像素但可点」——
   鼠标点在一块看不见的玻璃上，站点照样跳转。
   焦点不归它管（`pointer-events` 不影响 Tab 顺序），
   键盘那半条路见下面的 `:focus-within`。 */
@keyframes tile-arrive {
  from {
    opacity: 0;
    translate: 0 8px;
    pointer-events: none;
  }

  0.01% {
    pointer-events: auto;
  }

  to {
    opacity: 1;
    translate: none;
  }
}

/* 焦点在哪，哪一格就必须看得见。
   入场期间键盘把焦点送进一格（Tab 顺序里磁贴排在「整理」之后），动画还在
   延迟期、格子还是透明的 —— 焦点环于是落在空气里，回车却会打开站点。
   用 `!important` 把正在跑的动画按到落定态：作者声明里的 important 在层叠上
   高于 CSS 动画，所以能压住它，而**不是**取消动画（取消会让失焦后从头重播）。 */
.tile-cell.is-entering:focus-within {
  opacity: 1 !important;
  translate: none !important;
}

.tile-cell.is-entering:focus-within :deep(.tile-icon),
.tile-cell.is-entering:focus-within :deep(.tile-initial) {
  scale: 1 !important;
}

.tile-cell.is-entering:focus-within :deep(.tile-name) {
  opacity: 1 !important;
  translate: none !important;
}

/* ---------------------------------------------------------------
   图标：在自己的磁贴里**合焦**，不是从无到有地弹出来
   ---------------------------------------------------------------
   ## 上一版是 scale 0 → 1（更早还有 rotate −5° → 0 的摆正）
   从零长出来在 28px 的位图上读起来是「闪一下」：可见行程全挤在头几十毫秒，
   之后只剩一点点。它也是「生成式动效」最典型的语汇之一。
   现在起点是接近原尺寸的一档（值见下面的关键帧），读起来是照片对上焦，
   不是气球吹起来 —— 而且这一层的职责从此只和「图标」有关，
   不再替格子分担位移。

   ## 图形和首字母回退共用一条曲线
   `.tile-icon`（真图标）与 `.tile-initial`（首字母回退）是互斥挂载的两条分支，
   动效必须完全同拍：首访（缓存未命中）看到的正是首字母这一支，
   两条分支节奏不一样的话，第一次打开就露馅。

   ## 起点非零为什么安全：延迟期间它被格子的 opacity 罩住
   `animation-fill-mode: backwards` 会把 `from` 关键帧在**整个 delay 期间**渲染出来，
   而图标这一层的延迟比格子还晚一点 —— 那段时间里格子已经在显影、还没到位，
   所以起点必须是一个「即使被看见也不奇怪」的姿态。上一版起点写 `scale: 0`
   是因为那套的关键帧里图标还要摆正，起点非零会在显影的格子里钉一个小点；
   现在起点就是接近静止的半拍，露出来也只是提前对上焦。

   ## 为什么每个内部动作都只写独立属性
   下面这套（图标 / 站名）**只写独立的 `translate` / `scale` / `rotate`，
   一律不碰 `transform`** —— `transform` 是留给 hover / active 的
   （`.add-tile` 的悬停位移、磁贴图标的悬停放大都在那条通道上）。
   收尾能干净地落回 `none` 是 `backwards` 填充带来的，不是独立属性本身带来的 ——
   两者要一起用（见上面 fill-mode 那段）。
   --------------------------------------------------------------- */
.tile-cell.is-entering :deep(.tile-icon),
.tile-cell.is-entering :deep(.tile-initial) {
  /* 只有一条动画：从略小处合焦到原尺寸。
     图标自己的显影**不需要**：`.tile-cell` 的 `tile-arrive` 本来就在做 opacity 0→1，
     而父层的 opacity 是组不透明度，会乘到整棵子树上。上一版给图标单挂一条 fade，
     结果是「两层淡入叠在一起」。 */
  animation: tile-icon-arrive 180ms var(--ease-out) backwards;
  animation-delay: calc(var(--tile-enter-delay, 0ms) + 30ms);
}

/* 「+」那一格跟图标同一拍：空槽位不是图标，是一个虚线框，
   让它和旁边图标完全同拍落位，整行才整齐。 */
.tile-cell.is-entering .add-tile {
  animation: tile-slot-arrive 180ms var(--ease-out) backwards;
  animation-delay: calc(var(--tile-enter-delay, 0ms) + 30ms);
}

/* ---------------------------------------------------------------
   图标关键帧：只保留「合焦」这一下
   ---------------------------------------------------------------
   起点接近原尺寸的硬要求是不出现在显影中段「先小后大」的跳变 ——
   幅度太大就成了第二段位移，和格子那一段重复。
   这里**没有 rotate**：上一版那 5° 的摆正是回弹语汇的一部分，已经删掉。 */
@keyframes tile-icon-arrive {
  from { scale: 0.9; }
  to { scale: 1; }
}

/* 「+」那一格走**另一条**关键帧只是为了让它的节奏可以单独调；
   目前和图标完全同拍、同曲线。 */
@keyframes tile-slot-arrive {
  from { scale: 0.9; }
  to { scale: 1; }
}

/* 站名：最后一位，等格子沉到位之后再补上。
   它跟着格子走，位移只补一点点**竖直**方向（和格子同向），
   不再从侧面横移 —— 一格里两个方向会让「沉落」的读法散掉。

   位移走独立的 `translate` 而不是 `transform`：这条编排也用在
   空状态的 `.primary-control` 上，而那个按钮的按下姿态是
   `transform: scale(0.97)`。写进 transform 会被动画的填充值压住，
   按钮按下去就再也没有反馈了；`translate` 与 `transform` 是叠加关系。 */
.tile-cell.is-entering :deep(.tile-name) {
  animation: tile-label-arrive 160ms var(--ease-out) backwards;
  animation-delay: calc(var(--tile-enter-delay, 0ms) + 90ms);
}

@keyframes tile-label-arrive {
  0% {
    opacity: 0;
    translate: 0 3px;
  }

  100% {
    opacity: 1;
    translate: 0 0;
  }
}

/* ---------------------------------------------------------------
   入场只有三层：玻璃面 / 图标 / 站名
   ---------------------------------------------------------------
   曾经这里还挂着「站点色高光扫过磁贴面」和「图标落定时荡开的一圈波纹」。
   两层都不携带任何信息：不表示状态、不暗示可点击、不帮助认出站点，
   纯粹是「让画面热闹一点」。代价是实打实的：

   1. **同一个瞬间挤了四件事。** 一格磁贴里同时有：玻璃在动、图标在动、
      一道光在扫、一圈环在胀 —— 观众在那 100ms 里收到的是一团运动，
      不是一个动作。
   2. **尾巴被装饰层拖长。** 波纹和站名并列成为最后一层，
      而「最后结束的必须是内容」是入场的硬要求。
   3. **动画条数。** 每格只剩三条，每条都对应一件真事。

   注：磁贴自己的站点色存在感仍然由 `--tile-aurora` 负责（常亮的底缘光/晕），
   那是静态的材质，不属于入场编排。
   --------------------------------------------------------------- */

/* 起波之后才出现的磁贴（新增、撤销删除）：不排队，立刻落位。
   延迟为 0 是刻意的：这是对一次用户操作的应答，
   晚一拍出现会被读成「卡了一下」，而不是「编排」。

   它跟入场那套一样只写独立的 `translate` / `scale`，不碰 `transform`：
   一来收尾能干净地落回 `none`（这一格会一直带着 `is-fresh`），
   二来跟入场的写法统一，改一处不用记两套规矩。 */
.tile-cell.is-fresh {
  animation: tile-fresh 340ms var(--ease-spring) backwards;
}

/* 新来的这一格的图标跟入场用**同一套**（同一条曲线），只是不排队：
   给一个很小的固定延迟，而不是等波前。共用同一条曲线，是为了让
   「刚加进来的磁贴」和「页面打开时进来的磁贴」看起来是同一个东西。 */
.tile-cell.is-fresh :deep(.tile-icon),
.tile-cell.is-fresh :deep(.tile-initial) {
  animation: tile-icon-arrive 180ms var(--ease-out) 40ms backwards;
}

@keyframes tile-fresh {
  0% {
    opacity: 0;
    translate: 0 10px;
    scale: 0.9;
  }

  100% {
    opacity: 1;
    translate: none;
    scale: none;
  }
}

/* 标题行和磁贴带同一拍起、更早落定：它是这一块的「扶手」，
   比磁贴短一档 —— 扶手先稳住，内容再落下。 */
.grid-head.is-entering {
  animation: rise-in 260ms var(--ease-out) backwards;
}

/* 空状态：没有磁贴可编排时，卡片里的四件东西自己走一遍同样的层次
   （标记 → 标题 → 说明 → 按钮），不然这一屏就只剩「啪」地一下。 */
.empty-state.is-entering {
  animation: rise-in var(--dur-enter) var(--ease-out) backwards;
}

.empty-state.is-entering .empty-mark {
  animation: tile-slot-arrive 320ms var(--ease-out) 60ms backwards;
}

.empty-state.is-entering .empty-title {
  animation: tile-label-arrive 400ms var(--ease-out) 150ms backwards;
}

.empty-state.is-entering .empty-hint {
  animation: tile-label-arrive 400ms var(--ease-out) 210ms backwards;
}

.empty-state.is-entering .primary-control {
  animation: tile-label-arrive 400ms var(--ease-out) 270ms backwards;
}

/* ---------------------------------------------------------------
   减少动效：入场不是「压缩到 0.01ms」，而是**整条编排不参与**
   ---------------------------------------------------------------
   main.css 里那条全局规则把时长压到 0.01ms、延迟清 0。它确实能让现在这批
   动画在第一帧就落在终点（没有 delay 就没有 before phase，也就不会画 from 帧），
   所以「为什么还要在这里再摘一遍」要写清楚：

   1. **组件这一侧不依赖 main.css 的细则。** 那条全局规则一旦被改
      （比如为了别的效果保留延迟），这里所有图层会立刻退化成「先在 from 姿态
      停一会儿」—— 那正是减少动效的用户最不想要的。
   2. **用 `:deep(*)` 而不是逐层列名字。** 入场图层以后还会变；手抄名单漏一行
      不会报错，只会让某一层在 reduce 下多走一次 0.01ms 的动画。这条 `*` 是
      有意的：磁贴里新加的任何「入场」动画在 reduce 下都该一起消失。
      不属于入场的常驻动画（秒针的呼吸）不在这几棵子树里，不受影响。
   3. 摘掉之后连 `animation-delay` 都不用管：没有动画，就没有延迟期，
      也就不存在「内容分几次啪、啪、啪地瞬现」。 */
@media (prefers-reduced-motion: reduce) {
  .tile-cell.is-entering,
  .tile-cell.is-entering :deep(*),
  .tile-cell.is-fresh,
  .tile-cell.is-fresh :deep(*),
  .grid-head.is-entering,
  .empty-state.is-entering,
  .empty-state.is-entering :deep(*) {
    /* `!important` 是必须的，不是偷懒：子层自己的入场声明写得比这些通配更具体
       （`.empty-state.is-entering .empty-title` 一类），没有它，通配规则会被
       那条更具体的规则压掉 —— 实测「通配没加 !important」时子层的 computed
       animation-name 仍然是入场动画名。这里和 main.css 的全局 reset 同为
       无条件覆盖，语义一致。 */
    animation: none !important;
  }
}
/* 被拿起来的那一格：入场动画当场退出。
   可达路径是「撤销删除 → 那一格正在播 is-fresh（spring，门槛 220ms）→ 立刻按住」：
   虚线空位画在会跟着 `translate` 走的磁贴面上，不掐掉动画的话，
   空位会在被按住的那一刻从下方滑上来。 */
.tile-cell.is-drag-source,
.tile-cell.is-drag-source :deep(*) {
  animation: none !important;
}

/* 拖动中的「空位」
   ---------------------------------------------------------------
   被拿起来的那一格只留一个「落点」：虚线框画在图标自身上（3.75rem 那个方块），
   而不是整格。因为站名、整理模式的小按钮撤掉之后它们占的高度还在
   （网格行高不变，旁边磁贴才不会跳），照着整格画框就会多出一大截空的。
   框要**紧贴图标边缘、不外扩**，大小正好等于浮起的那张卡片 ——
   落点比卡片大一号的话，看着像是要放进去一个更大的东西。
   撤内容用 visibility 而不是 opacity：被撤掉的东西同时也从无障碍树里消失
   （它此刻是「被拿走」的，不该再被读到），而且它天然盖不掉，不必跟
   ShortcutTile 里悬停那几条规则（抬升、站点色、首字母反色）逐条对抗 ——
   悬停本身在拖动期间已经关掉了（见下面的 .tile-grid.is-sorting），这里是第二道保险。 */
.tile-cell.is-drag-source :deep(.tile-name),
.tile-cell.is-drag-source :deep(.tile-actions),
.tile-cell.is-drag-source :deep(.tile-aurora),
.tile-cell.is-drag-source :deep(.tile-icon),
.tile-cell.is-drag-source :deep(.tile-initial) {
  visibility: hidden;
}

/* 空位上的磁贴表面也一起让位，只留虚线。
   border-color 要清掉，否则细边框和虚线会叠成两层框；
   transform 也要压平 —— 悬停抬升在拖动期间已经关掉（见下），
   但按下去时留下的 :active 还可能挂在磁贴上，虚线圈会跟着跳。
   （这三条权重大于 a.tile-face:hover） */
.tile-cell.is-drag-source :deep(.tile-face) {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transform: none;
  outline: 2px dashed var(--brand-vivid);
  /* 虚线正好圈住图标本身：offset 取负，把 2px 线宽画进框内，
     外沿和图标边缘重合 —— 也就是和浮起的那张卡片一样大。
     （用 +3px 时整圈往外套了 5px，看着比卡片大一号。） */
  outline-offset: -2px;
}

/* 拖动期间指针底下压着的可能是链接或按钮（它们自带 cursor），
   光给网格设 cursor 会被它们自己的规则盖掉，得连后代一起压 */
.tile-grid.is-sorting,
.tile-grid.is-sorting a,
.tile-grid.is-sorting button {
  cursor: grabbing;
}

/* 拖动期间磁贴不再参与悬停。
   否则卡片扫过谁、谁就抬起来发一下光 —— 那是噪声，不是反馈；
   真正的反馈是跟着手指走的那个虚线空位。整理模式的小按钮也一并失效，
   拖动中本来就不该点到它们（外层格子仍可接收被捕获的指针，不受影响）。 */
.tile-grid.is-sorting :deep(.tile),
.tile-grid.is-sorting .add-tile {
  pointer-events: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---- 新增磁贴 ---- */
.add-tile {
  display: grid;
  place-items: center;
  width: 3.75rem;
  height: 3.75rem;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-tile);
  background: transparent;
  color: var(--text-3);
  font-size: 1.05rem;
  cursor: pointer;
  transition:
    border-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out),
    background var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-spring);
}

.add-tile:hover {
  border-color: var(--brand-vivid);
  background: var(--brand-soft);
  color: var(--brand);
  transform: translateY(-4px);
}

.add-tile:active {
  transform: translateY(-1px) scale(0.97);
}

.edit-note {
  margin: 1rem 0 0;
  color: var(--text-3);
  font-size: 0.72rem;
  line-height: 1.6;
}

/* ---- 空状态 ----
   空状态是「还没开始」的界面，不是错误页：
   给它一个安静的容器、一句明确的下一步、一个主按钮。
   玻璃面比别处实一档：这一块要压住主按钮的白字，
   底色太透会让按钮背后的有效背景变亮，白字对比度掉到 AA 以下。 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  /* 全宽会把这块撑成一条 1260px 的空盒子，右侧大片死区，
     反而不像「还没开始」而像「加载失败」。收到一个正常的卡片宽度。 */
  max-width: 32rem;
  padding: 1.6rem 1.5rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-surface);
  background: var(--surface-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.empty-mark {
  display: grid;
  place-items: center;
  width: 2.4rem;
  height: 2.4rem;
  margin-bottom: 0.35rem;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-inner);
  color: var(--text-3);
  font-size: 1rem;
}

.empty-title {
  margin: 0;
  color: var(--text-1);
  font-size: 0.92rem;
  font-weight: 600;
}

.empty-hint {
  max-width: 34ch;
  margin: 0 0 0.65rem;
  color: var(--text-3);
  font-size: 0.8rem;
  line-height: 1.65;
}

/* ---- 撤销 toast ---- */
.toast {
  position: fixed;
  left: 50%;
  bottom: 1.75rem;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  max-width: min(90vw, 24rem);
  padding: 0.6rem 0.75rem 0.6rem 1rem;
  border-radius: var(--radius-control);
  background: var(--text-1);
  color: var(--bg-base);
  font-size: 0.8rem;
  box-shadow: var(--shadow-3);
  z-index: var(--z-toast);
}

.toast-undo {
  padding: 0.15rem 0.4rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--brand-vivid);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.toast-undo:hover {
  background: var(--brand-soft);
}

/* ---- 对话框 ---- */
.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--scrim);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.dialog-panel {
  width: min(100%, 26rem);
  padding: 1.4rem 1.4rem 1.2rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-surface);
  background: var(--bg-base);
  color: var(--text-1);
  box-shadow:
    var(--shadow-3),
    inset 0 1px 0 var(--line-inset);
}

.dialog-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.02rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1.15rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field__label {
  color: var(--text-2);
  font-size: 0.76rem;
  font-weight: 500;
}

.field__help {
  margin: 0;
  color: var(--text-3);
  font-size: 0.72rem;
}

.field__error {
  margin: 0;
  color: var(--danger-text);
  font-size: 0.72rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

/* ---- 过渡 ---- */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-active .dialog-panel,
.dialog-leave-active .dialog-panel {
  transition:
    transform var(--dur-base) var(--ease-spring),
    opacity var(--dur-base) var(--ease-out);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .dialog-panel,
.dialog-leave-to .dialog-panel {
  opacity: 0;
  transform: translateY(8px) scale(0.975);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>

<!-- 浮起的拖拽卡片是 JS 直接挂到 body 上的（见 mountGhost），
     没有 scoped 标记，所以这几条必须放在非 scoped 的样式块里。
     卡片内容是磁贴 DOM 的克隆，它自己那些样式照旧生效；
     这里只管「浮起来」这件事：贴住指尖、抬高、加一层影子。 -->
<style>
.drag-ghost {
  position: fixed;
  left: 0;
  top: 0;
  /* 被拿在手里的卡片是当下最「上面」的东西：压过撤销那条浮层（它俩原本同级，
     卡片后进 DOM 反而会被盖住），只让模态对话框留在它上面。 */
  z-index: calc(var(--z-toast) + 1);
  pointer-events: none;
  will-change: transform;
  filter: drop-shadow(0 16px 30px rgb(0 0 0 / 0.32));
  animation: drag-ghost-pop var(--dur-fast) var(--ease-out) both;
}

/* 磁贴本体是克隆来的，悬停位移之类的交互态不会跟着复制过来，
   卡片始终是「拿在手里」的样子，不用额外压平。 */
@keyframes drag-ghost-pop {
  from {
    opacity: 0;
    /* 用独立的 scale 属性，不要写进 transform：
       卡片跟手的位置由内联 transform 管，写进 keyframes 会整个盖掉它 */
    scale: 0.86;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
</style>
