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

  const shotZoom = async (name, id) => {
    const clip = await page.evaluate((tid) => {
      const cell = document.querySelector(`[data-test="shortcut-tile-${tid}"]`)
      const r = cell.getBoundingClientRect()
      return { x: Math.max(0, r.left - 30), y: Math.max(0, r.top - 46), width: r.width + 60, height: r.height + 76 }
    }, id)
    await page.screenshot({ path: path.join(outDir, `${theme}-${name}.png`), clip })
  }

  await shot('editing')

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

  const otherTile = await page.evaluate(() => {
    const btn = document.querySelector('[data-test="tile-edit-p1"]')
    const r = btn.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })

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

  await hoverAction(`tile-edit-${ID}`)
  await shotZoom('zoom-hover-edit', ID)
  const editTip = await page.evaluate((id) => {
    return getComputedStyle(document.querySelector(`[data-test="tile-edit-${id}"] .tile-tip`)).opacity
  }, ID)

  await hoverAction(`tile-delete-${ID}`)
  await shotZoom('zoom-hover-delete', ID)

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

  await page.mouse.move(20, 20, { steps: 6 })
  await page.waitForTimeout(400)
  const awayOpacity = await page.evaluate((id) => {
    return getComputedStyle(document.querySelector(`[data-test="tile-right-${id}"] .tile-tip`)).opacity
  }, ID)

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
