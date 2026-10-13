/**
 * 开发用核对脚本（不属于测试套件）：确认「整理」模式下四个小按钮的
 * 排布顺序与悬停提示。
 *
 * 用法：node --no-experimental-require-module scripts/verify-tile-actions.mjs [轮次]
 * 产物：docs/review/<轮次>/<主题>-<状态>.png + stdout 的几何/提示核对结果
 *
 * 注意：排序按钮平时 `pointer-events: none`（见 ShortcutTile.vue），
 * 只有磁贴处于 hover 时才恢复。Playwright 的 locator.hover() 会先做
 * 命中测试，此时按钮还不能被点到 → 它会一直重试到超时。
 * 所以这里不走 locator.hover()，而是直接按坐标移动鼠标（和真人一样）：
 * 先移到磁贴上，再移到按钮上。
 */
/* global chrome */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'tile-actions'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const SHORTCUTS = [
  { id: 'p1', name: 'GitHub', url: 'https://github.com' },
  { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  { id: 'p3', name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 'p4', name: 'MDN', url: 'https://developer.mozilla.org' },
]

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  deviceScaleFactor: 2,
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
const url = `chrome-extension://${extensionId}/dist/newtab/index.html`

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const problems = []
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    problems.push(`console.error: ${m.text()}`)
})

async function set(key, value) {
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k]: v }), [key, value])
}

/** 第 3 个磁贴（哔哩哔哩）在中间，左右都能移，四个按钮都是可用态 */
const ID = 'p3'

async function centre(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el)
      return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, selector)
}

/** 先把鼠标放到磁贴图标上（让 tile 进入 :hover、排序按钮可点），再移到小按钮上 */
async function hoverAction(test) {
  const face = await centre(`[data-test="shortcut-tile-${ID}"] .tile-face`)
  await page.mouse.move(face.x, face.y, { steps: 6 })
  await page.waitForTimeout(160)

  const btn = await centre(`[data-test="${test}"]`)
  await page.mouse.move(btn.x, btn.y, { steps: 4 })
  await page.waitForTimeout(320)
}

await page.goto(url)
await page.waitForSelector('[data-test="search-input"]')

const report = { round, problems, themes: {} }

