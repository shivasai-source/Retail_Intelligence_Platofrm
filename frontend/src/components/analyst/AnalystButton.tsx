import { Icon } from '../../icons'

/** THE WAY IN — sits in the toolbar to the right of Export.
 *
 *  Deliberately not the app's `Button`: this one opens a different surface
 *  rather than acting on the page, and the violet fill separates it from the
 *  row of neutral filter controls without adding a second primary action to
 *  the toolbar. The label is the bot's name, so the panel it opens is the
 *  thing the reader expected.
 */
export function AnalystButton({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Ask the Analyst about your data"
      className="group inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-[var(--r-md)] bg-brand-violet px-3 text-sm font-semibold text-white shadow-[var(--shadow-card-soft)] transition-all duration-150 hover:bg-brand-violet-600 hover:shadow-[0_6px_16px_rgba(107,71,255,0.22)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 motion-safe:hover:-translate-y-px"
    >
      <Icon
        name="analyst"
        className="h-4 w-4 transition-transform duration-[260ms] ease-[var(--ease-out)] motion-safe:group-hover:scale-110"
      />
      <span className="whitespace-nowrap">Ask Analyst</span>
    </button>
  )
}
