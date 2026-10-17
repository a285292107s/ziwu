/**
 * 新标签页的「进入页面第一站 + 搜索框 Tab 出口」核对（开发用验证工具，不是测试套件）。
 *
 * 验的是：焦点从浏览器界面（地址栏）进入页面时，第一次 Tab 落在搜索框，
 * 而不是页眉的「设置」；进入后 Tab / Shift+Tab 永久切引擎、焦点留在输入框；
 * Esc 负责关列表 / 清输入 / 把焦点交回页面开头；页面其它区域仍是原生 Tab 顺序；
 * 点页面空白处失焦后（焦点停在 body 上）再按 Tab / Shift+Tab 先回到搜索框。
 *
 * ## 怎么模拟「从地址栏进来」
 * 直接 `blur()` 不行：Chrome 会把顺序焦点导航的起点留在上一次聚焦的元素上，
 * 下一次 Tab 于是从搜索框往后走（正好把 bug 遮住）。这里把 `document.body`
 * 临时变成可聚焦元素并 focus()，起点就落到**文档开头**，等价于焦点从浏览器
 * 界面进入页面。实测 `focusin` 的 `relatedTarget` 在这种进入方式下是 null，
 * 与页面内部 Tab（带上一元素）可区分 —— 产品逻辑正是靠这条判断的。
 *
 * 同一种「焦点停在 body 上」的状态也是点页面空白处失焦后的状态：这时按 Tab
 * 不该从点击位置继续走到问候语，而应先回到搜索框。
 *
 * 用法：node --no-experimental-require-module scripts/verify-first-tab.mjs
 * 退出码 1 表示有不通过的检查。
 */
/* global chrome -- sw.evaluate 的回调在扩展 service worker 里执行，chrome 是那边的全局 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const extensionPath = path.join(root, 'extension')
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

await sw.evaluate(() => chrome.storage.local.set({
  'meridiem-shortcuts': JSON.stringify([
    { id: 'v1', name: 'GitHub', url: 'https://github.com' },
    { id: 'v2', name: '知乎', url: 'https://www.zhihu.com' },
  ]),
}))

const page = await browser.newPage()
await page.setViewportSize({ width: 1440, height: 900 })
const problems = []
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    problems.push(`console.error: ${m.text()}`)
})

try {
  await page.goto(newTabUrl)
  await page.waitForSelector('[data-test="search-input"]', { timeout: 15000 })
  await sleep(800)

  const active = () => page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body)
      return 'body'
    return el.getAttribute('data-test') || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 10) || el.tagName
  })
  const engine = () => page.evaluate(() => document.querySelector('[data-test="engine-trigger"]')?.getAttribute('aria-label'))
  const step = async (key = 'Tab') => {
    await page.keyboard.press(key)
    await sleep(70)
    return active()
  }
  /** 把顺序焦点导航的起点挪到文档开头，等价于「焦点从地址栏进入页面」 */
  const enterFromOutside = async (key = 'Tab') => {
    await page.evaluate(() => {
      document.body.setAttribute('tabindex', '-1')
      document.body.focus()
      document.body.removeAttribute('tabindex')
    })
    return step(key)
  }

  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    if (!ok)
      problems.push(`${name}：${detail}`)
  }

  const onLoad = await active()
  check('打开时焦点在搜索框（autofocus）', onLoad === 'search-input', `实际=${onLoad}`)

  // 1. 第一次从页面外进入
  const firstEntry = await enterFromOutside()
  check('从浏览器界面进页面的第一次 Tab 落在搜索框', firstEntry === 'search-input', `实际=${firstEntry}`)

  // 2. 紧接着 Tab 是「永久轮换引擎」，焦点不离开搜索框
  const engineBefore = await engine()
  const afterRotate = await step()
  const engineAfter = await engine()
  check('第二次 Tab 轮换引擎、焦点留在搜索框', afterRotate === 'search-input' && engineAfter !== engineBefore, `焦点=${afterRotate} 引擎=${engineAfter}`)

  // 3. 连续 Tab 不把焦点放出去（不再有「走完一轮让位」）
  const afterMany = []
  for (let i = 0; i < 8; i++)
    afterMany.push({ active: await step(), engine: await engine() })
  check('连续 Tab 焦点始终留在搜索框', afterMany.every(s => s.active === 'search-input'), JSON.stringify(afterMany.map(s => s.active)))
  check('连续 Tab 一直在切引擎', new Set(afterMany.map(s => s.engine)).size >= 2, JSON.stringify(afterMany.map(s => s.engine)))

  // 4. Shift+Tab 也只反向切引擎，不退回页面
  const backward = []
  for (let i = 0; i < 3; i++)
    backward.push({ active: await step('Shift+Tab'), engine: await engine() })
  check('Shift+Tab 焦点留在搜索框', backward.every(s => s.active === 'search-input'), JSON.stringify(backward))
  check('Shift+Tab 反向切引擎', backward[0].engine !== backward[2].engine, JSON.stringify(backward.map(s => s.engine)))

  // 5. Esc 三级：有输入先清空，再按一次交回页面开头（设置按钮）
  await page.evaluate(() => document.querySelector('[data-test="search-input"]')?.focus())
  await page.keyboard.type('abc')
  await page.keyboard.press('Escape')
  await sleep(80)
  const cleared = await page.evaluate(() => ({
    value: document.querySelector('[data-test="search-input"]')?.value,
    active: document.activeElement?.getAttribute('data-test'),
  }))
  check('第一次 Esc 只清空输入', cleared.value === '' && cleared.active === 'search-input', JSON.stringify(cleared))
  await page.keyboard.press('Escape')
  await sleep(120)
  check('第二次 Esc 退出到页面开头（设置）', await active() === 'open-options', `实际=${await active()}`)

  // 6. 搜索框之外仍是原生 Tab 顺序：设置 → 主题
  const afterExitTab = await step()
  check('页面开头的设置之后是主题（原生 Tab）', afterExitTab === 'theme-light', `实际=${afterExitTab}`)

  // 7. 鼠标点主题按钮：焦点留在按钮上（不被重定向）
  await page.click('[data-test="theme-dark"]')
  await sleep(120)
  const afterClick = await active()
  check('鼠标点主题按钮时焦点不被拽回搜索框', afterClick === 'theme-dark', `实际=${afterClick}`)

  // 8. 焦点停在页面空白（点空白处失焦）时，Tab 先回到搜索框
  const fromBlank = await enterFromOutside()
  check('焦点不在任何控件上时 Tab 回到搜索框', fromBlank === 'search-input', `实际=${fromBlank}`)
  const blankEngineBefore = await engine()
  const afterBlankTab = await step()
  check('回到搜索框后继续 Tab 切引擎', afterBlankTab === 'search-input' && (await engine()) !== blankEngineBefore, `焦点=${afterBlankTab}`)
  const fromBlankBack = await enterFromOutside('Shift+Tab')
  check('空白处按 Shift+Tab 也回到搜索框', fromBlankBack === 'search-input', `实际=${fromBlankBack}`)

  const passed = checks.every(c => c.ok) && problems.length === 0
  console.log(JSON.stringify({ passed, checks, problems }, null, 2))
  process.exitCode = passed ? 0 : 1
}
finally {
  await browser.close()
}
