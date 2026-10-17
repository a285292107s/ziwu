# AGENTS.md

本文件约定 AI 代理在本仓库里的工作方式。它是硬性约束，不是建议。

## 核心原则：先功能，后验证

接到任务后，**第一优先级是把功能做出来、跑通、可用**。不要在执行路径上插入任何与「让功能工作」无关的动作。

功能做完之后，**代理可以自己验证，并且应该自己验证**——不要把一个「看起来对」的改动丢给用户，让用户去当第一道人肉测试。验证的边界见下面第 4、5 条。

具体来说：

1. **先实现功能。** 先读懂需求和相关代码，直接产出可运行的功能改动，让用户在真实场景里能看到、能点到。
2. **禁止写测试。** 不要新增任何测试代码——单元测试、E2E、快照、fixture、测试辅助工具，都不要，也不要「顺手补一个」。仓库**已经没有测试框架**：`vitest`、`@vue/test-utils`、`jsdom`、`playwright.config.ts` 以及全部测试文件都已被移除，请保持这个状态，不要重新引入。
3. **不要重建测试目录。** `src/tests/`、`src/**/__tests__/`、`e2e/` 均不存在，也不要新建同类目录。
4. **可以主动跑 `lint` / `typecheck` 自检。** 这两个是廉价的静态检查，代理应当在改动后主动运行，并顺手修掉它们报出的问题：
   - `pnpm lint`（`eslint --cache .`）：可加 `--fix` 自动修风格类问题。
   - `pnpm typecheck`（`tsc --noEmit`）：只检查类型，不产出文件。
   注意：它们**不运行代码**，通过 ≠ 功能可用。
5. **代理应当做功能验证。** 上面第 2 条禁的是「写测试」，不是「做验证」——这两件事要分清楚。验证指的是**真的把功能跑起来、看它能不能用**，而不是新增测试文件。允许并鼓励的做法：
   - **跑构建**：`pnpm build`、`node scripts/rebuild.mjs`，确认产物能生成。
   - **在真实浏览器里跑**：用仓库现成的 [scripts/](scripts/) 工具加载 `extension/`，真的打开页面。
   - **截图肉眼审**：`scripts/preview.mjs`、`scripts/shots.mjs`、`scripts/states.mjs` 会把界面截到 `docs/review/`，直接看图判断，而不是靠想象。
   - **量指标**：`scripts/contrast-audit.mjs` 量真实对比度。
   - **读懂报错**：这些脚本会收集 `pageerror` / `console.error` / `requestfailed`，报错要认真看，不要跳过。
6. **验证结论要说实话。** 验证做完，如实讲清楚「验了什么、怎么验的、结论是什么、哪部分没覆盖」。**不要**在没跑过的情况下宣称「功能已验证通过」；也**不要**因为跑通了 4、5 两条就夸大其词——静态检查和截图都不能证明所有交互路径都对。存在不确定性就直说。
7. **用户明确要求优先。** 用户在当前任务中明确要求写测试、跑某条命令或以某种方式验证时，照做，不必顾虑上面的默认约束。

### 一句话版本

> 接到任务，先把功能做完；静态检查（`lint` / `typecheck`）和功能验证（构建、真机跑、截图、量指标）代理都该主动做，但「写测试代码 / 建测试目录」不要碰。验证结论必须如实汇报。

## 注释规则：只写代码读不出来的东西

注释不是「把代码翻译成人话」。**凡是能从代码本身读到的内容，写进注释就是负债**——它不会跟着代码一起改，下一次调参它就变成假的。这条和第 2 条一样是硬约束，不是风格偏好。

**只写这三类：**

1. **意图与取舍**：为什么是这样而不是那样；被否决的方案，以及否决它的原因。
2. **代码读不出的约束**：浏览器 / 平台行为与兼容性、无障碍要求、性能边界、外部实测数据、踩过的坑、与外部规范或参考站的对照。
3. **明确标注为历史**的版本对照（「上一版是 X，因为……」）。历史事实是冻结的，不会漂移。

**不要写这四类：**

1. **复述同一段代码里的值**：常量、时长、延迟、百分比、颜色、尺寸、数量、DOM 结构、选择器、层级。要看这些，看代码。
2. **复述当前实现的状态**：诸如「现在是 320ms」「这一版收到 300ms」「一屏 29 条」「过冲 13.3%，冲顶 29.7%」。这类句子**每一次调参都会变成假的**，是历次评审里漂移的重灾区。
3. **抄其他文件里某个 token / 常量的值**：写名字（`--dur-enter`、`TILE_WAVE_ROW`）并注明「值见 <那个文件>」，不要把值搬过来——搬一份就是多一份会过期的副本。
4. **注释里的算术**：由代码里的数乘出来 / 加出来的结果（峰值像素、收尾时刻、动画总条数）。读者自己会算，而你算的那份会过期。

