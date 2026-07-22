import {
  argbFromHex,
  hexFromArgb,
  redFromArgb,
  greenFromArgb,
  blueFromArgb,
  Hct,
  SchemeTonalSpot,
  MaterialDynamicColors,
} from '@material/material-color-utilities'

/** 马卡龙预设色系（低饱和粉彩种子色，经 MD3 HCT 算法生成完整配色） */
export interface MacaronPreset {
  id: string
  label: string
  seed: string
}

export const MACARON_PRESETS: MacaronPreset[] = [
  { id: 'classic', label: '经典灰', seed: '#5F6368' },
  { id: 'sakura', label: '樱花粉', seed: '#F4A7B9' },
  { id: 'mint', label: '薄荷绿', seed: '#98D8C8' },
  { id: 'lavender', label: '薰衣草紫', seed: '#B4A7D6' },
  { id: 'sky', label: '天空蓝', seed: '#A7C7E7' },
  { id: 'peach', label: '蜜桃橙', seed: '#FFB59E' },
  { id: 'cream', label: '奶油黄', seed: '#F0D9A8' },
]

export const DEFAULT_COLOR_SCHEME = 'classic'
export const DEFAULT_CUSTOM_SEED = '#F4A7B9'

/** 解析设置项为实际种子色 */
export function resolveSeed(colorScheme: string, customSeedColor: string): string {
  if (colorScheme === 'custom') return customSeedColor || DEFAULT_CUSTOM_SEED
  return MACARON_PRESETS.find((p) => p.id === colorScheme)?.seed ?? MACARON_PRESETS[0].seed
}

function rgbComponents(argb: number): string {
  return `${redFromArgb(argb)} ${greenFromArgb(argb)} ${blueFromArgb(argb)}`
}

function buildScheme(seedHex: string, dark: boolean): SchemeTonalSpot {
  return new SchemeTonalSpot(Hct.fromInt(argbFromHex(seedHex)), dark, 0)
}

/**
 * 从种子色生成 MD3 配色并写入 CSS 变量。
 * 同时刷新 --md-* 与 --dark-* 两套变量，所有基于 token 的组件零改动生效。
 */
export function applyColorScheme(seedHex: string, dark: boolean): void {
  const scheme = buildScheme(seedHex, dark)
  const c = MaterialDynamicColors
  const argb = (color: (typeof c)['primary']) => color.getArgb(scheme)
  const root = document.documentElement

  const entries: Array<[string, number]> = [
    ['--md-primary-rgb', argb(c.primary)],
    ['--md-onPrimary-rgb', argb(c.onPrimary)],
    ['--md-primaryContainer-rgb', argb(c.primaryContainer)],
    ['--md-onPrimaryContainer-rgb', argb(c.onPrimaryContainer)],
    ['--md-secondary-rgb', argb(c.secondary)],
    ['--md-onSecondary-rgb', argb(c.onSecondary)],
    ['--md-secondaryContainer-rgb', argb(c.secondaryContainer)],
    ['--md-onSecondaryContainer-rgb', argb(c.onSecondaryContainer)],
    ['--md-tertiary-rgb', argb(c.tertiary)],
    ['--md-onTertiary-rgb', argb(c.onTertiary)],
    ['--md-tertiaryContainer-rgb', argb(c.tertiaryContainer)],
    ['--md-onTertiaryContainer-rgb', argb(c.onTertiaryContainer)],
    ['--md-surface-rgb', argb(c.surface)],
    ['--md-surfaceDim-rgb', argb(c.surfaceDim)],
    ['--md-surfaceBright-rgb', argb(c.surfaceBright)],
    ['--md-surfaceContainer-rgb', argb(c.surfaceContainer)],
    ['--md-surfaceContainerHigh-rgb', argb(c.surfaceContainerHigh)],
    ['--md-surfaceContainerHighest-rgb', argb(c.surfaceContainerHighest)],
    ['--md-onSurface-rgb', argb(c.onSurface)],
    ['--md-onSurfaceVariant-rgb', argb(c.onSurfaceVariant)],
    ['--md-outline-rgb', argb(c.outline)],
    ['--md-outlineVariant-rgb', argb(c.outlineVariant)],
    ['--md-error-rgb', argb(c.error)],
    ['--md-onError-rgb', argb(c.onError)],
  ]

  for (const [name, value] of entries) {
    root.style.setProperty(name, rgbComponents(value))
  }

  // dark-* token 是当前主题 surface 的镜像（历史命名），同步刷新
  const mirror: Array<[string, number]> = [
    ['--dark-surface-rgb', argb(c.surface)],
    ['--dark-surfaceDim-rgb', argb(c.surfaceDim)],
    ['--dark-surfaceBright-rgb', argb(c.surfaceBright)],
    ['--dark-surfaceContainer-rgb', argb(c.surfaceContainer)],
    ['--dark-surfaceContainerHigh-rgb', argb(c.surfaceContainerHigh)],
    ['--dark-surfaceContainerHighest-rgb', argb(c.surfaceContainerHighest)],
    ['--dark-onSurface-rgb', argb(c.onSurface)],
    ['--dark-onSurfaceVariant-rgb', argb(c.onSurfaceVariant)],
  ]
  for (const [name, value] of mirror) {
    root.style.setProperty(name, rgbComponents(value))
  }
}

/** 设置页色卡预览：返回该种子色在浅色下的 primary/secondary/tertiary 三色 */
export function schemeSwatches(seedHex: string): { primary: string; secondary: string; tertiary: string } {
  const scheme = buildScheme(seedHex, false)
  const c = MaterialDynamicColors
  return {
    primary: hexFromArgb(c.primary.getArgb(scheme)),
    secondary: hexFromArgb(c.secondaryContainer.getArgb(scheme)),
    tertiary: hexFromArgb(c.tertiaryContainer.getArgb(scheme)),
  }
}
