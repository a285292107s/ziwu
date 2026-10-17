/**
 * 磁贴入场编排：逐帧胶片条 + 实测指标 + 延迟定格断言（开发用截图工具，不是测试套件）。
 *
 * 和 `scripts/preview.mjs` 的区别：preview 只截「入场跑完的终态」，
 * 这个脚本把动画**暂停在指定时刻**（`Animation.currentTime = T`，T 含 delay），
 * 一帧一帧截出来拼成胶片条，于是「波是不是斜的、尾巴多长、图层有没有分层」
 * 可以直接看图 + 看数，而不是靠读 CSS。
 *
 * 用法：
 *   node --no-experimental-require-module scripts/wave-frames.mjs <轮次> \
 *     [--theme=light|dark] [--viewport=1440x900] [--from=0] [--to=1100] [--step=50] \
 *     [--icon-to=1000] [--icon-step=25] [--label=<后缀>] [--dir=<子目录>] \
 *     [--favicon=cold|warm|swap] [--sites=review|fixture] [--no-visit-sites] \
 *     [--no-frames] [--no-freeze] [--no-live-trace]
 *
 * 产物：docs/review/<轮次>/<theme>-<WxH>-<favicon模式>[-label]/（`--dir` 可整段改名）
 *   frame-t0000.png …        网格区域的逐帧图（T 为动画自身时间轴毫秒）
 *   viewport-t0000.png       入场起点整屏（看编排关系）
 *   viewport-t1100.png       入场终点整屏
 *   hover-*.png              hover 回归（磁贴本体 / 「+」格）
 *   filmstrip.png / .html    逐帧拼一张
 *   metrics.json             网格 / 延迟 / 动画分组 / 图标轨迹 / 图标层取证 / rAF / hover / 定格断言
 *
 * ## 图标层取证（回答「图标到底有没有动、动了多少、什么时候才真正可解码」）
 *
 * 只看 CSS 是答不了的：`.tile-icon`（真图标）与 `.tile-initial`（首字母回退）
 * 共用同一条 `tile-icon-arrive`，但**它们是两个互斥的 DOM 分支**（v-if / v-else），
 * 而 `/_favicon/` 的判定是异步的 —— 于是「用户实际看到的是哪一层、它什么时候
 * 才被插进 DOM、什么时候才真的可解码」必须实测。本脚本为此记录：
 *   - metrics.json.iconForensics.cells：逐格给出「该格图标是 img.tile-icon 还是
 *     span.tile-initial」「图标元素插入 / load / decode 的时刻（相对起波）」
 *     「该格图标动画的 delay / duration / 动画真正开始时刻」，并对齐到同一张表；
 *   - metrics.json.iconForensics.trace：入场窗口内逐 rAF 帧的图标 computed
 *     opacity / transform(scale, riseY) / filter，用来量「动了多少」；
 *   - metrics.json.favicon：本轮模式、Chrome 图标库是否真的有图、faviconCache 前后快照。
 *
 * ## favicon 三种模式（本脚本的核心区分）
 *
 *   cold  首次打开：Chrome 图标库本来就是空的 + faviconCache 也是空的
 *         → 判定为占位图的站点整屏回落首字母（真实用户装完第一次打开）。
 *   warm  真实用户第二次打开：先访问一遍站点把 **Chrome 图标库**种上，再让新标签页
 *         跑一遍把 **faviconCache（localStorage）**写热，**最后**才做采样加载
 *         → 命中缓存，首帧就是 img.tile-icon。用户抱怨的那个画面走的是这条路。
 *   swap  图标已知、但本页 faviconCache 为空（清掉了缓存、Chrome 图标库是热的）
 *         → 首字母先入场，判定完成后被 img.tile-icon 顶掉。
 *
 * 关键：`/_favicon/` 是**页面级**资源 + Chrome 按**浏览历史**解析图标，所以
 * 「Chrome 图标库」和「faviconCache」是两份独立的东西，只热一份的结论会误导。
 * 两者的实际状态都会写进 metrics.json.favicon，不靠猜。
 *
 * `--sites=fixture` 用本机临时 HTTP 站点代替真实站点（每格一个独立 origin +
 * 一张纯色 PNG 图标 + 一格刻意没有图标作对照）：离线可复现、颜色已知，
 * 用来证明 img 这一层到底动没动。产物里会标明是 fixture。
 *
 * 注意：脚本直接加载 `extension/`，那必须是**生产产物**。
 * 刚跑过 `pnpm dev` 的话先 `node scripts/rebuild.mjs`（dev 会把 dist 换成 localhost stub）。
 */
