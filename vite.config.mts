import { dirname, relative } from 'node:path'
import type { UserConfig } from 'vite'
import { defineConfig } from 'vite'
import Vue from '@vitejs/plugin-vue'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import UnoCSS from 'unocss/vite'
import { isDev, port, r } from './scripts/utils'
import packageJson from './package.json'
import unoConfig from './unocss.config'

export const sharedConfig: UserConfig = {
  root: r('src'),
  resolve: {
    alias: {
      '~/': `${r('src')}/`,
    },
  },
  define: {
    __DEV__: isDev,
    __NAME__: JSON.stringify(packageJson.name),
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
