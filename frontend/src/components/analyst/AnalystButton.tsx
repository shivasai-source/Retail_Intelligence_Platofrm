import { createPortal } from 'react-dom'
import { Icon } from '../../icons'

/** THE WAY IN — a floating launcher in the page's bottom-right corner, where
 *  every other application puts its chat.
 *
 *  It used to sit in the toolbar beside Export, which made it read as one more
 *  thing that acts on this page. It is not: it opens a different surface, and
 *  it is the only control here that stays useful when the filter selection is
 *  empty. Out of the toolbar it also gives the filter row back the width it
 *  needed to stay on one line.
 *
 *  ICON ONLY. The name is carried by the tooltip, the `title` and an
 *  `sr-only` label rather than by a permanent caption, so the launcher is a
 *  circle the eye can skip until it is wanted.
 *
 *  PORTALED TO <body>, `position: fixed`, for the same reason every other
 *  floating surface here is (see ui/Dropdown.tsx): the page's entrance
 *  animations establish stacking contexts, and an in-tree launcher would be
 *  trapped beneath later siblings however it was z-indexed. `z-[110]` sits
 *  above the page and below the drawer's backdrop (120) and the toasts (200).
 *
 *  IT GETS OUT OF THE WAY when the drawer it opens is open: the drawer owns
 *  that corner then, and carries its own close.
 */
export function AnalystButton({ onClick, open }: { onClick: () => void; open: boolean }) {
  return createPortal(
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      // Taken out of the tab order while the drawer covers it, so Tab does not
      // land on a control the reader cannot see.
      tabIndex={open ? -1 : 0}
      aria-hidden={open}
      title="Ask the Analyst about your data"
      className={`group fixed bottom-6 right-6 z-[110] grid h-14 w-14 place-items-center rounded-full bg-brand-violet text-white shadow-[0_10px_28px_rgba(107,71,255,0.34)] transition-all duration-200 ease-[var(--ease-out)] hover:bg-brand-violet-600 hover:shadow-[0_14px_34px_rgba(107,71,255,0.42)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 focus-visible:ring-offset-2 motion-safe:hover:-translate-y-0.5 ${
        open
          ? 'pointer-events-none scale-90 opacity-0'
          : 'cursor-pointer scale-100 opacity-100'
      }`}
    >
      {/* The label, revealed to the left on hover — the standard launcher
          affordance. `pointer-events-none` so it can never swallow the click
          that was aimed at the circle. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-full mr-3 whitespace-nowrap rounded-[var(--r-md)] bg-ink-primary px-2.5 py-1.5 text-sm font-semibold text-white opacity-0 shadow-[var(--shadow-card-soft)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        Ask Analyst
      </span>
      <Icon
        name="analyst"
        className="h-6 w-6 transition-transform duration-[260ms] ease-[var(--ease-out)] motion-safe:group-hover:scale-110"
      />
      <span className="sr-only">Ask Analyst</span>
    </button>,
    document.body,
  )
}
