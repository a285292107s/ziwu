import { dirname, relative } from 'node:path'
import fs from 'node:fs'
import type { Plugin, UserConfig } from 'vite'
import { defineConfig } from 'vite'
import Vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import UnoCSS from 'unocss/vite'
import { isDev, port, r } from './scripts/utils'
import unoConfig from './unocss.config'
import { THEME_MIRROR_KEY } from './src/logic/themeBoot'

/**
 * theme-boot：首帧主题预置的「打包 + 同步校验」。
 *
 * 背景：新标签页「白屏闪一下」的修法，是把底色和主题判断放到首帧之前（见
 * src/newtab/index.html 与 src/newtab/theme-boot.js）。这个插件负责把它正确地
 * 送进产物，并把几个**分散在两个文件里的值**变成构建期硬错误 —— 它们一旦漂移，
 * 症状是一次很难归因的闪动，而不是报错：
 *   - index.html 里内联的底色 ≠ main.css 的 --bg-deep → 开页时颜色跳一下；
 *   - theme-boot.js 里的镜像键 ≠ useTheme() 写入的键 → 预置静默失效，闪回原样。
 *
 * 还有一条只有 Vite 能兜住的坑：`<script src="./theme-boot.js">` 是**经典脚本**，
 * Vite 不会把它当入口（只有 module 脚本才会），html 里那个相对路径会**原样留在产物里**
 * —— 而 `dist/newtab/` 下并没有这个文件，于是脚本 404、预置静默失效。
 * 实测过：构建成功、产物里写着 `./theme-boot.js`、控制台一片安静，只有帧里那一下闪
 * 还在。所以这里在构建时把它 emit 成 `assets/theme-boot.js` 并改写标签，
 * 改不动就直接抛错（见下面 transformIndexHtml 的兜底断言）。
 */
