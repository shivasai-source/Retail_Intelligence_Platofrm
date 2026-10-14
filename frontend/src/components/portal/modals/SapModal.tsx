import { useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, Field, Input, BrandLogo } from '../../ui'
import { ConnectModalHeader, ErrorBox, InfoNote, ModalFooter } from './shared'
import { proxyFetch, saveProxyConn, loadProxyConn } from '../../../lib/portalConnectors'
import type { PortalConnector } from '../../../types/portal'

interface Saved {
  base_url: string
  username: string
  path: string
}

// Ported from js/portal.js's openSapModal — a real OData fetch via FastAPI
// (app/routers/connectors.py handles Basic Auth + CORS server-side).
export function SapModal({
  connector: _connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const saved = loadProxyConn<Saved>('sap')
  const [base, setBase] = useState(saved?.base_url ?? '')
  const [user, setUser] = useState(saved?.username ?? '')
  const [pass, setPass] = useState('')
  const [path, setPath] = useState(saved?.path ?? '')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null)
  const [recordCount, setRecordCount] = useState(0)

  const connect = async () => {
    setError('')
    if (!base.trim() || !path.trim()) {
      setError('Enter both the Gateway base URL and the OData entity set path.')
      return
    }
    setConnecting(true)
    try {
      const res = await proxyFetch<{ records: Record<string, unknown>[]; record_count: number }>('/proxy/sap/odata', {
        base_url: base.trim(),
        path: path.trim(),
        username: user.trim(),
        password: pass,
      })
      saveProxyConn('sap', { base_url: base.trim(), username: user.trim(), path: path.trim() })
      setRecords(res.records)
      setRecordCount(res.record_count)
      onConnected(`${res.record_count} record${res.record_count === 1 ? '' : 's'}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  const keys = records && records.length ? Object.keys(records[0]).filter((k) => !k.startsWith('__')).slice(0, 5) : []

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[560px]">
      <ConnectModalHeader
        logo={<BrandLogo logo="sap" name="SAP" />}
        title="Connect SAP (OData)"
        subtitle="Fetch real records from an SAP Gateway service"
        onClose={onClose}
      />
      <div className="p-5">
        <ErrorBox message={error} />
        <div className="mb-3">
          <Field label="Gateway base URL">
            <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://your-sap-host:port" />
          </Field>
        </div>
        <div className="mb-3 flex gap-2.5">
          <div className="flex-1">
            <Field label="Username">
              <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="service account" />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Password">
              <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" />
            </Field>
          </div>
        </div>
        <div className="mb-1.5">
          <Field label="OData entity set path">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder" />
          </Field>
        </div>
        <InfoNote>
          Routed through the app's own backend so CORS and Basic Auth headers work from the browser. Needs network access to this SAP
          system from the machine running the backend (VPN, if required) — same access your browser would need directly.
        </InfoNote>
        <Button variant="secondary" block className="mt-3.5" onClick={connect} disabled={connecting}>
          <Icon name="database" /> {connecting ? 'Fetching…' : 'Fetch records'}
        </Button>

        {records && (
          <div className="mt-3.5">
            {records.length ? (
              <>
                <div className="mb-1.5 text-sm text-ink-muted">
                  {recordCount} record{recordCount === 1 ? '' : 's'} returned{recordCount > records.length ? ` (showing first ${records.length})` : ''}
                </div>
                <div className="max-h-[220px] overflow-auto rounded-[var(--r-md)] border border-border-subtle">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        {keys.map((k) => (
                          <th key={k} className="sticky top-0 whitespace-nowrap bg-surface-muted p-[7px_10px] text-left font-medium text-ink-secondary">
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r, i) => (
                        <tr key={i} className="hover:bg-surface-hover">
                          {keys.map((k) => (
                            <td key={k} className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap border-t border-border-subtle p-[6px_10px]">
                              {r[k] === null || r[k] === undefined ? <span className="text-ink-muted">—</span> : String(r[k])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="text-sm text-ink-muted">No records returned.</div>
            )}
          </div>
        )}
      </div>
      <ModalFooter onClose={onClose} showDone={!!records} onDone={onClose} />
    </Modal>
  )
}
