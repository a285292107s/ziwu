/**
 * 首次安装时的**通用**站点种子。
 *
 * 这里只放「任何装了新标签页的人都可能用得上」的公共站点，
 * 用来让首屏不至于是一张空网格。**不要**往这里加任何个人信息：
 *
 * - 私人书签（自己的后台、自家域名、内网地址、带账号或订单参数的链接）
 *   一律不属于源码。仓库里的东西会被打包进扩展产物、推到远端、被别人看到，
 *   而书签是隐私。
 * - 个人站点请用设置页的「粘贴配置导入」写进 `browser.storage.local`：
 *   数据只留在本机的 `meridiem-shortcuts` 键里，不进仓库、不进构建产物。
 *
 * 清单本身是「公共站点目录」，不引用 `PRESET_SITES` —— 后者已随个人数据一起移除。
 */
export interface DefaultSite {
  name: string
  url: string
}

/**
 * 种子清单：覆盖搜索、代码、资讯、视频这几个最通用的类别，每个类别少量即可。
 * 顺序就是新标签页上的磁贴顺序，把最常用的放前面。
 *
 * 选取原则：**只选无需登录即可打开、且与具体个人账号无关的公开首页**。
 * 带查询串的深链（后台、审核台、投放页）即使域名公开也不该放进来，
 * 因为这类链接往往自带租户 / 账号标识。
 */
export const DEFAULT_SITES: DefaultSite[] = [
  { name: 'GitHub', url: 'https://github.com/' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { name: '掘金', url: 'https://juejin.cn/' },
  { name: 'MDN', url: 'https://developer.mozilla.org/zh-CN/' },
  { name: '维基百科', url: 'https://zh.wikipedia.org/' },
]
