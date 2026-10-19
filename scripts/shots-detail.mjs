import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'detail'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
})
let sw = browser.serviceWorkers()[0]
if (!sw)
  sw = await browser.waitForEvent('serviceworker')
const extensionId = sw.url().split('/')[2]

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
await page.goto(`chrome-extension://${extensionId}/dist/newtab/index.html`)
await page.waitForSelector('[data-test="shortcut-grid"]')
await page.waitForTimeout(800)

async function clipShot(selector, name, pad = 16) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) {
    console.log(`  !! no box for ${selector}`)
    return
  }
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1440, box.width + pad * 2),
      height: Math.min(900, box.height + pad * 2),
    },
  })
  console.log(`  saved ${name}.png  (${Math.round(box.width)}x${Math.round(box.height)} css px @2x)`)
}

const section = page.locator('section[aria-labelledby="shortcuts-heading"]')
const sbox = await section.boundingBox()
await page.screenshot({
  path: path.join(outDir, 'shortcuts-region.png'),
  clip: { x: sbox.x - 12, y: sbox.y - 12, width: sbox.width + 24, height: sbox.height + 24 },
})
console.log(`  saved shortcuts-region.png (section width ${Math.round(sbox.width)} css px)`)

await clipShot('[data-test^="shortcut-tile-"]', 'tile-closeup')

await clipShot('.search-shell', 'search-closeup')

const metrics = await page.evaluate(() => {
  const q = s => document.querySelector(s)?.getBoundingClientRect()
  const grid = q('[data-test="shortcut-grid"]')
  const shell = q('.search-shell')
  const heading = q('#shortcuts-heading')
  const editBtn = q('[data-test="toggle-edit"]')
  const addTile = q('[data-test="add-shortcut"]')
  const tiles = [...document.querySelectorAll('[data-test^="shortcut-tile-"]')].map(el => el.getBoundingClientRect())
  return {
    searchShell: { left: Math.round(shell.left), right: Math.round(shell.right), width: Math.round(shell.width) },
    grid: { left: Math.round(grid.left), right: Math.round(grid.right), width: Math.round(grid.width) },
    headingLeft: Math.round(heading.left),
    editBtnRight: Math.round(editBtn.right),
    addTileLeft: Math.round(addTile.left),
    tileLefts: tiles.map(t => Math.round(t.left)),
    tileCount: tiles.length,
  }
})
console.log('METRICS:', JSON.stringify(metrics, null, 2))

await browser.close()
