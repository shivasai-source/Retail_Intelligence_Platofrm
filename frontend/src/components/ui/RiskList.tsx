import { Icon, type IconName } from '../../icons'
import { Pill, type PillTone } from './Pill'

// Ported from css/tpo.css .risk-list / .risk-row / .risk-ic / .risk-title / .risk-desc
export interface RiskItem {
  title: string
  desc: string
  severity: string
  ic: IconName
  tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral'
}

const ICON_BG: Record<RiskItem['tone'], string> = {
  neutral: 'var(--brand-violet-50)',
  danger: 'var(--status-danger-bg)',
  warning: 'var(--status-warning-bg)',
  success: 'var(--status-success-bg)',
  info: 'var(--status-info-bg)',
}
const ICON_FG: Record<RiskItem['tone'], string> = {
  neutral: 'var(--brand-violet)',
  danger: 'var(--status-danger)',
  warning: 'var(--status-warning)',
  success: 'var(--status-success)',
  info: 'var(--status-info)',
}
const PILL_TONE: Record<RiskItem['tone'], PillTone> = {
  neutral: 'neutral',
  danger: 'danger',
  warning: 'warning',
  success: 'success',
  info: 'info',
}

export function RiskList({ items, onSelect }: { items: RiskItem[]; onSelect?: (item: RiskItem, i: number) => void }) {
  return (
    <div className="flex flex-col">
      {items.map((r, i) => (
        <div
          key={r.title}
          onClick={() => onSelect?.(r, i)}
          className="fade-in-up grid cursor-pointer grid-cols-[36px_1fr_auto] items-center gap-2.5 rounded-lg border-b border-border-subtle py-3 transition-colors duration-150 last:border-b-0 hover:bg-surface-hover"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div
            className="grid h-9 w-9 place-items-center rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]"
            style={{ background: ICON_BG[r.tone], color: ICON_FG[r.tone] }}
          >
            <Icon name={r.ic} />
          </div>
          <div className="min-w-0">
            <div className="text-base font-medium text-ink-primary">{r.title}</div>
            <div className="mt-0.5 text-sm text-ink-muted">{r.desc}</div>
          </div>
          <Pill tone={PILL_TONE[r.tone]}>{r.severity}</Pill>
        </div>
      ))}
    </div>
  )
}
