import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { useNav } from '../../hooks/useNav'
import { useCurrentUser, useLogout } from '../../hooks/useAuth'
import { Icon, type IconName } from '../../icons'
import { Dropdown } from '../ui'

// Ported from js/components/sidebar.js + css/layout.css .sidebar*.
// nav.json routes are stored as "#/command" (verbatim from the vanilla app); the
// leading "#" is stripped before handing them to <Link to> since HashRouter adds
// its own "#" when rendering the href.
const toPath = (route: string) => (route.startsWith('#') ? route.slice(1) : route)

/** THE NAVIGATION COLUMN - one width, and it does not move.
 *
 *  PRESENTATION ONLY. Every route, label, icon and destination still comes from
 *  `/api/nav` exactly as before. Nothing here renames, reorders, adds or removes
 *  a navigation item, and no page's data path is touched.
 *
 *  BELOW `md` - an off-canvas DRAWER at full width, with a backdrop, opened by
 *  the Topbar's menu button. A permanent column is what used to make every page
 *  overflow horizontally on a phone, so that behaviour stays.
 *
 *  AT `md` AND UP - a STATIC COLUMN, always at `--sidebar-w`, always labelled.
 *  The content is genuinely inset by it (see AppShell), so the column overlays
 *  nothing and casts no shadow.
 *
 *  IT USED TO COLLAPSE, and that is what this shape exists to undo. The rail sat
 *  at `--sidebar-rail-w` and widened under the pointer, so the navigation
 *  changed size as a matter of course: labels appeared and vanished while they
 *  were being read, and the one fixed landmark on every screen was the one thing
 *  that kept moving. A later revision held it open on the Insights Hub alone,
 *  which only made the chrome disagree with itself between routes. It is now the
 *  same column everywhere.
 *
 *  NOTHING HERE READS HOVER. No hover state, no width transition, no per-route
 *  exception to keep in sync - the width is a constant, so the layout cannot be
 *  caught mid-animation and the content never reflows.
 *
 *  `NavRow` STILL CARRIES ITS COLLAPSED-STATE AFFORDANCES - the focus tooltip
 *  and the native `title` - behind an `expanded` prop this file now always
 *  passes true. They are inert rather than deleted: the row is a general
 *  component, and a labelled row needs neither.
 */
