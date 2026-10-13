/**
 * 随时间变化的氛围背景。
 *
 * 纯函数，不依赖 Vue / DOM / storage，方便单测。
 * 设计意图：新标签页一天里被打开很多次，背景随清晨/白天/黄昏/深夜缓慢变化，
 * 提供「时间感」而不喧宾夺主：所有色相都很淡，保证正文对比度。
 */

export type PhaseKey = 'dawn' | 'day' | 'dusk' | 'night'

export interface AmbiencePalette {
  /** 渐变起始色 */
  from: string
  /** 渐变结束色 */
  to: string
  /** 顶部柔光颜色（rgba） */
  glow: string
}

export interface AmbiencePhase {
  key: PhaseKey
  label: string
  light: AmbiencePalette
  dark: AmbiencePalette
}

/**
 * 四个时段，界限按小时划分。
 *
 * 配色原则：
 * 1. **底色永远落在中性冷灰上**，时段只贡献极轻的一层染色（from/to 相差很小），
 *    这样正文对比度不会随时段漂移，深浅两主题也不用各调一套文字色。
 * 2. glow 用低饱和的品牌青系而不是时段原色：整页只有「青」一个强调色，
 *    时段感靠明度与冷暖的细微偏移表达，而不是换一种色相。
 * 3. 深色底不是纯黑：留一点蓝相，避免 OLED 上的死黑和边缘断层。
 */
export const phases: Record<PhaseKey, AmbiencePhase> = {
  dawn: {
    key: 'dawn',
    label: '清晨',
    light: { from: '#f2f4f8', to: '#f7f9fb', glow: 'rgba(13, 148, 136, 0.1)' },
    dark: { from: '#0b1218', to: '#070b11', glow: 'rgba(45, 212, 191, 0.1)' },
  },
  day: {
    key: 'day',
    label: '白天',
    light: { from: '#eef4f4', to: '#f8fafb', glow: 'rgba(15, 118, 110, 0.11)' },
    dark: { from: '#081215', to: '#060a0f', glow: 'rgba(45, 212, 191, 0.11)' },
  },
  dusk: {
    key: 'dusk',
    label: '黄昏',
    light: { from: '#f4f1f0', to: '#f8f7f8', glow: 'rgba(13, 148, 136, 0.09)' },
    dark: { from: '#120f13', to: '#08080c', glow: 'rgba(45, 212, 191, 0.09)' },
  },
  night: {
    key: 'night',
    label: '夜晚',
    light: { from: '#eef0f6', to: '#f6f8fa', glow: 'rgba(15, 118, 110, 0.1)' },
    dark: { from: '#0a1020', to: '#04060c', glow: 'rgba(45, 212, 191, 0.13)' },
  },
}

/** 时段顺序，用于背景叠层的渲染顺序（固定不变，避免重排） */
export const phaseOrder: PhaseKey[] = ['dawn', 'day', 'dusk', 'night']

/**
 * 由小时数决定时段。
 * - 5-7 清晨
 * - 8-16 白天
 * - 17-19 黄昏
 * - 20-4 夜晚
 */
export function phaseForHour(hour: number): PhaseKey {
  const h = Math.max(0, Math.min(23, Math.floor(hour)))

  if (h >= 5 && h < 8)
    return 'dawn'
  if (h >= 8 && h < 17)
    return 'day'
  if (h >= 17 && h < 20)
    return 'dusk'

  return 'night'
}

/** 取某个时段的配色 */
export function paletteFor(phase: PhaseKey, dark: boolean): AmbiencePalette {
  return dark ? phases[phase].dark : phases[phase].light
}
