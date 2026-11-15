import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'

interface VibeBoundaryProps {
  children: ReactNode
  title: string
  description: string
  exitLabel: string
  onExit: () => void
}

/** Optional VIBE resources must not leave the entire application blank. */
export class VibeErrorBoundary extends Component<VibeBoundaryProps, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[vibe] Unable to render VIBE mode', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex h-full w-full items-center justify-center bg-dark-surface px-6 py-10 text-dark-onSurface">
        <div role="alert" className="w-full max-w-md rounded-md3-lg border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer p-6 shadow-elevation-2">
          <h1 className="text-ui-xl font-semibold">{this.props.title}</h1>
          <p className="mt-3 text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{this.props.description}</p>
          <button type="button" onClick={this.props.onExit} className="md-focus mt-6 min-h-11 rounded-md3-md bg-md-primary px-5 py-2 text-ui-sm font-medium text-md-onPrimary">
            {this.props.exitLabel}
          </button>
        </div>
      </div>
    )
  }
}

export default function VibeModeBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <VibeErrorBoundary
      title={t('vibe.loadFailedTitle')}
      description={t('vibe.loadFailedDescription')}
      exitLabel={t('vibe.returnToWorkspace')}
      onExit={() => useVibeStore.getState().toggleVibeMode(false)}
    >
      {children}
    </VibeErrorBoundary>
  )
}

/** A wallpaper or entertainment failure must never replace the working conversation. */
export class VibeResourceBoundary extends Component<{
  children: ReactNode
  fallback: 'background' | 'controls' | 'music'
}, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) { console.error('[vibe] Optional resource failed', error) }
  render() {
    if (!this.state.hasError) return this.props.children
    if (this.props.fallback === 'background') return null
    return <ResourceRecovery onRetry={() => this.setState({ hasError: false })} />
  }
}

function ResourceRecovery({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="relative z-20 flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-black/70 px-4 py-3 text-ui-xs text-white/80">
      <span>{t('vibe.resourceFailed')}</span>
      <button type="button" className="md-focus min-h-9 rounded-md3-sm border border-white/20 px-3" onClick={onRetry}>{t('common.retry')}</button>
      <button type="button" className="md-focus min-h-9 rounded-md3-sm px-3 hover:bg-white/10" onClick={() => useVibeStore.getState().toggleVibeMode(false)}>{t('vibe.exit')}</button>
    </div>
  )
}