/* global chrome -- sw.evaluate 的回调在扩展 service worker 里执行，chrome 是那边的全局 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const extensionPath = path.join(root, 'extension')

/* ---------------- 参数 ---------------- */
const args = process.argv.slice(2)
const positional = args.filter(a => !a.startsWith('--'))
function flag(name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const round = positional[0] ?? 'wave'
const theme = flag('theme', 'light')
const [vpW, vpH] = flag('viewport', '1440x900').split('x').map(Number)
const from = Number(flag('from', 0))
const to = Number(flag('to', 1100))
const step = Number(flag('step', 50))
const iconTo = Number(flag('icon-to', 1000))
const iconStep = Number(flag('icon-step', 25))
const label = flag('label', '')
const dirOverride = flag('dir', '')
/** cold | warm | swap —— 见文件头「favicon 三种模式」 */
const faviconMode = flag('favicon', 'cold')
/** review（preview.mjs 那 9 个真实站点）| fixture（本机临时站点，离线可复现） */
const siteSet = flag('sites', 'review')
/** warm/swap 默认会先访问一遍站点把 Chrome 图标库种上；关掉就只剩 faviconCache 那一层 */
const visitSites = !args.includes('--no-visit-sites')
const withFrames = !args.includes('--no-frames')
const withFreeze = !args.includes('--no-freeze')
const withLiveTrace = !args.includes('--no-live-trace')
/** 无障碍对照：按 prefers-reduced-motion: reduce 跑，并断言「没有东西停在半途 / 没有格子被延迟藏起来」 */
const withReducedMotion = args.includes('--reduced-motion')
/** 特写帧：图标只有 28px，1440 宽的整屏帧里读不出姿态，所以单独放一轮高 DPR 的单格特写 */
const withZoom = args.includes('--zoom')
const zoomTile = Number(flag('zoom-tile', 2))
const zoomFrom = Number(flag('zoom-from', 0))
const zoomTo = Number(flag('zoom-to', 900))
const zoomStep = Number(flag('zoom-step', 25))
/** 设备像素比：特写默认 2x，其余默认 1x（和 g1 基线同口径） */
const dsf = Number(flag('dsf', withZoom ? 2 : 1))
/** 覆盖末尾的落定时刻（v3 尾巴更长，默认就按 1200 等） */
const settleMs = Number(flag('settle', 1200))

if (!['light', 'dark'].includes(theme))
  throw new Error(`--theme 只支持 light|dark，收到 ${theme}`)
if (!Number.isFinite(vpW) || !Number.isFinite(vpH) || vpW <= 0 || vpH <= 0)
  throw new Error(`--viewport 形如 1440x900，收到 ${vpW}x${vpH}`)
if (!(step > 0) || to < from)
  throw new Error(`--from/--to/--step 不合法：${from}/${to}/${step}`)
if ((to - from) / step > 300 || iconTo / iconStep > 400)
  throw new Error('采样点过多，调大 --step / --icon-step')
if (!['cold', 'warm', 'swap'].includes(faviconMode))
  throw new Error(`--favicon 只支持 cold|warm|swap，收到 ${faviconMode}`)
if (!['review', 'fixture'].includes(siteSet))
  throw new Error(`--sites 只支持 review|fixture，收到 ${siteSet}`)
if (!Number.isFinite(dsf) || dsf <= 0)
  throw new Error(`--dsf 必须为正数，收到 ${dsf}`)
if (withZoom && (!(zoomStep > 0) || zoomTo < zoomFrom))
  throw new Error(`--zoom-from/--zoom-to/--zoom-step 不合法：${zoomFrom}/${zoomTo}/${zoomStep}`)

const vpLabel = `${vpW}x${vpH}`
const outDir = dirOverride
  ? path.join(root, 'docs', 'review', round, dirOverride)
  : path.join(root, 'docs', 'review', round, `${theme}-${vpLabel}-${faviconMode}${label ? `-${label}` : ''}`)
fs.mkdirSync(outDir, { recursive: true })

/** 评审用的磁贴数据 = preview.mjs 那 8 条 + 1 条，共 9 条（加「新增」格 = 10 格）。 */
const REVIEW_SHORTCUTS = [
  { id: 'p1', name: 'GitHub', url: 'https://github.com' },
  { id: 'p2', name: '知乎', url: 'https://www.zhihu.com' },
  { id: 'p3', name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { id: 'p4', name: 'MDN', url: 'https://developer.mozilla.org' },
  { id: 'p5', name: 'Figma', url: 'https://www.figma.com' },
  { id: 'p6', name: 'Linear', url: 'https://linear.app' },
  { id: 'p7', name: '内部看板', url: 'https://meridiem-dashboard.invalid' },
  { id: 'p8', name: 'arXiv', url: 'https://arxiv.org' },
  { id: 'p9', name: 'Hacker News', url: 'https://news.ycombinator.com' },
]
/** 定格断言用：先删掉第 2 条（下标 1 = p2 知乎），再加一条全新的 */
const REVIEW_ADDED = { id: 'p10', name: '维基百科', url: 'https://zh.wikipedia.org' }

/**
 * faviconCache 在 localStorage 里的键名。
 * 必须与 `src/logic/faviconCache.ts` 的 `FAVICON_CACHE_KEY` 逐字一致 ——
 * 这里只是**读快照 / 清空**，不实现缓存逻辑（缓存逻辑改了要跟着改这个常量）。
 */
const FAVICON_CACHE_KEY = 'meridiem-favicon-cache-v1'
/**
 * 「取一张占位图」用的探测地址，必须与 `src/logic/shortcuts.ts` 的 `FAVICON_PROBE_URL` 一致。
 *
 * 这里刻意**不 import** 产品代码：本脚本要在 fixture 站点的独立 origin 里跑，
 * 引入 `~/logic/*` 会把 Vite 的别名解析需求带进一个纯 Node 进程。
 * 代价是这份字面量会漂移 —— 所以它旁边的注释只说明「必须与谁一致」，
 * 真要改的时候两边一起改（判断占位图是靠运行时标定的指纹，
 * 只要两边打的是同一个必然不存在的域名，具体域名是什么并不影响结论）。
 */
const PLACEHOLDER_PROBE_URL = 'https://meridiem-favicon-probe.invalid/'

/**
 * fixture 站点表：每格一个**独立 origin**（faviconCache 的键是 origin，
 * 同 origin 的两个磁贴会共用一条缓存，测不出「逐格」的行为）。
 * 最后一条刻意没有图标，作为「回落首字母」的对照。
 */
const FIXTURE_TILES = [
  { key: 'a', name: '样例甲', rgb: [214, 40, 40] },
  { key: 'b', name: '样例乙', rgb: [231, 111, 81] },
  { key: 'c', name: '样例丙', rgb: [233, 196, 106] },
  { key: 'd', name: '样例丁', rgb: [42, 157, 143] },
  { key: 'e', name: '样例戊', rgb: [38, 70, 83] },
  { key: 'f', name: '样例己', rgb: [94, 84, 142] },
  { key: 'g', name: '样例庚', rgb: [144, 190, 109] },
  { key: 'h', name: '样例辛', rgb: [255, 183, 3] },
  { key: 'z', name: '无图标站', rgb: null },
]

/**
 * 手写一张纯色 PNG（32x32）。只用 `node:zlib`，不引图像库：
 * 这个脚本是开发工具，不该为「造一张测试用的纯色图」多一个依赖。
 */
function solidPng(w, h, [r, g, b]) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (const byte of typed)
      crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0)
    return Buffer.concat([len, typed, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 起一组本机站点：每格一个 origin，页面上带 `<link rel=icon>` 指向一张纯色 PNG。
 * 「无图标站」那一格返回不带 link 的 HTML、并且 /favicon.ico 也是 404 ——
 * Chrome 图标库里因此没有它，`/_favicon/` 给占位地球，磁贴回落首字母。
 */
async function startFixtureSites() {
  const servers = []
  const shortcuts = []
  const added = { id: 'fx-added', name: '样例新增', url: null }
  const specs = [...FIXTURE_TILES, { key: 'added', name: added.name, rgb: [20, 20, 20] }]

  for (const spec of specs) {
    const icon = spec.rgb ? solidPng(32, 32, spec.rgb) : null
    const srv = http.createServer((req, res) => {
      if (icon && req.url.startsWith('/icon')) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' })
        res.end(icon)
        return
      }
      if (!icon) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('no icon here')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>fixture ${spec.key}</title>`
      + '<link rel="icon" type="image/png" href="/icon.png"></head>'
      + `<body>fixture ${spec.key}</body></html>`)
    })
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
    servers.push(srv)
    const url = `http://127.0.0.1:${srv.address().port}/`
    if (spec.key === 'added')
      added.url = url
    else
      shortcuts.push({ id: `fx-${spec.key}`, name: spec.name, url, fixtureRgb: spec.rgb })
  }

  return {
    shortcuts,
    added,
    /** 只关服务，不动别的 */
    stop: () => Promise.all(servers.map(s => new Promise(r => s.close(() => r())))),
  }
}

/** 本轮实际注入的磁贴清单（决定布局：9 条 + 「+」格 = 10 格） */
let fixtureSites = null
let SHORTCUTS = REVIEW_SHORTCUTS
let ADDED = REVIEW_ADDED
if (siteSet === 'fixture') {
  fixtureSites = await startFixtureSites()
  SHORTCUTS = fixtureSites.shortcuts
  ADDED = fixtureSites.added
}
const REMOVE_ID = SHORTCUTS[1].id

/** 产物里到底装的是哪份代码 —— 基线 / v1 对不上时先看这里 */
function extensionFingerprint() {
  const distDir = path.join(extensionPath, 'dist', 'assets')
  const indexHtml = path.join(extensionPath, 'dist', 'newtab', 'index.html')
  const stat = p => (fs.existsSync(p) ? fs.statSync(p) : null)
  const idx = stat(indexHtml)
  return {
    manifestMtime: stat(path.join(extensionPath, 'manifest.json'))?.mtime.toISOString() ?? null,
    newtabIndexMtime: idx?.mtime.toISOString() ?? null,
    newtabIndexSha256: idx ? createHash('sha256').update(fs.readFileSync(indexHtml)).digest('hex') : null,
    assets: fs.existsSync(distDir)
      ? fs.readdirSync(distDir).map(name => ({ name, bytes: fs.statSync(path.join(distDir, name)).size }))
      : [],
  }
}

const problems = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
/** 采样页：**最后**才创建并赋值（见 createSamplePage 的说明），这里先占位给下面的函数引用 */
let page = null

const browser = await chromium.launchPersistentContext('', {
  headless: true,
  deviceScaleFactor: dsf,
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

/* ---------------- favicon 取证用的小工具 ---------------- */

/** 打开一个扩展自己的页面干活（清缓存 / 读快照 / 探图标库），干完就关 */
async function withExtensionPage(fn, pagePath = 'dist/options/index.html') {
  const helper = await browser.newPage()
  try {
    await helper.goto(`chrome-extension://${extensionId}/${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await helper.waitForTimeout(150)
    return await fn(helper)
  }
  finally {
    await helper.close().catch(() => {})
  }
}

/**
 * localStorage 里那份 faviconCache 的可读快照。
 * 不认识的结构一律降级成 null / 计数，不猜 —— 这里只负责如实汇报状态。
 */
function summarizeFaviconCache(raw) {
  let record = {}
  let parseError = null
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      record = parsed
  }
  catch (e) {
    parseError = String(e)
  }
  const now = Date.now()
  const entries = Object.entries(record).map(([origin, entry]) => ({
    origin,
    hasData: typeof entry?.data === 'string' && entry.data.length > 0,
    dataBytes: typeof entry?.data === 'string' ? entry.data.length : 0,
    ageMs: typeof entry?.at === 'number' ? now - entry.at : null,
  }))
  return {
    present: raw !== null,
    bytes: raw ? raw.length : 0,
    entryCount: entries.length,
    withData: entries.filter(e => e.hasData).length,
    withoutData: entries.filter(e => !e.hasData).length,
    parseError,
    entries,
  }
}

const readFaviconCacheRaw = extPage => extPage.evaluate(key => localStorage.getItem(key), FAVICON_CACHE_KEY)

/**
 * 从扩展页面上量 `/_favicon/` 究竟给了什么。
 *
 * 「Chrome 图标库里到底有没有这个站的真图标」不能靠「看起来像首字母」猜：
 * 拿一个肯定不存在的域名标定出**占位地球**的像素指纹，再逐站比对即可判定。
 * 判据与 `src/composables/useFavicon.ts` 里那套一致（同一张占位图 = 没有真图标）。
 */
function faviconDbProbe(targets) {
  return withExtensionPage(helper => helper.evaluate(async ({ list, probeSite }) => {
    const favUrl = (site, size) => `chrome-extension://${location.host}/_favicon/?pageUrl=${encodeURIComponent(site)}&size=${size}`
    const fingerprint = async (url) => {
      const img = await new Promise((resolve) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => resolve(null)
        i.src = url
      })
      if (!img)
        return { ok: false }
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        let hash = 2166136261
        let opaque = 0
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < data.length; i++) {
          hash ^= data[i]
          hash = Math.imul(hash, 16777619)
          if (i % 4 === 3 && data[i] > 10)
            opaque++
        }
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }
        const n = data.length / 4
        return {
          ok: true,
          naturalWidth: img.naturalWidth,
          hash: (hash >>> 0).toString(16),
          opaque: +(opaque / 1024).toFixed(3),
          rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        }
      }
      catch (e) {
        return { ok: false, error: String(e) }
      }
    }

    const placeholder = await fingerprint(favUrl(probeSite, 64))
    const out = []
    for (const t of list) {
      const res = await fingerprint(favUrl(t.url, 64))
      const isPlaceholder = Boolean(res.ok && placeholder.ok && res.hash === placeholder.hash)
      out.push({
        id: t.id,
        url: t.url,
        ...res,
        isPlaceholder,
        /**
         * 三态，缺一不可：
         *   real        = 拿到了跟占位地球不同的图（Chrome 图标库里真的有这个站）
         *   placeholder = 就是那张通用灰地球
         *   unavailable = 图根本没加载出来（ok=false）
         * 之前把 unavailable 也写成 isPlaceholder:false，会被读成「有真图标」——
         * 这正是「静默误判」，所以单列一个 verdict。
         */
        verdict: !res.ok ? 'unavailable' : (isPlaceholder ? 'placeholder' : 'real'),
      })
    }
    return { placeholder, targets: out }
  }, { list: targets, probeSite: PLACEHOLDER_PROBE_URL }))
}

/**
 * warm / swap 的第一步：真的访问一遍站点，把 **Chrome 图标库**种上。
 * `/_favicon/` 是浏览历史的派生物 —— 不访问，图标库里就没有这个站。
 */
async function visitSitesForFaviconDb(targets) {
  const visitor = await browser.newPage()
  const results = []
  visitor.on('requestfailed', () => {})
  try {
    for (const t of targets) {
      const startedAt = Date.now()
      try {
        const resp = await visitor.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        results.push({ id: t.id, url: t.url, status: resp ? resp.status() : null, ms: Date.now() - startedAt, ok: true })
      }
      catch (e) {
        results.push({ id: t.id, url: t.url, status: null, ms: Date.now() - startedAt, ok: false, error: String(e).slice(0, 160) })
      }
    }
  }
  finally {
    await visitor.close().catch(() => {})
  }
  // 图标落库是异步的：给一点时间再探针（有没有真的落到库里由 dbProbeAfter 说了算）
  await sleep(1500)
  return results
}

/**
 * warm 模式的核心一步：正常打开一次新标签页，等 faviconCache 稳定后关掉。
 * 之后的**采样加载**就命中缓存（`readFaviconCache` 同步命中 → 首帧即 img.tile-icon），
 * 这正是真实用户第二次打开新标签页走的那条路。
 *
 * 关键：这一遍必须**先清空 faviconCache**（在 document_start 清，见下面的 addInitScript）。
 * 否则前面那些探针页面（设置页也渲染 ShortcutGrid！）写进去的**过期否定结论**
 * 会以 6 小时保鲜期命中，让本站该有的图标显示不出来 —— 那量到的是污染，不是真实路径。
 */
async function warmFaviconCachePass() {
  const warm = await browser.newPage()
  await warm.setViewportSize({ width: vpW, height: vpH })
  warm.on('pageerror', e => problems.push(`warmup pageerror: ${e.message}`))
  // 在页面脚本之前把缓存清空：Chrome 图标库是热的，所以这一遍会写出**正确**的结论
  await warm.addInitScript((key) => {
    try {
      localStorage.removeItem(key)
    }
    catch {
      // 非扩展源（about:blank）访问 localStorage 会抛，忽略：那本来也不是我们要清的文档
    }
  }, FAVICON_CACHE_KEY)
  const snapshots = []
  try {
    await warm.bringToFront()
    await warm.goto(newTabUrl)
    await warm.waitForSelector('.grid-root.is-waved', { timeout: 15000 })
    let stable = 0
    let lastShape = null
    for (let i = 0; i < 40; i++) {
      await warm.waitForTimeout(250)
      const snap = summarizeFaviconCache(await readFaviconCacheRaw(warm))
      const shape = `${snap.entryCount}/${snap.withData}`
      snapshots.push({ atMs: 250 * (i + 1), entryCount: snap.entryCount, withData: snap.withData, bytes: snap.bytes })
      stable = shape === lastShape ? stable + 1 : 0
      lastShape = shape
      if (stable >= 2)
        break
    }
    return { snapshots, final: summarizeFaviconCache(await readFaviconCacheRaw(warm)) }
  }
  finally {
    await warm.close().catch(() => {})
  }
}

/**
 * cold / swap 用：在**扩展自己的页面**上把 faviconCache 清干净，并如实回报清完是不是真的空的。
 *
 * 为什么要等页面里的网格先跑完：设置页（`Options.vue`）复用了 `ShortcutGrid`，
 * 它自己就会解析图标并写缓存；清早了它会再写一次，采样时命中的就是它的结论。
 */
async function clearFaviconCacheOnExtensionPage() {
  return withExtensionPage(async (helper) => {
    await helper.waitForSelector('[data-test="shortcut-grid"]', { timeout: 15000 }).catch(() => {})
    await helper.waitForTimeout(1500)
    const cleared = await helper.evaluate((key) => {
      const before = localStorage.getItem(key)
      localStorage.removeItem(key)
      return { hadKey: before !== null, beforeBytes: before ? before.length : 0, after: localStorage.getItem(key) }
    }, FAVICON_CACHE_KEY)
    return { ...cleared, afterSummary: summarizeFaviconCache(cleared.after) }
  })
}

/**
 * 采样页在**所有 helper 页面都关掉之后**才创建。
 *
 * 为什么要这么讲究：headless 下「标签页可见性」会把 rAF 和 setTimeout 一起节流
 * （rAF 直接不回调、timer 掉到 ~1s 一次）。前面为探图标库 / 清缓存 / 预热而开的
 * helper 标签页一旦抢走了前台状态，采样窗口里就只能采到 2~4 个样本 ——
 * 那不是「页面卡」，是测量装置坏了。所以：最后创建 + bringToFront + CDP 焦点模拟，
 * 三道一起上；另外还在页面里用 `visibilityState` 把实际状态记下来，别让它悄悄发生。
 */
async function createSamplePage() {
  const p = await browser.newPage()
  // persistent context 的 newPage() 不吃 viewport 选项（传了会被静默忽略），必须显式再设一次
  await p.setViewportSize({ width: vpW, height: vpH })
  p.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() === 'error')
      problems.push(`console.error: ${m.text()}`)
  })
  p.on('requestfailed', (r) => {
    const url = r.url()
    // favicon 取不到是这个页面的预期分支（回退首字母），不算问题
    if (url.includes('/_favicon/'))
      return
    problems.push(`requestfailed: ${url} (${r.failure()?.errorText})`)
  })
  await p.addInitScript(newtabProbe, {
    liveTrace: withLiveTrace,
    clearFaviconCache: faviconMode !== 'warm',
    faviconCacheKey: FAVICON_CACHE_KEY,
  })
  // headless=new 里不模拟焦点的话，标签页可能被判成不可见 → rAF/timer 被节流
  try {
    const cdp = await browser.newCDPSession(p)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  }
  catch (e) {
    problems.push(`focus emulation failed: ${String(e)}`)
  }
  await p.bringToFront()
  return p
}
// 从 document_start 起：① rAF 采样 ② 计时器抖动采样 ③ 记录「波是何时起的」
// ④ 一个认得「动画属于磁贴带」的判定器 ⑤ 图标层取证 ⑥ 落定态读数。
// ④ 很关键：v1 里 `.tile-face::after` 的高光是**伪元素动画**，
//    effect.target 可能是 CSSPseudoElement（不是 Element），简单 `instanceof Element` 会漏掉它。
function newtabProbe(opts) {
  window.__rafFrames = []
  window.__waveStart = null
  const push = (t) => {
    window.__rafFrames.push(t)
    if (window.__rafFrames.length < 4000)
      requestAnimationFrame(push)
  }
  requestAnimationFrame(push)

  /**
   * 计时器驱动的抖动探针（与 rAF 并行，独立一条证据）。
   *
   * 为什么必须有它：headless 里 rAF 是**跟着合成帧走**的 —— 页面一静止，合成器就不再
   * 产帧，rAF 直接不回调（实测入场跑完后能停 1 秒）。于是「入场窗口内采到几帧」
   * 变成了「这段编排让画面动了多久」的函数，而不是「页面卡不卡」的函数：
   * 两轮动画时长不同，rAF 的帧数就不可比（g1 的 49 帧 vs g3 的 4 帧就是这么来的，
   * 不是 g3 更卡）。setTimeout 不依赖合成帧，它的间隔反映的是**主线程有没有被占住**，
   * 这一条才可以跨轮比较。
   */
  window.__jankFrames = []
  const jankTick = () => {
    window.__jankFrames.push(performance.now())
    if (window.__jankFrames.length < 4000)
      setTimeout(jankTick, 16)
  }
  setTimeout(jankTick, 16)

  window.__gridAnimEntry = (a) => {
    const t = a.effect && a.effect.target
    if (!t)
      return null
    let el = null
    let pseudo = a.effect.pseudoElement ?? null
    if (typeof Element !== 'undefined' && t instanceof Element) {
      el = t
    }
    else if (t.element && typeof Element !== 'undefined' && t.element instanceof Element) {
      el = t.element
      pseudo = t.pseudoElement ?? pseudo
    }
    if (!el || !el.closest('.grid-root'))
      return null
    return { el, pseudo: pseudo || null }
  }
  window.__gridAnims = () => document.getAnimations()
    .map(a => ({ a, hit: window.__gridAnimEntry(a) }))
    .filter(x => x.hit)

  /**
   * 读一个元素（或伪元素）的「动作」状态 —— 本脚本所有逐帧采样的唯一入口。
   *
   * v2 起内层动作改走**独立属性**（`translate` / `scale` / `rotate`），
   * v1 用的是 `transform`，伪元素高光仍然用 `transform`：
   * 两代都读，并给出合并后的 x / y / sx / sy / rotateDeg，
   * 这样「g1 基线 → g2」是同口径（同名、同含义），而不是各读各的。
   *
   * 注意：独立属性按**计算值字符串**解析，本仓库用的都是 px / 无单位数，
   * 若将来写进 `%` 或 `calc()`，这里的 x/y/sx 会失真 —— matrix 字段仍可用于交叉验证。
   */
  window.__motionRead = (el, pseudo) => {
    if (!el)
      return null
    /* 伪元素不存在时要返回 null，不能返回「看起来像 opacity 1 的读数」。
       为什么必须显式判：`getComputedStyle(el, '::after')` 对一个**没有 content 的**
       伪元素不会报错，它会返回一份默认样式 —— `opacity` 是 `1`。
       于是「这个装饰层已经被删掉了」会被读成「它结束态还亮着」，
       在 reduce 落定断言里直接变成一条**假 FAIL**（实测 v7 报出 9 条
       「p1..p9 高光 opacity=1」，而高光那一层在源码和产物里都已经不存在）。
       唯一可靠的判据是 `content`：`none` 就说明这个伪元素没有被生成。 */
    const style = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el)
    if (pseudo && (style.content === 'none' || style.content === 'normal'))
      return null
    const norm = v => (v === undefined || v === null || v === '' ? null : v)
    const parts = (v) => {
      const s = norm(v)
      if (!s || s === 'none')
        return []
      return s.trim().split(/\s+/).map(p => Number.parseFloat(p))
    }
    const translate = norm(style.translate)
    const scale = norm(style.scale)
    const rotate = norm(style.rotate)
    const tParts = parts(translate)
    const sParts = parts(scale)
    const tx = Number.isFinite(tParts[0]) ? tParts[0] : 0
    const ty = Number.isFinite(tParts[1]) ? tParts[1] : 0
    const sx = Number.isFinite(sParts[0]) ? sParts[0] : 1
    const sy = Number.isFinite(sParts[1]) ? sParts[1] : sx
    let rotateDeg = 0
    if (rotate && rotate !== 'none') {
      const m = /(-?[\d.]+)deg/.exec(rotate)
      rotateDeg = m ? Number.parseFloat(m[1]) : (Number.parseFloat(rotate) || 0)
    }
    let matrix = null
    if (style.transform && style.transform !== 'none') {
      try {
        matrix = new DOMMatrixReadOnly(style.transform)
      }
      catch {
        matrix = null
      }
    }
    return {
      transform: style.transform,
      translate,
      scale,
      rotate,
      opacity: +Number(style.opacity).toFixed(3),
      filter: style.filter,
      x: +(tx + (matrix ? matrix.m41 : 0)).toFixed(3),
      y: +(ty + (matrix ? matrix.m42 : 0)).toFixed(3),
      sx: +(sx * (matrix ? matrix.a : 1)).toFixed(4),
      sy: +(sy * (matrix ? matrix.d : 1)).toFixed(4),
      rotateDeg: +rotateDeg.toFixed(2),
      matrix: matrix
        ? { a: +matrix.a.toFixed(4), d: +matrix.d.toFixed(4), e: +matrix.m41.toFixed(3), f: +matrix.m42.toFixed(3) }
        : null,
    }
  }

  /**
   * 入场期间把动画对象**收进一个 Set 并持有引用**（定格的前置条件）。
   *
   * 为什么不能等入场跑完再 `getAnimations()`：按 Web Animations 规范，一个动画只有
   * (a) 处于 before 相且 fill 影响它、(b) 处于 active 相、或 (c) 处于 after 相且
   * fill 是 forwards/both 时才算 relevant。入场动画的每个关键帧 100% 都等于静止值，
   * 所以产品侧把它从 `both` 换成了 `backwards` —— 换掉之后动画一跑完就**不再 relevant**，
   * 直接从 `document.getAnimations()` 里消失，定格逻辑当场失效：
   * 实测症状是 `paused 0` + 每帧 `landed=10/10`（拍到的全是落定态）。
   *
   * 持有 JS 引用则不会被回收：之后 `pause()` 再把 currentTime 设回 active 区间，
   * 它会重新变得 relevant 并生效，所以定格那一步的逻辑不用改。
   *
   * 注意：**不在这一拍里 pause**。入场期间的画面要留给实时取证（trace / 落定态 /
   * 帧率），中途暂停会把「用户实际看到的入场」冻在半路，量到的就不是真东西了。
   */
  window.__animRefs = new Set()
  window.__animCollect = { startedAtMs: null, endedAtMs: null, ticks: 0, firstTickSize: null, collected: 0, windowMs: 1400 }
  /**
   * 逐条动画的**元数据也在入场期间收**（不只是引用）。
   *
   * 原因同上：`fill: backwards` 的入场动画跑完就既不在 active 相、也没有 forwards 填充，
   * 于是 `document.getAnimations()` 什么都给不出来 —— 连 delay / duration / 逐段缓动
   * 这些**静态编排参数**也一起读不到了。本脚本原来是在入场跑完之后读的，
   * fill 一改，整张「延迟—时长—缓动」表就全空了。所以在动画第一次出现时就把它记下来。
   */
  window.__animMeta = []
  const animSeen = new WeakSet()
  const describeEl = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
    return `${el.tagName.toLowerCase()}${cls.map(c => `.${c}`).join('')}`
  }
  const metaOfAnim = (a, hit) => {
    const timing = a.effect.getTiming()
    const style = hit.pseudo ? getComputedStyle(hit.el, hit.pseudo) : getComputedStyle(hit.el)
    const cell = hit.el.closest('.tile-cell')
    const cls = typeof hit.el.className === 'string' ? hit.el.className.split(/\s+/).filter(Boolean) : []
    /**
     * **必须区分 CSSAnimation 与 CSSTransition**：`document.getAnimations()` 两者都给。
     *
     * 陷阱：过渡对象没有「动画名」，而 `getComputedStyle(el).animationName` 读的是元素
     * 当前的 animation-name —— 于是元素身上挂着入场动画时，它的**过渡**会被读成
     * 「tile-icon-arrive、delay=0」。上一版就是这样：删掉一格后那 16 条「新动画」其实是
     * 4 个元素各自的过渡，看起来像「删一格让其它格子重新入场了」——
     * 那会把工具噪声当成产品缺陷报出去。
     */
    const kind = (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation)
      ? 'animation'
      : ((typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) ? 'transition' : 'other')
    let keyframes = null
    try {
      keyframes = a.effect.getKeyframes().map(k => ({
        computedOffset: typeof k.computedOffset === 'number' ? +k.computedOffset.toFixed(4) : null,
        offset: k.offset,
        easing: k.easing ?? null,
        composite: k.composite ?? null,
      }))
    }
    catch {
      keyframes = null
    }
    const startTime = Number.isFinite(a.startTime) ? +a.startTime.toFixed(2) : null
    return {
      /** animation = 真·CSS 动画；transition = 过渡（getAnimations 也会返回它们） */
      kind,
      target: `${describeEl(hit.el)}${hit.pseudo ?? ''}`,
      targetBase: describeEl(hit.el),
      pseudo: hit.pseudo,
      iconKind: cls.includes('tile-icon') ? 'img' : (cls.includes('tile-initial') ? 'initial' : null),
      tag: hit.el.tagName.toLowerCase(),
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : false,
      animationName: style.animationName,
      durationMs: timing.duration,
      delayMs: timing.delay,
      fill: timing.fill,
      animationEasing: timing.easing,
      easing: timing.easing,
      easingNote: 'easing = effect.getTiming().easing（动画级，对 CSS 动画恒为 linear）；逐段曲线看 easingSegments',
      keyframes,
      easingSegments: keyframes
        ? keyframes.slice(0, -1).map((k, i) => ({
          fromPct: k.computedOffset === null ? null : +(k.computedOffset * 100).toFixed(2),
          toPct: keyframes[i + 1].computedOffset === null ? null : +(keyframes[i + 1].computedOffset * 100).toFixed(2),
          easing: k.easing ?? null,
        }))
        : null,
      iterations: timing.iterations,
      startTime,
      currentTimeMs: Number.isFinite(a.currentTime) ? +a.currentTime.toFixed(2) : null,
      playState: a.playState,
      startTimeRelWaveMs: (startTime !== null && window.__timelineAtWave !== null && window.__timelineAtWave !== undefined)
        ? +(startTime - window.__timelineAtWave).toFixed(1)
        : null,
      /** 第一次在 `getAnimations()` 里看到它的时刻（相对起波）—— 晚插入的元素会明显靠后 */
      firstSeenRelWaveMs: window.__waveStart === null ? null : +(performance.now() - window.__waveStart).toFixed(1),
      playStateAtFirstSeen: a.playState,
    }
  }

  /**
   * 现场收集一小段（毫秒）并返回这段时间里出现过的动画元数据。
   *
   * 为什么定格段必须用它：入场之后新产生的动画（删/增一格触发的 `tile-fresh` 等）
   * **不在入场窗口里**，而 `fill: backwards` 又让它们跑完就从 `getAnimations()` 消失，
   * 所以「操作前后各现场收一段」是唯一能看见它们的办法 ——
   * 否则那几条断言会静默空转（`added` / `missing` 全空，看起来像 PASS，其实什么都没验）。
   */
  window.__collectAnimMeta = ms => new Promise((resolve) => {
    const out = []
    const seen = new WeakSet()
    const startedAt = performance.now()
    const tick = () => {
      for (const { a, hit } of window.__gridAnims()) {
        if (!seen.has(a)) {
          seen.add(a)
          out.push(metaOfAnim(a, hit))
        }
      }
      if (performance.now() - startedAt < ms)
        requestAnimationFrame(tick)
      else
        resolve(out)
    }
    requestAnimationFrame(tick)
  })
  function startAnimCollect() {
    const collect = window.__animCollect
    if (collect.startedAtMs !== null)
      return
    collect.startedAtMs = +(performance.now() - (window.__waveStart ?? performance.now())).toFixed(1)
    const tick = () => {
      collect.ticks++
      const live = window.__gridAnims()
      if (collect.firstTickSize === null)
        collect.firstTickSize = live.length
      for (const { a, hit } of live) {
        window.__animRefs.add(a)
        if (!animSeen.has(a)) {
          animSeen.add(a)
          window.__animMeta.push(metaOfAnim(a, hit))
        }
      }
      collect.collected = window.__animRefs.size
      collect.metaCollected = window.__animMeta.length
      if (performance.now() - window.__waveStart < collect.windowMs) {
        requestAnimationFrame(tick)
      }
      else {
        collect.endedAtMs = +(performance.now() - window.__waveStart).toFixed(1)
        collect.liveAtEnd = window.__gridAnims().length
      }
    }
    requestAnimationFrame(tick)
  }

  const catchWave = () => {
    if (window.__waveStart !== null)
      return true
    if (document.querySelector('.grid-root.is-waved')) {
      window.__waveStart = performance.now()
      // 动画的 startTime 走的是 document.timeline，而 __waveStart 走的是 performance.now()。
      // 两套时钟在规范上是同一个原点，但「是同一个原点」这件事本身也要能被查，
      // 所以把两者的差记下来（正常应当在 0 附近；偏离大了，下面的 startTimeRelWaveMs 就不能信）。
      window.__timelineAtWave = Number.isFinite(document.timeline.currentTime) ? document.timeline.currentTime : null
      window.__clockOffsetAtWave = window.__timelineAtWave === null ? null : performance.now() - window.__timelineAtWave
      // 起波即开始收动画引用：晚一拍就漏掉最早的几条
      startAnimCollect()
      return true
    }
    return false
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (catchWave())
      return
    const obs = new MutationObserver(() => {
      if (catchWave())
        obs.disconnect()
    })
    obs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] })
  })

  /* ---- 图标层取证 ---- */
  window.__iconLog = {
    installedAt: performance.now(),
    imgs: [],
    initials: [],
    trace: [],
    traceWindowMs: 1600,
    traceDegraded: null,
    errors: [],
    note: '所有时刻都是 performance.now()，报告里统一减去 __waveStart（观测到 .grid-root.is-waved 的那一刻）',
  }

  /**
   * 「这一格现在是不是停在了半途」的逐层读数。
   *
   * 用来做两类断言：
   *   1. `prefers-reduced-motion: reduce` 下，入场结束后**没有任何元素停在半途**；
   *   2. reduce 下**没有格子在 delay 期间被藏起来**（所以要在入场刚开始时也拍一次）。
   *
   * 注意一次性装饰层（`.tile-pulse` / `.tile-face::after` 高光）的**结束态就是不可见**
   * （opacity 0），所以它们不能用「opacity 必须为 1」去判 —— 那样会把正确实现判成错。
   * 判据按层分开写在 Node 侧（见 checkSettleState）。
   */
  window.__settleProbe = () => {
    const read = (el, pseudo) => window.__motionRead(el, pseudo)
    const cells = [...document.querySelectorAll('.tile-cell')]
    return {
      atMs: window.__waveStart === null ? null : +(performance.now() - window.__waveStart).toFixed(1),
      isReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      cellCount: cells.length,
      cells: cells.map((c, i) => {
        const icon = c.querySelector('img.tile-icon, span.tile-initial')
        return {
          index: i,
          id: c.dataset.shortcutId ?? '<add>',
          cell: read(c),
          face: read(c.querySelector('.tile-face')),
          icon: read(icon),
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          pulse: read(c.querySelector('.tile-pulse')),
          name: read(c.querySelector('.tile-name')),
          sheen: read(c.querySelector('.tile-face'), '::after'),
          /**
           * **层叠**里的动画参数（不依赖动画对象是否还活着）。
           * 意义：`fill: backwards` 之后入场动画跑完就从 `getAnimations()` 消失，
           * 想核对「这一层到底挂了什么、delay 多少」只能读 computed 的
           * animation-name/delay/duration/fill —— 它们来自 CSS 层叠，
           * 与动画当前的相（before/active/after）无关。reduce 断言就靠它，
           * 因为 reduce 下动画只活 0.01ms，靠 rAF 收集根本抓不全。
           */
          anim: (() => {
            const st = (el, pseudo) => {
              if (!el)
                return null
              const s = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el)
              return {
                name: s.animationName,
                delay: s.animationDelay,
                duration: s.animationDuration,
                fill: s.animationFillMode,
                timing: s.animationTimingFunction,
              }
            }
            return {
              cell: st(c),
              icon: st(icon),
              pulse: st(c.querySelector('.tile-pulse')),
              name: st(c.querySelector('.tile-name')),
              sheen: st(c.querySelector('.tile-face'), '::after'),
            }
          })(),
        }
      }),
    }
  }

  /**
   * cold / swap：在**本页脚本之前**把 faviconCache 清空。
   *
   * 为什么非要在文档起点清：设置页（Options.vue）复用了 ShortcutGrid，
   * 本脚本为探图标库而打开的那些 helper 页面会把「没图标」这种否定结论写进缓存，
   * 而且否定结论有 6 小时保鲜期 —— 采样页一读就是它，量到的就不是真实路径了。
   * 在这里清，采样页看到的缓存状态才是我们要测的那个。
   */
  if (opts && opts.clearFaviconCache) {
    try {
      const had = localStorage.getItem(opts.faviconCacheKey)
      localStorage.removeItem(opts.faviconCacheKey)
      window.__iconLog.cacheClearedAtDocumentStart = {
        key: opts.faviconCacheKey,
        hadKey: had !== null,
        hadBytes: had ? had.length : 0,
        after: localStorage.getItem(opts.faviconCacheKey),
      }
    }
    catch (e) {
      window.__iconLog.cacheClearedAtDocumentStart = { error: String(e) }
    }
  }
  const shortSrc = (s) => {
    if (!s)
      return null
    if (s.startsWith('data:'))
      return `data:${s.slice(5, 18)}…(${s.length}B)`
    return s.length > 96 ? `${s.slice(0, 96)}…` : s
  }
  const cellMetaOf = (el) => {
    const cell = el?.closest('.tile-cell') ?? null
    return {
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : null,
    }
  }

  const seenImgs = new WeakMap()
  function watchImg(img) {
    if (seenImgs.has(img))
      return
    const rec = {
      ...cellMetaOf(img),
      tag: 'img',
      addedAt: performance.now(),
      srcShort: shortSrc(img.getAttribute('src')),
      srcIsData: (img.getAttribute('src') || '').startsWith('data:'),
      // 插入那一刻的状态：data: URL 有时是「插进来就可解码」的，这个字段就是判据
      completeAtInsert: img.complete,
      naturalWidthAtInsert: img.naturalWidth,
      loadAt: null,
      loadNaturalWidth: null,
      errorAt: null,
      decodedAt: null,
      decodedNaturalWidth: null,
      decodeFailedAt: null,
      decodeError: null,
    }
    seenImgs.set(img, rec)
    window.__iconLog.imgs.push(rec)
    img.addEventListener('load', () => {
      rec.loadAt = performance.now()
      rec.loadNaturalWidth = img.naturalWidth
    })
    img.addEventListener('error', () => {
      rec.errorAt = performance.now()
    })
    if (typeof img.decode === 'function') {
      img.decode().then(
        () => {
          rec.decodedAt = performance.now()
          rec.decodedNaturalWidth = img.naturalWidth
        },
        (e) => {
          rec.decodeFailedAt = performance.now()
          rec.decodeError = String(e).slice(0, 120)
        },
      )
    }
  }

  const seenInitials = new WeakMap()
  function watchInitial(span) {
    if (seenInitials.has(span))
      return
    const rec = {
      ...cellMetaOf(span),
      tag: 'span.tile-initial',
      text: (span.textContent || '').trim().slice(0, 4),
      addedAt: performance.now(),
      removedAt: null,
    }
    seenInitials.set(span, rec)
    window.__iconLog.initials.push(rec)
  }

  function scanIcons(node) {
    if (node.nodeType !== 1)
      return
    try {
      if (node.matches?.('img.tile-icon'))
        watchImg(node)
      if (node.matches?.('span.tile-initial'))
        watchInitial(node)
      node.querySelectorAll?.('img.tile-icon')?.forEach(watchImg)
      node.querySelectorAll?.('span.tile-initial')?.forEach(watchInitial)
    }
    catch (e) {
      window.__iconLog.errors.push(`scanIcons: ${String(e)}`)
    }
  }

  function installIconWatch() {
    scanIcons(document.documentElement)
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes)
          scanIcons(n)
        for (const n of m.removedNodes) {
          // 首字母被真图标顶掉的那一刻：元素已经脱离 DOM，只能按 WeakMap 认身份
          const rec = n.nodeType === 1 ? seenInitials.get(n) : null
          if (rec && n.matches?.('span.tile-initial'))
            rec.removedAt = performance.now()
        }
      }
    })
    mo.observe(document.documentElement, { subtree: true, childList: true })
  }

  if (document.documentElement) {
    installIconWatch()
  }
  else {
    const iv = setInterval(() => {
      if (document.documentElement) {
        clearInterval(iv)
        installIconWatch()
      }
    }, 0)
  }

  /**
   * 逐 rAF 帧记录每格图标（img 或首字母）、第二拍 `.tile-pulse`、
   * 以及磁贴格本身的 computed 动作状态。
   * 这是「动了多少」的原始证据：CSS 里写了什么不算数，实测值才算。
   *
   * 注意：rAF 在页面完全静止时可能不再回调（headless 尤其明显），
   * 所以 trace 的覆盖范围要单独检查（traceDegraded / traceEndMs）。
   */
  function traceTick() {
    try {
      const waveStart = window.__waveStart
      const log = window.__iconLog
      if (waveStart !== null) {
        const t = performance.now() - waveStart
        // 入场刚开始时也拍两次「是不是被藏起来了」：reduce 模式下 delay 必须已经被清掉，
        // 否则这些格子在 delay 期间就是 opacity 0（用户看到的是「啪、啪、啪」分几次瞬现）
        const marks = log.earlyMarks ?? (log.earlyMarks = {})
        for (const mark of [30, 120]) {
          if (!marks[`t${mark}`] && t >= mark)
            marks[`t${mark}`] = window.__settleProbe()
        }
        if (t >= 0 && t <= log.traceWindowMs && log.trace.length < 400) {
          const cells = document.querySelectorAll('.tile-cell')
          const snap = []
          for (const cell of cells) {
            const icon = cell.querySelector('img.tile-icon, span.tile-initial')
            const kind = icon ? (icon.classList.contains('tile-icon') ? 'img' : 'initial') : null
            const motion = icon ? window.__motionRead(icon) : null
            const pulse = window.__motionRead(cell.querySelector('.tile-pulse'))
            snap.push({
              id: cell.dataset.shortcutId ?? '<add>',
              kind,
              opacity: motion ? motion.opacity : null,
              x: motion ? motion.x : null,
              y: motion ? motion.y : null,
              sx: motion ? motion.sx : null,
              rotateDeg: motion ? motion.rotateDeg : null,
              filter: motion ? motion.filter : null,
              transform: motion ? motion.transform : null,
              scaleProp: motion ? motion.scale : null,
              translateProp: motion ? motion.translate : null,
              pulseOpacity: pulse ? pulse.opacity : null,
              pulseScale: pulse ? pulse.sx : null,
              cellY: null,
              complete: kind === 'img' ? icon.complete : null,
              naturalWidth: kind === 'img' ? icon.naturalWidth : null,
            })
          }
          const firstCell = document.querySelector('.tile-cell')
          const cellMotion = firstCell ? window.__motionRead(firstCell) : null
          if (snap[0] && cellMotion)
            snap[0].cellY = cellMotion.y
          log.trace.push({ t: +t.toFixed(1), cells: snap })
        }
        if (log.traceEndMs === undefined || t > (log.traceEndMs ?? -1))
          log.traceEndMs = +t.toFixed(1)
      }
    }
    catch (e) {
      window.__iconLog.errors.push(`traceTick: ${String(e)}`)
    }
    requestAnimationFrame(traceTick)
  }
  if (opts && opts.liveTrace !== false)
    requestAnimationFrame(traceTick)
  window.__iconLog.traceEnabled = !(opts && opts.liveTrace === false)
}

