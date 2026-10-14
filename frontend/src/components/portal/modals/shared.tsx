import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../../icons'
import { IconButton, Button } from '../../ui'

// Small shared pieces reused across the 5 "special connector" modals
// (Azure/Databricks/SAP/Power BI/NielsenIQ) — same header/footer/result-list shape
// as js/portal.js's near-identical modal builders for each.

export function ConnectModalHeader({ logo, title, subtitle, onClose }: { logo: ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[9px]">{logo}</div>
        <div>
          <h3 className="text-md font-medium">{title}</h3>
          <div className="mt-0.5 text-sm text-ink-muted">{subtitle}</div>
        </div>
      </div>
      <IconButton icon="x" onClick={onClose} />
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null
  return <div className="mb-3 rounded-[var(--r-sm)] bg-status-danger-bg p-[8px_12px] text-base text-[var(--pill-danger-ink)]">{message}</div>
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  )
}

export function ModalFooter({ onClose, showDone, onDone }: { onClose: () => void; showDone: boolean; onDone: () => void }) {
  return (
    <div className="flex justify-end gap-2 p-[14px_22px]">
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
      {showDone && (
        <Button variant="primary" onClick={onDone}>
          <Icon name="check" /> Done
        </Button>
      )}
    </div>
  )
}

export function ResultList({ items, onSelect }: { items: { key: string; icon: IconName; label: string; sub?: string }[]; onSelect: (key: string) => void }) {
  if (!items.length) return <div className="text-sm text-ink-muted">Nothing visible to this account.</div>
  return (
    <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onSelect(it.key)}
          className="flex w-full items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-medium text-ink-primary hover:bg-brand-violet-50 hover:text-brand-violet [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0 [&_svg]:text-ink-muted"
        >
          <Icon name={it.icon} />
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
          {it.sub && <span className="shrink-0 text-ink-muted">{it.sub}</span>}
        </button>
      ))}
    </div>
  )
}

export function Breadcrumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-brand-violet">
      <Icon name="chevronLeft" className="h-3.5 w-3.5" /> {label}
    </button>
  )
}

export function ProxyTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
  if (!columns.length) return <div className="text-sm text-ink-muted">No columns returned.</div>
  return (
    <div className="max-h-[220px] overflow-auto rounded-[var(--r-md)] border border-border-subtle">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className="sticky top-0 whitespace-nowrap bg-surface-muted p-[7px_10px] text-left font-medium text-ink-secondary">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-surface-hover">
              {r.map((v, j) => (
                <td key={j} className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap border-t border-border-subtle p-[6px_10px]">
                  {v === null || v === undefined ? <span className="text-ink-muted">null</span> : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
