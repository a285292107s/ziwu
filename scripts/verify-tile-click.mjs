/**
 * 开发用核对脚本（不属于测试套件）：确认「点击磁贴图标能不能跳转」。
 *
 * 用法：node --no-experimental-require-module scripts/verify-tile-click.mjs
 *
 * 做法：起一个本地 http 服务当跳转目标（`/a` `/b` `/c` 各不相同），
 * 把扩展加载进 Chromium，用**真实鼠标事件**分别跑：
 *   1. 普通点击          → 应当同标签页打开 /a
 *   2. 按住 320ms 再松手 → 应当同标签页打开 /a（这是被指针捕获吃掉、需要补偿的那一次）
 *   3. 按住 900ms 再松手 → 不该跳转（「拿起来又放下」）
 *   4. 按住 300ms 后拖到第 2 格 → 不该跳转，且顺序真的落盘了
 *   5. Ctrl+点击         → 应当新标签页打开 /a
 *   6. 键盘 Enter        → 应当同标签页打开 /a
 *
 * 顺带把每次 click 事件的 target 记下来（捕获阶段 + console），
 * 出问题时一眼能看出点击到底落在哪个元素上 —— 这正是之前那个 bug 的形状。
 */
/* global chrome */
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const PORT = 8791

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>target${req.url}</title><h1 id="hit">HIT ${req.url}</h1>`)
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
const target = p => `http://127.0.0.1:${PORT}${p}`

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  hasTouch: true,
  args: [
    '--headless=new',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

let sw = browser.serviceWorkers()[0]
if (!sw)
  sw = await browser.waitForEvent('serviceworker')
const extensionId = sw.url().split('/')[2]
const newtabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

/** 直接在后台里写 storage，避开页面首屏那次「并入预置站点」的竞态 */
async function seed(shortcuts) {
  await sw.evaluate(async (value) => {
    await chrome.storage.local.set({
      'meridiem-shortcuts': value,
      // 布尔值走 vueuse 的 boolean 序列化器：它只认字符串 'true'/'false'
      // （写原生 true 进去会被读成 false，预置站点又会并进来一次）
      'meridiem-preset-sites-merged': 'true',
      'meridiem-theme': 'light',
    })
  }, JSON.stringify(shortcuts))
}

const ALL = [
  { id: 'a', name: 'Alpha', url: target('/a') },
  { id: 'b', name: 'Bravo', url: target('/b') },
  { id: 'c', name: 'Charlie', url: target('/c') },
]

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const logs = []
page.on('console', (m) => {
  if (m.text().startsWith('CLICK'))
    logs.push(m.text())
})
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`))

// 捕获阶段记下每一次 click 的落点
await page.addInitScript(() => {
  document.addEventListener('click', (e) => {
    const t = e.target
    const desc = t?.tagName ? `${t.tagName}${t.className ? `.${String(t.className).split(' ')[0]}` : ''}` : String(t)
    console.log(`CLICK target=${desc} prevented=${e.defaultPrevented} href=${t?.closest?.('a')?.getAttribute('href') ?? 'none'}`)
  }, true)
})

const results = []

async function point(selector) {
  const el = page.locator(selector)
  // 设置页的磁贴可能落在首屏之外：不先滚进来，坐标会落到视口外
  await el.scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  const box = await el.boundingBox()
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function order() {
  const raw = await sw.evaluate(() => chrome.storage.local.get('meridiem-shortcuts'))
  return JSON.parse(raw['meridiem-shortcuts']).map(s => s.id).join(',')
}

async function reset() {
  await page.goto(newtabUrl)
  await page.waitForSelector('[data-test="shortcut-tile-a"] .tile-face')
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(500)
  return page.evaluate(() => document.querySelectorAll('[data-test^="shortcut-tile-"]').length)
}

function openTabs() {
  return browser.pages().map(p => p.url())
}

async function waitForTab(needle, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (openTabs().some(u => u.includes(needle)))
      return true
    await page.waitForTimeout(100)
  }
  return false
}

await seed(ALL)

/* 1. 普通点击 */
const tiles = await reset()
logs.length = 0
let at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.click(at.x, at.y)
await page.waitForTimeout(1200)
results.push({ case: '普通点击', tiles, url: page.url(), ok: tiles === 3 && page.url().includes('/a'), logs: [...logs] })

/* 2. 按住 320ms 再松手（不挪窝） */
await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.move(at.x, at.y)
await page.mouse.down()
await page.waitForTimeout(320)
await page.mouse.up()
await page.waitForTimeout(1200)
results.push({ case: '按住 320ms 松手', url: page.url(), ok: page.url().includes('/a'), logs: [...logs] })

/* 3. 按住 900ms 再松手：不算点击 */
await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.move(at.x, at.y)
await page.mouse.down()
await page.waitForTimeout(900)
await page.mouse.up()
await page.waitForTimeout(1200)
results.push({ case: '按住 900ms 松手', url: page.url(), ok: !page.url().includes('127.0.0.1'), logs: [...logs] })

/* 4. 拖动排序：按住 300ms 后拖到第 2 格 */
const tiles4 = await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.move(at.x, at.y)
await page.mouse.down()
await page.waitForTimeout(300)
await page.mouse.move(at.x + 100, at.y, { steps: 12 })
await page.waitForTimeout(200)
await page.mouse.up()
await page.waitForTimeout(900)
const orderAfter = await order()
results.push({
  case: '拖动到第 2 格',
  tiles: tiles4,
  url: page.url(),
  order: orderAfter.split(',').slice(0, 4).join(','),
  ok: tiles4 === 3 && !page.url().includes('127.0.0.1') && orderAfter === 'b,a,c',
  logs: [...logs],
})

/* 5. Ctrl+点击（不按住）：原生新标签页 */
await seed(ALL)
await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.move(at.x, at.y)
await page.keyboard.down('Control')
await page.mouse.click(at.x, at.y)
await page.keyboard.up('Control')
const ctrlOpened = await waitForTab('/a')
results.push({ case: 'Ctrl+点击', tabs: openTabs().filter(u => u.includes('127.0.0.1')), ok: ctrlOpened, logs: [...logs] })

/* 6. 中键点击（不按住）：原生新标签页 */
await seed(ALL)
await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.click(at.x, at.y, { button: 'middle' })
const middleOpened = await waitForTab('/a', 2000)
results.push({ case: '中键点击', tabs: openTabs().filter(u => u.includes('127.0.0.1')), ok: middleOpened, logs: [...logs] })

/* 7. 键盘 Enter */
for (const p of browser.pages()) {
  if (p !== page)
    await p.close()
}
await reset()
logs.length = 0
await page.evaluate(() => document.querySelector('[data-test="shortcut-tile-a"] .tile-face').focus())
await page.keyboard.press('Enter')
await page.waitForTimeout(1000)
results.push({ case: '键盘 Enter', url: page.url(), ok: page.url().includes('/a'), logs: [...logs] })

/* 7. 触屏轻点（手指路径） */
await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.touchscreen.tap(at.x, at.y)
await page.waitForTimeout(1200)
results.push({ case: '触屏轻点', url: page.url(), ok: page.url().includes('/a'), logs: [...logs] })

/* 8. 触屏按住拖拽：手指路径也要能排序，且不跳转 */
await seed(ALL)
const tiles8 = await reset()
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
const cdp = await page.context().newCDPSession(page)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
await page.waitForTimeout(420)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x + 100, y: at.y }] })
await page.waitForTimeout(260)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await page.waitForTimeout(900)
const touchOrder = await order()
results.push({
  case: '触屏按住拖拽',
  tiles: tiles8,
  url: page.url(),
  order: touchOrder,
  ok: tiles8 === 3 && !page.url().includes('127.0.0.1') && touchOrder === 'b,a,c',
  logs: [...logs],
})

/* 9. 设置页里的磁贴（ShortcutGrid 传了 openInNewTab，应当开新标签页） */
for (const p of browser.pages()) {
  if (p !== page)
    await p.close()
}
await page.goto(`chrome-extension://${extensionId}/dist/options/index.html`)
await page.waitForSelector('[data-test="shortcut-tile-a"] .tile-face')
await page.waitForTimeout(600)
logs.length = 0
at = await point('[data-test="shortcut-tile-a"] .tile-face')
await page.mouse.click(at.x, at.y)
const optionsOpened = await waitForTab('/a')
results.push({
  case: '设置页点击（openInNewTab）',
  url: page.url(),
  tabs: openTabs().filter(u => u.includes('127.0.0.1')),
  ok: optionsOpened && page.url().includes('/dist/options/index.html'),
  logs: [...logs],
})

console.log(JSON.stringify({ extensionId, results, passed: results.every(r => r.ok) }, null, 2))

await browser.close()
server.close()
process.exit(results.every(r => r.ok) ? 0 : 1)
