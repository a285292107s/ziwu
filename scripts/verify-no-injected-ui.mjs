import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')
const round = process.argv[2] ?? 'no-injected-ui'
const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

const PLAIN_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>plain page</title></head>
<body><h1>plain page</h1><p>这里不该出现任何扩展注入的 UI</p></body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PLAIN_HTML)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const plainUrl = `http://127.0.0.1:${server.address().port}/`

const report = {
  round,
  plainUrl,
  manifest: null,
  injectedOnPlainPage: null,
  negativeControl: null,
  backgroundErrors: [],
  newtab: null,
  problems: [],
}

function detectFn() {
  const hits = []
  if (document.querySelector('#meridiem'))
    hits.push('container #meridiem')
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot)
      hits.push(`shadowRoot on <${el.tagName.toLowerCase()}>`)
  }
  for (const el of document.querySelectorAll('script[src],link[href],img[src]')) {
    const u = el.getAttribute('src') || el.getAttribute('href') || ''
    if (u.startsWith('chrome-extension://'))
      hits.push(`${el.tagName.toLowerCase()} -> ${u}`)
  }
  const text = document.body ? document.body.textContent : ''
  if (text.includes('子午 Ziwu') || text.includes('This is the'))
    hits.push('scaffolding text in body')
  return {
    hits,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    tags: document.body ? [...document.body.children].map(c => c.tagName.toLowerCase()) : [],
  }
}

const context = await chromium.launchPersistentContext('', {
  headless: true,
  deviceScaleFactor: 2,
  args: [
    '--headless=new',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

let sw = context.serviceWorkers()[0]
if (!sw)
  sw = await context.waitForEvent('serviceworker')
const extensionId = sw.url().split('/')[2]

try {
  await sw.evaluate(() => {
    globalThis.__errs = []
    globalThis.addEventListener('error', e => globalThis.__errs.push(String(e.message || e)))
    globalThis.addEventListener('unhandledrejection', e => globalThis.__errs.push(`unhandledrejection: ${String(e.reason)}`))
  })
}
catch (e) {
  report.backgroundErrors.push(`sw.evaluate failed: ${e.message}`)
}

try {
  const m = await sw.evaluate(() => JSON.parse(JSON.stringify(chrome.runtime.getManifest())))
  report.manifest = {
    content_scripts: m.content_scripts ?? null,
    web_accessible_resources: m.web_accessible_resources ?? null,
    permissions: m.permissions,
    host_permissions: m.host_permissions,
  }
}
catch (e) {
  report.problems.push(`getManifest failed: ${e.message}`)
}

const page = await context.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', e => report.problems.push(`plain pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    report.problems.push(`plain console.error: ${m.text()}`)
})

await page.goto(plainUrl, { waitUntil: 'load' })
await page.waitForTimeout(1200)
report.injectedOnPlainPage = await page.evaluate(detectFn)
await page.screenshot({ path: path.join(outDir, 'plain-page.png') })

await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.id = 'meridiem'
  const inner = document.createElement('span')
  inner.textContent = '子午 Ziwu'
  probe.append(inner)
  document.body.append(probe)
})
const withProbe = await page.evaluate(detectFn)
await page.evaluate(() => document.querySelector('#meridiem')?.remove())
const afterRemoval = await page.evaluate(detectFn)
report.negativeControl = { foundHits: withProbe.hits, afterRemovalHits: afterRemoval.hits }

const other = await context.newPage()
await other.goto(plainUrl, { waitUntil: 'load' })
await page.bringToFront()
await other.bringToFront()
await page.bringToFront()
await page.waitForTimeout(900)
try {
  const errs = await sw.evaluate(() => globalThis.__errs ?? [])
  report.backgroundErrors.push(...errs)
}
catch (e) {
  report.backgroundErrors.push(`sw error read failed: ${e.message}`)
}
await other.close()

const newtab = await context.newPage({ viewport: { width: 1440, height: 900 } })
newtab.on('pageerror', e => report.problems.push(`newtab pageerror: ${e.message}`))
newtab.on('console', (m) => {
  if (m.type() === 'error')
    report.problems.push(`newtab console.error: ${m.text()}`)
})
const newtabProblemsBefore = report.problems.length
await newtab.goto(`chrome-extension://${extensionId}/dist/newtab/index.html`)
await newtab.waitForSelector('[data-test="search-input"]', { timeout: 15000 })
await newtab.evaluate(() => chrome.storage.local.set({
  'meridiem-shortcuts': JSON.stringify([
    { id: 'p1', name: 'GitHub', url: 'https://github.com' },
    { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  ]),
  'meridiem-theme': 'light',
}))
await newtab.reload()
await newtab.waitForSelector('[data-test="shortcut-grid"]', { timeout: 15000 })
await newtab.evaluate(async () => document.fonts.ready)
await newtab.waitForTimeout(800)
report.newtab = await newtab.evaluate(() => ({
  title: document.title,
  hasSearch: !!document.querySelector('[data-test="search-input"]'),
  tileCount: document.querySelectorAll('[data-test="shortcut-grid"] > *').length,
  bodyChildren: document.body.childElementCount,
}))
await newtab.screenshot({ path: path.join(outDir, 'newtab.png') })

report.newtabProblems = report.problems.slice(newtabProblemsBefore)

await context.close()
server.close()

const ok = report.manifest?.content_scripts === null
  && report.manifest?.web_accessible_resources === null
  && report.injectedOnPlainPage.hits.length === 0
  && report.negativeControl.foundHits.length > 0
  && report.negativeControl.afterRemovalHits.length === 0
  && report.backgroundErrors.length === 0
  && report.problems.length === 0
  && report.newtab?.hasSearch === true

report.ok = ok
console.log(JSON.stringify(report, null, 2))
process.exit(ok ? 0 : 1)