function themeBoot(): Plugin {
  let command: 'build' | 'serve' = 'serve'
  let base = '/'
  let enabled = true
  let bootScript = ''

  return {
    name: 'theme-boot',
    enforce: 'pre',

    configResolved(config) {
      command = config.command
      base = config.base.endsWith('/') ? config.base : `${config.base}/`
      /* 后台脚本复用了 sharedConfig（vite.config.background.mts 里 `...sharedConfig`），
         但它是 lib 构建、没有 HTML 入口：这里既不该校验也不该落资源，
         否则会在 extension/dist/background/ 下多出一份没人引用的 theme-boot.js。 */
      enabled = !config.build.lib
    },

    buildStart() {
      if (!enabled)
        return

      // 1. main.css 是底色的真源：浅色、深色各一处 --bg-deep，顺序即主题顺序
      const mainCss = fs.readFileSync(r('src/styles/main.css'), 'utf-8')
      const bgDeep = [...mainCss.matchAll(/--bg-deep:\s*(#[0-9a-f]{6})/gi)].map(m => m[1].toLowerCase())
      if (bgDeep.length !== 2) {
        throw new Error(
          `[theme-boot] src/styles/main.css 里期望恰好 2 个 --bg-deep（浅色在前、深色在后），实际 ${bgDeep.length} 个。`
          + `首帧底色依赖这两个值。`,
        )
      }

      // 2. index.html 的内联首帧底色必须与之一致（--boot-bg-light / --boot-bg-dark）
      const html = fs.readFileSync(r('src/newtab/index.html'), 'utf-8')
      const bootBg = new Map(
        [...html.matchAll(/--boot-bg-(light|dark):\s*(#[0-9a-f]{6})/gi)]
          .map(m => [m[1].toLowerCase(), m[2].toLowerCase()]),
      )
      const expect: Record<string, string> = { light: bgDeep[0], dark: bgDeep[1] }
      for (const [name, hex] of Object.entries(expect)) {
        if (bootBg.get(name) !== hex) {
          throw new Error(
            `[theme-boot] 首帧底色与 main.css 的 --bg-deep 不一致（${name}）：`
            + `src/newtab/index.html 里是 ${bootBg.get(name) ?? '缺失'}，main.css 里是 ${hex}。`
            + `两处必须一致，否则开页会闪一下颜色。`,
          )
        }
      }

      // 3. 首帧脚本必须是经典脚本，且读的镜像键与 useTheme() 写入的一致
      bootScript = fs.readFileSync(r('src/newtab/theme-boot.js'), 'utf-8')
      if (/^\s*(?:import|export)\s/m.test(bootScript)) {
        throw new Error(
          '[theme-boot] src/newtab/theme-boot.js 里出现了 import / export。'
          + '它必须保持经典脚本（同步执行），变成 module 会被推迟到首帧之后，预置就失效了。',
        )
      }
      if (!bootScript.includes(`'${THEME_MIRROR_KEY}'`)) {
        throw new Error(
          `[theme-boot] src/newtab/theme-boot.js 里没有读到镜像键 '${THEME_MIRROR_KEY}'`
          + `（真源在 src/logic/themeBoot.ts）。键名对不上时首帧预置会静默失效。`,
        )
      }

      // 4. 构建时把它作为静态资源落到 assets/ 下，URL 固定，便于产物里核对。
      //    dev 不 emit（Vite 的 dev server 不写盘），桩页面由 scripts/prepare.ts 指向 dev server。
      if (command === 'build') {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/theme-boot.js',
          source: bootScript,
        })
      }
    },

    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // 只处理新标签页；其余页面没有这段脚本
        if (!ctx.filename.replace(/\\/g, '/').endsWith('src/newtab/index.html'))
          return html

        const tag = '<script src="./theme-boot.js"></script>'
        const occurrences = html.split(tag).length - 1
        if (occurrences !== 1) {
          throw new Error(
            `[theme-boot] src/newtab/index.html 里期望恰好 1 个 ${tag}，实际 ${occurrences} 个。`
            + '首帧主题预置依赖它在 <head> 里同步执行；标签改名或搬走时，这个插件要一起改。',
          )
        }

        // serve 模式留给 prepare.ts 的桩页面改写，这里不动
        if (command !== 'build')
          return html

        return html.replace(tag, `<script src="${base}assets/theme-boot.js"></script>`)
      },
    },
  }
}

export const sharedConfig: UserConfig = {
  root: r('src'),
  resolve: {
    alias: {
      '~/': `${r('src')}/`,
    },
  },
  plugins: [
    Vue(),

    AutoImport({
      imports: [
        'vue',
        {
          'webextension-polyfill': [
            ['=', 'browser'],
          ],
        },
      ],
      dts: r('src/auto-imports.d.ts'),
    }),

    // https://github.com/antfu/unplugin-vue-components
    Components({
      dirs: [r('src/components')],
      // generate `components.d.ts` for ts support with Volar
      dts: r('src/components.d.ts'),
      resolvers: [
        // auto import icons
        IconsResolver({
          prefix: '',
        }),
      ],
    }),

    // https://github.com/antfu/unplugin-icons
    Icons(),

    // https://github.com/antfu/unocss
    //
    // 配置必须**内联**传进来，不能让 UnoCSS() 自己去加载 unocss.config.ts。
    // 默认路径是 @unocss/config → unconfig → jiti 在运行时加载 TS 配置；
    // 而 Node 22.18+ / 24 默认同时开着 .ts 类型擦除和 require(esm)，会先用原生
    // 加载器去解析 unocss.config.ts，卡在里面那句省略扩展名的相对导入
    // （`./src/logic/searchEngines`，只有打包器认）上；loader 链随后换一条路径
    // 再加载同一个文件，就撞上 Node 内部断言，`pnpm build` 直接崩在配置加载阶段：
    //   ERR_INTERNAL_ASSERTION: Unexpected status of a module that is
    //   imported again after being required. Status = 0
    // 传对象 + `configFile: false` 时 @unocss/config 会立刻返回这个对象、完全不碰
    // 文件加载；unocss.config.ts 变成上面那行普通 import，由 Vite 自己的 esbuild
    // 打包进配置，省略扩展名的导入交给打包器解析，于是和 Node 版本无关了。
    UnoCSS({ ...unoConfig, configFile: false }),

    // rewrite assets to use relative path
    {
      name: 'assets-rewrite',
      enforce: 'post',
      apply: 'build',
      transformIndexHtml(html, { path }) {
        return html.replace(/"\/assets\//g, `"${relative(dirname(path), '/assets')}/`)
      },
    },

    themeBoot(),

    // 时钟字体的 preload
    //
    // 为什么不能写在 index.html 里：字体是构建产物，文件名带内容哈希
    // （space-grotesk-latin-BhU9QXUp.woff2），源码阶段写不出这个带哈希、
    // 又相对于 dist/newtab/ 的正确路径。所以等 bundle 生成后，
    // 从产物里读出真实文件名，再按页面深度拼一个相对路径注入。
    {
      name: 'clock-font-preload',
      apply: 'build',
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!ctx.bundle)
            return html

          const font = Object.keys(ctx.bundle).find(
            name => name.endsWith('.woff2') && name.includes('space-grotesk-latin'),
          )
          if (!font) {
            throw new Error('时钟字体没有出现在构建产物里，检查 src/styles/main.css 的 @font-face')
            return html
          }

          // URL 里必须是正斜杠：Windows 下 path.relative 会给 `..\assets\x.woff2`
          const href = relative(dirname(ctx.path), `/${font}`).split('\\').join('/')
          return html.replace(
            '</title>',
            `</title>\n  <link rel="preload" as="font" type="font/woff2" crossorigin href="${href}">`,
          )
        },
      },
    },
  ],
  optimizeDeps: {
    include: [
      'vue',
      '@vueuse/core',
      'webextension-polyfill',
    ],
    exclude: [
      'vue-demi',
    ],
  },
}

export default defineConfig(({ command }) => ({
  ...sharedConfig,
  base: command === 'serve' ? `http://localhost:${port}/` : '/dist/',
  server: {
    /**
     * 显式绑 127.0.0.1，不要留空。
     *
     * Vite 5 的默认值是 `host: 'localhost'`，在 Windows 上只解析并绑定**一个**
     * 回环地址（本机实测只绑了 `::1`，`127.0.0.1` 直接 ECONNREFUSED）。
     * 而 `scripts/prepare.ts` 生成的 dev 桩页面里写的是
     * `http://localhost:3303/<view>/main.ts`，`localhost` 同时解析到 `::1` 和
     * `127.0.0.1`，浏览器先试哪个并不保证 —— 一旦它挑了 `127.0.0.1`，
     * 整个应用（连同磁贴的 <a href>）都加载不出来，页面只剩
     * 「Vite server did not start」，表现为「点图标没反应」，
     * 但根因其实跟磁贴逻辑毫无关系。
     *
     * 钉死 IPv4 之后，桩页面里的 `localhost` 必定解析到这个地址，行为确定。
     */
    host: '127.0.0.1',
    port,
    hmr: {
      host: 'localhost',
    },
    origin: `http://localhost:${port}`,
  },
  build: {
    watch: isDev
      ? {}
      : undefined,
    outDir: r('extension/dist'),
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    // https://developer.chrome.com/docs/webstore/program_policies/#:~:text=Code%20Readability%20Requirements
    terserOptions: {
      mangle: false,
    },
    rollupOptions: {
      input: {
        options: r('src/options/index.html'),
        popup: r('src/popup/index.html'),
        sidepanel: r('src/sidepanel/index.html'),
        newtab: r('src/newtab/index.html'),
      },
    },
  },
}))
