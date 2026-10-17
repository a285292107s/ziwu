/**
 * 全页动效的节拍。
 *
 * 为什么这件事值得一个共享常量：新标签页的入场是一条时间轴 ——
 * 时钟、问候、搜索框、磁贴带按先后落位（见 NewTab.vue 与 components/ShortcutGrid.vue）。
 * 这个先后原先散在两处：hero 的延迟写在 NewTab.vue 的 CSS 里，磁贴带的起波
 * 跟着 `chrome.storage` 的往返走。于是同一份构建每次打开，磁贴带会落在
 * 问候与搜索框之间的不同位置 —— 实测起波时刻在首帧之后十几毫秒到一百多毫秒
 * 之间漂。时间轴由 I/O 决定，就不叫编排。
 *
 * 现在两边都从这一个值派生：hero 的第 n 拍 = n × PAGE_BEAT_MS（CSS 里通过
 * `--beat` 变量取，见 NewTab.vue），磁贴带接在 hero 三拍之后起波。
 *
 * 放在 logic 层是因为它是纯数据：不碰 DOM、不碰 Vue、不碰 storage。
 */
export const PAGE_BEAT_MS = 60
