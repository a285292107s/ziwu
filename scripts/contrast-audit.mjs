import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const surfaces = [
  {
    name: 'newtab',
    ready: '[data-test="search-input"]',
    targets: [
      ['时钟', '[data-test="clock"]', 'large'],
      ['秒', '.clock__seconds', 'large'],
      ['日期', '[data-test="clock-date"]', 'normal'],
      ['问候语', '[data-test="greeting"]', 'large'],
      ['「快捷方式」标题', '#shortcuts-heading', 'normal'],
      ['磁贴名称', '[data-test^="shortcut-tile-"] > span', 'normal'],
      ['搜索占位符', '[data-test="search-input"]', 'normal'],
      ['「整理」按钮', '[data-test="toggle-edit"]', 'normal'],
      ['角落「设置」按钮', '[data-test="open-options"]', 'normal'],
      ['品牌标记', '.brand__word', 'normal'],
      ['主题开关', '.theme-switch__btn', 'normal'],
    ],
  },
  {
    name: 'options',
    ready: '[data-test="engine-option-google"]',
    targets: [
      ['页面标题', '.settings-title', 'large'],
      ['页面说明', '.settings-lede', 'normal'],
      ['分组标题', '.settings-card__title', 'normal'],
      ['分组说明', '.settings-card__desc', 'normal'],
      ['行标签', '.settings-row__label', 'normal'],
      ['行提示', '.settings-row__hint', 'normal'],
      ['主题按钮', '[data-test="options-theme-toggle"]', 'normal'],
      ['引擎名称', '.engine-card__label', 'normal'],
      ['输入框文字', '[data-test="options-greeting"]', 'normal'],
    ],
  },
  {
    name: 'popup',
    ready: '[data-test="popup-open-options"]',
    targets: [
      ['标题', '.popup__title', 'normal'],
      ['副标题', '.popup__sub', 'normal'],
      ['主按钮', '[data-test="popup-open-options"]', 'normal'],
    ],
  },
  {
    name: 'newtab-empty',
    url: 'newtab',
    ready: '[data-test="empty-add"]',
    prepare: async (page) => {
      await page.evaluate(() => new Promise(r =>
        chrome.storage.local.set({ 'meridiem-shortcuts': '[]' }, r),
      ))
      await page.reload()
    },
    targets: [
      ['空状态「添加」按钮', '[data-test="empty-add"]', 'normal'],
      ['空状态标题', '.empty-title', 'normal'],
      ['空状态说明', '.empty-hint', 'normal'],
    ],
  },
  {
    name: 'newtab-dialog',
    url: 'newtab',
    ready: '[data-test="shortcut-dialog"]',
    prepare: async (page) => {
      await page.evaluate(() => new Promise(r => chrome.storage.local.remove('meridiem-shortcuts', r)))
      await page.reload()
      await page.waitForSelector('[data-test="add-shortcut"]')
      await page.locator('[data-test="add-shortcut"]').click()
    },
    targets: [
      ['对话框标题', '#shortcut-dialog-title', 'normal'],
      ['对话框字段标签', '.field__label', 'normal'],
      ['对话框提示', '#shortcut-url-help', 'normal'],
      ['「保存」按钮', '[data-test="dialog-save"]', 'normal'],
      ['「取消」按钮', '[data-test="dialog-cancel"]', 'normal'],
    ],
  },
  {
    name: 'newtab-hints',
    url: 'newtab',
    ready: '.key-hint',
    prepare: async (page) => {
      await page.keyboard.down('Alt')
      await page.waitForTimeout(300)
    },
    targets: [
      ['提示键帽', '.key-hint .kbd', 'normal'],
      ['提示文字', '.key-hint__label', 'normal'],
      ['提示方向键说明', '.key-hint__detail', 'normal'],
    ],
  },
]

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
})
let sw = browser.serviceWorkers()[0]
for (let i = 0; i < 40 && !sw; i++) {
  await new Promise(r => setTimeout(r, 250))
  sw = browser.serviceWorkers()[0]
}
if (!sw) {
  console.error('service worker 没启动：extension/ 可能不是有效的生产构建')
  await browser.close()
  process.exit(1)
}
const extensionId = sw.url().split('/')[2]