/**
 * 把页面里的图标层取证拍平（在页面上下文执行），时刻统一换算成「相对起波」的毫秒。
 * 与 `__iconLog` 一样自包含：只读 window 上的探针数据。
 */
function harvestIconForensics() {
  const log = window.__iconLog
  const waveStart = window.__waveStart
  const rel = v => (v === null || v === undefined || waveStart === null || waveStart === undefined)
    ? null
    : +(v - waveStart).toFixed(1)
  const cellOf = id => (id === null || id === undefined ? '<add>' : id)
  return {
    installedAtMs: log ? +log.installedAt.toFixed(1) : null,
    waveStartMs: waveStart === null || waveStart === undefined ? null : +waveStart.toFixed(2),
    timelineAtWave: window.__timelineAtWave ?? null,
    clockOffsetAtWave: window.__clockOffsetAtWave ?? null,
    traceWindowMs: log?.traceWindowMs ?? null,
    traceEndMs: log?.traceEndMs ?? null,
    /** rAF 在页面静止后不再回调：trace 没覆盖满窗口就是降级的，结论要打折 */
    traceDegraded: log?.traceEndMs === undefined ? null : log.traceEndMs < (log.traceWindowMs - 150),
    traceEnabled: log?.traceEnabled ?? null,
    cacheClearedAtDocumentStart: log?.cacheClearedAtDocumentStart ?? null,
    // 注意：这两个都挂在 window 上（不在 __iconLog 里）
    animCollect: window.__animCollect ?? null,
    animMeta: window.__animMeta ?? [],
    animRefCount: window.__animRefs ? window.__animRefs.size : null,
    earlyMarks: log?.earlyMarks ?? null,
    errors: (log?.errors ?? []).slice(0, 20),
    imgs: (log?.imgs ?? []).map(r => ({
      ...r,
      addedRelMs: rel(r.addedAt),
      loadRelMs: rel(r.loadAt),
      decodedRelMs: rel(r.decodedAt),
      errorRelMs: rel(r.errorAt),
      decodeFailedRelMs: rel(r.decodeFailedAt),
      addedAt: undefined,
      loadAt: undefined,
      decodedAt: undefined,
      errorAt: undefined,
      decodeFailedAt: undefined,
    })),
    initials: (log?.initials ?? []).map(r => ({
      ...r,
      addedRelMs: rel(r.addedAt),
      removedRelMs: rel(r.removedAt),
      addedAt: undefined,
      removedAt: undefined,
    })),
    trace: (log?.trace ?? []).map(f => ({
      t: f.t,
      cells: f.cells.map(c => ({ cellKey: cellOf(c.id), ...c, id: undefined })),
    })),
  }
}

