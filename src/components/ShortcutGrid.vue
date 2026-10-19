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

const props = withDefaults(defineProps<{
  openInNewTab?: boolean
  keyboardShortcuts?: boolean
}>(), {
  openInNewTab: false,
  keyboardShortcuts: false,
})

const { list, add, update, remove, insertAt, move } = useShortcuts()
const { isDark } = useTheme()

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

const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const formName = ref('')
const formUrl = ref('')
const formError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
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

  closeDialog()
}

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

  insertAt(pending.shortcut, pending.index)

  pendingRemoval.value = null
  window.clearTimeout(undoTimer)
}

const HOLD_MOUSE_MS = 220
const HOLD_TOUCH_MS = 350
const HOLD_SLOP_PX = 10
const EDIT_SLOP_PX = 8
const MOVE_SLOP_PX = 12
const LONG_HOLD_MS = 600
const CLICK_GUARD_MS = 400
const TOUCH_LIFT_PX = 24
const HYSTERESIS_PX = 8
const AUTOSCROLL_ZONE_PX = 76
const AUTOSCROLL_MAX_PX = 14

let motionQuery: MediaQueryList | null | undefined
function prefersReducedMotion(): boolean {
  if (motionQuery === undefined)
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null

  return motionQuery?.matches ?? false
}

interface DragSession {
  pointerId: number
  finger: boolean
  from: number
  to: number
  itemId: string
  cell: HTMLElement
  tile: HTMLElement
  startX: number
  startY: number
  lastX: number
  lastY: number
  grabX: number
  grabY: number
  faceDx: number
  faceDy: number
  armed: boolean
  moved: boolean
  armedAt: number
  holdTimer: number | undefined
}

let session: DragSession | null = null
let ghostEl: HTMLElement | null = null
let suppressClickIn: HTMLElement | null = null
let suppressTimer: number | undefined
const flipAnims = new WeakMap<HTMLElement, Animation>()
let autoScrollFrame = 0

const order = ref<Shortcut[] | null>(null)
const displayed = computed(() => order.value ?? list.value)
const dragIndex = ref(-1)
const gridEl = ref<HTMLElement | null>(null)
const emptyAdd = ref<HTMLButtonElement | null>(null)
const announcement = ref('')

const activeCell = ref(0)

function gridCells(): HTMLElement[] {
  return Array.from(gridEl.value?.querySelectorAll<HTMLElement>('.tile-cell') ?? [])
}

interface CellBox {
  index: number
  top: number
  left: number
  right: number
  centerX: number
}

function cellBoxes(): CellBox[] {
  return gridCells().map((cell, index) => {
    const left = cell.offsetLeft
    const width = cell.offsetWidth
    return {
      index,
      top: cell.offsetTop,
      left,
      right: left + width,
      centerX: left + width / 2,
    }
  })
}

