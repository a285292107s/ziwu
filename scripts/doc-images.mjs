/**
 * 生成 README 用的文档配图（开发用，不属于测试套件）。
 *
 * 为什么单独有这个脚本：README 里的截图必须来自 **生产构建 + 真实扩展上下文**，
 * 否则很容易出现「文档配图还是脚手架时代的旧界面」——本仓库就踩过这个坑
 * （docs/newtab-preview.png 一度是开发模式的旧新标签页，连快捷方式都没有）。
 * 每次界面有可见改动，跑一遍这个脚本刷新配图即可。
 *
 * 用法：node --no-experimental-require-module scripts/doc-images.mjs
 * 前置：先 `node scripts/rebuild.mjs`（脚本会校验 extension/ 是生产构建）
 */
/* global chrome -- 注入到页面上下文里执行，本身不是 Node 全局 */
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

// 生产构建校验：开发构建的 manifest 里 CSP 会带 localhost，
// 用它当截图源会得到一份「看起来正常但其实和线上不一样」的配图。
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

/** 打开新标签页并等待入场动画结束（截到的必须是终态） */
async function openNewTab({ theme }) {
  await page.setViewportSize(VIEWPORT)
  // 必须先落到扩展页面上，`chrome.*` 才存在（about:blank 上 evaluate 会拿到 undefined）
  await page.goto(newTabUrl)
  await page.waitForSelector('[data-test="search-input"]')
  if (theme) {
    await set('meridiem-theme', theme)
    // 首次运行会写回默认站点；这里显式清掉，保证配图用默认那四个快捷方式
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

/**
 * 搜索框特写：以 .search-shell 的盒子为基准向外留白，
 * 下拉展开时把菜单的高度也算进去，否则菜单会被裁掉。
 */
async function shotSearchBox(file, { withDropdown }) {
  const shell = await page.locator('.search-shell').boundingBox()
  if (!shell)
    throw new Error('找不到 .search-shell，配图裁剪基准失效')

  const padX = 34
  const padTop = 30
  // 下留白刻意留小：留 34px 会把下面「整理」按钮的顶边切进画面（实测右下角出现一条杂边）
  let bottom = shell.y + shell.height + 16
  if (withDropdown) {
    const menu = await page.locator('[role="listbox"]').boundingBox()
    if (!menu)
      throw new Error('下拉没展开，无法截下拉配图')
    bottom = Math.max(bottom, menu.y + menu.height + 30)
  }

  const x = Math.max(0, shell.x - padX)
  const y = Math.max(0, shell.y - padTop)
  await page.screenshot({
    path: path.join(outDir, file),
    clip: {
      x,
      y,
      width: Math.min(VIEWPORT.width - x, shell.width + padX * 2),
      height: Math.min(VIEWPORT.height - y, bottom - y),
    },
  })
  const kb = Math.round(fs.statSync(path.join(outDir, file)).size / 1024)
  saved.push(`${file} (${kb} KB)`)
  console.log(`  saved docs/${file}`)
}

try {
  /* ---- 浅色：新标签页全貌 ---- */
  await openNewTab({ theme: 'light' })
  await shot('newtab-preview.png')

  /* ---- 浅色：搜索框特写 + 引擎下拉 ---- */
  await shotSearchBox('search-box.png', { withDropdown: false })
  await page.locator('[data-test="engine-trigger"]').click()
  await page.waitForSelector('[role="listbox"]')
  await page.waitForTimeout(320)
  await shotSearchBox('search-dropdown.png', { withDropdown: true })
  await page.keyboard.press('Escape')

  /* ---- 深色：新标签页全貌 ---- */
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