async function setStorage(key, value) {
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k]: v }), [key, value])
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

/** 网格在视口里的裁剪框（含入场上浮余量），让逐帧图只对准磁贴带 */
async function gridClip() {
  return page.evaluate(() => {
    const el = document.querySelector('.grid-root')
    if (!el)
      return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = el.getBoundingClientRect()
    const x = Math.max(0, Math.floor(r.left - 16))
    const y = Math.max(0, Math.floor(r.top - 24))
    return {
      x,
      y,
      width: Math.max(1, Math.min(vw - x, Math.ceil(r.width + 32))),
      height: Math.max(1, Math.min(vh - y, Math.ceil(r.height + 40))),
    }
  })
}

/**
 * 等一轮入场彻底跑完。
 * `reload: false` 用于**被采样的那一次加载**：那一次已经由 `page.goto()` 起来了，
 * 再 reload 一次会把它的现场（探针记录）冲掉。
 */
async function loadNewTab({ reload = true } = {}) {
  if (reload)
    await page.reload()
  await page.waitForSelector('.grid-root.is-waved', { timeout: 15000 })
  await page.waitForSelector('[data-test="shortcut-grid"]')
  await waitForFonts()
  // 入场最长（v3：延迟上限 + 340/400ms + 余量）；settleMs 默认 1200ms，够全部落定
  await sleep(settleMs)
}

/* ================= 第 0 阶段：两份 favicon 缓存的状态 ================= */
/**
 * `/_favicon/` 是**页面级**资源、而且 Chrome 按**浏览历史**解析图标，
 * 所以「图标能不能出现」由两份独立的缓存共同决定：
 *   - Chrome 自己的图标库（由「有没有访问过这个站」决定，本脚本靠真的访问一遍来种）；
 *   - 页面里的 faviconCache（localStorage，同步命中才会「首帧就是真图标」）。
 * 只热一份就下结论会误导，所以两份都量、都写进报告。
 */
const favicon = {
  mode: faviconMode,
  sites: siteSet,
  visitSites,
  cacheKey: FAVICON_CACHE_KEY,
  visited: null,
  dbProbeBefore: null,
  dbProbeAfter: null,
  warmup: null,
  cacheClear: null,
  cacheBeforeSample: null,
  cacheAfterSample: null,
}

// 0.1 storage 由 service worker 直接种。
// 关键：**不能在采样加载之前先加载一次 newtab** —— 那一次就会把 faviconCache 写热，
// 后面量到的「cold」其实已经是第二次打开了。
await sw.evaluate(
  payload => chrome.storage.local.set(payload),
  { 'meridiem-shortcuts': JSON.stringify(SHORTCUTS), 'meridiem-theme': theme },
)
favicon.storageReadback = await sw.evaluate(
  () => chrome.storage.local.get(['meridiem-shortcuts', 'meridiem-theme']),
)

// 0.2 Chrome 图标库：warm / swap 先真的访问一遍站点（fresh profile 的图标库本来就是空的）
favicon.dbProbeBefore = await faviconDbProbe(SHORTCUTS)
if (faviconMode !== 'cold' && visitSites) {
  favicon.visited = await visitSitesForFaviconDb(SHORTCUTS)
  favicon.dbProbeAfter = await faviconDbProbe(SHORTCUTS)
}

// 0.3 faviconCache（localStorage）
if (faviconMode === 'warm') {
  // 正常打开一次（document_start 先清空），让每个站点的判定结果 + 图标字节落进缓存；
  // 采样加载就会命中它 —— 这才是「真实用户第二次打开」那条路
  favicon.warmup = await warmFaviconCachePass()
  favicon.cacheBeforeSample = favicon.warmup.final
  favicon.cacheClear = null
}
else {
  // cold（首次打开）/ swap（图标已知但本页无缓存）：采样前必须清干净。
  // 光在这里清还不够：这个 helper 页面自己（以及后面的 goto）都可能再写一次，
  // 所以采样文档还会在 document_start 再清一次（见 addInitScript 的 clearFaviconCache）。
  favicon.cacheClear = await clearFaviconCacheOnExtensionPage()
  favicon.cacheBeforeSample = favicon.cacheClear.afterSummary
}

/* ================= 第 1 阶段：视觉与指标（这一次加载就是被采样的那一次） ================= */
// 采样页**最后**创建（原因见 createSamplePage 的说明：helper 标签页会把前台状态带走，
// headless 下那会同时节流 rAF 和 setTimeout，量到的帧率就全是假的）
page = await createSamplePage()
// 无障碍对照：按系统「减少动态效果」跑。必须在采样加载**之前**设好，
// 因为页面会在首帧读 matchMedia —— 设晚了量到的还是普通模式。
if (withReducedMotion)
  await page.emulateMedia({ reducedMotion: 'reduce' })
await page.bringToFront()
await page.goto(newTabUrl)
await page.waitForSelector('[data-test="search-input"]')
await loadNewTab({ reload: false })

favicon.cacheAfterSample = summarizeFaviconCache(await readFaviconCacheRaw(page))
const iconForensicsRaw = await page.evaluate(harvestIconForensics)

/* ---- 1b. 落定态 + reduce 对照的原始读数 ---- */
const settleRaw = await page.evaluate(() => ({
  settle: window.__settleProbe(),
  early: window.__iconLog?.earlyMarks ?? null,
  // 采样页当时到底算不算「可见/聚焦」：rAF 与 setTimeout 的节流全看这个，
  // 不记下来就没法分辨「页面卡」和「测量装置被节流」
  visibility: { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() },
}))

/**
 * 「有没有东西停在半途」的判据（按层分开，因为各层的**正确结束态并不一样**）：
 *   - `.tile-cell` / `.tile-icon`|`.tile-initial` / `.tile-name`：结束态是 opacity 1 +
 *     translate/scale/rotate 全部 `none`（v3 起全走独立属性，transform 也一并查）；
 *   - `.tile-pulse`（第二拍那圈光）与 `.tile-face::after`（高光）：**结束态就是不可见**，
 *     opacity 必须是 0 —— 它们的 fill:both 会留下 `scale: 1.5`，但 opacity 为 0 就不可见，
 *     所以对这两层只查「可见度」，不查残留 transform（那是有意保留的结束态）。
 */
function checkSettleState(probe) {
  const violations = []
  const visibleMidway = []
  /**
   * 「中性值」判定：动画用 fill:both 一直填着，结束帧写的是 `none`/`0`，
   * 但 Chromium 的 computed 值会落到**中性形态**上（实测 v3：
   * 图标 `translate: 0px` / `scale: 1` / `rotate: 0deg`，磁贴 `translate: 0px`）。
   * 这些和 `none` 在视觉与层叠上下文上等价，所以都算「已落定」——
   * 判据写严了会把正确实现判成失败（上一轮就是这么误报了 9 条）。
   */
  const neutral = (prop, v) => {
    if (v === null || v === undefined || v === '')
      return true
    const s = String(v).trim()
    if (s === 'none')
      return true
    if (/^0(?:px|%|deg|rad|turn)?$/.test(s))
      return true
    if (/^(?:0(?:px|%|deg|rad|turn)?\s+)+0(?:px|%|deg|rad|turn)?$/.test(s))
      return true
    if (prop === 'scale' && /^1(?:\s+1)?$/.test(s))
      return true
    return false
  }
  for (const c of probe.cells) {
    const label = c.id
    for (const [layer, v] of [['cell', c.cell], ['icon', c.icon], ['name', c.name]]) {
      if (!v)
        continue
      if (v.opacity < 0.999)
        violations.push(`${label} ${layer}.opacity=${v.opacity}（应当已落定为 1）`)
      for (const prop of ['translate', 'scale', 'rotate', 'transform']) {
        if (!neutral(prop, v[prop]))
          violations.push(`${label} ${layer}.${prop}=${v[prop]}（应当已回到 none / 中性值）`)
      }
      if (v.opacity > 0.02 && v.opacity < 0.98)
        visibleMidway.push(`${label} ${layer}.opacity=${v.opacity}`)
    }
    // 一次性装饰层：结束态必须看不见（`.tile-pulse` 的 scale: 1.5 是有意保留的结束态）
    if (c.pulse && c.pulse.opacity > 0.01)
      violations.push(`${label} .tile-pulse.opacity=${c.pulse.opacity}（一次性光，结束态应当是 0）`)
    if (c.sheen && c.sheen.opacity > 0.01)
      violations.push(`${label} 高光 opacity=${c.sheen.opacity}（一次性高光，结束态应当是 0）`)
  }
  return { violations, visibleMidway }
}

/** reduce 模式下「有没有格子在 delay 期间被藏起来」：早期快照里任何主层 opacity 都不该是 0 */
function checkNotHiddenEarly(early) {
  const offenders = []
  for (const [mark, probe] of Object.entries(early ?? {})) {
    for (const c of probe.cells) {
      for (const [layer, v] of [['cell', c.cell], ['icon', c.icon], ['name', c.name]]) {
        if (v && v.opacity < 0.999)
          offenders.push(`${mark} ${c.id} ${layer}.opacity=${v.opacity}`)
      }
    }
  }
  return offenders
}

const reducedMotion = {
  emulated: withReducedMotion,
  mediaMatchesAtSettle: settleRaw.settle.isReducedMotion,
  earlySampleMarks: Object.keys(settleRaw.early ?? {}),
  early: settleRaw.early,
  settle: settleRaw.settle,
  finalCheck: checkSettleState(settleRaw.settle),
  earlyCheck: checkNotHiddenEarly(settleRaw.early),
  note: '早期待拍点（t≈30ms / t≈120ms）用来判「reduce 下有没有格子在 delay 期间被藏起来」；'
  + 'settle 是入场跑完后的落定态。reduce 时全局规则会把 animation-duration 压到 0.01ms、delay 清 0（见 src/styles/main.css）。',
}
/**
 * reduce 的断言拆成两条**互相独立**的：
 *   1. delayCleared —— 所有入场动画的 delay 是不是真的 0（「delay 期间不可能藏东西」的**结构性**证据）；
 *   2. settledAtEnd —— 入场结束后有没有元素停在半途（落定态断言）。
 * 上一版把「早期待拍点上仍有元素处于 0% 关键帧」直接记成 FAIL —— 那是把**另一种现象**
 * （reduce 只压时长、不摘动画，第一帧仍可能落在 0% 上）错记成了 delay 没清。
 * 两者必须分开说，否则结论会指向错误的修改方向。
 */
if (withReducedMotion) {
  const reduceAnims = (iconForensicsRaw.animMeta ?? []).filter(a => typeof a.delayMs === 'number' && a.kind !== 'transition')
  const offendingDelays = reduceAnims.filter(a => a.delayMs > 0).map(a => `${a.target}:${a.delayMs}ms`)
  /**
   * 结构证据优先用**层叠**里的值（settle.cells[].anim）：reduce 下动画只活 0.01ms，
   * 靠 rAF 收集只能抓到个位数条 —— 那是采样不足，不是「delay 清干净了」的证据。
   * computed 的 animation-delay/duration 来自 CSS 层叠，跟动画跑到哪个相无关，稳。
   */
  const layers = []
  for (const c of settleRaw.settle.cells) {
    for (const [layer, v] of Object.entries(c.anim ?? {})) {
      if (v)
        layers.push({ id: c.id, layer, ...v })
    }
  }
  const delayedLayers = layers.filter(l => !/^0s?(?:,\s*0s?)*$/.test(l.delay.trim()))
  const durationOf = l => l.duration.trim()
  const delayCleared = (reduceAnims.length > 0 || layers.length > 0) && delayedLayers.length === 0
  const settledOk = reducedMotion.finalCheck.violations.length === 0
  reducedMotion.reduceAnims = {
    collectedAnimations: reduceAnims.length,
    collectedNames: [...new Set(reduceAnims.map(a => a.animationName))],
    computedLayerCount: layers.length,
    computedDurationValues: [...new Set(layers.map(durationOf))].slice(0, 6),
    computedDelayValues: [...new Set(layers.map(l => l.delay.trim()))].slice(0, 6),
    offendingDelays,
    note: 'computed* 来自 CSS 层叠（与动画处于哪个相无关），collected* 是 rAF 收集到的动画对象；'
    + 'reduce 下动画只活 0.01ms，所以结构结论以 computed* 为准',
  }
  reducedMotion.verdict = {
    delayCleared: delayCleared
      ? `PASS（${layers.length} 个图层的 computed animation-delay 全为 0s → delay 期间不可能藏住任何东西）`
      : `FAIL（仍有图层带 delay：${delayedLayers.slice(0, 5).map(l => `${l.id}.${l.layer}:${l.delay}`).join(', ')}）`,
    settledAtEnd: settledOk
      ? 'PASS（落定态：磁贴/图标/站名的 translate·scale·rotate·transform 全为 none，pulse 不可见）'
      : `FAIL（落定残留 ${reducedMotion.finalCheck.violations.length} 条：${reducedMotion.finalCheck.violations.slice(0, 3).join(' | ')}）`,
    firstFramesObservation: reducedMotion.earlyCheck.length > 0
      ? `观察（不是 delay 违规）：入场开始后的最初几个合成帧里仍有 ${reducedMotion.earlyCheck.length} 处主层 opacity<1，`
      + '即落在 0% 关键帧上 —— 见 iconForensics.hiddenSpan'
      : '未观察到（入场最早的那一帧就已经是落定态）',
    overall: (delayCleared && settledOk) ? 'PASS' : 'FAIL',
  }
}
else {
  reducedMotion.verdict = 'NOT-ASSERTED（本轮不是 reduce 模式，只留原始读数作对照）'
}

