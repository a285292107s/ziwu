/**
 * 新标签页视觉评审截图（开发用，不属于测试套件）。
 *
 * 与 `scripts/shots.mjs` 的区别：这个脚本只盯新标签页，
 * 用真实的磁贴数据、真实的字体加载等待，产出可以直接肉眼审图的整屏截图。
 * 每次改完样式跑一遍，看「改完到底长什么样」，而不是靠想象。
 *
 * 用法：
 *   node --no-experimental-require-module scripts/preview.mjs <轮次目录名>
 * 产物：docs/review/<轮次>/<主题>-<视口>.png
 */
/* global chrome -- 注入页面上下文执行，本身不是 Node 全局 */
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

/**
 * 评审用的磁贴数据。刻意混入：
 * - 能拿到 favicon 的大站（GitHub / 知乎 / MDN）
 * - 拿不到 favicon 的站（走首字母回退，验证回退配色是否好看）
 * - 一个偏长的中文名（验证截断与网格对齐）
 */
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
  // favicon 取不到是这个页面预期内的分支（会回退首字母），不算问题
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

/** 等字体真正可用：字体没落地就截图，会拍到回退字形，评审结论就错了 */
async function waitForFonts() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([
      document.fonts.load('300 3rem "Space Grotesk"', '20:03'),
      document.fonts.load('500 1rem "Manrope"', 'Meridiem'),
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
    // 让入场动画走完，截到的才是终态
    await page.waitForTimeout(1100)
    const file = path.join(outDir, `${theme}-${vp.label}.png`)
    await page.screenshot({ path: file })
    console.log(`  saved ${path.relative(path.join(__dirname, '..'), file)}`)
  }
}

console.log(JSON.stringify({ round, problems }, null, 2))
await browser.close()
