/**
 * 首帧主题预置（classic script）。
 *
 * ## 为什么必须有这个文件
 *
 * 主题的真源是 `chrome.storage.local`（**异步**），而浏览器的第一帧不等它。
 * 于是「存了深色主题、系统却是浅色」的用户会先看到一个浅色页面，几十毫秒后
 * 才翻成深色 —— 这就是开新标签页时「白屏闪一下」的一半来源（另一半是文档
 * 自己没有任何底色，见 index.html 里那段内联 <style>）。
 *
 * storage 没有同步读取接口，所以 `useTheme()` 每次把结果**镜像**进 localStorage
 * （见 composables/useTheme.ts），这里在第一帧之前把它读回来。localStorage 是同步
 * API，且 chrome-extension:// 下是持久的、四个页面（newtab/options/popup/sidepanel）
 * 共享同一份。
 *
 * ## 为什么是外链文件，不是内联 <script>
 *
 * MV3 生产 CSP 是 `script-src 'self'`，内联脚本会被拦。给内联脚本配 hash 也不行：
 * Chromium 把 hash 源当成不安全的 CSP 值，**整个扩展会加载失败**。实测（Chromium 128）：
 *
 *     Extension error: 无法加载以下来源的扩展程序： … 'content_security_policy.extension_pages':
 *     Insecure CSP value "'sha256-JPhC7YdV3yWOA9RPJBO7YeTjSE3NaD0EcfwxuFiJ+DM='" in directive 'script-src'.
 *
 * 所以只能做成 `'self'` 下的外链脚本 —— 它同样在 HTML 解析期间**同步**执行。
 *
 * ⚠️ 这里**不能**出现 `import` / `export`：那会让脚本变成 module（deferred），
 * 执行时机会掉到首帧之后，这个文件就白写了。vite.config.mts 的 theme-boot-guard
 * 会检查这一点。
 *
 * 主题的切换逻辑不在这里 —— 这里只负责「第一帧之前把 html 上的类放对」，
 * 之后由 useTheme() 接管。
 */
(function () {
  let mode = null

  try {
    mode = window.localStorage.getItem('meridiem-theme-mirror')
  }
  catch (error) {
    // localStorage 被禁（隐私设置/企业策略）时静默退回系统偏好，不能因此让页面报错
    void error
  }

  if (mode !== 'dark' && mode !== 'light') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }

  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  // `.light` 只服务于 index.html 里 `@media (prefers-color-scheme: dark) html:not(.light)`
  // 这条兜底规则：显式声明过浅色之后，系统偏好不能再把它翻成深色。
  root.classList.toggle('light', mode === 'light')
  root.style.colorScheme = mode
})()
