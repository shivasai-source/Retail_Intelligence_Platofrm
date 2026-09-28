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
import { Settings } from './pages/Settings'
import { AnalystWindow } from './pages/AnalystWindow'
import { RequireAuth } from './components/RequireAuth'
import { RequireDataset } from './components/RequireDataset'

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
        <Route path="/analyst" element={<RequireAuth><RequireDataset><AnalystWindow /></RequireDataset></RequireAuth>} />
        <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </HashRouter>
  )
}

export default App
