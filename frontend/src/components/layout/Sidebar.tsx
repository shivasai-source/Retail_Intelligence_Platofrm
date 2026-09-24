import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { useNav } from '../../hooks/useNav'
import { useCurrentUser, useLogout } from '../../hooks/useAuth'
import { useStarStatus } from '../../hooks/useDatasets'
import { Icon, type IconName } from '../../icons'
import { Dropdown } from '../ui'
import { useSidebar } from '../../store/sidebar'

// Ported from js/components/sidebar.js + css/layout.css .sidebar*.
// nav.json routes are stored as "#/command" (verbatim from the vanilla app); the
// leading "#" is stripped before handing them to <Link to> since HashRouter adds
// its own "#" when rendering the href.
const toPath = (route: string) => (route.startsWith('#') ? route.slice(1) : route)

/** Nav keys that stay reachable with no dataset installed.
 *
 *  THE LOCK. Every other page here is computed from the six star-schema CSVs,
 *  so with the Data/ folder empty they have nothing to render and RequireDataset
 *  turns each one into the same upload gate. A rail that still offered them was
 *  advertising seven doors onto one wall. Locked rows now say so — dimmed, with
 *  a padlock, and inert — which leaves exactly two rows that go anywhere: Data
 *  Connections, the screen that clears the lock, and Settings, which needs no
 *  data. The route gate stays as the backstop for a typed URL. */
const ALWAYS_OPEN = new Set(['connections', 'settings'])

