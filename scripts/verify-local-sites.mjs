import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const BACKUP_FORMAT = 'meridiem.backup'

const GENERIC = ['github.com', 'zhihu.com', 'bilibili.com', 'juejin.cn', 'developer.mozilla.org', 'wikipedia.org']

const PRIVATE_IP = /(?:^|\/\/)(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}(?::\d+)?/
const WINDOWS_USER_PATH = /[a-z]:\\Users\\[^\\\s]+/i

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridiem-backup-'))

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  acceptDownloads: true,
  downloadsPath: downloadDir,
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

async function readRaw(key) {
  const raw = await sw.evaluate(k => chrome.storage.local.get(k), key)
  return raw[key]
}

async function readJson(key) {
  const raw = await readRaw(key)
  return raw === undefined ? undefined : JSON.parse(raw)
}

async function getShortcuts() {
  return (await readJson('meridiem-shortcuts')) ?? []
}

function tileCount(p) {
  return p.evaluate(() => document.querySelectorAll('[data-test^="shortcut-tile-"]').length)
}

async function waitTiles(p) {
  await p.waitForSelector('[data-test="shortcut-grid"]', { timeout: 20000 })
  await p.waitForFunction(
    () => document.querySelectorAll('[data-test^="shortcut-tile-"]').length > 0,
    null,
    { timeout: 20000 },
  )
}

const errors = []

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

console.log('\n[2] 设置页')
const opt = await browser.newPage({ viewport: { width: 1280, height: 900 } })
opt.on('pageerror', e => errors.push(`options pageerror: ${e.message}`))
await opt.goto(optionsUrl)
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })

check('「导出备份」按钮存在', await opt.locator('[data-test="export-backup"]').count() === 1)
check('「导入备份」按钮存在', await opt.locator('[data-test="open-import"]').count() === 1)
check('iTab 时代的「粘贴配置导入」已移除', await opt.locator('[data-test="import-preset"]').count() === 0)

const optText = await opt.locator('body').textContent()
check('设置页文案声明数据只存本机', optText.includes('本机'), '')
check('设置页不再提 iTab', !/itab/i.test(optText), '')
check('设置页无内网地址 / 本机用户路径', !PRIVATE_IP.test(optText) && !WINDOWS_USER_PATH.test(optText))

console.log('\n[3] 导出备份')
const MY_SITE = { id: 'x', name: '我的内网看板', url: 'http://192.168.77.77:9000/' }
const CUSTOM_GREETING = '保持子午'

const beforeExport = await getShortcuts()
await setStorage({
  'meridiem-shortcuts': JSON.stringify([...beforeExport, MY_SITE]),
  'meridiem-greeting': CUSTOM_GREETING,
  'meridiem-search-engine': 'bing',
  'meridiem-theme': 'dark',
})
await opt.reload()
await opt.waitForSelector('[data-test="export-backup"]', { timeout: 15000 })
await opt.waitForTimeout(600)

const downloadPromise = opt.waitForEvent('download', { timeout: 15000 })
await opt.locator('[data-test="export-backup"]').click()
const download = await downloadPromise

check(
  '导出文件名是子午的命名',
  /^ziwu-backup-\d{8}-\d{4}\.json$/.test(download.suggestedFilename()),
  download.suggestedFilename(),
)

const savedPath = path.join(downloadDir, download.suggestedFilename())
await download.saveAs(savedPath)

let backup = null
try {
  backup = JSON.parse(fs.readFileSync(savedPath, 'utf8'))
}
catch (e) {
  check('导出的文件是合法 JSON', false, e.message)
}

if (backup) {
  check('导出的文件是合法 JSON', true)
  check('文件带子午格式标识', backup.format === BACKUP_FORMAT, String(backup.format))
  check('文件带版本号', backup.version === 1, String(backup.version))
  check(
    '备份包含个人站点',
    backup.shortcuts?.some(s => s.url.includes('192.168.77.77')),
    `${backup.shortcuts?.length} 条`,
  )
  check('备份包含问候语', backup.settings?.greeting === CUSTOM_GREETING, String(backup.settings?.greeting))
  check('备份包含默认引擎', backup.settings?.searchEngineKey === 'bing', String(backup.settings?.searchEngineKey))
  check('备份包含主题', backup.settings?.themeMode === 'dark', String(backup.settings?.themeMode))
  check(
    '备份里的站点不含 id（id 由接收方重新生成）',
    backup.shortcuts?.every(s => s.id === undefined),
  )
}

