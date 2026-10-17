/**
 * 按时段取色的**降级调色板**。
 *
 * 天光（WebGL）画不出来的时候，`.sky__fallback` 会直接用这里算出的三个颜色做
 * CSS 渐变兜底。所以它跟真实时间走，跟 `?sky=` 评审覆盖无关。
 *
 * 纯函数，不依赖 Vue / DOM / storage。
 */
import { phaseForHour } from './sky'
import type { PhaseKey } from './sky'

interface AmbiencePalette {
  from: string
  to: string
  glow: string
}

/**
 * 四个时段。
 *
 * 配色原则：
 * 1. **底色永远落在中性冷灰上**，时段只贡献极轻的一层染色，这样正文对比度
 *    不会随时段漂移，深浅两主题也不用各调一套文字色。
 * 2. glow 用低饱和的品牌青系而不是时段原色：整页只有「青」一个强调色。
 * 3. 深色底不是纯黑，留一点蓝相，避免 OLED 上的死黑和边缘断层。
 */
const phases: Record<PhaseKey, { light: AmbiencePalette, dark: AmbiencePalette }> = {
  dawn: {
    light: { from: '#f2f4f8', to: '#f7f9fb', glow: 'rgba(13, 148, 136, 0.1)' },
    dark: { from: '#0b1218', to: '#070b11', glow: 'rgba(45, 212, 191, 0.1)' },
  },
  day: {
    light: { from: '#eef4f4', to: '#f8fafb', glow: 'rgba(15, 118, 110, 0.11)' },
    dark: { from: '#081215', to: '#060a0f', glow: 'rgba(45, 212, 191, 0.11)' },
  },
  dusk: {
    light: { from: '#f4f1f0', to: '#f8f7f8', glow: 'rgba(13, 148, 136, 0.09)' },
    dark: { from: '#120f13', to: '#08080c', glow: 'rgba(45, 212, 191, 0.09)' },
  },
  night: {
    light: { from: '#eef0f6', to: '#f6f8fa', glow: 'rgba(15, 118, 110, 0.1)' },
    dark: { from: '#0a1020', to: '#04060c', glow: 'rgba(45, 212, 191, 0.13)' },
  },
}

/**
 * 时段只认 `logic/sky.ts` 的 `phaseForHour`（那里是唯一真源）。
 * 两边各写一套界限的话，WebGL 挂掉降级到本文件的调色板时，颜色会在时段边界上跳一下。
 */
export { phaseForHour }
export type { PhaseKey }

export function paletteFor(phase: PhaseKey, dark: boolean): AmbiencePalette {
  return dark ? phases[phase].dark : phases[phase].light
}