/* ---- 2.1 网格 + 动画分组 ---- */
const metrics = await page.evaluate(() => {
  const grid = document.querySelector('.tile-grid')
  const cells = [...document.querySelectorAll('.tile-cell')]
  const cs = el => getComputedStyle(el)
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []
    return `${el.tagName.toLowerCase()}${cls.map(c => `.${c}`).join('')}`
  }
  const entries = window.__gridAnims().map(({ a, hit }) => {
    const timing = a.effect.getTiming()
    const style = hit.pseudo ? getComputedStyle(hit.el, hit.pseudo) : cs(hit.el)
    const cell = hit.el.closest('.tile-cell')
    const cls = typeof hit.el.className === 'string' ? hit.el.className.split(/\s+/).filter(Boolean) : []
    const startTime = Number.isFinite(a.startTime) ? +a.startTime.toFixed(2) : null
    /**
     * 逐段缓动只能从关键帧上取。
     *
     * `effect.getTiming().easing` 对 CSS 动画给的是**动画级**那条曲线，
     * 而这条编排是逐段手写的（每段写在自己离开的那个关键帧上，这是 CSS 的规矩），
     * 所以只看 getTiming() 会把整条动画的节奏读成一条曲线 —— 甚至读成 linear。
     * 真正的逐段曲线在 `getKeyframes()[i].easing`：它管的是
     * 「第 i 个关键帧 → 第 i+1 个关键帧」这一段。
     */
    let keyframes = null
    try {
      keyframes = a.effect.getKeyframes().map(k => ({
        computedOffset: typeof k.computedOffset === 'number' ? +k.computedOffset.toFixed(4) : null,
        offset: typeof k.offset === 'number' ? k.offset : k.offset,
        easing: k.easing ?? null,
        composite: k.composite ?? null,
      }))
    }
    catch {
      keyframes = null
    }
    const easingSegments = keyframes
      ? keyframes.slice(0, -1).map((k, i) => ({
        fromPct: k.computedOffset === null ? null : +(k.computedOffset * 100).toFixed(2),
        toPct: keyframes[i + 1].computedOffset === null ? null : +(keyframes[i + 1].computedOffset * 100).toFixed(2),
        easing: k.easing ?? null,
      }))
      : null
    return {
      target: `${describe(hit.el)}${hit.pseudo ?? ''}`,
      targetBase: describe(hit.el),
      pseudo: hit.pseudo,
      /** 这条动画挂在图标层的哪一支上（img = 真图标 / initial = 首字母回退） */
      iconKind: cls.includes('tile-icon') ? 'img' : (cls.includes('tile-initial') ? 'initial' : null),
      tag: hit.el.tagName.toLowerCase(),
      cellId: cell ? (cell.dataset.shortcutId ?? null) : null,
      cellIndex: cell ? Number(cell.dataset.tileIndex ?? -1) : null,
      inAddCell: cell ? !cell.dataset.shortcutId : false,
      animationName: style.animationName,
      durationMs: timing.duration,
      delayMs: timing.delay,
      fill: timing.fill,
      /** 动画级曲线（getTiming 只能给到这一层；逐段曲线看 easingSegments） */
      animationEasing: timing.easing,
      easing: timing.easing,
      easingNote: 'easing = effect.getTiming().easing（动画级）；逐段曲线看 easingSegments / keyframes[].easing',
      keyframes,
      easingSegments,
      iterations: timing.iterations,
      playState: a.playState,
      startTime,
      /** 动画**真正开始**的时刻（相对起波）—— 晚插入的元素会重新计时，这个数会明显偏大 */
      startTimeRelWaveMs: (startTime !== null && window.__timelineAtWave !== null && window.__timelineAtWave !== undefined)
        ? +(startTime - window.__timelineAtWave).toFixed(1)
        : null,
      currentTime: Number.isFinite(a.currentTime) ? +a.currentTime.toFixed(2) : null,
    }
  })

  // 按「target class + 伪元素 + name/duration/fill/easing」分组，列出这一组出现过的延迟
  const groups = new Map()
  for (const e of entries) {
    const key = `${e.target}|${e.animationName}|${e.durationMs}|${e.fill}|${e.easing}`
    if (!groups.has(key)) {
      groups.set(key, {
        target: e.target,
        animationName: e.animationName,
        durationMs: e.durationMs,
        fill: e.fill,
        animationEasing: e.animationEasing,
        /** 逐段缓动（来自 getKeyframes，不是 getTiming） */
        easingSegments: e.easingSegments,
        keyframes: e.keyframes,
        delaysMs: [],
        count: 0,
        exampleCellIds: [],
      })
    }
    const g = groups.get(key)
    g.count++
    if (!g.delaysMs.includes(e.delayMs))
      g.delaysMs.push(e.delayMs)
    if (g.exampleCellIds.length < 4)
      g.exampleCellIds.push(e.cellId ?? (e.inAddCell ? '<add>' : `<idx=${e.cellIndex}>`))
  }

  const rootStyle = cs(document.documentElement)
  return {
    viewportActual: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      narrowMediaQuery: window.matchMedia('(max-width: 768px)').matches,
    },
    columns: grid ? cs(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
    gridTemplateColumns: grid ? cs(grid).gridTemplateColumns : null,
    tileCellCount: cells.length,
    shortcutTileCount: document.querySelectorAll('.tile-cell .tile').length,
    rows: grid ? new Set(cells.map(c => Math.round(c.getBoundingClientRect().top))).size : 0,
    tokens: {
      durEnter: rootStyle.getPropertyValue('--dur-enter').trim(),
      durBase: rootStyle.getPropertyValue('--dur-base').trim(),
    },
    cells: cells.map((c, i) => ({
      index: i,
      id: c.dataset.shortcutId ?? null,
      isAddCell: !c.dataset.shortcutId,
      delayVar: c.style.getPropertyValue('--tile-enter-delay').trim() || null,
      animationName: cs(c).animationName,
      animationDelay: cs(c).animationDelay,
      animationDuration: cs(c).animationDuration,
      // v2 起磁贴格本身用独立属性 translate（transform 保持 none）；
      // 三代字段都留着，「按属性读」和「按矩阵读」两条路都能量到
      transformAtRest: cs(c).transform,
      translateAtRest: cs(c).translate,
      scaleAtRest: cs(c).scale,
      rotateAtRest: cs(c).rotate,
      opacityAtRest: cs(c).opacity,
      rect: (() => {
        const r = c.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })(),
    })),
    animations: entries,
    animationGroups: [...groups.values()].map(g => ({ ...g, delaysMs: g.delaysMs.sort((a, b) => a - b) })),
  }
})

/* ---- 2.2 rAF + 计时器抖动：入场窗口的帧率与主线程占用 ---- */
const raf = await page.evaluate(() => {
  const waveStart = window.__waveStart
  const windowEnd = (waveStart ?? 0) + 1200
  const stats = (frames, source) => {
    const inWindow = frames.filter(t => waveStart !== null && t >= waveStart && t <= windowEnd)
    const deltas = []
    for (let i = 1; i < inWindow.length; i++)
      deltas.push(+(inWindow[i] - inWindow[i - 1]).toFixed(2))
    const long = deltas.filter(d => d > 20)
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null
    return {
      source,
      sampledFrames: inWindow.length,
      totalFrames: frames.length,
      framesBeforeWave: waveStart === null ? null : frames.filter(t => t < waveStart).length,
      firstFrameMs: frames.length ? +frames[0].toFixed(2) : null,
      lastFrameMs: frames.length ? +frames[frames.length - 1].toFixed(2) : null,
      spanMs: inWindow.length ? +(inWindow[inWindow.length - 1] - inWindow[0]).toFixed(2) : null,
      avgFrameMs: avg === null ? null : +avg.toFixed(2),
      avgFps: avg ? +(1000 / avg).toFixed(1) : null,
      longFrameCount: long.length,
      maxFrameMs: deltas.length ? Math.max(...deltas) : null,
      longDeltas: long,
      deltas,
    }
  }
  const r = stats(window.__rafFrames ?? [], 'requestAnimationFrame')
  return {
    ...r,
    waveStartMs: waveStart === null ? null : +waveStart.toFixed(2),
    // 跨轮可比的那条：不依赖合成帧，只看主线程有没有被占住
    jank: stats(window.__jankFrames ?? [], 'setTimeout(16)'),
    note: 'window = [is-waved 起, +1200ms]。rAF 的帧数取决于这段编排让画面动了多久'
    + '（headless 下页面静止就不再产帧），所以 sampledFrames / avgFps **不能跨轮直接比**；'
    + '跨轮比 maxFrameMs / longFrameCount，以及 jank（setTimeout 口径）。',
  }
})

/* ---- 2.3 逐帧胶片条 ---- */
const frames = []
let freezeRefs = null
let refsOk = false
if (withFrames) {
  /**
   * 定格：遍历 init script 在**入场期间**收下的引用集合。
   * 不能用「此刻再 getAnimations()」——`fill: backwards` 的入场动画跑完就
   * 从那里消失了（见 startAnimCollect 的说明）。
   */
  freezeRefs = await page.evaluate(() => {
    const refs = [...(window.__animRefs ?? [])]
    refs.forEach(a => a.pause())
    return {
      count: refs.length,
      liveAtPauseTime: window.__gridAnims().length,
      collect: window.__animCollect ?? null,
    }
  })
  refsOk = freezeRefs.count > 0
  console.log(`  paused ${freezeRefs.count} grid animations（入场期间收下的引用；此刻现场只剩 ${freezeRefs.liveAtPauseTime} 条）`)
  if (!refsOk) {
    // 明确失败，而不是静默产出一堆「看起来是落定态」的假帧
    problems.push('定格失败：入场期间没有收到任何动画引用（__animRefs.size === 0）。'
    + '常见原因是 fill-mode 从 both 改成 backwards、或起波检测失效 —— '
    + '此时逐帧图只会是落定态，因此跳过逐帧/轨迹采样并以非零码退出。')
    console.error('  !! 定格失败：__animRefs 为空 —— 跳过逐帧与图层轨迹采样（不产出假帧）')
  }
}

if (withFrames && refsOk) {
  const clip = await gridClip()
  console.log(`  freeze clip ${JSON.stringify(clip)}`)

  for (let t = from; t <= to; t += step) {
    const state = await page.evaluate((time) => {
      window.__animRefs.forEach((a) => {
        a.currentTime = time
      })
      document.documentElement.getBoundingClientRect()
      const cells = [...document.querySelectorAll('.tile-cell.is-entering')]
      const sample = cells.map(c => window.__motionRead(c))
      const icon = cells[0] ? cells[0].querySelector('.tile-icon, .tile-initial') : null
      const iconMotion = icon ? window.__motionRead(icon) : null
      const cell0 = sample[0] ?? null
      return {
        // v1 只有 transform；v2 起磁贴格与图标都走独立属性，两代字段都给
        firstCellTransform: cell0 ? cell0.transform : null,
        firstCellTranslate: cell0 ? cell0.translate : null,
        firstCellOpacity: cell0 ? cell0.opacity : null,
        firstIconTransform: iconMotion ? iconMotion.transform : null,
        firstIconScale: iconMotion ? iconMotion.sx : null,
        firstIconRotateDeg: iconMotion ? iconMotion.rotateDeg : null,
        firstIconRiseY: iconMotion ? iconMotion.y : null,
        firstIconOpacity: iconMotion ? iconMotion.opacity : null,
        cellsLanded: sample.filter(s => s && s.opacity >= 0.5).length,
        total: sample.length,
        opacities: sample.map(s => (s ? s.opacity : null)),
        riseByCell: sample.map(s => (s ? s.y : null)),
        scaleByCell: sample.map(s => (s ? s.sx : null)),
      }
    }, t)

    const file = `frame-t${String(t).padStart(4, '0')}.png`
    const shot = await page.screenshot({ path: path.join(outDir, file), clip })
    frames.push({ t, file, b64: shot.toString('base64'), ...state })
    if (t === from || t === to)
      await page.screenshot({ path: path.join(outDir, `viewport-t${String(t).padStart(4, '0')}.png`) })
    console.log(`  frame t=${t}ms  landed=${state.cellsLanded}/${state.total}  first-cell opacity=${state.firstCellOpacity}  icon scale=${state.firstIconScale}`)
  }
}

/* ---- 2.3b 特写帧（--zoom）：图标只有 28px，整屏帧里读不出它的姿态 ---- */
const zoomFrames = []
let zoomClipRect = null
if (withFrames && withZoom) {
  zoomClipRect = await page.evaluate((idx) => {
    const cell = document.querySelectorAll('.tile-cell')[idx]
    if (!cell)
      return null
    const r = cell.getBoundingClientRect()
    const pad = 14
    const x = Math.max(0, Math.floor(r.left - pad))
    const y = Math.max(0, Math.floor(r.top - pad))
    return {
      x,
      y,
      width: Math.max(1, Math.min(window.innerWidth - x, Math.ceil(r.width + pad * 2))),
      height: Math.max(1, Math.min(window.innerHeight - y, Math.ceil(r.height + pad * 2))),
    }
  }, zoomTile)
  if (!zoomClipRect) {
    problems.push(`--zoom 指定的第 ${zoomTile} 格不存在`)
  }
  else {
    console.log(`  zoom clip ${JSON.stringify(zoomClipRect)} @dsf=${dsf}`)
    for (let t = zoomFrom; t <= zoomTo; t += zoomStep) {
      const state = await page.evaluate(({ time, idx }) => {
        window.__animRefs.forEach((a) => {
          a.currentTime = time
        })
        document.documentElement.getBoundingClientRect()
        const cell = document.querySelectorAll('.tile-cell')[idx]
        if (!cell)
          return null
        const icon = cell.querySelector('img.tile-icon, span.tile-initial')
        const motion = window.__motionRead(icon)
        const pulse = window.__motionRead(cell.querySelector('.tile-pulse'))
        const cellMotion = window.__motionRead(cell)
        return {
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          iconOpacity: motion ? motion.opacity : null,
          iconScale: motion ? motion.sx : null,
          iconRotateDeg: motion ? motion.rotateDeg : null,
          iconRiseY: motion ? motion.y : null,
          pulseOpacity: pulse ? pulse.opacity : null,
          pulseScale: pulse ? pulse.sx : null,
          cellOpacity: cellMotion ? cellMotion.opacity : null,
          cellY: cellMotion ? cellMotion.y : null,
        }
      }, { time: t, idx: zoomTile })
      const file = `zoom-t${String(t).padStart(4, '0')}.png`
      const shot = await page.screenshot({ path: path.join(outDir, file), clip: zoomClipRect })
      zoomFrames.push({ t, file, b64: shot.toString('base64'), ...state })
    }
    console.log(`  zoom frames ${zoomFrames.length}（t=${zoomFrom}…${zoomTo} step ${zoomStep}，第 ${zoomTile} 格）`)
  }
}

/* ---- 2.4 图层轨迹（默认 t=0…1000 step 25，逐格 + 「+」格 + 第二拍 .tile-pulse） ---- */
const iconTrack = []
if (withFrames && refsOk) {
  for (let t = 0; t <= iconTo; t += iconStep) {
    const s = await page.evaluate((time) => {
      window.__animRefs.forEach((a) => {
        a.currentTime = time
      })
      document.documentElement.getBoundingClientRect()
      const num = v => +Number(v).toFixed(3)
      /**
       * 一格的完整动作读数。旧字段名（iconTransform/iconScale/iconRiseY/…）
       * 全部保留但换成「合并后的有效值」，这样 g1 与 g2 是同一口径可比：
       *   - iconScale  = 有效缩放（v2 从 `scale` 属性来，v1 从 transform 矩阵来）
       *   - iconRiseY  = 有效纵向位移（v2 从 `translate` 来，v1 从矩阵来）
       */
      const readCell = (cell) => {
        if (!cell)
          return null
        const icon = cell.querySelector('.tile-icon, .tile-initial')
        const pulse = cell.querySelector('.tile-pulse')
        const motion = window.__motionRead(icon)
        const pulseMotion = window.__motionRead(pulse)
        const name = window.__motionRead(cell.querySelector('.tile-name'))
        const sheen = window.__motionRead(cell.querySelector('.tile-face'), '::after')
        return {
          iconKind: icon ? (icon.classList.contains('tile-icon') ? 'img.tile-icon' : 'span.tile-initial') : null,
          iconTransform: motion ? motion.transform : null,
          iconTranslate: motion ? motion.translate : null,
          iconScaleProp: motion ? motion.scale : null,
          iconRotateProp: motion ? motion.rotate : null,
          iconScale: motion ? motion.sx : null,
          iconRotateDeg: motion ? motion.rotateDeg : null,
          iconRiseY: motion ? motion.y : null,
          iconOpacity: motion ? motion.opacity : null,
          iconFilter: motion ? motion.filter : null,
          iconNaturalWidth: icon && icon.tagName === 'IMG' ? icon.naturalWidth : null,
          pulseOpacity: pulseMotion ? pulseMotion.opacity : null,
          pulseScale: pulseMotion ? pulseMotion.sx : null,
          nameOpacity: name ? name.opacity : null,
          nameTranslate: name ? num(name.y) : null,
          sheenOpacity: sheen ? sheen.opacity : null,
          sheenTransform: sheen ? sheen.transform : null,
        }
      }
      const cells = [...document.querySelectorAll('.tile-cell.is-entering')]
      const addBtn = document.querySelector('.add-tile')
      const addMotion = window.__motionRead(addBtn)
      return {
        t: time,
        cellsLanded: cells.filter(c => Number(getComputedStyle(c).opacity) >= 0.5).length,
        total: cells.length,
        c0: readCell(cells[0]),
        c1: readCell(cells[1]),
        add: addMotion
          ? {
              scale: addMotion.scale,
              scaleEffective: addMotion.sx,
              rotate: addMotion.rotate,
              translate: addMotion.translate,
              opacity: addMotion.opacity,
              filter: addMotion.filter,
              transform: addMotion.transform,
            }
          : null,
        /** 逐格完整轨迹（v2 起：「第 0/1 格」不够用了，脉冲/图标逐格都在动） */
        all: cells.map((c, i) => ({
          index: i,
          id: c.dataset.shortcutId ?? null,
          isAdd: !c.dataset.shortcutId,
          cellTranslate: getComputedStyle(c).translate,
          cellY: (window.__motionRead(c) || {}).y ?? null,
          ...readCell(c),
        })),
      }
    }, t)
    iconTrack.push(s)
  }
}

