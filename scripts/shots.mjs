import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'r1'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

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

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    errors.push(`console.error: ${m.text()}`)
})

async function setTheme(mode) {
  await page.evaluate(m => chrome.storage.local.set({ 'meridiem-theme': m }), mode)
  const stored = await page.evaluate(() => new Promise(r =>
    chrome.storage.local.get('meridiem-theme', d => r(d['meridiem-theme'])),
  ))
  if (stored !== mode)
    throw new Error(`theme write failed: expected ${mode}, storage has ${JSON.stringify(stored)}`)
}

async function setShortcuts(value) {
  await page.evaluate(v => chrome.storage.local.set({ 'meridiem-shortcuts': v }), JSON.stringify(value))
}

async function shot(name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log(`  saved ${name}.png`)
}

await page.goto(newTabUrl)
await page.waitForSelector('[data-test="search-input"]')
await page.waitForTimeout(700)

await setTheme('light')
await page.reload()
await page.waitForSelector('[data-test="shortcut-grid"]')
await page.waitForTimeout(700)
await shot('light-default')

await page.locator('[data-test="engine-trigger"]').click()
await page.waitForSelector('[role="option"]')
await page.waitForTimeout(300)
await shot('light-dropdown')
await page.keyboard.press('Escape')
await page.locator('body').click({ position: { x: 10, y: 10 } })

await page.locator('[data-test="toggle-edit"]').click()
await page.waitForTimeout(400)
await shot('light-editing')
await page.locator('[data-test="toggle-edit"]').click()
await page.waitForTimeout(300)

await page.locator('[data-test="add-shortcut"]').click()
await page.waitForSelector('[data-test="shortcut-dialog"]')
await page.waitForTimeout(400)
await shot('light-dialog')
await page.locator('[data-test="shortcut-url-input"]').fill('not a url')
await page.locator('[data-test="dialog-save"]').click()
await page.waitForTimeout(300)
await shot('light-dialog-error')
await page.locator('[data-test="dialog-cancel"]').click()
await page.waitForTimeout(300)

await setShortcuts([])
await page.reload()
await page.waitForSelector('[data-test="shortcuts-empty"]')
await page.waitForTimeout(500)
await shot('light-empty')

await page.evaluate(() => chrome.storage.local.remove('meridiem-shortcuts'))
await setTheme('dark')
await page.reload()
await page.waitForSelector('[data-test="shortcut-grid"]')
await page.waitForTimeout(700)
await shot('dark-default')

await page.locator('[data-test="engine-trigger"]').click()
await page.waitForSelector('[role="option"]')
await page.waitForTimeout(300)
await shot('dark-dropdown')
await page.keyboard.press('Escape')
await page.locator('body').click({ position: { x: 10, y: 10 } })

await page.locator('[data-test="toggle-edit"]').click()
await page.waitForTimeout(400)
await shot('dark-editing')
await page.locator('[data-test="toggle-edit"]').click()

await page.locator('[data-test="add-shortcut"]').click()
await page.waitForSelector('[data-test="shortcut-dialog"]')
await page.waitForTimeout(400)
await shot('dark-dialog')
await page.locator('[data-test="dialog-cancel"]').click()

await setTheme('light')
for (const [label, width, height] of [['mobile', 390, 844], ['tablet', 834, 1112], ['wide', 1920, 1080]]) {
  await page.setViewportSize({ width, height })
  await page.reload()
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await page.waitForTimeout(600)
  await shot(`light-${label}`)
}

await page.setViewportSize({ width: 1440, height: 900 })
await page.reload()
await page.waitForSelector('[data-test="shortcut-grid"]')
const phaseAttr = await page.locator('main').getAttribute('data-phase')
console.log(`  current ambience phase: ${phaseAttr}`)

console.log(JSON.stringify({ round, phaseAttr, errors }, null, 2))
await browser.close()
