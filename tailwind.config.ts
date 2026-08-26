import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
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
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'md3-xs': '4px',
        'md3-sm': '8px',
        'md3-md': '12px',
        'md3-lg': '16px',
        'md3-xl': '28px',
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
        vibeCross: {
          '0%': { opacity: '0', transform: 'scale(1.06)', filter: 'blur(14px)' },
          '100%': { opacity: '1', transform: 'scale(1)', filter: 'blur(0px)' },
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
