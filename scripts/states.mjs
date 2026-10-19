import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'states'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const SHORTCUTS = [
  { id: 'p1', name: 'GitHub', url: 'https://github.com' },
  { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  { id: 'p3', name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 'p4', name: 'MDN', url: 'https://developer.mozilla.org' },
  { id: 'p5', name: 'Figma', url: 'https://www.figma.com' },
  { id: 'p6', name: '内部看板', url: 'https://meridiem-dashboard.invalid' },
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

const shot = async name => page.screenshot({ path: path.join(outDir, `${name}.png`) })

async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.waitForTimeout(1200)
}

async function set(key, value) {
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k]: v }), [key, value])
}

await page.goto(url)
await page.waitForSelector('[data-test="search-input"]')
await set('meridiem-shortcuts', JSON.stringify(SHORTCUTS))

for (const theme of ['light', 'dark']) {
  await set('meridiem-theme', theme)

  await page.reload()
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await settle()
  await shot(`${theme}-default`)
  await page.locator('[data-test="shortcut-tile-p1"] a').hover()
  await page.waitForTimeout(600)
  await shot(`${theme}-hover-tile`)

  await page.locator('[data-test="engine-trigger"]').click()
  await page.waitForSelector('[role="option"]')
  await page.waitForTimeout(400)
  await shot(`${theme}-dropdown`)
  await page.keyboard.press('Escape')
  await page.locator('.masthead').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(300)

  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(600)
  await shot(`${theme}-editing`)
  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(400)

  await page.locator('[data-test="add-shortcut"]').click()
  await page.waitForSelector('[data-test="shortcut-dialog"]')
  await page.waitForTimeout(500)
  await shot(`${theme}-dialog`)
  await page.locator('[data-test="shortcut-url-input"]').fill('not a url')
  await page.locator('[data-test="dialog-save"]').click()
  await page.waitForTimeout(400)
  await shot(`${theme}-dialog-error`)
  await page.locator('[data-test="dialog-cancel"]').click()
  await page.waitForTimeout(400)

  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-test^="tile-delete-"]').first().click()
  await page.waitForTimeout(600)
  await shot(`${theme}-undo-toast`)
  await page.locator('[data-test="undo-remove"]').click()
  await page.waitForTimeout(400)
  await page.locator('[data-test="toggle-edit"]').click()
  await page.waitForTimeout(300)

  await set('meridiem-shortcuts', '[]')
  await page.reload()
  await page.waitForSelector('[data-test="shortcuts-empty"]')
  await settle()
  await shot(`${theme}-empty`)
  await set('meridiem-shortcuts', JSON.stringify(SHORTCUTS))
}

console.log(JSON.stringify({ round, problems }, null, 2))
await browser.close()
