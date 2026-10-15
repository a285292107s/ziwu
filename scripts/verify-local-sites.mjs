/**
 * 开发用核对脚本（不属于测试套件）：确认「个人站点只存本地」这条改造真的成立。
 *
 * 用法：node --no-experimental-require-module scripts/verify-local-sites.mjs
 *
 * 跑 4 件事，全部用真实浏览器 + 真实扩展：
 *   1. 全新实例（storage 为空）→ 首屏只出现通用种子，且里面没有任何个人站点；
 *   2. 设置页不再有「导入 iTab 站点」按钮，但「粘贴配置导入」还在；
 *   3. 粘贴一份带个人站点的 iTab 备份 → 磁贴真的落进 storage（数据存本机这条路是通的）；
 *   4. 已有磁贴的实例重开新标签页 → 原有磁贴不被覆盖、也不被补种（不破坏老数据）。
 */
/* global chrome */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

/**
 * 「通用种子」应当覆盖的域名（与 `src/logic/defaultSites.ts` 一致）。
 * 断言方式是「种子里每一条都必须落在这个白名单内」，而不是去比对一份
 * 个人站点黑名单 —— 黑名单本身就得把那些隐私字符串再抄进仓库一遍，
 * 那就等于换个地方泄露，反而违背这次改造的目的。
 */
const GENERIC = ['github.com', 'zhihu.com', 'bilibili.com', 'juejin.cn', 'developer.mozilla.org', 'wikipedia.org']

/**
 * 隐私红线：**只放形状，不放原文**。
 *
 * 这里检查的是「有没有不该出现的类型」——RFC1918 内网地址、文件路径里的用户名、
 * 以及带账号参数的深层后台链接，而不是具体某个 IP 或账号。
 * 用模式和结构判断，脚本就不必携带任何真实隐私值。
 */
const PRIVATE_IP = /(?:^|\/\/)(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}(?::\d+)?/
const WINDOWS_USER_PATH = /[a-z]:\\Users\\[^\\\s]+/i

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

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
const newtabUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`
const optionsUrl = `chrome-extension://${extensionId}/dist/options/index.html`

function setStorage(obj) {
  return sw.evaluate(v => chrome.storage.local.set(v), obj)
}

async function getShortcuts() {
  const raw = await sw.evaluate(() => chrome.storage.local.get('meridiem-shortcuts'))
  const v = raw['meridiem-shortcuts']
  return v ? JSON.parse(v) : []
}

/** 磁贴的 data-test 是 `shortcut-tile-<id>`，按前缀数个数 */
function tileCount(p) {
  return p.evaluate(() => document.querySelectorAll('[data-test^="shortcut-tile-"]').length)
}

/** 等首屏磁贴渲染出来（种子需要从 storage 读一遍再写回，给足时间） */
async function waitTiles(p) {
  await p.waitForSelector('[data-test="shortcut-grid"]', { timeout: 20000 })
  await p.waitForFunction(
    () => document.querySelectorAll('[data-test^="shortcut-tile-"]').length > 0,
    null,
    { timeout: 20000 },
  )
}

const errors = []

/* ---------------- 1. 全新实例：首屏只出现通用种子 ---------------- */
console.log('\n[1] 全新实例（storage 为空）')
await sw.evaluate(() => chrome.storage.local.clear())

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => errors.push(`newtab pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    errors.push(`newtab console.error: ${m.text()}`)
})

await page.goto(newtabUrl)
await waitTiles(page)
await page.waitForTimeout(1200)

const seeded = await getShortcuts()
check('首屏写入了种子磁贴', seeded.length > 0, `${seeded.length} 个`)
check('首屏真的渲染出磁贴', await tileCount(page) > 0, `${await tileCount(page)} 个`)
check(
  '种子全部来自通用清单',
  seeded.every(s => GENERIC.some(d => s.url.includes(d))),
  seeded.map(s => s.name).join(' / '),
)
check(
  '种子中没有内网地址 / 本机用户路径',
  !seeded.some(s => PRIVATE_IP.test(s.url) || WINDOWS_USER_PATH.test(s.url)),
)

const pageHtml = await page.content()
check('新标签页 DOM 中无内网地址 / 本机用户路径', !PRIVATE_IP.test(pageHtml) && !WINDOWS_USER_PATH.test(pageHtml))

/* ---------------- 2. 设置页：按钮已移除，粘贴导入还在 ---------------- */
console.log('\n[2] 设置页')
const opt = await browser.newPage({ viewport: { width: 1280, height: 900 } })
opt.on('pageerror', e => errors.push(`options pageerror: ${e.message}`))
await opt.goto(optionsUrl)
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })

check('「粘贴配置导入」按钮存在', await opt.locator('[data-test="open-import"]').count() === 1)
check('「导入 iTab 站点」按钮已移除', await opt.locator('[data-test="import-preset"]').count() === 0)

const optText = await opt.locator('body').textContent()
check('设置页文案声明数据只存本机', optText.includes('本机'), '')
check('设置页无内网地址 / 本机用户路径', !PRIVATE_IP.test(optText) && !WINDOWS_USER_PATH.test(optText))

/* ---------------- 3. 粘贴导入：个人站点能写进本机 storage ---------------- */
console.log('\n[3] 粘贴导入个人站点')
/** 造一条「像个人站点」的数据：内网地址 + 中文名，用来验证本机存储这条路真的通 */
const MY_SITE = { id: 'x', name: '我的内网看板', url: 'http://192.168.77.77:9000/' }
const backup = JSON.stringify({
  navConfig: [{ name: '主页', children: [MY_SITE] }],
})

await opt.locator('[data-test="open-import"]').click()
await opt.locator('[data-test="import-textarea"]').fill(backup)
await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1200)

const afterImport = await getShortcuts()
const imported = afterImport.find(s => s.url.includes('192.168.77.77'))
check('粘贴的个人站点已写入本地 storage', !!imported, imported ? imported.name : '未找到')
check(
  '通用种子被保留（合并而非覆盖）',
  afterImport.some(s => s.url.includes('github.com')),
  `共 ${afterImport.length} 条`,
)
const status = await opt.locator('[data-test="import-status"]').textContent().catch(() => '')
check('导入结果有可见反馈', status.includes('已添加'), status.trim())

/* ---------------- 4. 已有磁贴的实例不被覆盖 ---------------- */
console.log('\n[4] 已有磁贴的实例重开新标签页')
await setStorage({ 'meridiem-shortcuts': JSON.stringify([MY_SITE]) })

const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page2.on('pageerror', e => errors.push(`newtab2 pageerror: ${e.message}`))
await page2.goto(newtabUrl)
await waitTiles(page2)
await page2.waitForTimeout(1500)

const afterReopen = await getShortcuts()
check(
  '原有磁贴不被覆盖',
  afterReopen.length === 1 && afterReopen[0].url.includes('192.168.77.77'),
  afterReopen.map(s => s.name).join(' / '),
)
check('不再补种预置站点（删掉的不会复活）', afterReopen.length === 1, `${afterReopen.length} 条`)

/* ---------------- 汇总 ---------------- */
check('全程无页面报错', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log('\n================ 汇总 ================')
const failed = results.filter(r => !r.ok)
console.log(`通过 ${results.length - failed.length}/${results.length}`)
if (failed.length)
  failed.forEach(f => console.log(`  FAILED: ${f.name} ${f.detail}`))

await browser.close()
process.exit(failed.length ? 1 : 0)