/* ---- 2.5 hover 回归（磁贴本体 / 「+」格 / 图层残留） ---- */
/**
 * 定格采样结束后，把动画推到结束之后、恢复播放并**等入场真正落定**，再做 hover 回归。
 *
 * 为什么必须补这一步：如果本轮是密集逐帧（例如 `--from=0 --to=320`），
 * 最后一次 seek 会把动画**暂停在半路**；此时读「静止态残留」读到的当然是半路的值，
 * 于是 `labelNoResidue` / `addScaleNoResidue` 会报 FAIL —— 那是采样时机的问题，
 * 不是产品回归（同一构建的对照组三次采样逐位相同，已经证明过）。
 * **一个会误报的断言比没有断言更危险**，所以这里既修时机、也加前置条件。
 */
async function settleAfterFreeze() {
  await page.evaluate(() => {
    const refs = [...(window.__animRefs ?? [])]
    for (const a of refs) {
      try {
        a.currentTime = 1e6 // 推到结束之后；fill:backwards 之下它就不再压住任何属性
        a.play()
      }
      catch {
        // 已经不可寻址的动画忽略即可
      }
    }
  })
  await sleep(800)
}

if (withFrames)
  await settleAfterFreeze()

function hoverProbe() {
  return page.evaluate(() => {
    const cs = el => getComputedStyle(el)
    const read = (el) => {
      if (!el)
        return null
      const style = cs(el)
      return {
        transform: style.transform,
        translateY: style.transform === 'none' ? 0 : +new DOMMatrixReadOnly(style.transform).m42.toFixed(2),
        scale: style.scale,
        opacity: +Number(style.opacity).toFixed(3),
        filter: style.filter,
        translate: style.translate,
      }
    }
    const cell = document.querySelector('.tile-cell[data-tile-index="0"]')
    const add = document.querySelector('.add-tile')
    return {
      face: read(cell?.querySelector('.tile-face')),
      cell: read(cell),
      icon: read(cell?.querySelector('.tile-icon, .tile-initial')),
      name: read(cell?.querySelector('.tile-name')),
      addTile: read(add),
      addCell: read(add?.closest('.tile-cell')),
      isEditing: Boolean(document.querySelector('.tile.is-editing')),
      /**
       * 前置条件：此刻还有没有**入场动画在跑**。
       * 落定残留类的断言只在「没有入场动画在跑」时才有意义；
       * 否则读到的是动画中间值，报 FAIL 是假阳性。
       */
      runningEntranceAnims: window.__gridAnims().filter(x => x.a.playState === 'running').length,
      liveEntranceAnims: window.__gridAnims().length,
    }
  })
}

const hover = { isEditing: (await hoverProbe()).isEditing }
hover.rest = await hoverProbe()
await page.hover('.tile-cell[data-tile-index="0"] .tile-face')
await sleep(500)
hover.hoverFace = await hoverProbe()
await page.screenshot({ path: path.join(outDir, 'hover-clip.png'), clip: await gridClip() })
await page.screenshot({ path: path.join(outDir, 'hover-viewport.png') })
await page.mouse.move(2, 2)
await sleep(500)
hover.restAfter = await hoverProbe()
await page.hover('.add-tile')
await sleep(500)
hover.hoverAdd = await hoverProbe()
if (withFrames && refsOk)
  await page.screenshot({ path: path.join(outDir, 'hover-add-clip.png'), clip: await gridClip() })
await page.mouse.move(2, 2)
await sleep(500)
hover.restAfterAdd = await hoverProbe()

/**
 * 落定残留类断言的**前置条件**：采样时不能有入场动画在跑。
 * 不满足就记 SKIP（而不是 PASS/FAIL）—— 否则密集逐帧那一轮会把「暂停在半路」
 * 读成「产品有残留」，制造假阳性。**一个会误报的断言比没有断言更危险。**
 */
const restSampleClean = Boolean(hover.rest) && hover.rest.runningEntranceAnims === 0
function residueGate(fn) {
  return restSampleClean
    ? fn()
    : `SKIP（静止态采样时仍有 ${hover.rest?.runningEntranceAnims ?? '?'} 条入场动画在跑，该断言不适用）`
}

hover.verdicts = {
  faceHoverLift: hover.rest && hover.hoverFace
    ? (hover.hoverFace.face.translateY < hover.rest.face.translateY - 2 ? 'PASS' : `FAIL (${hover.rest.face.translateY} → ${hover.hoverFace.face.translateY})`)
    : 'UNKNOWN',
  faceBackToRest: hover.restAfter && hover.rest
    ? (hover.restAfter.face.translateY === hover.rest.face.translateY ? 'PASS' : `FAIL (rest ${hover.rest.face.translateY} → 移开后 ${hover.restAfter.face.translateY})`)
    : 'UNKNOWN',
  addTileHoverLift: hover.rest && hover.hoverAdd
    ? (hover.hoverAdd.addTile.translateY < hover.rest.addTile.translateY - 2 ? 'PASS' : `FAIL (${hover.rest.addTile.translateY} → ${hover.hoverAdd.addTile.translateY})`)
    : 'UNKNOWN',
  addTileBackToRest: hover.restAfterAdd && hover.rest
    ? (hover.restAfterAdd.addTile.translateY === hover.rest.addTile.translateY ? 'PASS' : `FAIL (${hover.rest.addTile.translateY} → 移开后 ${hover.restAfterAdd.addTile.translateY})`)
    : 'UNKNOWN',
  iconNoResidue: residueGate(() => (Math.abs(hover.rest.icon.translateY) < 0.01 ? 'PASS' : `FAIL 残留位移 ${hover.rest.icon.translateY}`)),
  labelNoResidue: residueGate(() => (hover.rest.name.translate === 'none' || hover.rest.name.translate === '0px' ? 'PASS' : `FAIL 残留 translate ${hover.rest.name.translate}`)),
  cellNoResidue: residueGate(() => (hover.rest.cell.transform === 'none' || hover.rest.cell.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'PASS' : `FAIL 残留 transform ${hover.rest.cell.transform}`)),
  addScaleNoResidue: residueGate(() => (hover.rest.addTile.scale === 'none' || hover.rest.addTile.scale === '1' ? 'PASS' : `FAIL 残留 scale ${hover.rest.addTile.scale}`)),
}
/**
 * 落定残留类断言的**前置条件**：采样时不能有入场动画在跑。
 * 不满足就记 SKIP（而不是 PASS/FAIL）—— 否则密集逐帧那一轮会把「暂停在半路」
 * 读成「产品有残留」，制造假阳性。**一个会误报的断言比没有断言更危险。**
 */
hover.gate = {
  restSampleClean,
  runningEntranceAnimsAtRest: hover.rest?.runningEntranceAnims ?? null,
  liveEntranceAnimsAtRest: hover.rest?.liveEntranceAnims ?? null,
  note: 'restSampleClean=false 时，icon/label/cell/addScale 四条残留断言记 SKIP；'
  + '采样前会把动画推到结束之后并等 800ms 落定（settleAfterFreeze）',
}

/* ================= 第 2 阶段：延迟定格断言 ================= */
/* 用一次干净 reload 做，避免和上面的 seek/pause 互相干扰 */
let freezeCheck = null
if (withFreeze) {
  await loadNewTab()
  /** DOM 侧的定格读数（不含动画） */
  const domState = () => page.evaluate(() => {
    const cs = el => getComputedStyle(el)
    const cells = [...document.querySelectorAll('.tile-cell')]
    return {
      at: new Date().toISOString(),
      timelineNow: Number.isFinite(document.timeline.currentTime) ? +document.timeline.currentTime.toFixed(2) : null,
      cellCount: cells.length,
      cells: cells.map((c, i) => ({
        index: i,
        id: c.dataset.shortcutId ?? null,
        isAdd: !c.dataset.shortcutId,
        classes: c.className,
        isEntering: c.classList.contains('is-entering'),
        isFresh: c.classList.contains('is-fresh'),
        delayVar: c.style.getPropertyValue('--tile-enter-delay').trim(),
        animationName: cs(c).animationName,
        computedDelay: cs(c).animationDelay,
        opacity: +Number(cs(c).opacity).toFixed(3),
      })),
    }
  })

  /**
   * 「边收边改」：让页面**先开始**一段 rAF 收集，再在收集窗口里做变更，最后取回结果。
   *
   * 为什么必须重叠：`fill: backwards` 之下，`tile-fresh` 这类动画跑完就从
   * `getAnimations()` 消失；删/增一格触发的动画只存在它自己那 300~340ms 里。
   * 先变更、睡 400ms 再收集 = 收集窗口开始的时候动画早就没了 → 收不到任何东西，
   * 断言静默空转（上一轮就是这样：`collectNotVacuous` 报了 FAIL 才发现）。
   */
  async function snapshotDuring(mutate) {
    const collecting = page.evaluate(() => window.__collectAnimMeta(900))
    await sleep(80) // 让收集先真的跑起来，再变更
    await mutate()
    const collected = await collecting
    const dom = await domState()
    // 只把**真正的动画**当成「重新入场」的证据；过渡（getAnimations 也会返回）单独列出。
    // 不然元素身上的过渡会被误读成「入场动画又跑了一遍」（见 metaOfAnim 的说明）。
    const asFreezeAnim = m => ({
      key: `${m.cellId ?? '<add>'}::${m.target}::${m.animationName}`,
      cellId: m.cellId,
      inAddCell: m.inAddCell,
      target: m.target,
      name: m.animationName,
      startTime: m.startTime,
      currentTime: m.currentTimeMs,
      delayMs: m.delayMs,
      playState: m.playState,
      firstSeenRelWaveMs: m.firstSeenRelWaveMs,
    })
    const anims = collected.filter(m => m.kind !== 'transition').map(asFreezeAnim)
    const transitions = collected.filter(m => m.kind === 'transition').map(asFreezeAnim)
    return {
      ...dom,
      anims,
      transitions,
      collectedCount: collected.length,
      animationCount: anims.length,
      transitionCount: transitions.length,
      collectWindowMs: 900,
    }
  }

  const before = await snapshotDuring(async () => {})
  // ① 删掉第 2 条（删的过程中同时收集动画）
  const afterRemove = await snapshotDuring(() =>
    setStorage('meridiem-shortcuts', JSON.stringify(SHORTCUTS.filter(s => s.id !== REMOVE_ID))))
  // ② 再加一条全新的
  const afterAdd = await snapshotDuring(() =>
    setStorage('meridiem-shortcuts', JSON.stringify([...SHORTCUTS.filter(s => s.id !== REMOVE_ID), ADDED])))

  const diffStart = (a, b) => {
    const mapB = new Map(b.anims.map(x => [x.key, x]))
    const changed = []
    const missing = []
    for (const x of a.anims) {
      const y = mapB.get(x.key)
      if (!y) {
        missing.push({ key: x.key, startTimeBefore: x.startTime })
        continue
      }
      if (x.startTime !== y.startTime || x.currentTime !== y.currentTime)
        changed.push({ key: x.key, startTime: [x.startTime, y.startTime], currentTime: [x.currentTime, y.currentTime], delayMs: [x.delayMs, y.delayMs] })
    }
    const mapA = new Map(a.anims.map(x => [x.key, x]))
    const added = b.anims.filter(x => !mapA.has(x.key)).map(x => ({ key: x.key, startTime: x.startTime, delayMs: x.delayMs, playState: x.playState }))
    return { changed, missing, added }
  }

  const idDelays = s => Object.fromEntries(s.cells.filter(c => c.id).map(c => [c.id, c.delayVar]))
  /** 按 id 逐条比延迟：JSON.stringify 整串比会因「少了一条」而误报 CHANGED */
  const compareIdDelays = (a, b) => Object.keys(a)
    .filter(id => id in b && b[id] !== a[id])
    .map(id => ({ id, before: a[id], after: b[id] }))
  const delayChangedOnRemove = compareIdDelays(idDelays(before), idDelays(afterRemove))
  const delayChangedOnAdd = compareIdDelays(idDelays(afterRemove), idDelays(afterAdd))

  freezeCheck = {
    collectNote: '每张快照都在页面里跑 400ms 的 rAF 收集（__collectAnimMeta）——'
    + 'fill:backwards 之下入场动画跑完就消失，删/增一格触发的动画只在它自己的几百毫秒里存在，'
    + '现取 getAnimations() 会得到空表、让断言静默空转。',
    /**
     * 这批断言「有没有真的验到东西」的自检：
     * afterAdd 必须真的收到新动画（新增那一格的 tile-fresh / tile-icon-arrive）；
     * 若为 0，说明收集窗口什么都没抓到 —— 下面的 PASS 一律不可信，这条会直接标 FAIL。
     */
    collectNotVacuous: afterAdd.anims.length > 0
      ? `PASS（新增后收到 ${afterAdd.anims.length} 条新动画，收集链路有效）`
      : 'FAIL（新增后一条动画都没收到：断言在空转，下面的结论不可信）',
    removeTriggeredNoReentrance: afterRemove.anims.length === 0
      ? `PASS（删掉一格后没有任何新动画产生 —— 后面的格子没有被重新入场；同期有 ${afterRemove.transitionCount} 条过渡）`
      : `FAIL（删掉一格后有 ${afterRemove.anims.length} 条新动画：${afterRemove.anims.slice(0, 4).map(a => `${a.cellId ?? '<add>'}:${a.name}`).join(', ')}）`,
    addTouchedOnlyNewCell: (() => {
      const others = afterAdd.anims.filter(a => a.cellId !== ADDED.id && !a.inAddCell)
      return others.length === 0
        ? `PASS（新增只给新格挂了动画：${afterAdd.anims.map(a => a.name).join(', ')}）`
        : `FAIL（其它格也被触发了：${others.slice(0, 4).map(a => `${a.cellId}:${a.name}`).join(', ')}）`
    })(),
    collectedCounts: { before: before.collectedCount, afterRemove: afterRemove.collectedCount, afterAdd: afterAdd.collectedCount },
    /** 同时收到的过渡条数（getAnimations 会把过渡也算进来，它们不是「重新入场」） */
    transitionCounts: { before: before.transitionCount, afterRemove: afterRemove.transitionCount, afterAdd: afterAdd.transitionCount },
    before: { cellCount: before.cellCount, animCount: before.anims.length, timelineNow: before.timelineNow, idDelays: idDelays(before), cells: before.cells },
    afterRemove: { cellCount: afterRemove.cellCount, animCount: afterRemove.anims.length, timelineNow: afterRemove.timelineNow, idDelays: idDelays(afterRemove), cells: afterRemove.cells, removedIds: Object.keys(idDelays(before)).filter(id => !(id in idDelays(afterRemove))) },
    afterAdd: { cellCount: afterAdd.cellCount, animCount: afterAdd.anims.length, timelineNow: afterAdd.timelineNow, idDelays: idDelays(afterAdd), cells: afterAdd.cells, freshCellIds: afterAdd.cells.filter(c => c.isFresh).map(c => c.id) },
    delayVarUnchangedOnRemove: delayChangedOnRemove.length === 0 ? 'IDENTICAL（按 id 逐条相同）' : 'CHANGED',
    delayVarChangedOnRemove: delayChangedOnRemove,
    delayVarUnchangedOnAdd: delayChangedOnAdd.length === 0 ? 'IDENTICAL（按 id 逐条相同）' : 'CHANGED',
    delayVarChangedOnAdd: delayChangedOnAdd,
    removeDiff: diffStart(before, afterRemove),
    addDiff: diffStart(afterRemove, afterAdd),
    addCell: {
      newId: ADDED.id,
      cell: afterAdd.cells.find(c => c.id === ADDED.id) ?? null,
      addCellBefore: afterRemove.cells.find(c => c.isAdd) ?? null,
      addCellAfter: afterAdd.cells.find(c => c.isAdd) ?? null,
      newIdAnims: afterAdd.anims.filter(x => x.cellId === ADDED.id),
      otherAnimsStartTimeChanged: diffStart(afterRemove, afterAdd).changed.length,
    },
    snapshotRaw: { before, afterRemove, afterAdd },
  }
}

