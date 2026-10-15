import type { ReactNode } from 'react'
import { Navigate, Route } from 'react-router-dom'
import { RequireAuth } from '../components/RequireAuth'
import { RequireMmmDataset } from './components/RequireMmmDataset'
import { MMM_ROUTES } from './nav'
import { MmmAllocator } from './pages/MmmAllocator'
import { MmmBudget } from './pages/MmmBudget'
import { MmmCalendar } from './pages/MmmCalendar'
import { MmmConnections } from './pages/MmmConnections'
import { MmmForecast } from './pages/MmmForecast'
import { MmmInsights } from './pages/MmmInsights'
import { MmmReports } from './pages/MmmReports'
import { MmmSettings } from './pages/MmmSettings'

/** Every MMM route, mounted by App.tsx as `{mmmRoutes()}`.
 *
 *  The same gating TPO uses, on MMM's own contract: the data pages (Insights
 *  Hub, Calendar, Reports) are behind RequireMmmDataset, which reads MMM's
 *  dataset status — never TPO's star schema. Data Connections and Settings are
 *  open, because Data Connections is the screen that clears the gate. */
const gated = (page: ReactNode) => (
  <RequireAuth>
    <RequireMmmDataset>{page}</RequireMmmDataset>
  </RequireAuth>
)

export function mmmRoutes() {
  return (
    <>
      <Route path="/mmm" element={<Navigate to={MMM_ROUTES.insights} replace />} />
      <Route path={MMM_ROUTES.insights} element={gated(<MmmInsights />)} />
      <Route path={MMM_ROUTES.budget} element={gated(<MmmBudget />)} />
      <Route path={MMM_ROUTES.allocator} element={gated(<MmmAllocator />)} />
      <Route path={MMM_ROUTES.forecast} element={gated(<MmmForecast />)} />
      <Route path={MMM_ROUTES.calendar} element={gated(<MmmCalendar />)} />
      <Route path={MMM_ROUTES.reports} element={gated(<MmmReports />)} />
      <Route path={MMM_ROUTES.connections} element={<RequireAuth><MmmConnections /></RequireAuth>} />
      <Route path={MMM_ROUTES.settings} element={<RequireAuth><MmmSettings /></RequireAuth>} />
    </>
  )
}
