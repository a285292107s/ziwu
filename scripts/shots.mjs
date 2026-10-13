/**
 * 视觉评审脚本（开发用，不属于测试套件）。
 *
 * 用 Playwright 加载构建好的 extension/，把各种状态 × 明暗主题截图到 docs/review/，
 * 便于逐轮做视觉对比。不参与构建产物。
 *
 * 用法：node --no-experimental-require-module scripts/shots.mjs [轮次标签]
 */
/* global chrome -- 注入到页面上下文里执行，本身不是 Node 全局 */
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

/** 用 storage 直接设定主题。'auto'/'light'/'dark' 都是字符串，无需 JSON 编码 */
async function setTheme(mode) {
  await page.evaluate(m => chrome.storage.local.set({ 'meridiem-theme': m }), mode)
  // 校验真的写对了：写错格式的话页面会静默忽略，截图就白做了
  const stored = await page.evaluate(() => new Promise(r =>
    chrome.storage.local.get('meridiem-theme', d => r(d['meridiem-theme'])),
  ))
  if (stored !== mode)
    throw new Error(`theme write failed: expected ${mode}, storage has ${JSON.stringify(stored)}`)
}

/**
 * 直接写 shortcuts 到 storage。
 * 注意 `useWebExtensionStorage` 对对象/数组类型会用 JSON 序列化后存储，
 * 所以这里必须写 JSON 字符串；写原生数组的话读回来会被当成脏数据。
 */
async function setShortcuts(value) {
  await page.evaluate(v => chrome.storage.local.set({ 'meridiem-shortcuts': v }), JSON.stringify(value))
}

async function shot(name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log(`  saved ${name}.png`)
}

await page.goto(newTabUrl)
await page.waitForSelector('[data-test="search-input"]')
// 让入场动画走完，截图才是终态
await page.waitForTimeout(700)

/* ---------------- 浅色 ---------------- */
await setTheme('light')
await page.reload()
await page.waitForSelector('[data-test="shortcut-grid"]')
await page.waitForTimeout(700)
await shot('light-default')

// 引擎下拉展开
await page.locator('[data-test="engine-trigger"]').click()
await page.waitForSelector('[role="option"]')
await page.waitForTimeout(300)
await shot('light-dropdown')
await page.keyboard.press('Escape')
await page.locator('body').click({ position: { x: 10, y: 10 } })

// 整理模式（显示排序/删除按钮）
await page.locator('[data-test="toggle-edit"]').click()
await page.waitForTimeout(400)
await shot('light-editing')
await page.locator('[data-test="toggle-edit"]').click()
await page.waitForTimeout(300)

// 新增对话框
await page.locator('[data-test="add-shortcut"]').click()
await page.waitForSelector('[data-test="shortcut-dialog"]')
await page.waitForTimeout(400)
await shot('light-dialog')
// 校验错误态
await page.locator('[data-test="shortcut-url-input"]').fill('not a url')
await page.locator('[data-test="dialog-save"]').click()
await page.waitForTimeout(300)
await shot('light-dialog-error')
await page.locator('[data-test="dialog-cancel"]').click()
await page.waitForTimeout(300)

// 空状态：清空所有磁贴
await setShortcuts([])
await page.reload()
await page.waitForSelector('[data-test="shortcuts-empty"]')
await page.waitForTimeout(500)
await shot('light-empty')

/* ---------------- 深色 ---------------- */
// 删掉这个键，重新加载后会写回默认站点（而不是空列表）
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

/* ---------------- 响应式 ---------------- */
await setTheme('light')
for (const [label, width, height] of [['mobile', 390, 844], ['tablet', 834, 1112], ['wide', 1920, 1080]]) {
  await page.setViewportSize({ width, height })
  await page.reload()
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await page.waitForTimeout(600)
  await shot(`light-${label}`)
}

/* ---------------- 时段氛围（伪造系统时间不便，直接断言属性） ---------------- */
await page.setViewportSize({ width: 1440, height: 900 })
await page.reload()
await page.waitForSelector('[data-test="shortcut-grid"]')
const phaseAttr = await page.locator('main').getAttribute('data-phase')
console.log(`  current ambience phase: ${phaseAttr}`)

console.log(JSON.stringify({ round, phaseAttr, errors }, null, 2))
await browser.close()
