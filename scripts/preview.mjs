import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'preview'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const SHORTCUTS = [
  { id: 'p1', name: 'GitHub', url: 'https://github.com' },
  { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  { id: 'p3', name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 'p4', name: 'MDN', url: 'https://developer.mozilla.org' },
  { id: 'p5', name: 'Figma', url: 'https://www.figma.com' },
  { id: 'p6', name: 'Linear', url: 'https://linear.app' },
  { id: 'p7', name: '内部看板', url: 'https://meridiem-dashboard.invalid' },
  { id: 'p8', name: 'arXiv', url: 'https://arxiv.org' },
]

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'laptop', width: 1280, height: 760 },
  { label: 'mobile', width: 390, height: 844 },
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
const newTabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const problems = []
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    problems.push(`console.error: ${m.text()}`)
})
page.on('requestfailed', (r) => {
  const url = r.url()
  if (url.includes('/_favicon/'))
    return
  problems.push(`requestfailed: ${url} (${r.failure()?.errorText})`)
})

async function setStorage(key, value) {
  await page.evaluate(
    ([k, v]) => chrome.storage.local.set({ [k]: v }),
    [key, value],
  )
}

async function waitForFonts() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([
      document.fonts.load('300 3rem "Space Grotesk"', '20:03'),
      document.fonts.load('500 1rem "Manrope"', 'Ziwu'),
    ])
  })
}

await page.goto(newTabUrl)
await page.waitForSelector('[data-test="search-input"]')
await setStorage('meridiem-shortcuts', JSON.stringify(SHORTCUTS))

for (const theme of ['light', 'dark']) {
  await setStorage('meridiem-theme', theme)
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.reload()
    await page.waitForSelector('[data-test="shortcut-grid"]')
    await waitForFonts()
    await page.waitForTimeout(1100)
    const file = path.join(outDir, `${theme}-${vp.label}.png`)
    await page.screenshot({ path: file })
    console.log(`  saved ${path.relative(path.join(__dirname, '..'), file)}`)
  }
}

console.log(JSON.stringify({ round, problems }, null, 2))
await browser.close()