function gridRows(boxes: CellBox[]): CellBox[][] {
  const rows: CellBox[][] = []
  for (const box of [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = rows.find(items => Math.abs(items[0].top - box.top) <= 4)
    if (row)
      row.push(box)
    else
      rows.push([box])
  }
  for (const row of rows)
    row.sort((a, b) => a.left - b.left)
  return rows
}

function focusCell(index: number) {
  const cell = gridCells()[index]
  if (!cell)
    return

  activeCell.value = index
  cell.querySelector<HTMLElement>('.tile-face, .add-tile')?.focus()
}

function focusGrid() {
  if (displayed.value.length === 0) {
    emptyAdd.value?.focus()
    return
  }

  const index = Math.min(Math.max(activeCell.value, 0), displayed.value.length)
  nextTick(() => focusCell(index))
}

function tileTabIndex(index: number) {
  if (!props.keyboardShortcuts)
    return editing.value ? -1 : 0
  return editing.value ? -1 : (index === activeCell.value ? 0 : -1)
}

function onGridFocusIn(event: FocusEvent) {
  if (!props.keyboardShortcuts)
    return

  const target = event.target as HTMLElement | null
  const cell = target?.closest<HTMLElement>('.tile-cell')
  if (!cell || !gridEl.value?.contains(cell))
    return

  const index = gridCells().indexOf(cell)
  if (index !== -1)
    activeCell.value = index
}

function onGridKeydown(event: KeyboardEvent) {
  if (!props.keyboardShortcuts)
    return
  if (dialogOpen.value || session)
    return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
    return

  const target = event.target as HTMLElement | null
  const cell = target?.closest<HTMLElement>('.tile-cell')
  if (!cell || !gridEl.value?.contains(cell))
    return

  const cells = gridCells()
  const current = cells.indexOf(cell)
  if (current === -1)
    return

  const rows = gridRows(cellBoxes())
  const rowIndex = rows.findIndex(row => row.some(box => box.index === current))
  const row = rows[rowIndex]
  if (!row)
    return

  const currentBox = row.find(box => box.index === current)
  if (!currentBox)
    return

  let next: CellBox | undefined

  if (event.key === 'ArrowLeft') {
    const position = row.indexOf(currentBox)
    next = row[position - 1]
  }
  else if (event.key === 'ArrowRight') {
    const position = row.indexOf(currentBox)
    next = row[position + 1]
  }
  else {
    const nextRow = rows[rowIndex + (event.key === 'ArrowDown' ? 1 : -1)]
    if (nextRow) {
      next = nextRow.reduce((best, box) =>
        Math.abs(box.centerX - currentBox.centerX) < Math.abs(best.centerX - currentBox.centerX) ? box : best,
      )
    }
  }

  if (!next)
    return

  event.preventDefault()
  focusCell(next.index)
}

watch(() => displayed.value.length, (length) => {
  if (activeCell.value > length)
    activeCell.value = length
})

function toggleEditing() {
  if (displayed.value.length === 0)
    return

  editing.value = !editing.value
  nextTick(() => focusGrid())
}

function isKeyboardLocked() {
  return dialogOpen.value || session !== null
}

function announce(text: string) {
  announcement.value = text
}

function moveTo(from: number, to: number) {
  const item = list.value[from]
  move(from, to)
  activeCell.value = to
  if (item)
    announce(`「${item.name}」已移到第 ${to + 1} 位`)
}

function haptic(duration = 8) {
  const api = navigator as Navigator & { vibrate?: (pattern: number) => boolean }
  try {
    api.vibrate?.(duration)
  }
  catch {
  }
}

function onTilePointerDown(index: number, event: PointerEvent) {
  if (session || dialogOpen.value || !event.isPrimary)
    return
  if (event.pointerType !== 'touch' && event.button !== 0)
    return
  if (list.value.length < 2)
    return
  if ((event.target as HTMLElement | null)?.closest('button'))
    return

  const cell = event.currentTarget as HTMLElement
  const tile = cell.querySelector<HTMLElement>('.tile')
  if (!tile)
    return

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

  if (session.finger || !editing.value) {
    session.holdTimer = window.setTimeout(
      armDrag,
      session.finger ? HOLD_TOUCH_MS : HOLD_MOUSE_MS,
    )
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

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
  const armTravel = Math.hypot(active.lastX - active.startX, active.lastY - active.startY)
  if (armTravel > MOVE_SLOP_PX)
    active.moved = true

  document.documentElement.style.userSelect = 'none'
  window.addEventListener('touchmove', blockPageScroll, { passive: false })

  try {
    active.cell.setPointerCapture(active.pointerId)
  }
  catch {
  }

  mountGhost(active)
  haptic()
  scheduleAutoScroll()

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

function ghostAnchor(active: DragSession): { x: number, y: number } {
  return {
    x: active.lastX - active.grabX,
    y: active.lastY - active.grabY - (active.finger ? TOUCH_LIFT_PX : 0),
  }
}

function scheduleAutoScroll() {
  if (!autoScrollFrame)
    autoScrollFrame = window.requestAnimationFrame(autoScrollStep)
}

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
  if (scroller.scrollTop === before)
    return

  updateDropTarget()
  scheduleAutoScroll()
}

function blockPageScroll(event: TouchEvent) {
  if (session?.armed)
    event.preventDefault()
}

function mountGhost(active: DragSession) {
  const clone = active.tile.cloneNode(true) as HTMLElement

  clone.removeAttribute('data-test')
  clone.setAttribute('tabindex', '-1')
  clone.querySelectorAll('[data-test]').forEach(node => node.removeAttribute('data-test'))
  clone.querySelectorAll('[tabindex]').forEach(node => node.setAttribute('tabindex', '-1'))
  clone.querySelector('.tile-actions')?.remove()
  clone.querySelectorAll('img').forEach(node => node.setAttribute('loading', 'eager'))

  clone.querySelector('.tile-name')?.remove()

  ghostEl = document.createElement('div')
  ghostEl.className = 'drag-ghost'
  ghostEl.setAttribute('aria-hidden', 'true')
  ghostEl.append(clone)
  document.body.append(ghostEl)

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

  const anchor = ghostAnchor(active)
  const x = anchor.x - active.faceDx
  const y = anchor.y - active.faceDy

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

    if (active.finger) {
      if (travel > HOLD_SLOP_PX)
        endDrag()
      return
    }

    if (!editing.value || travel < EDIT_SLOP_PX) {
      return
    }

    armDrag()
  }

  if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > MOVE_SLOP_PX)
    active.moved = true

  positionGhost(active)
  updateDropTarget()
  scheduleAutoScroll()
}