check(
  '导出是只读操作，storage 未被改动',
  (await getShortcuts()).length === beforeExport.length + 1,
)

console.log('\n[4] 导入备份')

await setStorage({ 'meridiem-shortcuts': JSON.stringify(beforeExport) })
await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)

async function pasteBackup(text) {
  await opt.locator('[data-test="open-import"]').click()
  await opt.locator('[data-test="import-textarea"]').fill(text)
  await opt.waitForTimeout(250)
}

await pasteBackup(JSON.stringify({ navConfig: [{ name: '主页', children: [MY_SITE] }] }))
check(
  'iTab 风格的备份被明确拒绝',
  (await opt.locator('[data-test="import-error"]').count()) === 1,
  (await opt.locator('[data-test="import-error"]').textContent().catch(() => '')).trim(),
)
check('解析失败时「导入」按钮是禁用的', await opt.locator('[data-test="import-submit"]').isDisabled())
await opt.locator('.backup-actions .ghost-control').click()
await opt.waitForTimeout(250)

await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)

const messy = JSON.stringify({
  format: BACKUP_FORMAT,
  version: 1,
  app: '子午 Ziwu',
  exportedAt: '2026-10-15T08:34:00.000Z',
  settings: { greeting: 'x', searchEngineKey: '不存在的引擎', themeMode: 'light' },
  shortcuts: [
    { name: '好站点', url: 'https://good.example.com/' },
    { name: '好站点重复', url: 'https://good.example.com/' },
    { name: '危险协议', url: 'javascript:alert(1)' },
    { name: '不是网址', url: '这不是地址' },
  ],
})

await pasteBackup(messy)
check(
  '坏站点被丢弃时给出可见提示',
  (await opt.locator('[data-test="import-warnings"]').count()) === 1,
  (await opt.locator('[data-test="import-warnings"]').textContent().catch(() => '')).replace(/\s+/g, ' ').trim(),
)

await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1000)
const messyImported = await getShortcuts()
check(
  '只导入了那一条合法站点',
  messyImported.filter(s => s.url.includes('good.example.com')).length === 1
  && !messyImported.some(s => s.url.startsWith('javascript:')),
  `共 ${messyImported.length} 条`,
)
check(
  '不在目录里的引擎名被忽略，storage 里仍是有效 key',
  ['google', 'baidu', 'bing', 'duckduckgo', 'zhihu', 'bilibili', 'github'].includes(String(await readRaw('meridiem-search-engine'))),
  String(await readRaw('meridiem-search-engine')),
)
await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)

await pasteBackup(fs.readFileSync(savedPath, 'utf8'))
check(
  '合法备份能识别出内容',
  (await opt.locator('[data-test="import-summary"]').count()) === 1,
  (await opt.locator('[data-test="import-summary"]').textContent().catch(() => '')).trim(),
)

await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1200)

const afterImport = await getShortcuts()
const imported = afterImport.find(s => s.url.includes('192.168.77.77'))
check('备份里的个人站点已写入本地 storage', !!imported, imported ? imported.name : '未找到')
check('导入的站点拿到了新的 id', !!imported && imported.id !== 'x', imported?.id ?? '—')
check(
  '通用种子被保留（合并而非覆盖）',
  afterImport.some(s => s.url.includes('github.com')),
  `共 ${afterImport.length} 条`,
)
check('问候语已恢复', (await readRaw('meridiem-greeting')) === CUSTOM_GREETING, String(await readRaw('meridiem-greeting')))
check('默认引擎已恢复', (await readRaw('meridiem-search-engine')) === 'bing', String(await readRaw('meridiem-search-engine')))
check('主题已恢复', (await readRaw('meridiem-theme')) === 'dark', String(await readRaw('meridiem-theme')))

const status = await opt.locator('[data-test="import-status"]').textContent().catch(() => '')
check('导入结果有可见反馈', status.includes('已'), status.trim())

