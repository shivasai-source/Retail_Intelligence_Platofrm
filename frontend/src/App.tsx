import { lazy, Suspense, type ComponentType } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Login } from './pages/Login'
import { Spinner } from './components/ui'

/** A PAGE AT A TIME. Everything used to be one 1.1 MB bundle: opening the
 *  login screen downloaded the Studio, the MMM product and every page besides,
 *  and any change to any of them re-sent the lot. Each page is its own chunk
 *  now, fetched when it is first opened; `Login` stays eager because it is the
 *  first thing anyone sees. The pages export by name, hence the `.then` -- an
 *  import() has to resolve to a default for `lazy`. */
const page = <P extends object, K extends string, T extends Record<K, ComponentType<P>>>(
  load: () => Promise<T>,
  name: K,
) => lazy(() => load().then((m) => ({ default: m[name] })))

const Home = page(() => import('./pages/Home'), 'Home')
const CommandCenter = page(() => import('./pages/CommandCenter'), 'CommandCenter')
const Investigations = page(() => import('./pages/Investigations'), 'Investigations')
const Intelligence = page(() => import('./pages/Intelligence'), 'Intelligence')
const PromotionPlanner = page(() => import('./pages/PromotionPlanner'), 'PromotionPlanner')
const Decision = page(() => import('./pages/Decision'), 'Decision')
const Calendar = page(() => import('./pages/Calendar'), 'Calendar')
const Reports = page(() => import('./pages/Reports'), 'Reports')
const Connections = page(() => import('./pages/Connections'), 'Connections')
const Settings = page(() => import('./pages/Settings'), 'Settings')
const AnalystWindow = page(() => import('./pages/AnalystWindow'), 'AnalystWindow')
import { RequireAuth } from './components/RequireAuth'
import { RequireDataset } from './components/RequireDataset'
import { RouteErrorBoundary } from './components/ErrorBoundary'
import { mmmRoutes } from './mmm/routes'

// HashRouter matches the vanilla app's `#/command`-style routes verbatim (see
// nav.json), so no route strings needed to change when porting Sidebar/Topbar.
// The portal (login.html/home.html in the vanilla app) sits in front of the TPO
// app at /login and /home; the root path lands on /login, same entry point a
// fresh user would hit. Every route but /login is now gated on a real session
// (RequireAuth — see components/RequireAuth.tsx) now that login actually means
// something; previously any of these were reachable by URL with no session at all.
// The data-backed pages carry a SECOND gate (RequireDataset): the Data/ folder
// ships empty and every KPI, chart and report is computed from the star CSVs in
// it, so those pages have nothing to render until the set is uploaded. /home and
// /connections are deliberately NOT gated — they hold the Excel connector the
// upload happens through, so gating them would lock the user out of the only
// screen that can clear the gate.
function App() {
  return (
    <HashRouter>
      {/* Any page that throws while rendering shows the error screen instead
          of a white page; moving to another route clears it. */}
      <RouteErrorBoundary>
      {/* While a page's chunk is on its way. Full height, so the shell does
          not jump as it arrives. */}
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center">
            <Spinner />
          </div>
        }
      >
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<RequireAuth><Home /></RequireAuth>} />
        <Route path="/command" element={<RequireAuth><RequireDataset><CommandCenter /></RequireDataset></RequireAuth>} />
        <Route path="/investigations" element={<RequireAuth><RequireDataset><Investigations /></RequireDataset></RequireAuth>} />
        <Route path="/intelligence" element={<RequireAuth><RequireDataset><Intelligence /></RequireDataset></RequireAuth>} />
        <Route path="/simulation" element={<RequireAuth><RequireDataset><PromotionPlanner /></RequireDataset></RequireAuth>} />
        <Route path="/decision" element={<RequireAuth><RequireDataset><Decision /></RequireDataset></RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth><RequireDataset><Calendar /></RequireDataset></RequireAuth>} />
        <Route path="/reports" element={<RequireAuth><RequireDataset><Reports /></RequireDataset></RequireAuth>} />
        <Route path="/analyst" element={<RequireAuth><RequireDataset><AnalystWindow /></RequireDataset></RequireAuth>} />
        <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
        {mmmRoutes()}
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      </Suspense>
      </RouteErrorBoundary>
    </HashRouter>
  )
}

export default App
