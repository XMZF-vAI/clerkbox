import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: {
    files: [
      './index.html',
      './src/**/*.{ts,tsx}',
      // markdown 渲染器不是模板文件：里面的字符类正则（表格分隔行 /^[-:|\s]+$/）
      // 会被扫描器当成 Tailwind 任意属性，产物 CSS 里因此长出一条非法声明
      // `-: |s` 并触发 esbuild 的 css-syntax-error 告警。
      '!./src/lib/markdown.ts',
    ],
  },
  theme: {
    extend: {
      colors: {
        md: {
          primary: 'rgb(var(--md-primary-rgb) / <alpha-value>)',
          onPrimary: 'rgb(var(--md-onPrimary-rgb) / <alpha-value>)',
          primaryContainer: 'rgb(var(--md-primaryContainer-rgb) / <alpha-value>)',
          onPrimaryContainer: 'rgb(var(--md-onPrimaryContainer-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--md-secondary-rgb) / <alpha-value>)',
          onSecondary: 'rgb(var(--md-onSecondary-rgb) / <alpha-value>)',
          secondaryContainer: 'rgb(var(--md-secondaryContainer-rgb) / <alpha-value>)',
          onSecondaryContainer: 'rgb(var(--md-onSecondaryContainer-rgb) / <alpha-value>)',
          tertiary: 'rgb(var(--md-tertiary-rgb) / <alpha-value>)',
          onTertiary: 'rgb(var(--md-onTertiary-rgb) / <alpha-value>)',
          tertiaryContainer: 'rgb(var(--md-tertiaryContainer-rgb) / <alpha-value>)',
          onTertiaryContainer: 'rgb(var(--md-onTertiaryContainer-rgb) / <alpha-value>)',
          surface: 'rgb(var(--md-surface-rgb) / <alpha-value>)',
          surfaceDim: 'rgb(var(--md-surfaceDim-rgb) / <alpha-value>)',
          surfaceBright: 'rgb(var(--md-surfaceBright-rgb) / <alpha-value>)',
          surfaceContainer: 'rgb(var(--md-surfaceContainer-rgb) / <alpha-value>)',
          surfaceContainerHigh: 'rgb(var(--md-surfaceContainerHigh-rgb) / <alpha-value>)',
          surfaceContainerHighest: 'rgb(var(--md-surfaceContainerHighest-rgb) / <alpha-value>)',
          onSurface: 'rgb(var(--md-onSurface-rgb) / <alpha-value>)',
          onSurfaceVariant: 'rgb(var(--md-onSurfaceVariant-rgb) / <alpha-value>)',
          outline: 'rgb(var(--md-outline-rgb) / <alpha-value>)',
          outlineVariant: 'rgb(var(--md-outlineVariant-rgb) / <alpha-value>)',
          error: 'rgb(var(--md-error-rgb) / <alpha-value>)',
          onError: 'rgb(var(--md-onError-rgb) / <alpha-value>)',
          success: 'rgb(var(--md-success-rgb) / <alpha-value>)',
          warning: 'rgb(var(--md-warning-rgb) / <alpha-value>)',
          info: 'rgb(var(--md-info-rgb) / <alpha-value>)',
          // Agent 交互语义色（固定基线，不随 seed 变化）：ask=待审批，confirmation=危险确认
          askSurface: 'rgb(var(--md-ask-surface-rgb) / <alpha-value>)',
          askForeground: 'rgb(var(--md-ask-onSurface-rgb) / <alpha-value>)',
          confirmationSurface: 'rgb(var(--md-confirmation-surface-rgb) / <alpha-value>)',
          confirmationForeground: 'rgb(var(--md-confirmation-onSurface-rgb) / <alpha-value>)',
        },
        dark: {
          surface: 'rgb(var(--dark-surface-rgb) / <alpha-value>)',
          surfaceDim: 'rgb(var(--dark-surfaceDim-rgb) / <alpha-value>)',
          surfaceBright: 'rgb(var(--dark-surfaceBright-rgb) / <alpha-value>)',
          surfaceContainer: 'rgb(var(--dark-surfaceContainer-rgb) / <alpha-value>)',
          surfaceContainerHigh: 'rgb(var(--dark-surfaceContainerHigh-rgb) / <alpha-value>)',
          surfaceContainerHighest: 'rgb(var(--dark-surfaceContainerHighest-rgb) / <alpha-value>)',
          onSurface: 'rgb(var(--dark-onSurface-rgb) / <alpha-value>)',
          onSurfaceVariant: 'rgb(var(--dark-onSurfaceVariant-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--app-font-family)'],
      },
      // text-ui-*：跟随 --ui-font-size 整体缩放；倍率与 line-height 取自 Tailwind 默认档，
      // 故 scale=100% 时与同名默认类（xs/sm/base/lg/xl/2xl）计算值完全相等，可逐档迁移
      fontSize: {
        'ui-2xl': ['calc(var(--ui-font-size) * 1.5)', { lineHeight: '2rem' }],
        'ui-xl': ['calc(var(--ui-font-size) * 1.25)', { lineHeight: '2rem' }],
        'ui-lg': ['calc(var(--ui-font-size) * 1.125)', { lineHeight: '1.75rem' }],
        'ui-base': ['var(--ui-font-size)', { lineHeight: '1.5rem' }],
        'ui-sm': ['calc(var(--ui-font-size) * 0.875)', { lineHeight: '1.25rem' }],
        'ui-xs': ['calc(var(--ui-font-size) * 0.75)', { lineHeight: '1rem' }],
      },
      borderRadius: {
        'md3-xs': '4px',
        'md3-sm': '8px',
        'md3-md': '12px',
        'md3-lg': '16px',
        'md3-xl': '28px',
      },
      // MD3 高程阴影：令牌定义在 index.css :root（shadow-elevation-1/2/3）
      boxShadow: {
        'elevation-1': 'var(--md-shadow-1)',
        'elevation-2': 'var(--md-shadow-2)',
        'elevation-3': 'var(--md-shadow-3)',
      },
      // MD3 标准缓动曲线（ease-md-standard / ease-md-emphasized-decelerate / ease-md-emphasized-accelerate）
      transitionTimingFunction: {
        'md-standard': 'cubic-bezier(0.2, 0, 0, 1)',
        'md-emphasized-decelerate': 'cubic-bezier(0.05, 0.7, 0.1, 1)',
        'md-emphasized-accelerate': 'cubic-bezier(0.3, 0, 0.8, 0.15)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-left': 'slideInLeft 0.25s cubic-bezier(0.23, 1, 0.32, 1) both',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'fade-up': 'fadeUp 0.3s cubic-bezier(0.23, 1, 0.32, 1) both',
        'pop-in': 'popIn 0.25s cubic-bezier(0.23, 1, 0.32, 1) both',
        'vibe-cross': 'vibeCross 1.4s cubic-bezier(0.23, 1, 0.32, 1) both',
      },
      keyframes: {
        // 全屏图层动画只走 opacity/transform（合成器友好）；
        // blur 关键帧会让全屏图层每帧重算模糊，核显机器切图时掉帧
        vibeCross: {
          '0%': { opacity: '0', transform: 'scale(1.06)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        popIn: {
          '0%': { opacity: '0', transform: 'scale(0.92)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
