import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../icons'
import { Dropdown, IconButton, LiveStatus, ThemeToggle, useLiveStatus } from '../ui'
import { NotificationBell } from '../command/NotificationBell'
import { useCurrentUser, useLogout } from '../../hooks/useAuth'

export interface Crumb {
  label: string
  route?: string
}

// Ported from js/components/topbar.js + css/layout.css .topbar*. `onMenuClick` only
// renders (and only matters) below `md`, where Sidebar is an off-canvas drawer; at
// `md` and up the collapsed rail is always on screen and needs no menu button.
export function Topbar({ crumbs = [], onMenuClick }: { crumbs?: Crumb[]; onMenuClick?: () => void }) {
  // B12: see Sidebar — the real signed-in session, not the authored persona.
  const { data: user } = useCurrentUser()
  const logout = useLogout()
  const navigate = useNavigate()

  // The Live pill, in the one corner that is the same on every page. Each
  // page used to mount its own beside its title, at whatever x the title's
  // length left it. Arriving on a page restarts the clock, as the per-page
  // mount used to.
  const live = useLiveStatus()
  const { pathname } = useLocation()
  useEffect(() => live.reset(), [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // The avatar used to be `cursor-pointer` with nothing behind it — it looked
  // clickable on every TPO page and did nothing. Same account menu the portal
  // header (pages/Home.tsx) already had, so the gesture means the same thing
  // wherever the avatar appears.
  const onAccountSelect = (value: string) => {
    if (value === 'settings') navigate('/settings')
    else if (value === 'signout') logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  return (
    <header className="sticky top-0 z-10 flex h-[var(--topbar-h)] items-center gap-2 border-b border-border-subtle bg-surface-page pl-4 pr-4 sm:gap-4 sm:pl-8 sm:pr-7">
      {onMenuClick && <IconButton icon="menu" title="Menu" onClick={onMenuClick} className="-ml-1.5 md:hidden" />}
      <div className="flex min-w-0 items-center gap-2 text-base text-ink-muted">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <span
              key={i}
              className={
                isLast
                  ? 'inline-flex min-w-0 items-center gap-2'
                  : 'hidden min-w-0 shrink-0 items-center gap-2 sm:inline-flex'
              }
            >
              {c.route && !isLast ? (
                <Link
                  to={c.route.startsWith('#') ? c.route.slice(1) : c.route}
                  className="whitespace-nowrap hover:text-ink-primary"
                >
                  {c.label}
                </Link>
              ) : (
                <span className={`truncate ${isLast ? 'font-semibold text-ink-primary' : ''}`}>{c.label}</span>
              )}
              {!isLast && <Icon name="chevronRight" className="h-3.5 w-3.5 shrink-0 text-ink-disabled" />}
            </span>
          )
        })}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        {/* The Help button that sat here is gone. It opened a toast promising a
            help centre that does not exist, and there is nothing behind it to
            open; nothing replaces it, so the row closes up on its own. */}
        <LiveStatus label={live.label} className="mr-1.5 hidden sm:inline-flex" />
        <ThemeToggle />
        <NotificationBell />
        <IconButton icon="settings" title="Settings" onClick={() => navigate('/settings')} />
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
              className="ml-1 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-gradient-to-br from-[#6B47FF] to-[#8C6EFF] text-sm font-bold text-white"
              title={user ? `${user.name} — signed in` : 'Not signed in'}
            >
              {user?.initials}
            </div>
          }
        />
      </div>
    </header>
  )
}
