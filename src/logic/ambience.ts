import { phaseForHour } from './sky'
import type { PhaseKey } from './sky'

interface AmbiencePalette {
  from: string
  to: string
  glow: string
}

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

export { phaseForHour }
export type { PhaseKey }

export function paletteFor(phase: PhaseKey, dark: boolean): AmbiencePalette {
  return dark ? phases[phase].dark : phases[phase].light
}
