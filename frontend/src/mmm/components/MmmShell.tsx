import type { ReactNode } from 'react'
import { AppShell } from '../../components/layout/AppShell'
import { MMM_BRAND, MMM_NAV, MMM_ROUTES } from '../nav'
import { useMmmStatus } from '../hooks'

/** THE MMM PAGE SHELL — TPO's AppShell, configured for MMM once.
 *
 *  Every MMM page renders inside this, so the rail, the wordmark, the padlock
 *  and the top bar are the same on all of them and no page can forget one:
 *
 *    nav             MMM's rail (nav.ts), not TPO's /api/nav
 *    datasetComplete MMM's own dataset status, never TPO's star schema
 *    settingsHref    /mmm/settings, so the gear keeps the reader in MMM
 *    tpoTools=false  TPO's alert bell and sync pill read TPO's data — off here
 *
 *  While the status request is in flight the rail is treated as unlocked, as
 *  TPO's is, so it does not flash a wall of padlocks on every load. */
export function MmmShell({
  activeKey,
  page,
  children,
}: {
  activeKey: string
  /** The last breadcrumb, e.g. "Calendar". */
  page: string
  children: ReactNode
}) {
  const status = useMmmStatus()
  return (
    <AppShell
      activeKey={activeKey}
      crumbs={[{ label: MMM_BRAND, route: `#${MMM_ROUTES.insights}` }, { label: page }]}
      nav={MMM_NAV}
      brand={MMM_BRAND}
      brandHref="/home"
      // `true` while loading, NOT undefined: undefined makes Sidebar fall back
      // to TPO's star status, which says nothing about MMM.
      datasetComplete={status.data ? status.data.complete : true}
      settingsHref={MMM_ROUTES.settings}
      tpoTools={false}
    >
      {children}
    </AppShell>
  )
}