for (const theme of ['light', 'dark']) {
  await set('meridiem-shortcuts', JSON.stringify(SHORTCUTS))
  await set('meridiem-theme', theme)
  await page.reload()
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await page.evaluate(async () => document.fonts.ready)
  await page.waitForTimeout(900)

  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(500)

  const shot = async name => page.screenshot({ path: path.join(outDir, `${theme}-${name}.png`) })

  /** 只截这一格磁贴（含溢出到外面的气泡），放大看细节 */
  const shotZoom = async (name, id) => {
    const clip = await page.evaluate((tid) => {
      const cell = document.querySelector(`[data-test="shortcut-tile-${tid}"]`)
      const r = cell.getBoundingClientRect()
      return { x: Math.max(0, r.left - 30), y: Math.max(0, r.top - 46), width: r.width + 60, height: r.height + 76 }
    }, id)
    await page.screenshot({ path: path.join(outDir, `${theme}-${name}.png`), clip })
  }

  await shot('editing')

  // 悬停到「后移」按钮：看提示文字、位置、可见性
  await hoverAction(`tile-right-${ID}`)
  await shot('hover-right')
  await shotZoom('zoom-hover-right', ID)

  const hoverState = await page.evaluate((id) => {
    const box = document.querySelector(`[data-test="tile-actions-${id}"]`)
    const btn = document.querySelector(`[data-test="tile-right-${id}"]`)
    const tip = btn.querySelector('.tile-tip')
    const r = tip.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    const s = getComputedStyle(tip)
    const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    // 气泡有没有压住任何一个小按钮（四个按钮的矩形）
    const covers = [...box.querySelectorAll('button')]
      .filter((b) => {
        const q = b.getBoundingClientRect()
        return !(r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom)
      })
      .map(b => b.dataset.test.replace(`-${id}`, ''))
    return {
      text: tip.textContent.trim(),
      opacity: s.opacity,
      hasSize: r.width > 0 && r.height > 0,
      aboveButton: Math.round(r.bottom) <= Math.round(br.top),
      aboveActions: Math.round(r.bottom) <= Math.round(box.getBoundingClientRect().top),
      coversButtons: covers,
      stack: stack.map(el => el.className?.toString?.().slice(0, 40) ?? el.tagName).slice(0, 4),
    }
  }, ID)

  // 四个按钮的排布：按几何分行，看第二行是不是左/右箭头
  const layout = await page.evaluate((id) => {
    const cells = [...document.querySelectorAll(`[data-test="tile-actions-${id}"] button`)].map((btn) => {
      const r = btn.getBoundingClientRect()
      return {
        kind: btn.dataset.test.replace(`-${id}`, ''),
        tip: btn.querySelector('.tile-tip').textContent.trim(),
        disabled: btn.getAttribute('aria-disabled') === 'true',
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    })
    const sorted = [...cells].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    const rows = []
    for (const c of sorted) {
      const row = rows.find(r => Math.abs(r.cy - c.cy) < 4)
      if (row)
        row.items.push(c.kind)
      else
        rows.push({ cy: c.cy, items: [c.kind] })
    }
    return { cells, rows }
  }, ID)

  // 网格里其他磁贴的按钮是不是同一套（宽度没被气泡撑开）
  const otherTile = await page.evaluate(() => {
    const btn = document.querySelector('[data-test="tile-edit-p1"]')
    const r = btn.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })

  // 第一个磁贴：左移应当提示「已到最前」并且是 aria-disabled
  const firstLeft = await page.evaluate(() => {
    const btn = document.querySelector('[data-test="tile-left-p1"]')
    return {
      tip: btn.querySelector('.tile-tip').textContent.trim(),
      disabled: btn.getAttribute('aria-disabled'),
    }
  })
  await hoverAction('tile-left-p1')
  await shot('hover-first-left')
  await shotZoom('zoom-hover-first-left', 'p1')

  // 悬停「编辑」「删除」，确认整格四个按钮的提示都能出来
  await hoverAction(`tile-edit-${ID}`)
  await shotZoom('zoom-hover-edit', ID)
  const editTip = await page.evaluate((id) => {
    return getComputedStyle(document.querySelector(`[data-test="tile-edit-${id}"] .tile-tip`)).opacity
  }, ID)

  await hoverAction(`tile-delete-${ID}`)
  await shotZoom('zoom-hover-delete', ID)

  // 四个按钮逐个悬停：每一格的气泡都不能压住任何一个按钮
  const tipCollisions = {}
  for (const kind of ['edit', 'delete', 'left', 'right']) {
    await hoverAction(`tile-${kind}-${ID}`)
    tipCollisions[kind] = await page.evaluate((id) => {
      const box = document.querySelector(`[data-test="tile-actions-${id}"]`)
      const tip = document.querySelector(`[data-test="tile-actions-${id}"] .tile-tip[style], [data-test="tile-${id}"] .tile-tip`)
      void tip
      const live = [...box.querySelectorAll('.tile-tip')].find(t => getComputedStyle(t).opacity === '1')
      if (!live)
        return { error: 'no visible tip' }
      const r = live.getBoundingClientRect()
      const covers = [...box.querySelectorAll('button')]
        .filter((b) => {
          const q = b.getBoundingClientRect()
          return !(r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom)
        })
        .map(b => b.dataset.test.replace(`-${id}`, ''))
      return { text: live.textContent.trim(), coversButtons: covers }
    }, ID)
  }

  // 鼠标移开：气泡应当收回去
  await page.mouse.move(20, 20, { steps: 6 })
  await page.waitForTimeout(400)
  const awayOpacity = await page.evaluate((id) => {
    return getComputedStyle(document.querySelector(`[data-test="tile-right-${id}"] .tile-tip`)).opacity
  }, ID)

  // 键盘：一路 Tab 走到「后移」按钮上，气泡也要出得来。
  // 不能用 element.focus()——那是脚本聚焦，不满足 :focus-visible 的
  // 「用户是在用键盘」判定，量出来的 opacity 会假阴性。真按 Tab 键才算数。
  await page.mouse.move(20, 20, { steps: 4 })
  await page.evaluate(() => document.activeElement?.blur?.())
  let tabFocus = { reached: false, tabs: 0 }
  for (let tabs = 1; tabs <= 60; tabs++) {
    await page.keyboard.press('Tab')
    const hit = await page.evaluate((t) => {
      const el = document.activeElement
      if (el?.dataset?.test !== t)
        return null
      const tip = el.querySelector('.tile-tip')
      return {
        tipOpacity: getComputedStyle(tip).opacity,
        // 排序按钮此时应当已经显形（不是 opacity 0 的「隐形按钮」）
        btnOpacity: getComputedStyle(el).opacity,
        outline: getComputedStyle(el).outlineWidth,
      }
    }, `tile-right-${ID}`)
    if (hit) {
      tabFocus = { reached: true, tabs, ...hit }
      await shotZoom('zoom-tab-focus', ID)
      break
    }
  }

  report.themes[theme] = { layout, hoverState, tipCollisions, otherTile, firstLeft, editTip, awayOpacity, tabFocus }

  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(300)
}

console.log(JSON.stringify(report, null, 2))
await browser.close()
