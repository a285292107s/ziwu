/**
 * 天光背景的视觉评审脚本（开发用，不属于测试套件）。
 *
 * 把「一天」拍下来：同一个页面在若干时刻 × 两套主题下的样子，全部落到 docs/review/<轮次>/。
 * 天空是跟真实时间走的，所以评审必须能钉住时刻 —— 用 `?sky=` 覆盖（见 sky.ts）。
 *
 * 两个时间点集按北纬 35°（中国大部）算，用的是真实的日出日落：
 *   夏至 2026-06-21：日出 04:48、日落 19:27、太阳正午高度 78.5°
 *   冬至 2026-12-21：日出 07:11、日落 16:49、太阳正午高度 31.6°
 * 选点刻意压在太阳高度 ±10° 附近 —— 天光最好看、也最难画的那一段。
 *
 * 用法：
 *   node --no-experimental-require-module scripts/sky-shots.mjs <轮次>
 *   node --no-experimental-require-module scripts/sky-shots.mjs r01 --season=winter --themes=dark
 *   node --no-experimental-require-module scripts/sky-shots.mjs r01 --only=12,19.6
 */
/* global chrome -- 注入到页面上下文里执行，本身不是 Node 全局 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', 'extension')

const args = process.argv.slice(2)
const round = args.find(a => !a.startsWith('--')) ?? 'sky01'
function flag(name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const outDir = path.join(__dirname, '..', 'docs', 'review', round)
fs.mkdirSync(outDir, { recursive: true })

/** [标签, 时刻, 这一时刻的看点] */
const SUMMER = [
  ['0450-first-light', '2026-06-21T04:48', '太阳在 0° 上下，地平线只剩一条冷光'],
  ['0560-low-sun', '2026-06-21T05:36', '太阳 8.6°，低角度暖光斜射'],
  ['1200-noon', '2026-06-21T12:00', '太阳 78.5°，正午高白'],
  ['1900-sunset', '2026-06-21T19:00', '太阳 1.9°，日落临界'],
  ['1936-blue-hour', '2026-06-21T19:36', '太阳 -3.4°，蓝调时刻'],
  ['2020-civil-dusk', '2026-06-21T20:18', '太阳 -10.4°，暮光将尽'],
  ['2200-night', '2026-06-21T22:00', '太阳 -25°，只剩气辉与星野'],
]

const WINTER = [
  ['0730-sunrise', '2026-12-21T07:18', '太阳 1.3°，冬季低日照'],
  /* 名字里必须带 -winter：--season=all 是 SUMMER 接 WINTER 顺序跑的，
     两边都叫 1200-noon 的话，冬季那张会把夏季那张盖掉 ——
     20 个文件看着齐全，实际上夏季正午已经没了。 */
  ['1200-noon-winter', '2026-12-21T12:00', '太阳 31.6°，全年最低的正午'],
  ['1654-sunset', '2026-12-21T16:54', '太阳 -0.8°，日落'],
  ['1740-dusk', '2026-12-21T17:36', '太阳 -7.5°，冬季蓝调'],
]

const season = flag('season', 'summer')
const times = season === 'winter' ? WINTER : season === 'all' ? [...SUMMER, ...WINTER] : SUMMER
const themes = flag('themes', 'light,dark').split(',')
const only = flag('only', '')
const [vw, vh] = flag('view', '1440x900').split('x').map(Number)

const picked = only
  ? times.filter(([label]) => only.split(',').some(o => label.includes(o)))
  : times
if (!picked.length)
  throw new Error(`--only=${only} 没匹配到任何时刻`)

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  // viewport / deviceScaleFactor 只有在这里给才生效（newPage() 会忽略它们）
  viewport: { width: vw, height: vh },
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
const baseUrl = `chrome-extension://${extensionId}/dist/newtab/index.html`

const page = await browser.newPage()

const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error')
    errors.push(`console.error: ${m.text()}`)
})

async function setTheme(mode) {
  await page.evaluate(m => chrome.storage.local.set({ 'meridiem-theme': m }), mode)
}

/**
 * 等 WebGL 真的画出来了，再等画面进入**稳态**。
 *
 * 这里以前是「painted 之后固定等 2200ms」，那个等待量级是错的。
 * headless SwiftShader 上第一帧要 ~8 秒编译着色器，之后自适应分辨率
 * 才从 renderScale(0.34) 往像素预算上限(1440x900 → 0.4355)爬，爬满要几十秒。
 * 而画面**不是尺度无关的**：同一时刻同一 gain，
 *   scale 0.340 → 整幅中位数 0.508、正文带 p90 0.843
 *   scale 0.4355 → 整幅中位数 0.383、正文带 p90 0.735
 * 因为**着色器里有按屏幕分辨率走的高频淡出**，低分辨率下波纹被砍掉，
 * Snell 窗退化成一块过曝白色平台、边缘发硬 —— 看着像「冰扇」。
 * （旧版是 waterGrad 里手写的「每波长几个采样」淡出；换成 FFT 波场之后
 * 这件事交给 mipmap 了，但**结论不变**：低分辨率下高频本来就少，画面不是尺度无关的。）
 * 之前几轮追着这个「缺陷」改 MIRROR_GLINT / 太阳圆盘 / 月亮圆盘都没用，
 * 就是因为成因根本不在着色器里，而在**拍早了**。
 *
 * 判据：scale 连续 3 次采样不变 = 自适应分辨率收敛。不写死毫秒，
 * 这样慢机器（一直 hold 在低档）也能正确结束，只是画面确实会软一些。
 * 需要 ?skydebug=1 才有 window.__sky。
 */
