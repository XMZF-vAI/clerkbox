import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, RotateCcw, Database, Zap, ArrowDownToLine, ArrowUpFromLine, TrendingUp } from 'lucide-react'
import { useTokenUsageStore } from '../../stores/token-usage-store'
import ConfirmDialog from '../ui/ConfirmDialog'

/** 格式化数字：千分位 + K/M 简写 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

interface StatCardProps {
  icon: typeof Activity
  label: string
  value: string
  hint?: string
  accent: 'primary' | 'success' | 'warning' | 'info'
}

function StatCard({ icon: Icon, label, value, hint, accent }: StatCardProps) {
  const accentMap: Record<StatCardProps['accent'], string> = {
    primary: 'text-md-primary',
    success: 'text-md-success',
    warning: 'text-md-warning',
    info: 'text-md-info',
  }
  const bgMap: Record<StatCardProps['accent'], string> = {
    primary: 'bg-md-primary/8 border-md-primary/20',
    success: 'bg-md-success/8 border-md-success/20',
    warning: 'bg-md-warning/8 border-md-warning/20',
    info: 'bg-md-info/8 border-md-info/20',
  }
  return (
    <div className={`p-3 rounded-md3-md border ${bgMap[accent]}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={12} className={accentMap[accent]} />
        <span className="text-[11px] text-dark-onSurfaceVariant/70">{label}</span>
      </div>
      <div className={`text-base font-semibold ${accentMap[accent]}`}>{value}</div>
      {hint && <div className="text-[10px] text-dark-onSurfaceVariant/50 mt-0.5">{hint}</div>}
    </div>
  )
}

export default function TokenUsageStats() {
  const { t } = useTranslation()
  const stats = useTokenUsageStore()
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const hasData = stats.totalCalls > 0
  const cacheTotal = stats.totalCacheCreationTokens + stats.totalCacheReadTokens
  const cacheHitRate = cacheTotal > 0
    ? (stats.totalCacheReadTokens / cacheTotal) * 100
    : 0

  return (
    <div className="space-y-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-md-primary flex-shrink-0" />
          <span className="text-sm font-medium text-dark-onSurface">{t('settings.general.tokenTitle')}</span>
        </div>
        {hasData && (
          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            className="flex items-center gap-1 text-[11px] text-dark-onSurfaceVariant/60 hover:text-md-error transition-colors"
          >
            <RotateCcw size={11} />
            {t('settings.general.clearStats')}
          </button>
        )}
      </div>

      <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed">
        {t('settings.general.tokenDesc')}
      </p>

      {!hasData ? (
        <div className="py-6 text-center text-xs text-dark-onSurfaceVariant/40">
          {t('settings.general.noData')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={Zap}
              label={t('settings.general.totalCalls')}
              value={stats.totalCalls.toLocaleString()}
              accent="primary"
            />
            <StatCard
              icon={TrendingUp}
              label={t('settings.general.cacheHitRate')}
              value={cacheHitRate.toFixed(1) + '%'}
              hint={`${formatTokens(stats.totalCacheReadTokens)} / ${formatTokens(cacheTotal)}`}
              accent="success"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={ArrowDownToLine}
              label={t('settings.general.totalPrompt')}
              value={formatTokens(stats.totalPromptTokens)}
              hint={stats.totalPromptTokens.toLocaleString() + ' tokens'}
              accent="info"
            />
            <StatCard
              icon={ArrowUpFromLine}
              label={t('settings.general.totalCompletion')}
              value={formatTokens(stats.totalCompletionTokens)}
              hint={stats.totalCompletionTokens.toLocaleString() + ' tokens'}
              accent="warning"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={Database}
              label={t('settings.general.cacheCreation')}
              value={formatTokens(stats.totalCacheCreationTokens)}
              accent="info"
            />
            <StatCard
              icon={Database}
              label={t('settings.general.cacheRead')}
              value={formatTokens(stats.totalCacheReadTokens)}
              accent="success"
            />
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-dark-onSurfaceVariant/10 text-xs">
            <span className="text-dark-onSurfaceVariant/70">{t('settings.general.totalTokens')}</span>
            <span className="font-semibold text-dark-onSurface">{formatTokens(stats.totalTokens)}</span>
          </div>
        </>
      )}

      {showClearConfirm && (
        <ConfirmDialog
          title={t('settings.general.clearStats')}
          message={t('settings.general.clearStatsConfirm')}
          confirmText={t('settings.general.clearStats')}
          variant="danger"
          onConfirm={() => {
            stats.resetStats()
            setShowClearConfirm(false)
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}
