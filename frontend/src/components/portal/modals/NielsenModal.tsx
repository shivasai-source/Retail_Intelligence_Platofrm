import { useState } from 'react'
import { Icon } from '../../../icons'
import { Modal, Button, Field, Input, Select, BrandLogo } from '../../ui'
import { ConnectModalHeader, ErrorBox, InfoNote, ModalFooter } from './shared'
import { proxyFetch, saveProxyConn, loadProxyConn } from '../../../lib/portalConnectors'
import type { PortalConnector } from '../../../types/portal'

type AuthType = 'none' | 'basic' | 'bearer'
interface Saved {
  base_url: string
  path: string
  auth_type: AuthType
}

// Ported from js/portal.js's openNielsenModal — a generic REST connector shell.
// There's no single standardized public NielsenIQ API; this forwards whatever real
// endpoint/auth the user's own Nielsen contract gave them. Nothing here is guessed.
export function NielsenModal({
  connector: _connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const saved = loadProxyConn<Saved>('nielsen')
  const [base, setBase] = useState(saved?.base_url ?? '')
  const [path, setPath] = useState(saved?.path ?? '')
  const [authType, setAuthType] = useState<AuthType>(saved?.auth_type ?? 'none')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [raw, setRaw] = useState<unknown>(undefined)
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null)

  const connect = async () => {
    setError('')
    if (!base.trim()) {
      setError('Enter the base URL your Nielsen team provided.')
      return
    }
    setConnecting(true)
    try {
      const payload: Record<string, unknown> = { base_url: base.trim(), path: path.trim(), auth_type: authType }
      if (authType === 'basic') {
        payload.username = user.trim()
        payload.password = pass
      }
      if (authType === 'bearer') {
        payload.token = token.trim()
      }
      const res = await proxyFetch<{ data: unknown }>('/proxy/generic/rest', payload)
      saveProxyConn('nielsen', { base_url: base.trim(), path: path.trim(), auth_type: authType })
      onConnected('connected')

      const data = res.data as { value?: unknown[]; d?: { results?: unknown[] } } | unknown[]
      const list = Array.isArray(data) ? data : Array.isArray((data as { value?: unknown[] }).value) ? (data as { value: unknown[] }).value : Array.isArray((data as { d?: { results?: unknown[] } }).d?.results) ? (data as { d: { results: unknown[] } }).d.results : null
      if (list) {
        setRecords(list as Record<string, unknown>[])
        setRaw(undefined)
      } else {
        setRecords(null)
        setRaw(data)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  const keys = records && records.length ? Object.keys(records[0]).filter((k) => !k.startsWith('__')).slice(0, 5) : []

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[520px]">
      <ConnectModalHeader
        logo={<BrandLogo logo="nielsen" name="NielsenIQ" />}
        title="Connect NielsenIQ"
        subtitle="Generic REST connector — point it at your real endpoint"
        onClose={onClose}
      />
      <div className="p-5">
        <ErrorBox message={error} />
        <InfoNote>
          There's no single standardized public NielsenIQ API — access is typically a bespoke integration from your Nielsen contract.
          Enter the real endpoint your Nielsen account team gave you; nothing here is pre-filled with guesses.
        </InfoNote>
        <div className="mb-3 mt-3.5">
          <Field label="Base URL">
            <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.your-nielsen-endpoint.com" />
          </Field>
        </div>
        <div className="mb-3">
          <Field label="Path">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/v1/scanner-data" />
          </Field>
        </div>
        <div className="mb-3">
          <Field label="Authentication">
            <Select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
              <option value="none">None</option>
              <option value="basic">Username / password</option>
              <option value="bearer">Bearer token</option>
            </Select>
          </Field>
        </div>
        {authType === 'basic' && (
          <div className="mb-3 flex gap-2.5">
            <div className="flex-1">
              <Field label="Username">
                <Input value={user} onChange={(e) => setUser(e.target.value)} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Password">
                <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
              </Field>
            </div>
          </div>
        )}
        {authType === 'bearer' && (
          <div className="mb-3">
            <Field label="Bearer token">
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          </div>
        )}
        <Button variant="secondary" block onClick={connect} disabled={connecting}>
          <Icon name="database" /> {connecting ? 'Fetching…' : 'Fetch data'}
        </Button>

        {(records || raw !== undefined) && (
          <div className="mt-3.5">
            {records ? (
              records.length ? (
                <>
                  <div className="mb-1.5 text-sm text-ink-muted">{records.length} record{records.length === 1 ? '' : 's'} returned</div>
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
              )
            ) : (
              <>
                <div className="mb-1.5 text-sm text-ink-muted">Response received — not a record list, showing raw JSON:</div>
                <div className="rounded-[var(--r-md)] border border-border-subtle p-2.5">
                  <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(raw, null, 2).slice(0, 2000)}</pre>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <ModalFooter onClose={onClose} showDone={!!records || raw !== undefined} onDone={onClose} />
    </Modal>
  )
}
