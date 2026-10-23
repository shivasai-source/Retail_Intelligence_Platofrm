import type { ReactNode } from 'react'
import { Navigate, Route } from 'react-router-dom'
import { AnalystWindow } from '../pages/AnalystWindow'
import { RequireAuth } from '../components/RequireAuth'
import { RequireMmmDataset } from './components/RequireMmmDataset'
import { MMM_ANALYST } from './analystModule'
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
      {/* THE ANALYST'S POP-OUT WINDOW. The same component TPO's #/analyst
          route mounts, carrying the MMM module — so it asks the MMM endpoint
          and takes its thread from the MMM hand-off keys. Behind the dataset
          gate like every other MMM page that reads data: a window that opened
          to a conversation it could not answer would be worse than one that
          says the dataset is missing. */}
      <Route path={MMM_ROUTES.analyst} element={gated(<AnalystWindow module={MMM_ANALYST} />)} />
    </>
  )
}