**判断标准一句话：** 把某个数字从 320 改成 360 之后，这句话还成立吗？不成立，就不该写。

**历史数据要标清楚。** 「上一版 520ms 里有 375ms 几乎不动」是证据，可以留；「这一版 320ms」是复述，不要写。分不清时就加上「上一版」把它钉成历史，或者干脆删掉。

**想强调某个参数的性格，就指向它的声明。** 写「见 main.css 里 `--dur-enter` 旁边那段」，而不是把它的时长再抄一遍。注意这条规则**自己也适用**：举例时引用一个已被删掉的 token，例子就成了下一个漂移点。

**改数字时要连带扫一遍。** 动任何一个数之前，先 grep 这个数的**文本形式**（`400ms`、`13.3%`、`760`、`29 条`……），把所有复述它的注释一起修掉——**包括其他文件里的**。本仓库已经出现过同一批动效参数在 `ShortcutGrid.vue`、`NewTab.vue`、`main.css`、`skyRenderer.ts` 四个文件里各留一份副本、且已经互相矛盾的情况。

## 验证工具速查

`scripts/` 下的脚本都是**开发用的验证工具，不是测试套件**。用法与产物：

```bash
pnpm dev                                  # 开发模式（HMR）
pnpm build                                # 生产构建
node scripts/rebuild.mjs                  # 生产构建入口（清空 → web → prepare → background）
node scripts/rebuild.mjs scripts/contrast-audit.mjs   # 构建完接着跑指定脚本

# 交互行为验证（会真的点、真的拖，断言跳转与落盘结果）
node --no-experimental-require-module scripts/verify-tile-click.mjs
node --no-experimental-require-module scripts/verify-first-tab.mjs   # 进入页面的第一站是搜索框

# 视觉评审截图 → docs/review/<轮次>/
node --no-experimental-require-module scripts/preview.mjs <轮次>   # 新标签页整屏截图
node --no-experimental-require-module scripts/shots.mjs   <轮次>   # 各状态 × 明暗主题截图
node --no-experimental-require-module scripts/states.mjs  <轮次>   # 交互状态截图
node --no-experimental-require-module scripts/contrast-audit.mjs   # WCAG 对比度审计

# 天光 / 海面背景（three.js，按需；天空跟真实时间走，用 ?sky= 钉住时刻）
node --no-experimental-require-module scripts/sky-shots.mjs <轮次> [--season=winter] [--themes=dark] [--only=12,19.6]
node --no-experimental-require-module scripts/sky-layers.mjs <轮次> <时刻> [light|dark]   # 拆层：-final/-raw/-nogl
node --no-experimental-require-module scripts/sky-rows.mjs <时刻> [light|dark] [轮次]     # 逐行量 RGB

# 主题过渡（要在真机的中间帧里看，稳态截图表象不出来）
node --no-experimental-require-module scripts/theme-transition.mjs <轮次> [--from=light] [--to=dark,light] [--screencast=1]
#   → docs/review/<轮次>/trace-*.json（逐帧像素时间线：单帧跳变占比、走完 95% 的时刻）
#   → --screencast=1 收带真实时间戳的帧（默认只量不拍）
```

截图产物落在 `docs/review/<轮次>/`。

> 截图与审计脚本都要求 `extension/` 是**生产产物**（它们直接加载 `extension/`）。
> 刚跑过 `pnpm dev` 的话先 `node scripts/rebuild.mjs`。

### 两个必须知道的坑

- **`pnpm dev` 会污染 `extension/`。** 开发模式下 `extension/dist` 被覆盖成**指向 localhost 的 stub**（`<script src="http://localhost:3303/...">`）。此后 Vite 一停，任何直接加载 `extension/` 的浏览器验证都会死在 `ERR_CONNECTION_REFUSED`，页面只剩「Vite server did not start」——**看着像功能坏了，其实只是产物是开发态**。要手工验证，先 `node scripts/rebuild.mjs` 回到生产产物。
- **Vite 已固定绑 `127.0.0.1`**（见 `vite.config.mts` 里 `server.host` 的注释）。这是为了避免 Windows 上 `localhost` 解析到 `::1` 而 Vite 只监听了单个回环地址、导致 stub 页面加载不出来的问题。改这个配置前先读那段注释。

## 项目速览

浏览器扩展（MV3），接管新标签页。技术栈：Vue 3 + TypeScript + Vite + Unocss，包管理器为 pnpm。

```bash
pnpm install              # 安装依赖
pnpm dev                  # 开发（产物在 extension/，用 pnpm start:chromium 加载）
pnpm build                # 生产构建
node scripts/rebuild.mjs  # 完整构建入口（清空 → web → prepare → background）
```

代码组织见 `README.md`：新标签页在 `src/newtab/`，设置页 / 弹窗 / 侧边栏分别在 `src/options/`、`src/popup/`、`src/sidepanel/`，共享逻辑在 `src/logic/`，四者共用同一套组件与 storage。