export function Sidebar({
  activeKey,
  open,
  onClose,
}: {
  activeKey?: string
  open: boolean
  onClose: () => void
}) {
  const { data: nav } = useNav()
  // B12: the signed-in persona, not user.json's hard-coded "Sanjay Kumar ·
  // Commercial Analyst". The chrome used to name a different person from the
  // one who signed in.
  //
  // This now reads the REAL session (GET /auth/me behind an httpOnly cookie)
  // rather than the old client-only portalUser store, so the name shown is a
  // verified account rather than whatever the visitor typed. `user` is
  // undefined while that request is in flight and when signed out.
  const { data: user } = useCurrentUser()
  const logout = useLogout()
  const navigate = useNavigate()

  // The footer row carried a chevron and a hover state but no handler — it
  // advertised a menu that never opened. Same account menu as the topbar
  // avatar, so the chevron now means what it looks like it means.
  const onAccountSelect = (value: string) => {
    onClose()
    if (value === 'settings') navigate('/settings')
    else if (value === 'signout') logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  // ALWAYS. Named rather than inlined so the brand, every row and the account
  // footer read one fact: at `md` and up the column is open, and below `md` the
  // drawer is full width whenever it is open at all. There is no third state.
  const labelled = true

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        aria-label="Main navigation"
        data-expanded="true"
        className={[
          'fixed inset-y-0 left-0 z-50 flex h-screen flex-col border-r border-white/[0.06]',
          'bg-sidebar-bg text-sidebar-item',
          // ONE WIDTH AT EVERY BREAKPOINT. Below `md` it is the drawer's width;
          // at `md` and up it is the column's, and they are the same number.
          'w-[var(--sidebar-w)]',
          // Below `md` the drawer slides in and out; from `md` it is simply
          // there. This is the only thing left that moves.
          open ? 'translate-x-0' : '-translate-x-full',
          'md:translate-x-0',
          // No shadow: the content is inset by this column rather than sitting
          // under it, so there is nothing for it to cast onto.
          'transition-transform duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
        ].join(' ')}
      >
        {/* ---- brand ------------------------------------------------------- */}
        {/* Exactly the topbar's height, so the rail's first separator lines up
            with the one across the content and the two read as one chrome. */}
        <div className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2.5 overflow-hidden border-b border-white/[0.06] px-[14px]">
          <Link
            to="/command"
            title="TransOrg IQ — TPO Intelligence"
            onClick={onClose}
            className="flex shrink-0 items-center rounded-[var(--r-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)]"
          >
            {/* ONE SIZE IN BOTH STATES, `object-contain` throughout — the mark is
                never stretched and never re-flows between rail and expanded. */}
            <img src="/image.png" alt="TransOrg IQ" className="h-10 w-10 shrink-0 object-contain" />
          </Link>
          <Reveal expanded={labelled} className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold uppercase tracking-[0.1em] text-sidebar-brand-sub">
              TPO Intelligence
            </span>
          </Reveal>
        </div>

        {/* ---- navigation -------------------------------------------------- */}
        {/* `overflow-x-hidden` is what clips the labels as the rail narrows, so
            the reveal reads as the rail widening rather than as text popping in.
            Tooltips escape it by portalling to the body. */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-3 pb-4 pt-3">
          {nav?.navMain.map((n) => (
            <NavRow
              key={n.key}
              item={n}
              active={n.key === activeKey}
              expanded={labelled}
              onNavigate={onClose}
            />
          ))}
          <div className="mx-2 my-3 h-px shrink-0 bg-white/[0.06]" />
          {nav?.navSecondary.map((n) => (
            <NavRow
              key={n.key}
              item={n}
              active={n.key === activeKey}
              expanded={labelled}
              onNavigate={onClose}
            />
          ))}
        </nav>

        {/* ---- user -------------------------------------------------------- */}
        <div className="shrink-0 border-t border-white/[0.06] p-3">
          <Dropdown
            selected=""
            options={[
              { label: user ? `Signed in as ${user.email}` : 'Not signed in', value: 'noop' },
              { label: 'Profile & settings', value: 'settings' },
              { label: 'Sign out', value: 'signout' },
            ]}
            onSelect={onAccountSelect}
            trigger={
              <div
                className="flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-[var(--r-md)] p-1.5 transition-colors duration-150 hover:bg-white/[0.05]"
                title={user ? `${user.name} — signed in` : 'Not signed in'}
              >
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#6B47FF] to-[#8C6EFF] text-xs font-bold text-white">
                  {user?.initials}
                </div>
                <Reveal expanded={labelled} className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-semibold text-sidebar-brand">
                      {user?.name}
                    </span>
                    <span className="truncate text-xs text-sidebar-brand-sub">
                      Signed in locally
                    </span>
                  </span>
                  <Icon name="chevronDown" className="h-3.5 w-3.5 shrink-0 text-sidebar-brand-sub" />
                </Reveal>
              </div>
            }
          />
        </div>
      </aside>
    </>
  )
}

/** Text that fades and slides out of the way as the rail narrows.
 *
 *  Kept in the DOM rather than unmounted so the reveal can be animated, and
 *  `aria-hidden` + `pointer-events-none` while collapsed so a screen reader does
 *  not announce a label the sighted user cannot see and no click can land on it.
 *  Each row's own `aria-label` carries the accessible name at either width.
 */
function Reveal({
  expanded,
  className = '',
  children,
}: {
  expanded: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      aria-hidden={!expanded}
      className={[
        className,
        'transition-[opacity,transform] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
        expanded ? 'opacity-100' : 'pointer-events-none -translate-x-1 opacity-0',
      ].join(' ')}
    >
      {children}
    </span>
  )
}

function NavRow({
  item,
  active,
  expanded,
  onNavigate,
}: {
  item: { key: string; label: string; icon: string; route: string; badge?: string }
  active: boolean
  expanded: boolean
  onNavigate: () => void
}) {
  // Raised for KEYBOARD focus while the rail is collapsed. Coordinates are taken
  // once, at focus, from the focused row's own box — nothing polls or observes,
  // and the tooltip is torn down on blur before anything could move under it.
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null)
  const showTip = tip !== null && !expanded

  return (
    <>
      <Link
        to={toPath(item.route)}
        data-key={item.key}
        onClick={onNavigate}
        // The accessible name is the full label at either width.
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        // Native tooltip only while the label is hidden, so an expanded rail
        // never shows the same label twice.
        title={expanded ? undefined : item.label}
        onFocus={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setTip({ top: rect.top + rect.height / 2, left: rect.right + 18 })
        }}
        onBlur={() => setTip(null)}
        className={[
          'relative flex h-10 shrink-0 items-center gap-3 overflow-hidden rounded-[var(--r-md)]',
          // A fixed 20px icon cell inside 10px padding puts the glyph at the same
          // x in both states: the row grows to the right, the icon never moves.
          'px-2.5 text-base font-medium no-underline',
          'transition-colors duration-150',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-violet)]',
          active
            ? 'bg-sidebar-item-active-bg font-semibold text-sidebar-item-active [&_svg]:text-[#B7A6FF]'
            : 'text-sidebar-item hover:bg-white/5 hover:text-sidebar-item-hover',
        ].join(' ')}
      >
        {/* THE ACTIVE MARKER. A 3px violet bar at the row's leading edge — the one
            part of the active treatment that stays legible when the row is a bare
            icon. Same brand colour and same active background as before; no new
            visual language. */}
        {active && (
          <span
            aria-hidden="true"
            className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-brand-violet"
          />
        )}
        <span className="grid h-5 w-5 shrink-0 place-items-center">
          <Icon name={item.icon as IconName} className="h-[18px] w-[18px] stroke-[1.8]" />
        </span>
        <Reveal expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{item.label}</span>
          {item.badge && (
            <span className="ml-auto shrink-0 rounded-[var(--r-pill)] bg-brand-violet px-1.5 py-px text-2xs font-bold leading-4 text-white">
              {item.badge}
            </span>
          )}
        </Reveal>
      </Link>

      {/* Portalled to the body so neither the rail's `overflow-x-hidden` nor the
          nav's own scroll container can clip it, and so it occupies no layout —
          the brief's "outside the sidebar without causing layout movement". The
          same approach components/ui/Dropdown.tsx already uses for its menu. */}
      {showTip &&
        createPortal(
          <span
            role="tooltip"
            className="fade-in pointer-events-none fixed z-[9999] -translate-y-1/2 whitespace-nowrap rounded-[var(--r-sm)] bg-sidebar-bg px-2.5 py-1.5 text-sm font-semibold text-sidebar-brand shadow-[var(--shadow-lg)] ring-1 ring-white/10"
            style={{ top: tip.top, left: tip.left }}
          >
            {item.label}
          </span>,
          document.body,
        )}
    </>
  )
}
