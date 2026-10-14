// Ported from css/components.css .tabs / .tab / .tab-count
export interface TabItem {
  key: string
  label: string
  count?: number
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="mb-5 flex gap-1 border-b border-border-subtle">
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-4 py-2.5 text-base font-medium transition-colors duration-150 ${
              isActive
                ? 'border-brand-violet text-brand-violet'
                : 'border-transparent text-ink-muted hover:text-ink-primary'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`rounded-[var(--r-pill)] px-1.5 text-xs font-medium ${
                  isActive ? 'bg-brand-violet-50 text-brand-violet' : 'bg-surface-muted text-ink-secondary'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
