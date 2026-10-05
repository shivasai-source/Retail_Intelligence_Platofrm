import { Button, Dropdown } from '../../components/ui'
import { Icon } from '../../icons'
import { useMmmView } from '../store'

const ALL_YEARS = 'All Years'

/** The MMM scope controls — the year and the display currency — in the same
 *  pill buttons and ₹ INR / $ USD switch TPO's filter bar uses, so the two
 *  modules' toolbars read as one design. State lives in ../store.ts and is
 *  shared by every MMM page. */
export function MmmToolbar({
  years,
  year,
  allowAll = true,
}: {
  years: number[]
  /** The year the page is actually showing (resolved from the store). */
  year: number | null
  /** The calendar is per year, so it hides "All Years". */
  allowAll?: boolean
}) {
  const setYear = useMmmView((s) => s.setYear)
  const label = year === null ? ALL_YEARS : String(year)
  const sorted = [...years].sort((a, b) => b - a)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dropdown
        selected={label}
        options={[...(allowAll ? [{ label: ALL_YEARS }] : []), ...sorted.map((y) => ({ label: String(y) }))]}
        onSelect={(picked) => setYear(picked === ALL_YEARS ? null : Number(picked))}
        trigger={
          <Button variant="secondary" size="pill" className="cursor-pointer">
            <Icon name="filter" />
            <span>{label}</span>
            <Icon name="chevronDown" />
          </Button>
        }
      />
      <MmmCurrencyToggle />
    </div>
  )
}

/** ₹ INR / $ USD, drawn as TPO's filter bar draws it. Presentation only:
 *  it changes how money is rendered, never a figure. */
export function MmmCurrencyToggle() {
  const currency = useMmmView((s) => s.currency)
  const setCurrency = useMmmView((s) => s.setCurrency)
  return (
    <div
      className="inline-flex h-9 items-center overflow-hidden rounded-[var(--r-md)] border border-border-subtle bg-surface-card p-0.5"
      role="radiogroup"
      aria-label="Display currency"
    >
      {(['INR', 'USD'] as const).map((code) => (
        <button
          key={code}
          type="button"
          role="radio"
          aria-checked={currency === code}
          aria-label={code === 'INR' ? 'Indian rupees' : 'US dollars'}
          onClick={() => setCurrency(code)}
          className={`h-full cursor-pointer rounded-[calc(var(--r-md)-3px)] px-2.5 text-sm font-semibold transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet ${
            currency === code
              ? 'bg-brand-violet text-white shadow-[var(--shadow-card-soft)]'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink-primary'
          }`}
        >
          {code === 'INR' ? '₹ INR' : '$ USD'}
        </button>
      ))}
    </div>
  )
}

/** The year a page should show: the reader's choice, or the latest in the
 *  data until they make one. */
export function resolveYear(chosen: number | null | undefined, years: number[] | undefined, allowAll = true) {
  if (chosen === null && allowAll) return null
  if (typeof chosen === 'number') return chosen
  return years?.length ? Math.max(...years) : null
}