async function waitForSky() {
  await page.waitForFunction(
    () => !!document.querySelector('canvas[class*="sky__canvas"]'),
    null,
    { timeout: 5000 },
  )
  const painted = await page
    .waitForFunction(
      () => document.querySelector('canvas[class*="sky__canvas"]')?.classList.contains('is-painted'),
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)

  /* 稳态判据：scale 连续 3 次采样不变。
   *
   * **为什么在 Node 侧轮询、不用 waitForFunction({ polling })**：扩展页的 CSP 是
   * `script-src 'self'`，页面里没有 eval。Playwright 把谓词投进页面时可能走 eval，
   * 被 CSP 拦下就抛 EvalError —— 而外面套了 `.catch(() => false)`，于是它**静默地**
   * 永远返回 false，每一帧都被判成「没稳」。实测过：`--only=1200 --themes=light`
   * 跑出来 settled:false 而 adapt 是 "up"，分辨率还在往上爬，说明判据根本没在跑。
   * 换成 Node 侧 page.evaluate 轮询：既不碰 eval，也能把「为什么没稳」报出来。 */
  const deadline = Date.now() + 180000
  const hist = []
  let last = null
  let settled = false
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const q = window.__sky?.probe
      if (!q || !q.perf)
        return null
      return { scale: q.scale, adapt: q.perf.adapt, fps: q.perf.fps, gain: q.gain }
    })
    /* 判据是「自适应控制器自己说它在 hold」，而不是「我采样到 3 次相同的 scale」。
       后者太松：adapt 每 2000ms 才动一次，而我 1000ms 采一次，
       完全可能连着三次都落在两次调整之间，于是**在还在爬坡的时候**被判成稳。
       实测过 dark-1200-noon：scale=0.3046、adapt="up"，却被判成 settled —— 而像素预算
       上限是 0.4355，也就是说它是用一半的分辨率被审的。 */
    if (last && (last.adapt === 'hold:max' || last.adapt === 'hold:band')) {
      hist.push(last.scale)
      if (hist.length > 3)
        hist.shift()
      if (hist.length === 3 && hist.every(v => v === hist[0])) {
        settled = true
        break
      }
    }
    else {
      hist.length = 0
    }
    await page.waitForTimeout(1000)
  }
  if (!settled && last)
    console.log(`    ! 未收敛：scale=${last.scale.toFixed(4)} adapt=${last.adapt} fps=${last.fps?.toFixed(1)}`)

  // 曝光闭环比分辨率慢得多（稳态每 2 秒只动 ±1.4%），再给一段沉降时间
  await page.waitForTimeout(4000)
  const probe = await page.evaluate(() => {
    const q = window.__sky?.probe
    if (!q)
      return null
    return {
      scale: q.scale,
      gain: q.gain,
      p10: q.p10,
      p50: q.p50,
      p90: q.p90,
      textP90: q.text?.p90,
      adapt: q.perf?.adapt,
      fps: q.perf?.fps,
      ocean: q.ocean,
      /* 元素级的正文背景统计 —— 那才是驱动薄膜的数。
         不取它的话，外面只看到「薄膜变轻了」，看不到为什么可以变轻。 */
      elements: q.elements
        ? { count: q.elements.count, worstLow: q.elements.worstLow, worstHigh: q.elements.worstHigh }
        : null,
    }
  })
  return { painted, settled, probe }
}

const report = []

for (const theme of themes) {
  for (const [label, when, note] of picked) {
    await page.goto(`${baseUrl}?sky=${encodeURIComponent(when)}&skydebug=1`)
    await page.waitForSelector('[data-test="search-input"]')
    await setTheme(theme)
    await page.reload()
    await page.waitForSelector('[data-test="search-input"]')
    const sky = await waitForSky()

    const name = `${theme}-${label}`
    await page.screenshot({ path: path.join(outDir, `${name}.png`) })

    report.push({
      shot: name,
      sky: when,
      note,
      webgl: sky.painted,
      settled: sky.settled,
      probe: sky.probe,
      clock: await page.locator('[data-test="clock"]').textContent().catch(() => null),
      phase: await page.locator('main').getAttribute('data-phase').catch(() => null),
    })
    console.log(`  ${sky.painted ? 'gl' : 'CSS'}  ${sky.settled ? '稳' : '未稳'}  scale=${sky.probe?.scale ?? '-'}  gain=${sky.probe?.gain?.toFixed(3) ?? '-'}  ${name}`)
  }
}

const fellBack = report.filter(r => !r.webgl).map(r => r.shot)
const unsettled = report.filter(r => r.webgl && !r.settled).map(r => r.shot)
console.log(JSON.stringify({
  round,
  season,
  themes,
  view: `${vw}x${vh}`,
  fellBack,
  unsettled,
  errors,
  report,
}, null, 2))

await browser.close()

// 报错就是没画出来，不能当成功交差；没进稳态的帧也不能当证据
if (errors.length || fellBack.length || unsettled.length)
  process.exit(1)
