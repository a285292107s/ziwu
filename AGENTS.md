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

## 验证工具速查

`scripts/` 下的脚本都是**开发用的验证工具，不是测试套件**。用法与产物：

```bash
pnpm dev                                  # 开发模式（HMR）
pnpm build                                # 生产构建
node scripts/rebuild.mjs                  # 生产构建入口（清空 → web → prepare → background）
node scripts/rebuild.mjs scripts/contrast-audit.mjs   # 构建完接着跑指定脚本

# 交互行为验证（会真的点、真的拖，断言跳转与落盘结果）
node --no-experimental-require-module scripts/verify-tile-click.mjs

# 视觉评审截图 → docs/review/<轮次>/
node --no-experimental-require-module scripts/preview.mjs <轮次>   # 新标签页整屏截图
node --no-experimental-require-module scripts/shots.mjs   <轮次>   # 各状态 × 明暗主题截图
node --no-experimental-require-module scripts/states.mjs  <轮次>   # 交互状态截图
node --no-experimental-require-module scripts/contrast-audit.mjs   # WCAG 对比度审计

# 天光 / 海面背景（three.js，按需；天空跟真实时间走，用 ?sky= 钉住时刻）
node --no-experimental-require-module scripts/sky-shots.mjs <轮次> [--season=winter] [--themes=dark] [--only=12,19.6]
node --no-experimental-require-module scripts/sky-layers.mjs <轮次> <时刻> [light|dark]   # 拆层：-final/-raw/-nogl
node --no-experimental-require-module scripts/sky-rows.mjs <时刻> [light|dark] [轮次]     # 逐行量 RGB
node scripts/extract-sky-glsl.mjs                                                         # 从产物里抽 GLSL
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
