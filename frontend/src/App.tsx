import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Login } from './pages/Login'
import { Home } from './pages/Home'
import { CommandCenter } from './pages/CommandCenter'
import { Investigations } from './pages/Investigations'
import { Intelligence } from './pages/Intelligence'
import { Simulation } from './pages/Simulation'
import { Decision } from './pages/Decision'
import { Calendar } from './pages/Calendar'
import { Reports } from './pages/Reports'
import { Connections } from './pages/Connections'
import { MmmConnections } from './pages/MmmConnections'
import { MmmInsights } from './pages/MmmInsights'
import { Settings } from './pages/Settings'
import { RequireAuth } from './components/RequireAuth'
import { RequireDataset } from './components/RequireDataset'
import { RequireMmmDataset } from './components/RequireMmmDataset'

// HashRouter matches the vanilla app's `#/command`-style routes verbatim (see
// nav.json), so no route strings needed to change when porting Sidebar/Topbar.
// The portal (login.html/home.html in the vanilla app) sits in front of the TPO
// app at /login and /home; the root path lands on /login, same entry point a
// fresh user would hit. Every route but /login is now gated on a real session
// (RequireAuth — see components/RequireAuth.tsx) now that login actually means
// something; previously any of these were reachable by URL with no session at all.
// The data-backed pages carry a SECOND gate (RequireDataset): the Data/ folder
// ships empty and every KPI, chart and report is computed from the six CSVs in
// it, so those pages have nothing to render until the set is uploaded. /home and
// /connections are deliberately NOT gated — they hold the Excel connector the
// upload happens through, so gating them would lock the user out of the only
// screen that can clear the gate.
function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<RequireAuth><Home /></RequireAuth>} />
        <Route path="/command" element={<RequireAuth><RequireDataset><CommandCenter /></RequireDataset></RequireAuth>} />
        <Route path="/investigations" element={<RequireAuth><RequireDataset><Investigations /></RequireDataset></RequireAuth>} />
        <Route path="/intelligence" element={<RequireAuth><RequireDataset><Intelligence /></RequireDataset></RequireAuth>} />
        <Route path="/simulation" element={<RequireAuth><RequireDataset><Simulation /></RequireDataset></RequireAuth>} />
        <Route path="/decision" element={<RequireAuth><RequireDataset><Decision /></RequireDataset></RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth><RequireDataset><Calendar /></RequireDataset></RequireAuth>} />
        <Route path="/reports" element={<RequireAuth><RequireDataset><Reports /></RequireDataset></RequireAuth>} />
        <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
        {/* MMM. Its own module namespace, so later MMM pages are /mmm/<page>
            and neither module's routes can collide. Data Connections is the
            only MMM screen that exists, and the MMM portal card points here.
            No RequireDataset: that gate is TPO's six-table star schema, which
            says nothing about MMM. */}
        <Route path="/mmm/connections" element={<RequireAuth><MmmConnections /></RequireAuth>} />
        {/* Gated the way /command is, but on MMM's OWN contract. RequireDataset
            would check TPO's six-table star schema and send an MMM reader off to
            upload promotion tables; RequireMmmDataset checks the MMM datasets and
            points at the MMM catalogue. Same flow, right module. */}
        <Route
          path="/mmm/insights"
          element={
            <RequireAuth>
              <RequireMmmDataset>
                <MmmInsights />
              </RequireMmmDataset>
            </RequireAuth>
          }
        />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </HashRouter>
  )
}

export default App
