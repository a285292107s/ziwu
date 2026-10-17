/**
 * 首帧主题预置相关的跨文件常量。
 *
 * 这个模块**只放常量、不 import 任何东西**：`vite.config.mts` 的 theme-boot-guard
 * 要在 Node 侧（Vite 配置进程里）读它，去校验 `src/newtab/theme-boot.js` 里的字面量
 * 有没有漂移。一旦这里多出一个 import，配置加载就会被牵连。
 */

/**
 * 主题的**同步镜像**键。
 *
 * `useTheme()` 每次主题变化都写它；`src/newtab/theme-boot.js` 在首帧之前读它。
 * 键名两边必须一致，theme-boot-guard 会校验。
 */
export const THEME_MIRROR_KEY = 'meridiem-theme-mirror'