await pasteBackup(fs.readFileSync(savedPath, 'utf8'))
await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1000)
check(
  '重复导入不会产生重复磁贴',
  (await getShortcuts()).length === afterImport.length,
  `${(await getShortcuts()).length} 条`,
)

const EXTRA_SITE = { id: 'extra', name: '备份里没有的站点', url: 'https://example.com/not-in-backup' }
const beforeReplace = [...(backup?.shortcuts ?? []).map((s, i) => ({ id: `seed-${i}`, ...s })), EXTRA_SITE]
await setStorage({ 'meridiem-shortcuts': JSON.stringify(beforeReplace) })
await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)
check(
  '覆盖前的本机磁贴已按预期铺好',
  (await getShortcuts()).length === (backup?.shortcuts?.length ?? 0) + 1,
  `${(await getShortcuts()).length} 条`,
)

await pasteBackup(fs.readFileSync(savedPath, 'utf8'))
await opt.locator('[data-test="import-mode-replace"]').check()
await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1200)

const afterReplace = await getShortcuts()
check(
  '覆盖导入后磁贴数量等于备份里的数量',
  afterReplace.length === backup?.shortcuts?.length,
  `${afterReplace.length} 条 / 备份 ${backup?.shortcuts?.length} 条`,
)
check(
  '覆盖导入真的删掉了备份里没有的站点',
  !afterReplace.some(s => s.url.includes('not-in-backup')),
)
check(
  '覆盖导入后顺序与备份一致',
  afterReplace.map(s => s.url).join('|') === backup?.shortcuts?.map(s => s.url).join('|'),
)

await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)

const noSitesBackup = JSON.stringify({
  format: BACKUP_FORMAT,
  version: 1,
  app: '子午 Ziwu',
  exportedAt: '2026-10-15T08:34:00.000Z',
  settings: { greeting: '只有设置没有站点', searchEngineKey: 'google', themeMode: 'light' },
  shortcuts: [],
})

await pasteBackup(noSitesBackup)
check(
  '只带设置的备份是合法的（解析不报错）',
  (await opt.locator('[data-test="import-error"]').count()) === 0,
)
check(
  '合并模式下不提示会删站点',
  (await opt.locator('[data-test="replace-hint"]').count()) === 0,
)

await opt.locator('[data-test="import-mode-replace"]').check()
await opt.waitForTimeout(300)
const hint = (await opt.locator('[data-test="replace-hint"]').textContent().catch(() => '')).trim()
check('覆盖零站点备份时警告会清空全部磁贴', hint.includes('全部清空'), hint)

await opt.keyboard.press('Escape')
await opt.waitForTimeout(400)

await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)
await setStorage({ 'meridiem-shortcuts': JSON.stringify([EXTRA_SITE]) })
await opt.reload()
await opt.waitForSelector('[data-test="open-import"]', { timeout: 15000 })
await opt.waitForTimeout(600)

await opt.locator('[data-test="open-import"]').click()
await opt.locator('[data-test="import-file"]').setInputFiles(savedPath)
await opt.waitForTimeout(500)

check(
  '选中的文件名会显示出来',
  (await opt.locator('.backup-filename').textContent().catch(() => '')).includes('ziwu-backup'),
  (await opt.locator('.backup-filename').textContent().catch(() => '')).trim(),
)
check(
  '选择文件后也能识别出内容',
  (await opt.locator('[data-test="import-summary"]').count()) === 1,
  (await opt.locator('[data-test="import-summary"]').textContent().catch(() => '')).trim(),
)

await opt.locator('[data-test="import-submit"]').click()
await opt.waitForTimeout(1200)

const afterFileImport = await getShortcuts()
check(
  '选择文件导入把站点写进了 storage',
  afterFileImport.some(s => s.url.includes('192.168.77.77')),
  `共 ${afterFileImport.length} 条`,
)

console.log('\n[5] 已有磁贴的实例重开新标签页')
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

check('全程无页面报错', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log('\n================ 汇总 ================')
const failed = results.filter(r => !r.ok)
console.log(`通过 ${results.length - failed.length}/${results.length}`)
if (failed.length)
  failed.forEach(f => console.log(`  FAILED: ${f.name} ${f.detail}`))

await browser.close()
fs.rmSync(downloadDir, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
