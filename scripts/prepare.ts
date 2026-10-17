// generate stub index.html files for dev entry
import { execSync } from 'node:child_process'
import fs from 'fs-extra'
import chokidar from 'chokidar'
import { isDev, log, port, r } from './utils'

/**
 * Stub index.html to use Vite in development
 */
async function stubIndexHtml() {
  const views = ['options', 'popup', 'sidepanel', 'newtab']

  for (const view of views) {
    await fs.ensureDir(r(`extension/dist/${view}`))
    let data = await fs.readFile(r(`src/${view}/index.html`), 'utf-8')
    data = data
      .replace('"./main.ts"', `"http://localhost:${port}/${view}/main.ts"`)
      // 首帧主题预置的脚本也要指向 dev server：桩页面就在 extension/dist 下，
      // 相对路径 `./theme-boot.js` 在这里是找不到文件的（只有 newtab 有它）。
      // 注意连 </script> 一起匹配：index.html 的注释里也写了这个标签的样子，
      // 只匹配 `"./theme-boot.js"` 会改到注释上、真正的标签留在原地变 404。
      .replace('<script src="./theme-boot.js"></script>', `<script src="http://localhost:${port}/${view}/theme-boot.js"></script>`)
      .replace('<div id="app"></div>', '<div id="app">Vite server did not start</div>')
    await fs.writeFile(r(`extension/dist/${view}/index.html`), data, 'utf-8')
    log('PRE', `stub ${view}`)
  }
}

function writeManifest() {
  execSync('npx esno ./scripts/manifest.ts', { stdio: 'inherit' })
}

writeManifest()

if (isDev) {
  stubIndexHtml()
  chokidar.watch(r('src/**/*.html'))
    .on('change', () => {
      stubIndexHtml()
    })
  chokidar.watch([r('src/manifest.ts'), r('package.json')])
    .on('change', () => {
      writeManifest()
    })
}