/** THE NAVIGATION: an icon rail that reveals its labels on demand.
 *
 *  PRESENTATION ONLY. Every route, label, icon and destination still comes from
 *  `/api/nav` exactly as before. Nothing here renames, reorders, adds or removes
 *  a navigation item, and no page's data path is touched.
 *
 *  BELOW `md` - an off-canvas DRAWER at full width, with a backdrop, opened by
 *  the Topbar's menu button, always labelled. Unchanged.
 *
 *  AT `md` AND UP - three states, one width rule:
 *
 *    unpinned, at rest     68px icon rail; the content is inset by 68px.
 *    unpinned, hovered or  224px, drawn OVER the content with a shadow. The
 *      focused within      inset stays 68px, so nothing behind it moves.
 *    pinned                224px column; the content is inset by 224px.
 *
 *  THE OVERLAY IS THE POINT. An earlier expanding rail widened the content
 *  inset as it grew, so every page reflowed under the pointer and labels came
 *  and went while they were being read; it was replaced by a static column,
 *  which then cost every page 224px of width it did not use. Expanding as an
 *  overlay keeps the content still, and the pin (the round button on the
 *  rail's edge, remembered per browser) gives a reader who wants the labels
 *  permanently the old column back.
 *
 *  Hover expansion is DEBOUNCED both ways -- a short delay in, a slightly
 *  longer delay out -- so a pointer crossing the rail on its way to the
 *  content does not flash it open, and a pointer that strays a few pixels
 *  outside while reading a label does not snap it shut. Keyboard focus
 *  inside the rail expands it immediately, so a tab through the navigation
 *  is always labelled.
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
  const { data: starStatus } = useStarStatus()
  const logout = useLogout()
  const navigate = useNavigate()

  // Undefined while the status request is in flight. Treated as unlocked until
  // it resolves, so the rail does not flash a wall of padlocks on every load of
  // a page that is about to render perfectly well.
  const gating = starStatus ? !starStatus.complete : false

  // The footer row carried a chevron and a hover state but no handler — it
  // advertised a menu that never opened. Same account menu as the topbar
  // avatar, so the chevron now means what it looks like it means.
  const onAccountSelect = (value: string) => {
    onClose()
    if (value === 'settings') navigate('/settings')
    else if (value === 'signout') logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  const pinned = useSidebar((s) => s.pinned)
  const togglePinned = useSidebar((s) => s.togglePinned)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const hoverTimer = useRef<number | null>(null)

  const hover = (next: boolean) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHovered(next), next ? 120 : 220)
  }
  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current) }, [])

  // The drawer (below `md`) is always labelled when it is open at all. At `md`
  // and up the labels show when pinned, or while the pointer or focus is in.
  const revealed = pinned || hovered || focused
  const labelled = open || revealed

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
        data-expanded={labelled ? 'true' : 'false'}
        data-pinned={pinned ? 'true' : 'false'}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false) }}
        className={[
          'group/nav fixed inset-y-0 left-0 z-50 flex h-screen flex-col border-r border-white/[0.06]',
          'bg-sidebar-bg text-sidebar-item',
          // Below `md` the drawer is always the full width. From `md` the width
          // is the rail's until the labels are revealed.
          'w-[var(--sidebar-w)]',
          revealed ? 'md:w-[var(--sidebar-w)]' : 'md:w-[var(--sidebar-rail-w)]',
          // A shadow ONLY while overlaying the content (revealed but not
          // pinned): a pinned column sits beside the content and casts nothing.
          revealed && !pinned ? 'md:shadow-[8px_0_24px_-8px_rgba(0,0,0,0.45)]' : '',
          // Below `md` the drawer slides in and out; from `md` it is simply
          // there.
          open ? 'translate-x-0' : '-translate-x-full',
          'md:translate-x-0',
          'transition-[transform,width,box-shadow] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
        ].join(' ')}
      >
        {/* THE PIN. A round button on the rail's edge, on the brand row's
            centre line, that turns the overlay into a permanent column and
            back. Hidden below `md`, where the drawer needs no pin. Faded
            until the rail is in use, so its edge stays clean. */}
        <button
          type="button"
          onClick={(e) => {
            // Collapsing must collapse NOW, not when the pointer happens to
            // leave: drop the hover and focus that would otherwise keep the
            // labels revealed until the reader moved away.
            if (pinned) {
              if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
              setHovered(false)
              setFocused(false)
              e.currentTarget.blur()
            }
            togglePinned()
          }}
          aria-pressed={pinned}
          aria-label={pinned ? 'Collapse navigation to icons' : 'Keep navigation expanded'}
          title={pinned ? 'Collapse navigation' : 'Keep navigation open'}
          className={[
            'absolute -right-3 top-[calc(var(--topbar-h)/2)] z-10 hidden h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full',
            'border border-border-default bg-surface-card text-ink-muted shadow-[var(--shadow-card-soft)]',
            'transition-[opacity,color,border-color] duration-150 hover:border-brand-violet hover:text-brand-violet',
            'focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-violet md:grid',
            revealed ? 'opacity-100' : 'opacity-0 group-hover/nav:opacity-100',
            '[&_svg]:h-3.5 [&_svg]:w-3.5',
          ].join(' ')}
        >
          <Icon name={pinned ? 'chevronLeft' : 'chevronRight'} />
        </button>
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
              locked={gating && !ALWAYS_OPEN.has(n.key)}
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
              locked={gating && !ALWAYS_OPEN.has(n.key)}
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
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-[var(--r-md)] p-1.5 text-left transition-colors duration-150 hover:bg-white/[0.05]"
                title={user ? `${user.name} — signed in` : 'Not signed in'}
                aria-label={user ? `Account menu — ${user.name}` : 'Account menu'}
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
              </button>
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
  locked = false,
  onNavigate,
}: {
  item: { key: string; label: string; icon: string; route: string; badge?: string }
  active: boolean
  expanded: boolean
  /** No dataset installed and this page needs one — see ALWAYS_OPEN above. */
  locked?: boolean
  onNavigate: () => void
}) {
  // Raised for KEYBOARD focus while the rail is collapsed. Coordinates are taken
  // once, at focus, from the focused row's own box — nothing polls or observes,
  // and the tooltip is torn down on blur before anything could move under it.
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null)
  const showTip = tip !== null && !expanded

  // A LOCKED ROW IS NOT A LINK, and must not carry an href. Rendering it as a
  // <Link> with the click suppressed still leaves a real anchor behind: the
  // browser shows its target in the status bar, ctrl-click and "open in new
  // tab" bypass the handler entirely, and react-router resolves an empty `to`
  // against the CURRENT route, so the href silently became whatever page you
  // happened to be on. The disabled row is a focusable <span> instead — no
  // href to follow, no handler to get around — which is also what the platform
  // means: the page is not there yet, not merely out of reach.
  const shared = {
    'data-key': item.key,
    // The accessible name is the full label at either width, and says why a
    // locked row will not open.
    'aria-label': locked ? `${item.label} — locked until a dataset is connected` : item.label,
    'aria-current': active ? ('page' as const) : undefined,
    // Native tooltip only while the label is hidden, so an expanded rail never
    // shows the same label twice. A locked row always explains itself, at
    // either width — that is the one thing its label cannot say.
    title: locked
      ? `${item.label} — connect a data source to unlock`
      : expanded
        ? undefined
        : item.label,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      setTip({ top: rect.top + rect.height / 2, left: rect.right + 18 })
    },
    onBlur: () => setTip(null),
    className: [
      'relative flex h-10 shrink-0 items-center gap-3 overflow-hidden rounded-[var(--r-md)]',
      // A fixed 20px icon cell inside 10px padding puts the glyph at the same
      // x in both states: the row grows to the right, the icon never moves.
      'px-2.5 text-base font-medium no-underline',
      'transition-colors duration-150',
      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-violet)]',
      locked
        ? 'cursor-not-allowed text-sidebar-item opacity-40'
        : active
          ? 'bg-sidebar-item-active-bg font-semibold text-sidebar-item-active [&_svg]:text-[#B7A6FF]'
          : 'text-sidebar-item hover:bg-white/5 hover:text-sidebar-item-hover',
    ].join(' '),
  }

  const body = (
    <>
      {/* THE ACTIVE MARKER. A 3px violet bar at the row's leading edge — the one
          part of the active treatment that stays legible when the row is a bare
          icon. Same brand colour and same active background as before; no new
          visual language. */}
      {active && !locked && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-brand-violet"
        />
      )}
      {/* THE GLYPH IS NOT A HIT TARGET, and has to say so.
       *
       *  Without `pointer-events-none` the topmost element under a pointer
       *  resting on the icon is one of the SVG's own `<path>`s. The rail
       *  widens on hover, React re-renders the row, and the path the
       *  mousedown landed on is gone by mouseup — so the browser fires no
       *  `click` at all and the navigation is silently lost. It showed up
       *  as "Decision Center does nothing": its `checkCircle` glyph is the
       *  one whose stroke actually covers the row's centre point, where a
       *  pointer arriving at the collapsed rail lands. The other rows have
       *  a hole there, so the press hit the `<svg>` itself and survived.
       *
       *  Making the decorative glyph transparent to hit-testing puts every
       *  press and release on the `<a>`, which cannot be re-created out
       *  from under the pointer. */}
      <span className="pointer-events-none grid h-5 w-5 shrink-0 place-items-center">
        <Icon name={item.icon as IconName} className="h-[18px] w-[18px] stroke-[1.8]" />
      </span>
      <Reveal expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{item.label}</span>
        {/* The padlock replaces the badge rather than sitting beside it: a
            locked page has no unread count worth reading. */}
        {locked ? (
          <Icon name="lock" className="ml-auto h-3.5 w-3.5 shrink-0" />
        ) : (
          item.badge && (
            <span className="ml-auto shrink-0 rounded-[var(--r-pill)] bg-brand-violet px-1.5 py-px text-2xs font-bold leading-4 text-white">
              {item.badge}
            </span>
          )
        )}
      </Reveal>
    </>
  )

  return (
    <>
      {locked ? (
        <span role="link" aria-disabled="true" tabIndex={0} {...shared}>
          {body}
        </span>
      ) : (
        <Link to={toPath(item.route)} onClick={onNavigate} {...shared}>
          {body}
        </Link>
      )}

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
            {locked ? `${item.label} — locked` : item.label}
          </span>,
          document.body,
        )}
    </>
  )
}
