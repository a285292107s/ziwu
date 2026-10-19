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
  key: string
  label: string
  selector: string
  placement: KeyHintPlacement
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