function updateDropTarget() {
  const active = session
  if (!active?.armed || !order.value)
    return

  const anchor = ghostAnchor(active)
  const target = tileIndexAt(anchor.x, anchor.y, active.to)
  if (target === -1 || target === active.to)
    return

  const before = snapshotCells()
  order.value = moveItem(order.value, active.to, target)
  active.to = target
  active.moved = true
  dragIndex.value = target
  haptic(6)
  void nextTick(() => playFlip(before))
}

function tileIndexAt(x: number, y: number, current: number): number {
  const grid = gridEl.value
  if (!grid)
    return -1

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
    const raw = y < top ? top - y : y > bottom ? y - bottom : 0
    const isCurrentRow = currentBox?.top === top
    const gap = isCurrentRow ? Math.max(0, raw - HYSTERESIS_PX) : raw
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

    flipAnims.get(cell)?.cancel()
    flipAnims.set(cell, cell.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    ))
  })
}

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

  const dragged = armed && (moved || performance.now() - active.armedAt > LONG_HOLD_MS)

  const landing = dragged ? faceLandingPoint(to) : null
  const landed = landing ? detachGhost() : null

  endDrag()

  if (!dragged) {
    if (armed && !moved) {
      const shortcut = list.value.find(item => item.id === itemId)
      if (shortcut)
        activateTile(shortcut, event)
    }
    return
  }

  suppressClickIn = cell
  window.clearTimeout(suppressTimer)
  suppressTimer = window.setTimeout(() => {
    suppressClickIn = null
  }, CLICK_GUARD_MS)

  if (landed && landing)
    settleGhost(landed, landing)

  haptic(10)

  const from = list.value.findIndex(item => item.id === itemId)
  if (from === -1 || list.value.length < 2)
    return

  const target = Math.max(0, Math.min(to, list.value.length - 1))
  if (from === target)
    return

  move(from, target)
  announce(name ? `「${name}」已移到第 ${target + 1} 位` : '已更新顺序')
}

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

function detachGhost(): HTMLElement | null {
  const el = ghostEl
  ghostEl = null
  return el
}

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

function springEasing(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim()
  return value || 'cubic-bezier(0.34, 1.4, 0.64, 1)'
}

function onPointerCancel(event: PointerEvent) {
  if (session && event.pointerId === session.pointerId)
    cancelDrag()
}

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

function onNativeDragStart(event: DragEvent) {
  event.preventDefault()
}

function onTileContextMenu(event: MouseEvent) {
  if (session)
    event.preventDefault()
}