/* ================= 胶片条拼图 + 逐帧像素统计 ================= */
let pixelStats = null
if (withFrames && frames.length) {
  const html = `<!doctype html><meta charset="utf-8"><title>wave filmstrip ${round} ${theme} ${vpLabel}</title>
<style>
  body { margin: 0; padding: 16px; background: #11141a; color: #e8edf2;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p.meta { margin: 0 0 14px; color: #9aa7b4; }
  .strip { display: grid; grid-template-columns: repeat(2, max-content); gap: 10px; align-items: start; }
  figure { margin: 0; }
  img { display: block; width: 680px; height: auto; border: 1px solid #2a313c; border-radius: 4px; }
  figcaption { margin-top: 3px; color: #8fa0b3; font-variant-numeric: tabular-nums; }
  figcaption b { color: #e8edf2; font-weight: 600; }
</style>
<h1>磁贴入场编排 · ${round} · ${theme} · ${vpLabel}${label ? ` (${label})` : ''}</h1>
<p class="meta">列数 ${metrics.columns} · 行数 ${metrics.rows} · 格数 ${metrics.tileCellCount} · 每帧 T 为动画自身时间轴毫秒（含 delay）</p>
<div class="strip">
${frames.map(f => `  <figure><img src="data:image/png;base64,${f.b64}"><figcaption><b>t=${f.t}ms</b> · 落位 ${f.cellsLanded}/${f.total} · 首格 opacity ${f.firstCellOpacity}</figcaption></figure>`).join('\n')}
</div>`
  fs.writeFileSync(path.join(outDir, 'filmstrip.html'), html)

  const strip = await browser.newPage()
  await strip.setViewportSize({ width: 1440, height: 900 })
  await strip.setContent(html, { waitUntil: 'load' })
  await strip.waitForTimeout(300)

  // 逐帧像素统计：证明每帧不是空白、且确实随时间在变（不依赖人眼）
  pixelStats = await strip.evaluate(() => {
    const imgs = [...document.querySelectorAll('.strip img')]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const out = []
    let base = null
    for (const img of imgs) {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let luma = 0
      for (let p = 0; p < data.length; p += 4)
        luma += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
      if (!base)
        base = data.slice()
      let diff = 0
      for (let p = 0; p < data.length; p += 4) {
        if (Math.abs(data[p] - base[p]) > 12
          || Math.abs(data[p + 1] - base[p + 1]) > 12
          || Math.abs(data[p + 2] - base[p + 2]) > 12) {
          diff++
        }
      }
      out.push({ w: canvas.width, h: canvas.height, meanLuma: +(luma / (data.length / 4)).toFixed(2), diffPixelsVsFirst: diff, totalPixels: data.length / 4 })
    }
    return out
  })

  await strip.screenshot({ path: path.join(outDir, 'filmstrip.png'), fullPage: true })
  await strip.close()
}

/* ---- 特写胶片条：只裁一格，放大看单个图标的 scale / rotate ---- */
if (zoomFrames.length) {
  const imgW = Math.round(zoomClipRect.width * dsf)
  const html = `<!doctype html><meta charset="utf-8"><title>icon close-up ${round} ${theme}</title>
<style>
  body { margin: 0; padding: 16px; background: #11141a; color: #e8edf2;
         font: 12px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p.meta { margin: 0 0 14px; color: #9aa7b4; }
  .strip { display: grid; grid-template-columns: repeat(8, max-content); gap: 8px; align-items: start; }
  figure { margin: 0; }
  img { display: block; width: ${imgW}px; height: auto; border: 1px solid #2a313c; border-radius: 4px; }
  figcaption { margin-top: 3px; color: #8fa0b3; font-variant-numeric: tabular-nums; font-size: 11px; }
  figcaption b { color: #e8edf2; font-weight: 600; }
</style>
<h1>图标特写 · ${round} · ${theme} · 第 ${zoomTile} 格 · dsf=${dsf}</h1>
<p class="meta">T 为该格动画自身时间轴毫秒（含 delay）· 裁切 ${zoomClipRect.width}×${zoomClipRect.height} CSS px · 每格 ${imgW}px 宽</p>
<div class="strip">
${zoomFrames.map(f => `  <figure><img src="data:image/png;base64,${f.b64}"><figcaption><b>t=${f.t}</b><br>s=${f.iconScale ?? '—'} r=${f.iconRotateDeg ?? '—'}°<br>o=${f.iconOpacity ?? '—'}</figcaption></figure>`).join('\n')}
</div>`
  fs.writeFileSync(path.join(outDir, 'zoom-filmstrip.html'), html)
  const zstrip = await browser.newPage()
  await zstrip.setViewportSize({ width: 1440, height: 900 })
  await zstrip.setContent(html, { waitUntil: 'load' })
  await zstrip.waitForTimeout(300)
  await zstrip.screenshot({ path: path.join(outDir, 'zoom-filmstrip.png'), fullPage: true })
  await zstrip.close()
}

/**
 * 按「target + 伪元素 + name/duration/fill」分组，列出这一组出现过的延迟与逐段缓动。
 * 入场的分组用**入场期间**收下的元数据（`fill: backwards` 之后，跑完就再也读不到了）。
 */
function groupAnimations(entries) {
  const groups = new Map()
  for (const e of entries) {
    const key = `${e.target}|${e.animationName}|${e.durationMs}|${e.fill}`
    if (!groups.has(key)) {
      groups.set(key, {
        target: e.target,
        animationName: e.animationName,
        durationMs: e.durationMs,
        fill: e.fill,
        animationEasing: e.animationEasing,
        easingSegments: e.easingSegments ?? null,
        keyframes: e.keyframes ?? null,
        delaysMs: [],
        count: 0,
        exampleCellIds: [],
        startTimeRelWaveMs: [],
      })
    }
    const g = groups.get(key)
    g.count++
    if (!g.delaysMs.includes(e.delayMs))
      g.delaysMs.push(e.delayMs)
    if (e.startTimeRelWaveMs !== null && e.startTimeRelWaveMs !== undefined && !g.startTimeRelWaveMs.includes(e.startTimeRelWaveMs))
      g.startTimeRelWaveMs.push(e.startTimeRelWaveMs)
    if (g.exampleCellIds.length < 4)
      g.exampleCellIds.push(e.cellId ?? (e.inAddCell ? '<add>' : `<idx=${e.cellIndex}>`))
  }
  return [...groups.values()].map(g => ({
    ...g,
    delaysMs: g.delaysMs.sort((a, b) => a - b),
    startTimeRelWaveMs: g.startTimeRelWaveMs.sort((a, b) => a - b),
  }))
}

/* ================= 图标层取证：把「可解码时刻」与「动画 delay/时长」对齐 ================= */
/**
 * 一格一行，左边是**编排**（该格图标动画的 delay / duration / 动画真正开始的时刻），
 * 右边是**事实**（图标元素何时插进 DOM、何时 load、何时 decode 成功）。
 * 「图标出现缺乏动态效果」这类问题只能靠这张表回答：
 * 是动画没跑，还是元素根本没在动画期间出现。
 *
 * `decodedMinusDelayMs` 是验收要的那一列：真图标的解码时刻 − 该格图标动画的 delay。
 * 它 < 0 表示「动画还没开始（还在 delay 里）图就已经可解码」→ 用户看到的是
 * 「图标一出现就已经是那个样子」；它 >> 0 表示图标是在动画跑起来之后才冒出来的。
 */
function buildIconForensics(raw, metrics_, faviconInfo) {
  /**
   * 入场动画的元数据以**入场期间**收下的为准：`fill: backwards` 之后，
   * 入场跑完 `document.getAnimations()` 里就什么都不剩了，`metrics_.animations`
   * （落定时现场读的）会退化成空表 —— 这条回退只是保险，正常都走 `animMeta`。
   */
  const animList = (raw.animMeta && raw.animMeta.length) ? raw.animMeta : metrics_.animations
  // 只认真正的 CSS 动画：过渡对象会被 getComputedStyle().animationName 误读成入场动画名
  const iconAnims = animList.filter(a => a.iconKind !== null && a.kind !== 'transition')
  const animsByCell = new Map()
  for (const a of iconAnims) {
    const key = a.cellId ?? '<add>'
    if (!animsByCell.has(key))
      animsByCell.set(key, [])
    animsByCell.get(key).push(a)
  }

  const traceByCell = new Map()
  for (const f of raw.trace) {
    for (const c of f.cells) {
      if (!traceByCell.has(c.cellKey))
        traceByCell.set(c.cellKey, [])
      traceByCell.get(c.cellKey).push({ t: f.t, ...c })
    }
  }

  const keyOfRecord = r => r.cellId ?? (r.inAddCell ? '<add>' : '<unknown>')
  /**
   * 采样文档里其实是**两次渲染**：先渲染默认种子站（storage 是异步的），
   * storage 回来后整份换成注入的清单，波是在**第二次渲染**之后才起的。
   * 所以图标元素记录里会混进一批「种子站的 .tile-initial」——它们从来没参与入场编排。
   * 把它们单独标出来，不混进统计（否则 cellCount / initialCells 会虚高、
   * 延迟范围也会被 null 拉花）。
   */
  const waveKeys = new Set(metrics_.cells.map(c => c.id ?? '<add>'))
  const cellKeys = [...new Set([
    ...metrics_.cells.map(c => c.id ?? '<add>'),
    ...animsByCell.keys(),
    ...raw.imgs.map(keyOfRecord),
    ...raw.initials.map(keyOfRecord),
  ])]

  const range = (xs) => {
    const nums = xs.filter(v => typeof v === 'number' && Number.isFinite(v))
    return nums.length ? { min: +Math.min(...nums).toFixed(3), max: +Math.max(...nums).toFixed(3), samples: nums.length } : null
  }

  const cells = cellKeys.map((key) => {
    const meta = metrics_.cells.find(c => (c.id ?? '<add>') === key) ?? null
    const anims = (animsByCell.get(key) ?? []).map(a => ({
      animationName: a.animationName,
      target: a.target,
      iconKind: a.iconKind,
      durationMs: a.durationMs,
      delayMs: a.delayMs,
      fill: a.fill,
      easing: a.easing,
      startTimeRelWaveMs: a.startTimeRelWaveMs,
      plannedEndRelWaveMs: a.startTimeRelWaveMs === null ? null : +(a.startTimeRelWaveMs + a.durationMs).toFixed(1),
    }))
    const imgRecs = raw.imgs.filter(r => keyOfRecord(r) === key)
    const initialRecs = raw.initials.filter(r => keyOfRecord(r) === key)
    const trace = traceByCell.get(key) ?? []

    let kindSwitch = null
    let prevKind = null
    for (const f of trace) {
      if (prevKind !== null && f.kind !== prevKind)
        kindSwitch = { atMs: f.t, from: prevKind, to: f.kind }
      prevKind = f.kind
    }

    const img = imgRecs[0] ?? null
    const iconAnim = anims[0] ?? null
    const firstImgFrame = trace.find(f => f.kind === 'img') ?? null
    const firstDecodableFrame = trace.find(f => f.kind === 'img' && f.complete === true && (f.naturalWidth ?? 0) > 0) ?? null

    return {
      cellKey: key,
      /** wave = 参与这轮入场编排的格子；pre-storage = 种子站那一轮渲染的残留记录 */
      phase: waveKeys.has(key) ? 'wave' : 'pre-storage',
      cellIndex: meta ? meta.index : null,
      delayVarMs: meta ? meta.delayVar : null,
      kindAtSettle: imgRecs.length ? 'img.tile-icon' : (initialRecs.length ? 'span.tile-initial' : 'none'),
      iconAnimations: anims,
      img: img
        ? {
            addedRelMs: img.addedRelMs,
            loadRelMs: img.loadRelMs,
            decodedRelMs: img.decodedRelMs,
            decodeFailedRelMs: img.decodeFailedRelMs,
            decodeError: img.decodeError ?? null,
            srcIsData: img.srcIsData,
            srcShort: img.srcShort,
            completeAtInsert: img.completeAtInsert,
            naturalWidthAtInsert: img.naturalWidthAtInsert,
            loadNaturalWidth: img.loadNaturalWidth,
            decodedNaturalWidth: img.decodedNaturalWidth,
          }
        : null,
      initials: initialRecs.map(r => ({ text: r.text, addedRelMs: r.addedRelMs, removedRelMs: r.removedRelMs })),
      /** 逐帧实测的「动了多少」（trace 是 rAF 驱动的，样本数一并给出） */
      iconMotion: {
        opacity: range(trace.map(f => f.opacity)),
        scale: range(trace.map(f => f.sx)),
        riseY: range(trace.map(f => f.y)),
        rotateDeg: range(trace.map(f => f.rotateDeg)),
        filters: [...new Set(trace.map(f => f.filter).filter(v => v !== null))].slice(0, 4),
      },
      pulseMotion: {
        opacity: range(trace.map(f => f.pulseOpacity)),
        scale: range(trace.map(f => f.pulseScale)),
      },
      traceFrames: trace.length,
      firstImgFrameRelMs: firstImgFrame ? firstImgFrame.t : null,
      firstDecodableFrameRelMs: firstDecodableFrame ? firstDecodableFrame.t : null,
      kindSwitch,
      /** 验收口径：可解码时刻 − 该格图标动画的 delay */
      decodedMinusDelayMs: (img && img.decodedRelMs !== null && iconAnim) ? +(img.decodedRelMs - iconAnim.delayMs).toFixed(1) : null,
      /** 元素插入时刻 − 动画 delay：>0 表示这个元素是动画开始后才插进来的（会重新计时） */
      addedMinusDelayMs: (img && img.addedRelMs !== null && iconAnim) ? +(img.addedRelMs - iconAnim.delayMs).toFixed(1) : null,
      kindSwitchMinusDelayMs: (kindSwitch && iconAnim) ? +(kindSwitch.atMs - iconAnim.delayMs).toFixed(1) : null,
      iconAnimStartedLateMs: iconAnim && iconAnim.startTimeRelWaveMs !== null
        ? +(iconAnim.startTimeRelWaveMs - (iconAnim.delayMs ?? 0)).toFixed(1)
        : null,
    }
  })

  const waveCells = cells.filter(c => c.phase === 'wave')
  const preStorageCells = cells.filter(c => c.phase !== 'wave')
  const imgCells = waveCells.filter(c => c.kindAtSettle === 'img.tile-icon')
  const initialCells = waveCells.filter(c => c.kindAtSettle === 'span.tile-initial')
  const decodedList = imgCells.map(c => c.img?.decodedRelMs).filter(v => typeof v === 'number')
  const delayedList = imgCells.map(c => c.decodedMinusDelayMs).filter(v => typeof v === 'number')

  /**
   * 「还有格子没显影」的连续帧段 —— 给 reduce 对照用。
   * 全局规则只把动画时长压到 0.01ms、**不是** `animation: none`，所以理论上仍可能出现
   * 一帧落在 0% 关键帧上的空白。这里用逐帧 opacity 把那一段量出来，而不是靠推断。
   */
  const traceHidden = raw.trace.map(f => ({
    t: f.t,
    hiddenCells: f.cells.filter(c => typeof c.opacity === 'number' && c.opacity < 0.999).length,
  }))
  const hiddenSpan = {
    traceFrames: traceHidden.length,
    framesWithAnyHiddenCell: traceHidden.filter(x => x.hiddenCells > 0).length,
    firstHiddenMs: (traceHidden.find(x => x.hiddenCells > 0) ?? {}).t ?? null,
    lastHiddenMs: ([...traceHidden].reverse().find(x => x.hiddenCells > 0) ?? {}).t ?? null,
    contiguousFromStartFrames: (() => {
      let n = 0
      for (const x of traceHidden) {
        if (x.hiddenCells > 0)
          n++
        else break
      }
      return n
    })(),
    note: 'trace 由 rAF 驱动：这里的「帧」只在浏览器真的产帧时存在；'
    + 'contiguousFromStartFrames = 入场开始后连续「还有格子没显影」的帧数',
  }

  return {
    mode: faviconInfo.mode,
    sites: faviconInfo.sites,
    waveStartMs: raw.waveStartMs,
    clockOffsetAtWaveMs: raw.clockOffsetAtWave,
    clockNote: 'clockOffsetAtWave = performance.now() − document.timeline.currentTime（起波那一刻）；'
    + 'startTimeRelWaveMs 走 document.timeline，其余时刻走 performance.now()，这个偏离量是两者的对齐检查',
    /** cold / swap：采样文档在 document_start 清 faviconCache 的实测结果（证明「本页无缓存」不是假设） */
    cacheClearedAtDocumentStart: raw.cacheClearedAtDocumentStart,
    /** 入场期间收下的动画引用（定格靠它；fill:backwards 之后现场 getAnimations 已经空了） */
    animCollect: raw.animCollect,
    trace: {
      enabled: raw.traceEnabled,
      frames: raw.trace.length,
      endMs: raw.traceEndMs,
      windowMs: raw.traceWindowMs,
      degraded: raw.traceDegraded,
      note: 'trace 由 rAF 驱动：页面静止后 rAF 可能不再回调，degraded=true 表示窗口没被覆盖满',
    },
    /** 「入场开始后还有格子没显影」的连续帧段（reduce 对照的关键读数） */
    hiddenSpan,
    cells,
    summary: {
      /** 只统计参与入场的格子；种子站那一轮渲染的记录单列成 preStorageCells */
      cellCount: waveCells.length,
      preStorageCells: preStorageCells.length,
      preStorageNote: '种子站那一次渲染留下的图标元素记录（storage 是异步的，列表会被整份换掉）；它们不参与入场编排',
      imgCells: imgCells.length,
      initialCells: initialCells.length,
      noneCells: waveCells.filter(c => c.kindAtSettle === 'none').length,
      imgPathExercised: imgCells.length > 0,
      iconDelayRangeMs: range(waveCells.map(c => c.iconAnimations[0]?.delayMs)),
      iconDurationMs: [...new Set(waveCells.map(c => c.iconAnimations[0]?.durationMs).filter(v => typeof v === 'number'))],
      firstDecodableRelMs: decodedList.length ? Math.min(...decodedList) : null,
      lastDecodableRelMs: decodedList.length ? Math.max(...decodedList) : null,
      decodedMinusDelayMs: delayedList.length ? { min: Math.min(...delayedList), max: Math.max(...delayedList) } : null,
      cellsWhereIconInsertedAfterAnimStart: imgCells.filter(c => (c.addedMinusDelayMs ?? -Infinity) > 0).length,
      cellsWhereDecodedAfterAnimStart: imgCells.filter(c => (c.decodedMinusDelayMs ?? -Infinity) > 0).length,
      kindSwitches: waveCells.filter(c => c.kindSwitch).length,
      pulseCells: waveCells.filter(c => c.pulseMotion.scale).length,
      pulsePeakScale: range(waveCells.map(c => c.pulseMotion.scale?.max)),
      pulsePeakOpacity: range(waveCells.map(c => c.pulseMotion.opacity?.max)),
      note: 'kindAtSettle 是入场结束后的状态；kindSwitch 给出「首字母 → 真图标」发生的那一帧',
    },
    errors: raw.errors,
  }
}

