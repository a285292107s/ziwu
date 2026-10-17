/**
 * 按住 Alt 时浮出的区块快捷键表。
 *
 * 这里只放**纯数据**：键位、文案、要贴靠的 DOM 选择器、动作 id。
 * 真正的动作处理在 `NewTab.vue` 里（它才拿得到搜索框 / 快捷方式区的组件引用），
 * 视觉气泡在 `KeyHints.vue` 里。两处共用同一份配置，键位不会漂。
 *
 * 键位选型：Chrome 优先，避开 Alt+E/F/D（菜单/地址栏）和 Alt+数字（切标签页）。
 */
export type KeyHintPlacement = 'above' | 'below' | 'left' | 'right'

export type KeyHintAction =
  | 'settings'
  | 'theme'
  | 'greeting'
  | 'search'
  | 'grid'
  | 'manage'
  | 'add'

export interface KeyHintConfig {
  /** 小写键名，和 `KeyboardEvent.key.toLowerCase()` 对齐；`/` 原样 */
  key: string
  label: string
  /** 贴在哪个元素旁边；不存在就跳过（例如空列表时的「整理」） */
  selector: string
  placement: KeyHintPlacement
  /** 可选的副说明，例如网格的方向键 */
  detail?: string
  action: KeyHintAction
}

export const keyHints: KeyHintConfig[] = [
  {
    key: 's',
    label: '设置',
    selector: '[data-test="open-options"]',
    placement: 'below',
    action: 'settings',
  },
  {
    key: 't',
    label: '主题',
    selector: '.theme-switch',
    placement: 'below',
    action: 'theme',
  },
  {
    key: 'h',
    label: '问候',
    selector: '[data-test="greeting"], [data-test="greeting-input"]',
    placement: 'right',
    action: 'greeting',
  },
  {
    key: '/',
    label: '搜索',
    selector: '.search-root',
    placement: 'right',
    action: 'search',
  },
  {
    key: 'g',
    label: '快捷方式',
    detail: '↑↓←→',
    selector: '#shortcuts-heading',
    placement: 'above',
    action: 'grid',
  },
  {
    key: 'm',
    label: '整理',
    selector: '[data-test="toggle-edit"]',
    placement: 'above',
    action: 'manage',
  },
  {
    key: 'n',
    label: '新增',
    selector: '[data-test="add-shortcut"], [data-test="empty-add"]',
    placement: 'right',
    action: 'add',
  },
]
