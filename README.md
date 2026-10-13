# 子午 Meridiem

一个基于 [`vitesse-webext`](https://github.com/antfu/vitesse-webext) 的 Chrome 扩展：**接管浏览器新标签页**，把「打开新标签页」这件事变成一次干净的停留——时间、搜索、常用站点，就这三样。

技术栈：**Vue 3 + TypeScript + Vite + Unocss + MV3**。

视觉上走「精密计时仪器 + 编辑式留白」：左侧一条对齐的中轴（时钟 → 日期问候 → 搜索 → 磁贴），背景按时段（清晨 / 白天 / 黄昏 / 夜晚）换一层很淡的氛围色，材质是玻璃 + 一层胶片颗粒。字体自托管（时钟 Space Grotesk、正文 Manrope），深浅两个主题各有一套完整的语义令牌，见 [设计与工程约束](#设计与工程约束)。

![新标签页（浅色）](./docs/newtab-preview.png)

![新标签页（深色）](./docs/newtab-dark.png)

## 功能

### 多引擎搜索框

![搜索框与引擎下拉](./docs/search-dropdown.png)

内置 **Google、百度、Bing、DuckDuckGo、知乎、哔哩哔哩、GitHub** 七个引擎，全部定义在 `src/logic/searchEngines.ts` 的 `searchEngines` 数组里，增删改都只动这一处。

| 操作 | 效果 |
| --- | --- |
| 点输入框左侧图标 | 展开引擎列表，点选切换 |
| 输入框内按 <kbd>Tab</kbd> | 依次轮换引擎，走完一轮后焦点交给浏览器（下一个是搜索按钮，再往下是磁贴） |
| 输入框内按 <kbd>Shift</kbd>+<kbd>Tab</kbd> | 反向轮换；走回起点后焦点退回引擎按钮 |
| 输入关键词后回车 / 点右侧按钮 | 用当前引擎搜索 |
| 回车时按住 <kbd>Ctrl</kbd> / <kbd>⌘</kbd>，或中键点搜索按钮 | 在新标签页打开 |

> **输入法组词期间不抢按键**：`onKeydown` 开头会检查 `event.isComposing`。
> 拼音候选词要靠回车确认、Esc 取消，组词中如果照常处理，用户打「知乎」敲回车选词
> 就会被直接送去搜索。中文是这里的默认输入场景，这条不能省。

> **焦点出口**：因为 <kbd>Tab</kbd> 被「切引擎」占用，输入框里按 <kbd>Tab</kbd> 不会立刻移动焦点。
> 出口有两个：正向轮换完一轮（7 次）后放行，或者用 <kbd>Shift</kbd>+<kbd>Tab</kbd> 反向走回起点。
> 判断 `preventDefault()` 必须放在「确定要拦截」之后，否则出口那一次 Tab 既没轮换、也没移动焦点。

选中结果写入 `browser.storage.local` 的 `meridiem-search-engine`，因此**多个新标签页之间自动同步**：一个标签页切到知乎，其他已打开的新标签页跟着变。

默认是**当前标签页内跳转**（和 Chrome 地址栏一致）。新标签页里的磁贴同理——不写 `target`，所以 <kbd>Ctrl</kbd> / 中键点击天然是新标签页。而**设置页和侧边栏**里的磁贴显式传了 `open-in-new-tab`，因为在那些界面上同页跳转会把设置页/侧边栏本身顶掉；设置页里那个「试一下」的搜索框预览同理传了 `open-in-new-tab`。

### 快捷方式图标

页面上可以直接**创建图标并绑定站点，点击跳转**，像书签栏但不占地方。

- **新增**：点磁贴末尾的 `+`，填名称和网址；名称留空时用域名首字母。
- **按住拖动排序**：**按住图标**（鼠标 / 触控笔约 0.2 秒，手指约 0.35 秒）磁贴会浮起来，拖到哪一格就插到哪一格，松手落位；按住了但没挪窝、以及快速点击，都仍然是打开站点，拖动中按 <kbd>Esc</kbd> 可放回原位。整条手势走指针事件，鼠标 / 触屏 / 触控笔通用：手指会把卡片抬到指尖上方、贴到屏幕边缘会自动往那个方向滚，顺序只在松手时写一次 storage。
- **整理**：点右上「整理」进入整理模式，可编辑 / 删除；键盘用户可以用磁贴上的「左 / 右」按钮排序。退出后恢复干净视图。
- **删除可撤销**：删掉后底部浮出一条提示，点「撤销」原**位置**恢复（不是追加到末尾）。
- **图标自动获取**：用 MV3 的 `_favicon` 接口按站点地址取图标（64px，见 `src/logic/shortcuts.ts` 的 `faviconUrl()`）。
- **拿不到图标时**不显示灰地球：`_favicon` 对「Chrome 没缓存过图标的站点」返回的是**通用灰色地球而不是 404**，`<img>` 的 `onerror` 永远不触发。这里用一个不存在的域名做一次标定，取 32×32 画布的 FNV-1a 像素指纹，再逐站点比对；命中占位图就回退到**首字母色块**。指纹是运行时标定的，换 Chrome 版本/平台也不会失效。
- **配色不撞车**：`assignShortcutAccents()` 用线性探测给每个站点分配强调色，保证同屏颜色互不重复，同时**不冲突的站点颜色保持稳定**（加一个站点不会让其他站点集体变色）。

数据写在 `browser.storage.local` 的 `meridiem-shortcuts`，跨标签页实时同步。

### 外观

右上角两个控件：**设置**（打开设置页）和**主题**。主题只有**深色 / 浅色两态**，首次安装时读一次系统的 `prefers-color-scheme` 作为默认值，之后完全听用户的，不再跟随系统。

不同时段会给背景一层不同的氛围色（`src/logic/ambience.ts`），只影响光晕，不改变文字对比度。

### 设置页 / 弹窗 / 侧边栏

- **设置页**（`src/options/`）：主题、默认搜索引擎（七张卡片）、问候语、快捷方式管理，并内嵌一个可交互的搜索框预览。
- **工具栏弹窗**（`src/popup/`）：一个「打开设置」和一个主题开关。
- **侧边栏**（`src/sidepanel/`）：导航 + 快捷方式网格。

四者共用同一套组件与同一份 storage，改一处全处生效。

## 快速开始

```bash
pnpm install     # 安装依赖
pnpm dev         # 开发模式：监听改动并打包到 extension/
```

然后在 Chrome 打开 `chrome://extensions/` → 打开右上角 **开发者模式** → **加载已解压的扩展程序** → 选择项目根目录下的 **`extension/`** 文件夹。

> 开发模式下修改 `src/newtab/` 下的文件会热更新，无需重新加载扩展。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式，产物输出到 `extension/` |
| `pnpm build` | 生产构建 |
| `node scripts/rebuild.mjs` | **推荐的构建入口**：清空 → 依次构建 web / prepare / background / js，四步缺一不可 |
| `pnpm pack` | 打包成 `extension.zip` / `.crx` / `.xpi` |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint（可自动修复） |
| `node scripts/contrast-audit.mjs` | 对比度审计：新标签页 / 设置页 / 弹窗 × 明暗两主题 |
| `node scripts/doc-images.mjs` | 重新生成本文档里的配图（会校验 `extension/` 是生产构建） |
| `node scripts/shots.mjs r10` | 视觉评审：把各种状态截到 `docs/review/r10/` |
| `node scripts/preview.mjs r10` | **改界面时最常用**：只盯新标签页，明暗 × 桌面/笔记本/手机六张整屏图 |
| `node scripts/states.mjs s10` | 交互态截图：下拉、整理模式、对话框、错误态、撤销 toast、空状态 |

> `docs/review/` 是这些脚本的一次性产物（一轮动辄几十 MB），已加进 `.gitignore`；
> `docs/*.png` 才是 README 的正式配图，由 `scripts/doc-images.mjs` 生成，随仓库提交。

> ⚠️ `pnpm typecheck` 依赖 Vite 插件生成的 `src/auto-imports.d.ts` 与 `src/components.d.ts`（两者已被 `.gitignore` 忽略）。
> **全新克隆后请先执行一次 `pnpm dev` 或 `pnpm build`**，否则会报 `Cannot find name 'browser'`。

> ⚠️ **构建顺序不能省也不能截断**：`vite build`（web）→ `esno scripts/prepare.ts` → background 配置。
> 只跑第一段会得到一个「能加载但后台脚本缺失」的 extension；把 `scripts/rebuild.mjs` 的输出接给
> `Select-Object -First N` 之类会提前终止管道的命令，构建会被中途杀掉。`scripts/rebuild.mjs` 就是为了不再手滑。

## 目录结构

```text
mytab/
├── src/
│   ├── newtab/             # 新标签页（子午 Meridiem 的核心）
│   ├── popup/              # 工具栏弹窗
│   ├── options/            # 设置页
│   ├── sidepanel/          # 侧边栏
│   ├── background/         # 后台 Service Worker（MV3）
│   ├── components/         # 共享组件（自动按需注册）
│   │   ├── SearchBox.vue     # 多引擎搜索框（新标签页与设置页共用）
│   │   ├── ShortcutGrid.vue  # 快捷方式网格 + 新增/整理/撤销
│   │   └── ShortcutTile.vue  # 单个磁贴
│   ├── composables/
│   │   ├── useWebExtensionStorage.ts  # 打通 storage.local 的响应式封装
│   │   ├── useShortcuts.ts            # 快捷方式增删改排序
│   │   ├── useTheme.ts                # 明暗两态主题
│   │   └── useFavicon.ts              # favicon 获取 + 占位图探测
│   ├── logic/
│   │   ├── searchEngines.ts  # 引擎目录 + 纯函数
│   │   ├── shortcuts.ts      # 快捷方式纯逻辑（URL 规范化、配色分配、字号）
│   │   ├── ambience.ts       # 按时段的背景氛围色
│   │   └── storage.ts        # storage.local 里的持久化状态
│   ├── styles/             # 全局样式与设计令牌（视觉真源，见「设计与工程约束」）
│   ├── assets/
│   │   └── fonts/          # 自托管字体（Space Grotesk / Manrope，随扩展打包）
│   └── manifest.ts         # 用 TypeScript 定义 manifest
├── scripts/
│   ├── rebuild.mjs         # 可靠的完整构建
│   ├── contrast-audit.mjs  # 对比度审计（不达标则退出码 1）
│   ├── doc-images.mjs      # 生成 README 配图
│   ├── preview.mjs         # 新标签页整屏截图（改样式时看效果）
│   ├── states.mjs          # 新标签页各交互状态截图
│   ├── shots-detail.mjs    # 局部放大截图（逐像素看细节）
│   ├── shots.mjs           # 视觉评审截图
│   ├── manifest.ts         # 把 manifest 对象写盘为 manifest.json
│   └── prepare.ts          # 生成开发用的 stub HTML，并监听 manifest 变化
├── extension/              # 扩展包根目录（直接加载它调试）
│   ├── assets/             # 图标等静态资源
│   └── dist/               # 构建产物
└── vite.config.mts         # 主配置（popup / options / sidepanel / newtab）
```

## 设计与工程约束

这一节记录几条**踩过就会重复踩**的规则，改样式前值得先读。

### 视觉语言：一套语义 token，两个主题各一份值

新标签页的样式真源是 `src/styles/main.css`。组件里**不要写裸色值、裸圆角、裸 z-index**，一律取语义 token：

- **颜色**：`--bg-base` `--bg-deep` `--surface*` `--text-1/2/3` `--line*` `--brand*` `--danger*` `--shadow-*`。浅色定义在 `:root`，深色定义在 `:root.dark`，同一个 rgb 在清晨和深夜落在完全不同的底色上，所以「正文 / 次级 / 弱化」是按**意图**而不是按色值固定的。
- **字体**：`--font-display`（Space Grotesk，时钟与标题）、`--font-sans`（Manrope，正文）、`--font-mono`、`--tile-ink` / `--tile-aurora`。
- **圆角三档**：`--radius-control`（胶囊，交互控件）、`--radius-tile`（磁贴）、`--radius-surface`（浮层）。不要临时加第四档。
- **z-index**：`--z-ambience/content/rail/menu/toast/dialog/grain`，集中声明，组件里不要写数字。
- **动效**：`--ease-out` / `--ease-in-out` / `--ease-spring` + `--dur-fast/base/slow/enter`。

因为颜色自己会随主题切换，**不再需要 `html.dark .foo` 覆盖块**（老代码里那批已经删掉）。

### 字体是自托管的，不要改成 CDN

`src/assets/fonts/` 里是 Space Grotesk 与 Manrope 的可变字重 woff2（只带 latin / latin-ext 两个子集，共约 81KB），随扩展一起打包：扩展要能在离线、无网、CSP 收紧的环境下正常显示。中文走系统字体（PingFang SC / 微软雅黑 / Noto Sans CJK），中文字体不下载。

时钟字体的 `<link rel="preload">` 由 `vite.config.mts` 的 `clock-font-preload` 插件在构建时注入：产物文件名带内容哈希，而且扩展页面走 `chrome-extension://` 协议，绝对路径 `/assets/...` 会指向扩展根目录，所以必须按页面深度拼成相对路径。

### 入场动画不要挂在「有子级浮层」的容器上

`animation: ... both` 会让动画结束后**依然保留 transform 的已结束状态**，而带 `transform` 的元素自成一格层叠上下文。曾经把 `.search-root` 挂上入场动画，结果它内部 `position: absolute` 的引擎下拉被压在后面的磁贴带下面（截图里能看到磁贴从菜单里透出来）。

所以入场动画挂在 `.search-shell` / `.grid-root` 这类**没有子级浮层**的元素上。

### 深色样式必须写在 `src/styles/main.css`，不能写在 `<style scoped>` 里

Vue 的 scoped 编译器会把 `:global(.dark) .foo` 处理成**裸的 `.dark { … }`**——后代选择器被丢掉，规则挂到了 `<html>` 上，目标元素一点没生效，而且不报任何错。

所以本项目所有深色覆盖统一写在 `src/styles/main.css`。现在的做法更进一步：深色差异写成 token 值，组件里只取 token，`html.dark` 前缀基本已经用不到了。

同理，**跨页面复用的基础件**（`.kbd`、`.dialog-input`、`.text-muted`、`.primary-control`、`.ghost-control`、`.focus-ring`）也必须放全局：scoped 样式只作用于组件自己的模板，设置页复用 `ShortcutGrid` 时，设置页自己的标记是拿不到那些样式的。

### 不要用 `opacity` 把文字调淡，也不要用它做禁用态

`opacity` 不改变 computed color，但会按比例拉低**最终**对比度。实测把角落按钮压到 `opacity: 0.72` 时，浅色主题下只有 4.43:1，低于 AA 的 4.5:1。需要次级文字就用 `.text-muted` 的明确色值，需要禁用态就换 `color`。

还有一个反例：编辑模式里「前移 / 后移」按钮原本用 `opacity: 0` 隐藏，**但 opacity: 0 的元素仍然在 Tab 顺序里**，键盘用户会走过一个看不见的按钮（WCAG 2.4.7）。现在改成 `visibility: hidden`，不进 Tab 顺序，悬停或聚焦时再显形。

### 磁贴回退徽标：中性底 + 中性字形 + 站点色细环

试过三种：实心站点色块 + 白字（整排糖果色，把页面调性拖走，还和真实 favicon 重量对不齐）、低饱和站点色底 + 同色字（小尺寸下糊成一块，字形对比度实测最低只有 3.55:1）、**中性底 + 中性字形 + 站点色细环**（当前）。颜色以「一圈线 + 一圈光晕」的身份出现，安静但认得出。

站点色有两套调色板（`SHORTCUT_ACCENTS` / `SHORTCUT_ACCENTS_DARK`），**下标一一对应**：切主题时同一个站点留在同一个色系里，只是明暗翻转。

### 对比度靠算，不靠肉眼

- 品牌青 `--brand` 是**算出来**的：按钮填色配白字 5.47:1，留出半透明玻璃提亮的余量。
- 秒数字故意固定 1.6rem（25.6px），踩在 WCAG「大字号」门槛（24px）之上，这样强调色在随时段变化的氛围底上只需要守住 3:1。
- 危险色分 `--danger`（填色按钮底）与 `--danger-text`（错误文案）两档，深色下必须提亮，否则压在深底上像褐色。

`node scripts/contrast-audit.mjs` 按「界面 × 主题」分组跑，任何一项不达标**或选择器找不到元素**都返回退出码 1。它还会等 `document.getAnimations()` 落定再量——入场动画期间元素带着 `opacity < 1`，量到的是「动画到一半的样子」，会把达标的地方误判成 FAIL。

### 事件类型不匹配 `tsc` 抓不到

`tsc --noEmit` 不检查 `.vue` 模板里的组件事件签名，需要 `vue-tsc`。曾经有一个「删除按钮点了没反应」的 bug：磁贴 emit 的是 `shortcut.id`（字符串），父组件却读 `shortcut.id`，`findIndex` 返回 -1 后**静默 return**，`tsc` 全绿。改动组件 emit/props 后，**手动点一遍对应交互**（新标签页和设置页都要过，它们复用同一批组件）。

### UnoCSS 静态扫描不到动态类名

引擎图标写在数据里（模板中是 `:class="engine.icon"`），所以 `unocss.config.ts` 里必须 safelist：

```ts
safelist: [...searchEngines.map(e => e.icon), 'i-carbon-sun', 'i-carbon-moon']
```

**删掉它，下拉列表里的图标和主题按钮会变成空白。**

### storage 的序列化细节

`useWebExtensionStorage` 对对象/数组会用 JSON 序列化后存储。外部（比如截图脚本）往里写数组时必须先 `JSON.stringify`，写原生数组读回来会被当成脏数据。单值类型（如主题字符串）则不需要。

`shortcuts` 用了 `{ mergeDefaults: false }`：这样用户主动清空列表后不会被默认值"复活"。

storage 键名统一用 `meridiem-` 前缀（产品名 子午 Meridiem）。改名前的 `mytab-*` 由 `useWebExtensionStorage` 的**读路径懒搬迁**一次：读到旧键 → 写新键 → 删旧键。不放在启动流程里，是因为 `writeDefaults` 默认开启 —— 键不存在时 `read()` 会先写一遍默认值，异步迁移会晚一步，把老数据顶掉。`scripts/*.mjs` 里的截图与对比度脚本直接按这些键读写 storage，改键名要和它们一起改。

### 无障碍

- 所有可聚焦控件都有统一可见的焦点环（`.focus-ring`，`:focus-visible` 触发）。
- `prefers-reduced-motion: reduce` 下入场动画与过渡全部关闭。
- 对比度由脚本把关，不靠肉眼：`node scripts/contrast-audit.mjs`。

## 关键配置说明

### manifest 由 TypeScript 生成

`src/manifest.ts` 导出 `getManifest()`，`scripts/manifest.ts` 调用它写出 `extension/manifest.json`。
可以按环境动态增删权限。子午 Meridiem 的核心字段是：

```ts
const manifest = {
  chrome_url_overrides: {
    newtab: 'dist/newtab/index.html',
  },
}
```

### 权限

`src/manifest.ts` 中当前申请了 `tabs`、`storage`、`activeTab`、`sidePanel`、`favicon`，以及 `host_permissions: ['*://*/*']`。

- `favicon` 是磁贴取真实站点图标（MV3 的 `/_favicon/` 接口）所需的权限，**不要删**。`_favicon` 只在扩展页面里调用，所以不需要为它声明 `web_accessible_resources`（那是给 content script 用的）。
- 子午 Meridiem **不注入任何网页脚本**（脚手架时代那份 content script 及其右下角按钮已移除），因此 `host_permissions` 与 `tabs` / `activeTab` 目前没有代码依赖。要收窄权限，请先在真实浏览器里加载 `extension/` 确认磁贴图标仍然正常——`_favicon` 对**用户没访问过**的站点是否依赖 host 权限去实时取图标，靠读文档无法下结论，必须实测：

```ts
// 收窄后大致长这样（改完务必真机确认磁贴图标与侧边栏都还在）
const manifest = {
  permissions: ['storage', 'sidePanel', 'favicon'],
  host_permissions: [],
}
```

### 关于侧边栏与工具栏图标

`src/background/main.ts` 中 `USE_SIDE_PANEL = false`：点击工具栏图标会正常弹出 popup。
若改为 `true`，图标点击会打开侧边栏，popup 将不再出现。

### 跨上下文通信

四个页面（新标签页 / 设置 / 弹窗 / 侧边栏）共用同一套组件与 `storage.local`，**当前不需要跨上下文消息通道**。

脚手架自带的 `webext-bridge` 示例——`tab-prev` / `get-current-tab` 两个消息、`shim.d.ts` 里的 `ProtocolMap`、以及后台中 `browser.tabs.onActivated` 那段「上报上一个标签页标题」——已随 content script 一并移除。将来确实需要跨上下文通信时再引入。

### 新增一个页面

要加一个新页面（例如 `bookmarks`），需要同步改四个地方：

1. 新建 `src/<page>/index.html` + `main.ts` + `<Page>.vue`；
2. 在 `vite.config.mts` 的 `build.rollupOptions.input` 中登记；
3. 在 `scripts/prepare.ts` 的 `views` 数组中登记（开发模式 stub 用）；
4. 如需在 `manifest.json` 中引用，改 `src/manifest.ts`。

### 文档配图的维护

`docs/*.png` 全部由 `node scripts/doc-images.mjs` 生成，脚本会**拒绝**使用开发构建（manifest 的 CSP 里含 localhost 时会直接报错）。文档配图曾经停留在脚手架时代好几个月而没人发现——配图有专门的生成脚本，改了界面跑一次就好。

## License

[MIT](./LICENSE)

模板来自 [antfu/vitesse-webext](https://github.com/antfu/vitesse-webext)。
