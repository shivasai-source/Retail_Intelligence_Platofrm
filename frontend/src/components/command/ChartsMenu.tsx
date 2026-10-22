import { Button } from '../ui'
import { Icon } from '../../icons'
import { MultiSelect } from './MultiSelect'
import { DEFAULT_PANELS, HUB_PANELS } from './hubPanels'
import { useHubLayout } from '../../store/hubLayout'

/** WHICH CHARTS ARE ON THE DASHBOARD, from the toolbar.
 *
 *  The Analyst can do this in a sentence — "drop the region chart", "put
 *  product performance back" — and that is the point of it. But a capability
 *  that exists only inside a chat is one a reader has to know to ask for, and
 *  they would still have no way to see what is available. So the same list
 *  sits behind a control beside Add KPI, in the same MultiSelect, with the
 *  same pill trigger: the two menus are the same kind of thing — what is on
 *  screen, not what the numbers are scoped to.
 *
 *  Both routes write the same store, so a chart hidden by the Analyst shows as
 *  unticked here, and a chart unticked here is one the Analyst will say is
 *  already off. */
export function ChartsMenu() {
  const visible = useHubLayout((s) => s.charts)
  const setCharts = useHubLayout((s) => s.setCharts)
  const change = useHubLayout((s) => s.change)

  const options = HUB_PANELS.map((p) => ({ code: p.id, name: p.label }))
  const hidden = HUB_PANELS.length - visible.length

  return (
    <MultiSelect
      label="Charts"
      options={options}
      selected={visible}
      allLabel="Every chart"
      onToggle={(id) =>
        // Through `change` so the reader's own edit is undoable by the same
        // stack the Analyst's are: "undo" should mean the last change, not the
        // last change of a particular kind.
        change(
          visible.includes(id) ? `removed ${label(id)}` : `added ${label(id)}`,
          () => setCharts(visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id]),
        )
      }
      onClear={() => change('put every chart back', () => setCharts([...DEFAULT_PANELS]))}
      trigger={
        <Button variant="secondary" size="pill" className="cursor-pointer">
          <Icon name="grid" />
          <span>Charts</span>
          {/* How many are OFF, not how many are on: nine of nine is the
              default and a badge reading "9" on every page load would be
              noise. A badge here always means "something is hidden". */}
          {hidden > 0 && (
            <span className="rounded-[var(--r-pill)] bg-brand-violet-50 px-1.5 text-xs font-medium tabular-nums text-brand-violet">
              {hidden} off
            </span>
          )}
          <Icon name="chevronDown" />
        </Button>
      }
    />
  )
}

const label = (id: string) => HUB_PANELS.find((p) => p.id === id)?.label ?? id
