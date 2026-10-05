import type { NavData } from '../types/nav'

/** MMM's routes, in one place. Every MMM page lives under /mmm/. */
export const MMM_ROUTES = {
  insights: '/mmm/insights',
  calendar: '/mmm/calendar',
  reports: '/mmm/reports',
  connections: '/mmm/connections',
  settings: '/mmm/settings',
} as const

export const MMM_BRAND = 'MMM Intelligence'

/** MMM's rail — shaped like TPO's /api/nav so it drops into the same Sidebar.
 *
 *  The same split TPO's rail has: the analysis screen above the line, then
 *  Calendar, Reports, Data Connections and Settings below it. Keys match TPO's
 *  (`calendar`, `reports`, `connections`, `settings`), so Sidebar's padlock
 *  rule treats them identically — Connections and Settings stay open while no
 *  dataset is loaded, everything else is locked until one is. */
export const MMM_NAV: NavData = {
  navMain: [{ key: 'insights', label: 'Insights Hub', icon: 'grid', route: `#${MMM_ROUTES.insights}` }],
  navSecondary: [
    { key: 'calendar', label: 'Calendar', icon: 'calendar', route: `#${MMM_ROUTES.calendar}` },
    { key: 'reports', label: 'Reports', icon: 'file', route: `#${MMM_ROUTES.reports}` },
    { key: 'connections', label: 'Data Connections', icon: 'database', route: `#${MMM_ROUTES.connections}` },
    { key: 'settings', label: 'Settings', icon: 'settings', route: `#${MMM_ROUTES.settings}` },
  ],
}
