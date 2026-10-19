import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const extensionPath = path.join(root, 'extension')
const outDir = path.join(root, 'docs')
fs.mkdirSync(outDir, { recursive: true })

const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'))
const csp = JSON.stringify(manifest.content_security_policy ?? '')
if (csp.includes('localhost'))
  throw new Error('extension/ 是开发构建（CSP 含 localhost），请先跑 node scripts/rebuild.mjs')

const browser = await chromium.launchPersistentContext('', {
  headless: true,
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
const newTabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

const VIEWPORT = { width: 1280, height: 800 }
const page = await browser.newPage({ viewport: VIEWPORT })

const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    errors.push(`console.error: ${m.text()}`)
})

async function set(key, value) {
  await page.evaluate(
    ([k, v]) => chrome.storage.local.set({ [k]: v }),
    [key, value],
  )
  const readBack = await page.evaluate(
    k => new Promise(r => chrome.storage.local.get(k, d => r(d[k]))),
    key,
  )
  if (readBack !== value)
    throw new Error(`写入 ${key} 失败：期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(readBack)}`)
}

async function openNewTab({ theme }) {
  await page.setViewportSize(VIEWPORT)
  await page.goto(newTabUrl)
  await page.waitForSelector('[data-test="search-input"]')
  if (theme) {
    await set('meridiem-theme', theme)
    await page.evaluate(() => chrome.storage.local.remove('meridiem-shortcuts'))
    await page.reload()
  }
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await page.waitForTimeout(900)
}

const saved = []
async function shot(file, options = {}) {
  const target = path.join(outDir, file)
  await page.screenshot({ path: target, ...options })
  const kb = Math.round(fs.statSync(target).size / 1024)
  saved.push(`${file} (${kb} KB)`)
  console.log(`  saved docs/${file}`)
}

async function shotSearchBox(file, { withDropdown }) {
  const shell = await page.locator('.search-shell').boundingBox()
  if (!shell)
    throw new Error('找不到 .search-shell，配图裁剪基准失效')

  const bubbles = await page.locator('.engine-bubble').evaluateAll(els =>
    els
      .filter(el => Number(getComputedStyle(el).opacity) > 0.01)
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }),
  )
  const left = Math.min(shell.x, ...bubbles.map(b => b.left))
  const top = Math.min(shell.y, ...bubbles.map(b => b.top))
  const right = Math.max(shell.x + shell.width, ...bubbles.map(b => b.right))

  const padX = 34
  const padTop = 30
  let bottom = Math.max(shell.y + shell.height, ...bubbles.map(b => b.bottom)) + 16
  if (withDropdown) {
    const menu = await page.locator('[role="listbox"]').boundingBox()
    if (!menu)
      throw new Error('下拉没展开，无法截下拉配图')
    bottom = Math.max(bottom, menu.y + menu.height + 30)
  }

  const x = Math.max(0, left - padX)
  const y = Math.max(0, top - padTop)
  await page.screenshot({
    path: path.join(outDir, file),
    clip: {
      x,
      y,
      width: Math.min(VIEWPORT.width - x, right + padX - x),
      height: Math.min(VIEWPORT.height - y, bottom - y),
    },
  })
  const kb = Math.round(fs.statSync(path.join(outDir, file)).size / 1024)
  saved.push(`${file} (${kb} KB)`)
  console.log(`  saved docs/${file}`)
}

try {
  await openNewTab({ theme: 'light' })
  await shot('newtab-preview.png')

  await page.keyboard.down('Alt')
  await page.waitForTimeout(240)
  await shot('keyboard-hints.png')
  await page.keyboard.up('Alt')
  await page.waitForTimeout(240)
  await page.reload()
  await page.waitForSelector('[data-test="search-input"]')
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await page.waitForTimeout(900)

  await shotSearchBox('search-box.png', { withDropdown: false })
  await page.keyboard.press('Tab')
  await page.waitForTimeout(340)
  await shotSearchBox('search-ring.png', { withDropdown: false })

  await page.locator('[data-test="engine-trigger"]').click()
  await page.waitForSelector('[role="listbox"]')
  await page.waitForTimeout(700)
  await shotSearchBox('search-dropdown.png', { withDropdown: true })
  await page.keyboard.press('Escape')

  await openNewTab({ theme: 'dark' })
  await shot('newtab-dark.png')
}
finally {
  await browser.close()
}

console.log('\n生成完毕：')
for (const line of saved)
  console.log(`  · ${line}`)
if (errors.length) {
  console.error('\n页面报错（配图可能不对，请先修）：')
  for (const line of errors)
    console.error(`  ! ${line}`)
  process.exitCode = 1
}
