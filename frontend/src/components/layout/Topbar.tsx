import { useEffect, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../icons'
import { Dropdown, IconButton, ThemeToggle, useLiveStatus } from '../ui'
import { SyncStatus } from './SyncStatus'
import { NotificationBell } from '../command/NotificationBell'
import { useCurrentUser, useLogout } from '../../hooks/useAuth'

export interface Crumb {
  label: string
  route?: string
}

// Ported from js/components/topbar.js + css/layout.css .topbar*. `onMenuClick` only
// renders (and only matters) below `md`, where Sidebar is an off-canvas drawer; at
// `md` and up the collapsed rail is always on screen and needs no menu button.
export function Topbar({
  crumbs = [],
  onMenuClick,
  settingsHref = '/settings',
  tpoTools = true,
  tools,
}: {
  crumbs?: Crumb[]
  onMenuClick?: () => void
  /** Where the settings icon and the account menu go. */
  settingsHref?: string
  /** TPO's alert bell and its source-sync pill. Both read TPO's star schema,
   *  so another module's pages turn them off rather than show TPO alerts. */
  tpoTools?: boolean
  /** A module's OWN pill, in the slot TPO's would occupy. MMM has a connected
   *  source of its own to sync (mmm/components/MmmSyncStatus), and a live
   *  pill belongs in the one corner that is the same on every page rather
   *  than wherever a page's title happens to end. It is rendered with the
   *  same page-visit timer TPO's gets, so a module that cannot sync still
   *  shows the plain timer and the corner never changes shape. */
  tools?: (live: { label: string; reset: () => void }) => ReactNode
}) {
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
    if (value === 'settings') navigate(settingsHref)
    else if (value === 'signout') logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  return (
    <header className="sticky top-0 z-10 flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-page pl-4 pr-4 sm:gap-4 sm:pl-8 sm:pr-6 md:pl-10">
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
                <span className={`truncate ${isLast ? 'font-medium text-ink-primary' : ''}`}>{c.label}</span>
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
        {/* Clickable when the data came from Azure or Databricks: it pulls the
            latest rows from there. Otherwise the plain timer pill. */}
        {tpoTools && (
          <SyncStatus liveLabel={live.label} onSynced={live.reset} className="mr-1.5 hidden sm:inline-flex" />
        )}
        {!tpoTools && tools?.({ label: live.label, reset: live.reset })}
        <ThemeToggle />
        {tpoTools && <NotificationBell />}
        <IconButton icon="settings" title="Settings" onClick={() => navigate(settingsHref)} />
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
              className="ml-1 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-gradient-to-br from-[var(--brand-violet)] to-[var(--brand-violet)] text-sm font-medium text-white"
              title={user ? `${user.name} — signed in` : 'Not signed in'}
              aria-label={user ? `Account menu — ${user.name}` : 'Account menu'}
            >
              {user?.initials}
            </button>
          }
        />
      </div>
    </header>
  )
}