async function measure(page, surface, theme) {
  return page.evaluate(async ({ mode, targets }) => {
    await new Promise(r => chrome.storage.local.set({ 'meridiem-theme': mode }, r))

    await Promise.race([
      Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))),
      new Promise(r => setTimeout(r, 1500)),
    ])
    await new Promise(r => setTimeout(r, 200))

    const parse = (col) => {
      const m = col.match(/rgba?\(([^)]+)\)/)
      if (!m)
        return null
      const parts = m[1].split(',').map(s => Number.parseFloat(s.trim()))
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }

    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    })

    const backgroundCandidates = (el) => {
      const stops = []
      let node = el
      while (node) {
        const cs = getComputedStyle(node)
        const bg = parse(cs.backgroundColor)
        if (bg && bg.a > 0)
          stops.push(bg)
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          const found = cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []
          for (const f of found) {
            const c = parse(f)
            if (c)
              stops.push(c)
          }
        }
        if (bg && bg.a === 1)
          break
        node = node.parentElement
      }

      const base = { r: 255, g: 255, b: 255, a: 1 }
      const out = []
      for (let i = 0; i < stops.length; i++) {
        let acc = base
        for (let j = stops.length - 1; j > i; j--)
          acc = over(stops[j], acc)
        out.push(over(stops[i], acc))
      }
      if (out.length === 0)
        out.push(base)
      return out
    }

    const lum = (c) => {
      const f = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }

    const ratio = (a, b) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (l1 + 0.05) / (l2 + 0.05)
    }

    const cumulativeOpacity = (el) => {
      let o = 1
      let node = el
      while (node && node !== document.documentElement) {
        const v = Number.parseFloat(getComputedStyle(node).opacity)
        if (!Number.isNaN(v))
          o *= v
        node = node.parentElement
      }
      return o
    }

    return targets.map(([label, selector, kind]) => {
      const el = document.querySelector(selector)
      if (!el)
        return { label, selector, error: 'element missing' }

      const fgRaw = parse(getComputedStyle(el).color)
      if (!fgRaw)
        return { label, selector, error: 'unparsable color' }

      const opacity = cumulativeOpacity(el)
      const fg = { ...fgRaw, a: fgRaw.a * opacity }

      const candidates = backgroundCandidates(el)
      let worst = null
      for (const bg of candidates) {
        const composed = fg.a < 1 ? over(fg, bg) : fg
        const r = ratio(composed, bg)
        if (!worst || r < worst.ratio)
          worst = { ratio: r, bg }
      }

      const min = kind === 'large' ? 3 : 4.5
      const bgCss = `rgb(${Math.round(worst.bg.r)}, ${Math.round(worst.bg.g)}, ${Math.round(worst.bg.b)})`
      return {
        label,
        selector,
        kind,
        color: getComputedStyle(el).color,
        opacity: Number(opacity.toFixed(2)),
        bg: bgCss,
        ratio: Number(worst.ratio.toFixed(2)),
        required: min,
        pass: worst.ratio >= min,
      }
    })
  }, { mode: theme, targets: surface.targets })
}

let totalFails = 0
let totalMissing = 0
const pageErrors = []

for (const surface of surfaces) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', e => pageErrors.push(`[${surface.name}] ${e.message}`))
  await page.goto(`chrome-extension://${extensionId}/dist/${surface.url ?? surface.name}/index.html`)
  if (surface.prepare)
    await surface.prepare(page)
  await page.waitForSelector(surface.ready, { timeout: 15000 })

  for (const theme of ['light', 'dark']) {
    console.log(`\n=== ${surface.name.toUpperCase()} / ${theme.toUpperCase()} ===`)
    const rows = await measure(page, surface, theme)
    let fails = 0
    for (const r of rows) {
      if (r.error) {
        console.log(`  ?? ${r.label.padEnd(16)} ${r.error}  (${r.selector})`)
        totalMissing++
        continue
      }
      if (!r.pass)
        fails++
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(16)} ratio=${String(r.ratio).padStart(6)} (need ${r.required})  fg=${r.color} bg=${r.bg}`)
    }
    totalFails += fails
    console.log(`  --> ${fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`}`)
  }

  await page.close()
}

console.log(`\n总计：${totalFails} 处对比度不达标，${totalMissing} 个选择器查不到元素`)
if (totalMissing)
  console.log('（选择器查不到元素说明页面结构变了、审计已经失效，必须修好，不要当成通过。）')

if (pageErrors.length)
  console.log('\nPAGE ERRORS:', pageErrors)

await browser.close()
process.exit(totalFails > 0 || totalMissing > 0 ? 1 : 0)