function onClickCapture(event: MouseEvent) {
  if (!suppressClickIn || event.currentTarget !== suppressClickIn)
    return

  suppressClickIn = null
  window.clearTimeout(suppressTimer)
  event.preventDefault()
  event.stopPropagation()
}

function onGlobalKeydown(event: KeyboardEvent) {
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

const BAND_START_MS = PAGE_BEAT_MS * 3
const TILE_WAVE_ROW = PAGE_BEAT_MS
const TILE_WAVE_COL = 12
const TILE_WAVE_KNEE = PAGE_BEAT_MS * 3
const TILE_WAVE_TAIL = 0.35

const waveStarted = ref(false)
const gridCols = ref(1)

const waveDelays = ref(new Map<string, number>())
const addTileDelay = ref(0)
const emptyEntering = ref(false)
const addCellEntering = ref(false)

function tileWaveDelay(index: number): number {
  const row = Math.floor(index / gridCols.value)
  const col = index % gridCols.value
  const raw = row * TILE_WAVE_ROW + col * TILE_WAVE_COL
  return raw <= TILE_WAVE_KNEE
    ? raw
    : TILE_WAVE_KNEE + (raw - TILE_WAVE_KNEE) * TILE_WAVE_TAIL
}

function isEntering(id: string): boolean {
  return waveDelays.value.has(id)
}

function enterDelay(id: string): number {
  return waveDelays.value.get(id) ?? 0
}

const freshIds = ref(new Set<string>())
let prevIds = new Set<string>()

function startTileWave() {
  if (waveStarted.value)
    return

  const el = gridEl.value
  if (el) {
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    gridCols.value = Math.max(1, cols)
  }

  const frozen = new Map<string, number>()
  list.value.forEach((shortcut, index) => frozen.set(shortcut.id, tileWaveDelay(index)))
  waveDelays.value = frozen
  addTileDelay.value = tileWaveDelay(list.value.length)
  emptyEntering.value = list.value.length === 0
  addCellEntering.value = Boolean(el)
  waveStarted.value = true
}

const mountedAt = performance.now()
let waveTimer: number | undefined

function scheduleTileWave() {
  const wait = prefersReducedMotion()
    ? 0
    : Math.max(0, BAND_START_MS - (performance.now() - mountedAt))
  waveTimer = window.setTimeout(startTileWave, wait)
}

onMounted(() => {
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

  if (value.length === 0)
    addCellEntering.value = false
  else
    emptyEntering.value = false
}, { immediate: true })

defineExpose({
  focusGrid,
  toggleEditing,
  openCreate,
  isKeyboardLocked,
})
</script>

<template>
  <section
    class="grid-root"
    :class="{ 'is-waved': waveStarted }"
    aria-labelledby="shortcuts-heading"
    :aria-keyshortcuts="keyboardShortcuts ? 'Alt+G' : undefined"
  >
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
        :aria-keyshortcuts="keyboardShortcuts ? 'Alt+M' : undefined"
        data-test="toggle-edit"
        @click="editing = !editing"
      >
        <span :class="editing ? 'i-carbon-checkmark' : 'i-carbon-settings-adjust'" aria-hidden="true" />
        {{ editing ? '完成' : '整理' }}
      </button>
    </div>

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
      <button
        ref="emptyAdd"
        type="button"
        class="primary-control"
        :aria-keyshortcuts="keyboardShortcuts ? 'Alt+N' : undefined"
        data-test="empty-add"
        @click="openCreate"
      >
        添加第一个
      </button>
    </div>

    <ul
      v-else
      ref="gridEl"
      class="tile-grid"
      :class="{ 'is-sorting': dragIndex !== -1 }"
      data-test="shortcut-grid"
      @keydown="onGridKeydown"
      @focusin="onGridFocusIn"
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
          :tab-index="tileTabIndex(index)"
          :active="!keyboardShortcuts || index === activeCell"
          @move="moveTo"
          @edit="openEdit"
          @remove="removeWithUndo"
        />
      </li>

      <li
        class="tile-cell"
        :class="{ 'is-entering': addCellEntering }"
        :style="{ '--tile-enter-delay': `${addTileDelay}ms` }"
      >
        <button
          type="button"
          class="add-tile focus-ring"
          aria-label="添加快捷方式"
          :tabindex="!keyboardShortcuts ? 0 : (activeCell === displayed.length ? 0 : -1)"
          :aria-keyshortcuts="keyboardShortcuts ? 'Alt+N' : undefined"
          data-test="add-shortcut"
          @click="openCreate"
        >
          <span class="i-carbon-add" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <p v-if="editing && list.length > 0" class="edit-note">
      不想拖的话，鼠标停在图标上会出现排序按钮（停在按钮上能看到提示），键盘用户用 Tab 也能走到
    </p>

    <p class="sr-only" role="status" aria-live="polite">
      {{ announcement }}
    </p>

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
.grid-root {
  width: 100%;
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

.grid-title {
  margin: 0;
  font-size: clamp(0.7rem, 0.66rem + 0.18vw, 0.78rem);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

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

.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, 5.5rem);
  gap: 1.15rem 0.75rem;
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

  .grid-hint {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.tile-cell {
  display: flex;
  justify-content: center;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

.tile-cell.is-entering {
  animation: tile-arrive 200ms var(--ease-out) backwards;
  animation-delay: var(--tile-enter-delay, 0ms);
}

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

.tile-cell.is-entering :deep(.tile-icon),
.tile-cell.is-entering :deep(.tile-initial) {
  animation: tile-icon-arrive 180ms var(--ease-out) backwards;
  animation-delay: calc(var(--tile-enter-delay, 0ms) + 30ms);
}

.tile-cell.is-entering .add-tile {
  animation: tile-slot-arrive 180ms var(--ease-out) backwards;
  animation-delay: calc(var(--tile-enter-delay, 0ms) + 30ms);
}

@keyframes tile-icon-arrive {
  from { scale: 0.9; }
  to { scale: 1; }
}

@keyframes tile-slot-arrive {
  from { scale: 0.9; }
  to { scale: 1; }
}

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

.tile-cell.is-fresh {
  animation: tile-fresh 340ms var(--ease-spring) backwards;
}

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

.grid-head.is-entering {
  animation: rise-in 260ms var(--ease-out) backwards;
}

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

@media (prefers-reduced-motion: reduce) {
  .tile-cell.is-entering,
  .tile-cell.is-entering :deep(*),
  .tile-cell.is-fresh,
  .tile-cell.is-fresh :deep(*),
  .grid-head.is-entering,
  .empty-state.is-entering,
  .empty-state.is-entering :deep(*) {
    animation: none !important;
  }
}
.tile-cell.is-drag-source,
.tile-cell.is-drag-source :deep(*) {
  animation: none !important;
}

.tile-cell.is-drag-source :deep(.tile-name),
.tile-cell.is-drag-source :deep(.tile-actions),
.tile-cell.is-drag-source :deep(.tile-aurora),
.tile-cell.is-drag-source :deep(.tile-icon),
.tile-cell.is-drag-source :deep(.tile-initial) {
  visibility: hidden;
}

.tile-cell.is-drag-source :deep(.tile-face) {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transform: none;
  outline: 2px dashed var(--brand-vivid);
  outline-offset: -2px;
}

.tile-grid.is-sorting,
.tile-grid.is-sorting a,
.tile-grid.is-sorting button {
  cursor: grabbing;
}

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

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
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

<style>
.drag-ghost {
  position: fixed;
  left: 0;
  top: 0;
  z-index: calc(var(--z-toast) + 1);
  pointer-events: none;
  will-change: transform;
  filter: drop-shadow(0 16px 30px rgb(0 0 0 / 0.32));
  animation: drag-ghost-pop var(--dur-fast) var(--ease-out) both;
}

@keyframes drag-ghost-pop {
  from {
    opacity: 0;
    scale: 0.86;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
</style>
