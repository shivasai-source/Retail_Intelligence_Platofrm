import { useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, Field, Input, BrandLogo } from '../../ui'
import { ConnectModalHeader, ErrorBox, InfoNote, ModalFooter, Breadcrumb } from './shared'
import { proxyFetch, saveProxyConn, loadProxyConn, loadMsal } from '../../../lib/portalConnectors'
import type { PortalConnector } from '../../../types/portal'

interface Workspace {
  id: string
  name: string
}
interface Report {
  name: string
}
interface Saved {
  client_id: string
  tenant_id: string
}
// Minimal shape of the bits of msal-browser (loaded from CDN) this modal calls.
interface MsalModule {
  PublicClientApplication: new (config: unknown) => {
    initialize: () => Promise<void>
    loginPopup: (req: { scopes: string[] }) => Promise<{ accessToken: string }>
  }
}

// Ported from js/portal.js's openPowerBiModal — real Azure AD sign-in via MSAL.js
// (Authorization Code + PKCE, loaded from CDN), then workspace/report calls routed
// through FastAPI (app/routers/connectors.py) so CORS doesn't block them.
export function PowerBiModal({
  connector: _connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const saved = loadProxyConn<Saved>('powerbi')
  const [clientId, setClientId] = useState(saved?.client_id ?? '')
  const [tenant, setTenant] = useState(saved?.tenant_id ?? 'organizations')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  const [reports, setReports] = useState<Report[] | null>(null)
  const [loadingReports, setLoadingReports] = useState(false)

  const redirectUri = window.location.origin + window.location.pathname

  const connect = async () => {
    setError('')
    if (!clientId.trim()) {
      setError('Enter your Azure AD app Client ID first.')
      return
    }
    setConnecting(true)
    try {
      const msal = (await loadMsal()) as MsalModule
      const app = new msal.PublicClientApplication({
        auth: { clientId: clientId.trim(), authority: `https://login.microsoftonline.com/${tenant.trim() || 'organizations'}`, redirectUri },
      })
      await app.initialize()
      const result = await app.loginPopup({ scopes: ['https://analysis.windows.net/powerbi/api/.default'] })
      setToken(result.accessToken)

      const wsRes = await proxyFetch<{ workspaces: Workspace[] }>('/proxy/powerbi/workspaces', { token: result.accessToken })
      const list = wsRes.workspaces || []
      setWorkspaces(list)
      saveProxyConn('powerbi', { client_id: clientId.trim(), tenant_id: tenant.trim() || 'organizations' })
      onConnected(`${list.length} workspace${list.length === 1 ? '' : 's'}`)
    } catch (err) {
      const e = err as { errorMessage?: string; message?: string }
      setError(e.errorMessage || e.message || String(err))
    } finally {
      setConnecting(false)
    }
  }

  const openWorkspace = async (ws: Workspace) => {
    setActiveWs(ws)
    setLoadingReports(true)
    try {
      const res = await proxyFetch<{ reports: Report[] }>('/proxy/powerbi/reports', { token, workspace_id: ws.id })
      setReports(res.reports || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingReports(false)
    }
  }

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[540px]">
      <ConnectModalHeader
        logo={<BrandLogo logo="powerbi" name="Power BI" />}
        title="Connect Power BI"
        subtitle="Sign in with Microsoft to list real workspaces & reports"
        onClose={onClose}
      />
      <div className="p-5">
        <ErrorBox message={error} />
        {!workspaces ? (
          <>
            <div className="mb-3">
              <Field label="Azure AD app Client ID">
                <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            </div>
            <div className="mb-1.5">
              <Field label="Tenant ID">
                <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="organizations" />
              </Field>
            </div>
            <InfoNote>
              Needs an Azure AD App Registration (type: Single-page application) with redirect URI <code>{redirectUri}</code> and Power
              BI Service permissions consented. Sign-in happens directly with Microsoft; workspace/report calls are routed through the
              app's own backend.
            </InfoNote>
            <Button variant="secondary" block className="mt-3.5" onClick={connect} disabled={connecting}>
              <Icon name="database" /> {connecting ? 'Signing in…' : 'Sign in with Microsoft'}
            </Button>
          </>
        ) : !activeWs ? (
          <>
            <div className="mb-2 text-sm text-ink-muted">
              {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'} — pick one to list reports
            </div>
            <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => openWorkspace(w)}
                  className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-medium hover:bg-brand-violet-50 hover:text-brand-violet"
                >
                  <Icon name="folder" className="h-4 w-4 text-ink-muted" />
                  <span className="flex-1">{w.name}</span>
                  <Icon name="chevronRight" className="h-4 w-4 text-ink-muted" />
                </button>
              ))}
              {!workspaces.length && <div className="text-sm text-ink-muted">No workspaces visible to this account.</div>}
            </div>
          </>
        ) : (
          <>
            <Breadcrumb label="All workspaces" onClick={() => { setActiveWs(null); setReports(null); }} />
            <div className="mb-2 text-sm text-ink-muted">
              {activeWs.name} · {loadingReports ? 'loading…' : `${reports?.length ?? 0} report${reports?.length === 1 ? '' : 's'}`}
            </div>
            <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
              {(reports ?? []).map((r) => (
                <div key={r.name} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-base font-medium">
                  <Icon name="file" className="h-4 w-4 shrink-0 text-ink-muted" />
                  <span>{r.name}</span>
                </div>
              ))}
              {reports && !reports.length && <div className="text-sm text-ink-muted">No reports in this workspace.</div>}
            </div>
          </>
        )}
      </div>
      <ModalFooter onClose={onClose} showDone={!!workspaces} onDone={onClose} />
    </Modal>
  )
}