const iconForensics = buildIconForensics(iconForensicsRaw, metrics, favicon)
/** 入场动画按组列出（延迟 + 逐段缓动）；这是「延迟—时长—缓动」表的真源 */
const entranceAnimations = (iconForensicsRaw.animMeta ?? []).filter(a => a.kind !== 'transition')
const entranceTransitions = (iconForensicsRaw.animMeta ?? []).filter(a => a.kind === 'transition')
const entranceGroups = groupAnimations(entranceAnimations.length ? entranceAnimations : metrics.animations)

/* ================= 产物自检：空产物直接判失败 ================= */
/**
 * 几种「看起来跑完了、其实什么都没测到」的产物必须**硬失败**，不能静默落盘：
 *   - 逐帧图一张没出（定格失败）；
 *   - 每一帧都已经落定（`landed == total`）—— 那就是把入场拍成了静止画面；
 *   - 入场动画表为空（`animationGroups` 会是空表）—— `fill: backwards` 换掉之后
 *     现场 `getAnimations()` 读不到东西时就会这样。
 * 上一轮 `paused 0` + 每帧 10/10 的假产物就是靠肉眼发现的，这里补齐自动判据。
 */
const artifactSanity = {
  framesWritten: frames.length,
  allFramesAlreadySettled: frames.length > 0 && frames.every(f => f.cellsLanded === f.total),
  entranceAnimationCount: entranceAnimations.length,
  freezeRefCount: freezeRefs ? freezeRefs.count : null,
  verdicts: [],
}
if (withFrames && frames.length === 0)
  artifactSanity.verdicts.push('FAIL：没有产出任何逐帧图')
if (withFrames && artifactSanity.allFramesAlreadySettled)
  artifactSanity.verdicts.push('FAIL：所有帧都已是落定态（定格失败，拍到的不是入场）')
if (entranceAnimations.length === 0 && !withReducedMotion)
  artifactSanity.verdicts.push('FAIL：入场动画表为空（animationGroups 会是空产物）')
if (entranceAnimations.length === 0 && withReducedMotion) {
  artifactSanity.note = 'reduce 模式下入场动画只活 0.01ms，rAF 收集不到它们是**预期**的；'
  + '这一轮的结构结论看 reducedMotion.verdict.delayCleared（读的是 CSS 层叠里的 computed 值）'
}
if (withFrames && freezeRefs && freezeRefs.count === 0)
  artifactSanity.verdicts.push('FAIL：入场期间没收到任何动画引用')
artifactSanity.ok = artifactSanity.verdicts.length === 0
if (!artifactSanity.ok) {
  for (const v of artifactSanity.verdicts)
    problems.push(`产物自检 ${v}`)
  console.error(`  !! 产物自检失败：${artifactSanity.verdicts.join(' / ')}`)
}

/* ================= 落盘 metrics.json ================= */
const report = {
  round,
  label: label || null,
  capturedAt: new Date().toISOString(),
  theme,
  viewport: vpLabel,
  newTabUrl,
  /** 本轮是 cold / warm / swap，以及两份 favicon 缓存的实测状态（不是猜的） */
  favicon,
  iconForensics,
  /** 落定态读数 + prefers-reduced-motion 对照（--reduced-motion 才断言） */
  reducedMotion,
  /** 采样页在采样时的可见性（rAF / timer 会不会被节流就看它） */
  pageVisibility: settleRaw.visibility,
  /** 每次运行的采样口径（跨轮对照时先看这里，避免拿不同 DPR / 不同模式的数字比） */
  captureConfig: {
    theme,
    viewport: `${vpW}x${vpH}`,
    deviceScaleFactor: dsf,
    faviconMode,
    siteSet,
    visitSites,
    reducedMotion: withReducedMotion,
    liveTrace: withLiveTrace,
    framesEnabled: withFrames,
    freezeEnabled: withFreeze,
    zoom: withZoom ? { tile: zoomTile, from: zoomFrom, to: zoomTo, step: zoomStep } : null,
    settleMs,
    frameRange: { from, to, step },
    iconTrackRange: { from: 0, to: iconTo, step: iconStep },
  },
  extension: extensionFingerprint(),
  shortcutsInjected: SHORTCUTS.length,
  shortcutsSites: siteSet === 'fixture' ? SHORTCUTS.map(s => ({ id: s.id, name: s.name, url: s.url, fixtureRgb: s.fixtureRgb ?? null })) : null,
  viewportActual: metrics.viewportActual,
  grid: {
    columns: metrics.columns,
    rows: metrics.rows,
    gridTemplateColumns: metrics.gridTemplateColumns,
    tileCellCount: metrics.tileCellCount,
    shortcutTileCount: metrics.shortcutTileCount,
    tokens: metrics.tokens,
  },
  tileDelays: metrics.cells.map(c => ({ index: c.index, id: c.id, isAddCell: c.isAddCell, delayVar: c.delayVar, animationDelay: c.animationDelay, animationName: c.animationName })),
  cellRestState: metrics.cells.map(c => ({
    index: c.index,
    id: c.id,
    transform: c.transformAtRest,
    translate: c.translateAtRest,
    scale: c.scaleAtRest,
    rotate: c.rotateAtRest,
    opacity: c.opacityAtRest,
    rect: c.rect,
  })),
  animationGroups: entranceGroups,
  /** 落定时现场还能读到的动画（fill:backwards 之后入场那批已经不在里面了，通常只剩 0 条） */
  animationGroupsAtSettle: metrics.animationGroups,
  animationsAtSettle: metrics.animations,
  /** 入场期间逐条收下的动画元数据（延迟/时长/逐段缓动/动画真正开始的时刻） */
  animationsDuringEntrance: entranceAnimations,
  /**
   * 同期收到的**过渡**（`getAnimations()` 把过渡也返回）。
   * 单独列出：元素身上挂着入场动画时，过渡会被 `getComputedStyle().animationName`
   * 误读成「入场动画又跑了一遍」，把它们和动画混在一起会造出假缺陷。
   */
  transitionsDuringEntrance: entranceTransitions,
  raf,
  frames: frames.map((f, i) => ({
    t: f.t,
    file: f.file,
    firstCellOpacity: f.firstCellOpacity,
    firstCellTransform: f.firstCellTransform,
    firstCellTranslate: f.firstCellTranslate,
    firstIconTransform: f.firstIconTransform,
    firstIconScale: f.firstIconScale,
    firstIconRotateDeg: f.firstIconRotateDeg,
    firstIconRiseY: f.firstIconRiseY,
    firstIconOpacity: f.firstIconOpacity,
    cellsLanded: f.cellsLanded,
    total: f.total,
    opacities: f.opacities,
    riseByCell: f.riseByCell,
    scaleByCell: f.scaleByCell,
    pixels: pixelStats ? pixelStats[i] : null,
  })),
  waveFront: frames.map(f => `t=${f.t}:${f.cellsLanded}/${f.total}`),
  iconTrack,
  /** 空产物自检（逐帧全落定 / 入场动画表为空 / 定格引用为 0 → 判失败） */
  artifactSanity,
  /** 定格用的动画引用是入场期间收下的；这里是收了多少条、以及定格那一刻现场还剩几条 */
  freezeRefs,
  /** 特写帧的逐帧读数（--zoom） */
  zoomFrames: zoomFrames.map(f => ({
    t: f.t,
    file: f.file,
    iconKind: f.iconKind,
    iconOpacity: f.iconOpacity,
    iconScale: f.iconScale,
    iconRotateDeg: f.iconRotateDeg,
    iconRiseY: f.iconRiseY,
    pulseOpacity: f.pulseOpacity,
    pulseScale: f.pulseScale,
    cellOpacity: f.cellOpacity,
    cellY: f.cellY,
  })),
  zoomClip: zoomClipRect,
  hover,
  freezeCheck,
  problems,
}
fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`)

/* ================= 人读摘要 ================= */
// Vue 的 scoped keyframes 会带 scope 后缀（tile-icon-arrive-9052b7ba），只按前缀匹配
const iconDelay0 = entranceAnimations.find(a => a.animationName?.startsWith('tile-icon-arrive') && a.cellIndex === 0)?.delayMs ?? null
const iconPeak = iconTrack.reduce((best, s) => (s.c0 && s.c0.iconScale !== null && (best === null || s.c0.iconScale > best.c0.iconScale) ? s : best), null)
// v1 的图标有 blur 起点，v2 删掉了 —— 这个字段两代都留着，方便对照
const iconBlurEnd = iconTrack.find(s => s.c0 && s.c0.iconFilter === 'none') ?? null
const pulsePeak = iconTrack.reduce((best, s) => {
  const p = s.c0?.pulseOpacity
  return (typeof p === 'number' && (best === null || p > best.pulseOpacity)) ? { t: s.t, pulseOpacity: p, pulseScale: s.c0.pulseScale } : best
}, null)
console.log(JSON.stringify({
  outDir: path.relative(root, outDir),
  theme,
  viewport: vpLabel,
  favicon: {
    mode: favicon.mode,
    sites: favicon.sites,
    visited: favicon.visited ? favicon.visited.map(v => `${v.id}:${v.ok ? v.status : 'ERR'}`) : null,
    chromeDbBefore: favicon.dbProbeBefore?.targets?.map(t => `${t.id}:${t.isPlaceholder ? 'placeholder' : 'real'}`) ?? null,
    chromeDbAfter: favicon.dbProbeAfter?.targets?.map(t => `${t.id}:${t.isPlaceholder ? 'placeholder' : 'real'}`) ?? null,
    cacheBeforeSample: favicon.cacheBeforeSample && { entries: favicon.cacheBeforeSample.entryCount, withData: favicon.cacheBeforeSample.withData },
    cacheAfterSample: favicon.cacheAfterSample && { entries: favicon.cacheAfterSample.entryCount, withData: favicon.cacheAfterSample.withData },
  },
  iconForensics: {
    summary: iconForensics.summary,
    trace: iconForensics.trace,
    perCell: iconForensics.cells.map(c => ({
      cell: c.cellKey,
      kind: c.kindAtSettle,
      delayMs: c.iconAnimations[0]?.delayMs ?? null,
      durMs: c.iconAnimations[0]?.durationMs ?? null,
      animStartRelWaveMs: c.iconAnimations[0]?.startTimeRelWaveMs ?? null,
      imgAddedRelMs: c.img?.addedRelMs ?? null,
      imgDecodedRelMs: c.img?.decodedRelMs ?? null,
      decodedMinusDelayMs: c.decodedMinusDelayMs,
      firstDecodableFrameRelMs: c.firstDecodableFrameRelMs,
      kindSwitch: c.kindSwitch,
      iconScale: c.iconMotion.scale,
      iconRiseY: c.iconMotion.riseY,
      iconRotateDeg: c.iconMotion.rotateDeg,
      pulse: c.pulseMotion,
    })),
  },
  viewportActual: metrics.viewportActual,
  columns: metrics.columns,
  rows: metrics.rows,
  tileCellCount: metrics.tileCellCount,
  delays: metrics.cells.map(c => `${c.id ?? '<add>'}:${c.delayVar}`),
  animationGroups: entranceGroups.map(g => `${g.target} → ${g.animationName} ${g.durationMs}ms delays=[${g.delaysMs}] fill=${g.fill} ×${g.count}`),
  /**
   * 逐段缓动：这次编排是**逐段手写**的，所以这一段才是关键读数。
   * （`getTiming().easing` 只给动画级曲线，对 CSS 动画恒为 linear —— 之前那版 easing 字段就是被它误导的。）
   */
  easingSegments: entranceGroups.map(g => ({
    animation: `${g.target} → ${g.animationName} ${g.durationMs}ms`,
    animationEasing: g.animationEasing,
    segments: (g.easingSegments ?? []).map(s => `${s.fromPct}%→${s.toPct}%: ${s.easing}`),
  })),
  reducedMotion: {
    emulated: reducedMotion.emulated,
    mediaMatches: reducedMotion.mediaMatchesAtSettle,
    verdict: reducedMotion.verdict,
    reduceAnims: reducedMotion.reduceAnims ?? null,
    finalViolations: reducedMotion.finalCheck.violations,
    earlyHiddenCount: reducedMotion.earlyCheck.length,
    earlyHiddenSample: reducedMotion.earlyCheck.slice(0, 6),
    earlyMarks: reducedMotion.earlySampleMarks,
    hiddenSpan: iconForensics.hiddenSpan ?? null,
  },
  zoom: withZoom
    ? {
        tile: zoomTile,
        dsf,
        clip: zoomClipRect,
        frames: zoomFrames.length,
        scaleRange: (() => {
          const xs = zoomFrames.map(f => f.iconScale).filter(v => typeof v === 'number')
          return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null
        })(),
        rotateRange: (() => {
          const xs = zoomFrames.map(f => f.iconRotateDeg).filter(v => typeof v === 'number')
          return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null
        })(),
      }
    : null,
  raf: {
    frames: raf.sampledFrames,
    totalFrames: raf.totalFrames,
    framesBeforeWave: raf.framesBeforeWave,
    avgFps: raf.avgFps,
    avgFrameMs: raf.avgFrameMs,
    longFrames: raf.longFrameCount,
    maxFrameMs: raf.maxFrameMs,
  },
  iconTrack: {
    iconDelayCell0: iconDelay0,
    at0: iconTrack[0]?.c0 ?? null,
    peak: iconPeak ? { t: iconPeak.t, scale: iconPeak.c0.iconScale, riseY: iconPeak.c0.iconRiseY, rotateDeg: iconPeak.c0.iconRotateDeg, blur: iconPeak.c0.iconFilter } : null,
    firstBlurNoneAt: iconBlurEnd?.t ?? null,
    pulsePeak,
    end: iconTrack[iconTrack.length - 1]?.c0 ?? null,
  },
  waveFront: report.waveFront,
  hover: { verdicts: hover.verdicts, restFace: hover.rest.face, hoverFace: hover.hoverFace.face, restAdd: hover.rest.addTile, hoverAdd: hover.hoverAdd.addTile },
  freeze: freezeCheck
    ? {
        delayVarUnchangedOnRemove: freezeCheck.delayVarUnchangedOnRemove,
        removedIds: freezeCheck.afterRemove.removedIds,
        removeChangedAnims: freezeCheck.removeDiff.changed.length,
        removeChangedList: freezeCheck.removeDiff.changed,
        removeMissingAnims: freezeCheck.removeDiff.missing.map(m => m.key),
        addChangedAnims: freezeCheck.addDiff.changed.length,
        addChangedList: freezeCheck.addDiff.changed,
        addNewAnims: freezeCheck.addDiff.added,
        freshCellIds: freezeCheck.afterAdd.freshCellIds,
        newCellDelay: freezeCheck.addCell.cell?.delayVar,
        newCellClasses: freezeCheck.addCell.cell?.classes,
        addCellDelayBefore: freezeCheck.addCell.addCellBefore?.delayVar,
        addCellDelayAfter: freezeCheck.addCell.addCellAfter?.delayVar,
      }
    : null,
  framesWritten: frames.length,
  /** 空产物自检：逐帧全落定 / 动画表为空 / 定格引用为 0 都判失败 */
  artifactSanity,
  /** 定格用的动画引用是入场期间收下的；这里是收了多少条、以及现场还剩几条 */
  freezeRefs,
  problems,
}, null, 2))

if ((withFrames && !refsOk) || !artifactSanity.ok)
  process.exitCode = 1

await browser.close()
// fixture 站点是本脚本起的本机服务，跑完要关（否则进程不退出）
if (fixtureSites)
  await fixtureSites.stop()
