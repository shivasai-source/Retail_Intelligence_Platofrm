import { useEffect, useState } from 'react'
import { Icon } from '../../../icons'
import { MissingTables } from './MissingTables'
import { InstallProgress } from './InstallProgress'
import { Modal, Button, IconButton, Field, Input, Spinner, useToast, useConfirm, BrandLogo } from '../../ui'
import { ErrorBox, InfoNote } from './shared'
import { fmtSize, saveProxyConn, loadProxyConn } from '../../../lib/portalConnectors'
import {
  useStarStatus,
  useResetStar,
  useDbxCatalogs,
  useDbxSchemas,
  useDbxTables,
  useDbxInspect,
  useDbxInstall,
} from '../../../hooks/useDatasets'
import { STAR_ROLE_LABELS, matchHeader } from '../../../lib/starSchema'
import { ApiError } from '../../../lib/api'
import type { PortalConnector } from '../../../types/portal'
import type { DbxTable, DbxTableSel, StarInspectResult, StarRole } from '../../../types/dataset'
import { StarFileViewer } from './StarFileViewer'

// Loading the six star-schema tables from a Databricks Unity Catalog.
//
// THE SAME CONNECTOR AS EXCEL AND AZURE, WITH A THIRD SOURCE. Every rule about
// what is acceptable — the six tables identified by their columns, all of them
// or none, no extras, locked once loaded, reset before reloading — is the
// backend's `star_dataset`, shared with the other two. This modal differs only
// in where the data comes from, and mirrors AzureDatasetModal's states: loaded
// shows View/Reset and no picker; empty shows the picker.
//
// A DATABRICKS TABLE IS NOT A FILE, which is the one real difference. The SQL
// API can return a table AS CSV, so the backend exports the six and hands the
// installer exactly the bytes it would have got from an upload. Nothing about
// the six-table contract had to be re-specified for this source.
//
// BROWSING COSTS NOTHING. Catalogs, schemas and tables all come from Unity
// Catalog metadata, which needs no SQL warehouse and reads no rows — and the
// column names arrive with the table listing, so a table is labelled with its
// star role the moment it appears. Only "Load 6 tables" runs a query.
export function DatabricksModal({
  connector,
  onClose,
  onConnected,
}: {
  connector: PortalConnector
  onClose: () => void
  onConnected: (detail: string) => void
}) {
  const saved = loadProxyConn<{ workspace_url: string; token: string }>('databricks')
  const [workspace, setWorkspace] = useState(saved?.workspace_url ?? '')
  const [token, setToken] = useState(saved?.token ?? '')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState('')
  const [catalogs, setCatalogs] = useState<string[] | null>(null)
  const [catalog, setCatalog] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<string[] | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  const [tables, setTables] = useState<DbxTable[] | null>(null)
  const [picked, setPicked] = useState<DbxTableSel[]>([])
  const [inspection, setInspection] = useState<StarInspectResult | null>(null)
  const [viewing, setViewing] = useState<StarRole | null>(null)

  const { show } = useToast()
  const confirm = useConfirm()
  const status = useStarStatus()
  const reset = useResetStar()
  const listCatalogs = useDbxCatalogs()
  const listSchemas = useDbxSchemas()
  const listTables = useDbxTables()
  const inspect = useDbxInspect()
  const install = useDbxInstall()

  const locked = status.data?.locked ?? false
  const creds = { workspace_url: workspace.trim(), token: token.trim() }
  const busy =
    listCatalogs.isPending || listSchemas.isPending || listTables.isPending ||
    inspect.isPending || install.isPending

  const fail = (e: unknown) =>
    setError(e instanceof ApiError ? e.message : "Couldn't reach the server — is the backend running?")

  const connect = () => {
    setError('')
    if (!creds.workspace_url || !creds.token) {
      setError('Enter both a workspace URL and a personal access token.')
      return
    }
    listCatalogs.mutate(creds, {
      onSuccess: (res) => {
        setCatalogs(res.catalogs.map((c) => c.name))
        setCatalog(null)
        setSchemas(null)
        setSchema(null)
        setTables(null)
        saveProxyConn('databricks', creds)
      },
      onError: fail,
    })
  }

  const openCatalog = (name: string) => {
    setError('')
    listSchemas.mutate(
      { ...creds, catalog: name },
      {
        onSuccess: (res) => {
          setCatalog(name)
          setSchemas(res.schemas.map((s) => s.name))
          setSchema(null)
          setTables(null)
        },
        onError: fail,
      },
    )
  }

  const openSchema = (name: string) => {
    setError('')
    listTables.mutate(
      { ...creds, catalog: catalog ?? '', schema_name: name },
      {
        onSuccess: (res) => {
          setSchema(name)
          setTables(res.tables)
        },
        onError: fail,
      },
    )
  }

  // Selection spans the whole workspace, not one schema: the six tables can sit
  // in different schemas, so navigating away must not drop what was ticked.
  const toggle = (sel: DbxTableSel) => {
    setInspection(null)
    setPicked((prev) => {
      const hit = prev.findIndex(
        (t) => t.catalog === sel.catalog && t.schema_name === sel.schema_name && t.name === sel.name,
      )
      return hit >= 0 ? prev.filter((_, i) => i !== hit) : [...prev, sel]
    })
  }
  const isPicked = (sel: DbxTableSel) =>
    picked.some(
      (t) => t.catalog === sel.catalog && t.schema_name === sel.schema_name && t.name === sel.name,
    )

  // Clear a stale error when the selection changes — it described a set the
  // user has since edited. Keyed on contents, so a swap of equal length counts.
  const pickedKey = picked.map((t) => `${t.catalog}.${t.schema_name}.${t.name}`).join('|')
  useEffect(() => setError(''), [pickedKey])

  const runInspect = () => {
    setError('')
    inspect.mutate({ ...creds, tables: picked }, { onSuccess: setInspection, onError: fail })
  }

  const runInstall = () => {
    setError('')
    install.mutate(
      { ...creds, tables: picked },
      {
        onSuccess: (res) => {
          const rows = res.rows
          onConnected(`${res.installed.length} core tables${rows ? ` · ${rows.toLocaleString()} fact rows` : ''}`)
          show(`Dataset loaded from Databricks — ${rows?.toLocaleString() ?? ''} fact rows ready.`, { duration: 4000 })
          setPicked([])
          setInspection(null)
        },
        onError: fail,
      },
    )
  }

  const doReset = () => {
    confirm({
      title: 'Reset uploaded data?',
      body:
        'All 6 files will be deleted from the data folder and every dashboard will go back to ' +
        'its upload prompt. This cannot be undone — you will need to load the full set again.',
      primaryText: 'Delete all 6 files',
      icon: 'alertTriangle',
      onConfirm: () => {
        setError('')
        reset.mutate(undefined, {
          onSuccess: (res) => {
            setViewing(null)
            setPicked([])
            setInspection(null)
            show(`${res.removed.length} files cleared — load a new dataset.`, { duration: 3500 })
          },
          onError: fail,
        })
      },
    })
  }

  if (viewing) {
    return <StarFileViewer role={viewing} onBack={() => setViewing(null)} onClose={onClose} />
  }

  const installed = status.data?.files.filter((f) => f.present) ?? []
  const ready = inspection?.ready ?? false

  // Star role for a table, matched locally from the columns the listing already
  // carries. `matchHeader` is the same rule `star_dataset` applies, mirrored in
  // starSchema.ts — so a table is labelled the moment it is listed, with no
  // request at all, and the label cannot contradict the backend's verdict.
  const roleOf = (t: DbxTable): StarRole | null => matchHeader(t.columns).role

  return (
    <Modal open onClose={onClose} maxWidthClassName="max-w-[560px]">
      <div className="flex items-center justify-between border-b border-border-subtle p-[16px_20px]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[9px]">
            <BrandLogo logo="databricks" name={connector.name} />
          </div>
          <div>
            <h3 className="text-md font-bold">{locked ? 'Your dataset' : 'Load dataset from Databricks'}</h3>
            <div className="mt-0.5 text-sm text-ink-muted">
              {locked
                ? 'All 6 tables loaded · view or reset'
                : 'Pick the 6 tables · recognised by their column names'}
            </div>
          </div>
        </div>
        <IconButton icon="x" onClick={onClose} />
      </div>

      <div className="max-h-[64vh] overflow-y-auto p-5">
        <ErrorBox message={error} />

        {status.isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-muted">
            <Spinner /> Checking what's loaded…
          </div>
        )}

        {/* ---------------- LOADED: view / reset, no picker ---------------- */}
        {!status.isLoading && locked && (
          <>
            <div className="mb-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-status-success-bg p-[10px_12px] text-sm leading-[1.5] text-[#047857] [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
              <Icon name="checkCircle" />
              <span>
                All 6 tables are loaded and every dashboard is reading from them. To load a different
                dataset, reset first — the six tables are only consistent as one set.
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {installed.map((f) => (
                <div key={f.role} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
                  <Icon name="database" className="h-4 w-4 shrink-0 text-[#047857]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold">{f.label}</div>
                    <div className="mt-px truncate text-xs leading-[1.45] text-ink-muted">
                      {f.filename} · {fmtSize(f.size_bytes)}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setViewing(f.role)}>
                    <Icon name="eye" /> View
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---------------- EMPTY: credentials, then the catalog picker ------ */}
        {!status.isLoading && !locked && (
          <>
            <div className="mb-3">
              <Field label="Workspace URL">
                <Input
                  value={workspace}
                  onChange={(e) => { setWorkspace(e.target.value); setCatalogs(null) }}
                  placeholder="https://dbc-xxxxxxxx.cloud.databricks.com"
                />
              </Field>
            </div>
            <div className="mb-1.5">
              <Field label="Personal access token">
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setCatalogs(null) }}
                    placeholder="dapi..."
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-1 top-1/2 grid h-[26px] w-[26px] -translate-y-1/2 place-items-center rounded-md text-ink-muted"
                  >
                    <Icon name="eye" className="h-4 w-4" />
                  </button>
                </div>
              </Field>
            </div>
            <InfoNote>
              Needs a token with USE and SELECT on the tables. Browsing reads catalog metadata only —
              a SQL warehouse is used only to export the data, when you load and each time you sync.
              Once the data loads, the server keeps this connection so the Live pill can sync new
              rows — use a read-only token that expires.
            </InfoNote>

            <Button
              variant="secondary"
              block
              className="mt-3.5"
              onClick={connect}
              disabled={listCatalogs.isPending}
            >
              <Icon name="database" />{' '}
              {listCatalogs.isPending ? 'Connecting…' : catalogs ? 'Reconnect' : 'Connect & list catalogs'}
            </Button>

            {/* Catalogs */}
            {catalogs && !catalog && (
              <div className="mt-3.5">
                <div className="mb-2 text-sm text-ink-muted">
                  {catalogs.length} catalog{catalogs.length === 1 ? '' : 's'} — open one to find your tables
                </div>
                <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
                  {catalogs.map((name) => (
                    <button
                      key={name}
                      onClick={() => openCatalog(name)}
                      className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-semibold hover:bg-brand-violet-50 hover:text-brand-violet"
                    >
                      <Icon name="database" className="h-4 w-4 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <Icon name="chevronRight" className="h-4 w-4 text-ink-muted" />
                    </button>
                  ))}
                  {!catalogs.length && (
                    <div className="text-sm text-ink-muted">No catalogs visible to this token.</div>
                  )}
                </div>
              </div>
            )}

            {/* Schemas */}
            {catalog && !schema && (
              <div className="mt-3.5">
                <button
                  onClick={() => { setCatalog(null); setSchemas(null) }}
                  className="mb-2 inline-flex items-center gap-1 text-sm font-bold text-brand-violet"
                >
                  <Icon name="chevronLeft" className="h-3.5 w-3.5" /> All catalogs
                </button>
                <div className="mb-2 truncate text-sm text-ink-muted">
                  {catalog}
                  {listSchemas.isPending && ' · loading…'}
                </div>
                <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
                  {(schemas ?? []).map((name) => (
                    <button
                      key={name}
                      onClick={() => openSchema(name)}
                      className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_11px] text-left text-base font-semibold hover:bg-brand-violet-50 hover:text-brand-violet"
                    >
                      <Icon name="folder" className="h-4 w-4 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <Icon name="chevronRight" className="h-4 w-4 text-ink-muted" />
                    </button>
                  ))}
                  {schemas && !schemas.length && (
                    <div className="text-sm text-ink-muted">No schemas in this catalog.</div>
                  )}
                </div>
              </div>
            )}

            {/* Tables */}
            {schema && tables && (
              <div className="mt-3.5">
                <button
                  onClick={() => { setSchema(null); setTables(null) }}
                  className="mb-2 inline-flex items-center gap-1 text-sm font-bold text-brand-violet"
                >
                  <Icon name="chevronLeft" className="h-3.5 w-3.5" /> All schemas
                </button>
                <div className="mb-2 truncate text-sm text-ink-muted">
                  {catalog}.{schema}
                  {listTables.isPending && ' · loading…'}
                </div>
                <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto">
                  {tables.map((t) => {
                    const sel = { catalog: catalog ?? '', schema_name: schema, name: t.name }
                    const on = isPicked(sel)
                    const role = roleOf(t)
                    return (
                      <button
                        key={t.name}
                        onClick={() => toggle(sel)}
                        className={`flex items-center gap-2.5 rounded-[var(--r-md)] p-[9px_11px] text-left text-base ${
                          on ? 'bg-brand-violet-50 text-brand-violet' : 'bg-surface-muted hover:bg-surface-hover'
                        }`}
                      >
                        <Icon
                          name={on ? 'checkCircle' : 'grid'}
                          className={`h-4 w-4 shrink-0 ${on ? 'text-brand-violet' : 'text-ink-muted'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{t.name}</div>
                          <div className="mt-px truncate text-xs text-ink-muted">
                            {role ? STAR_ROLE_LABELS[role] : `${t.columns.length} columns`}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                  {!tables.length && <div className="text-sm text-ink-muted">No tables in this schema.</div>}
                </div>
              </div>
            )}

            {/* What was picked, and what the columns say it is. */}
            {picked.length > 0 && (
              <div className="mt-3.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">
                    {picked.length} table{picked.length === 1 ? '' : 's'} selected
                  </span>
                  <button
                    onClick={() => { setPicked([]); setInspection(null) }}
                    className="text-xs font-semibold text-ink-muted hover:text-[#B91C1C]"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {picked.map((t) => {
                    const full = `${t.catalog}.${t.schema_name}.${t.name}`
                    const found = inspection?.files.find((f) => f.filename === full)
                    const ok = found?.recognised && found.missing_columns.length === 0
                    return (
                      <div key={full} className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-surface-muted p-[9px_12px]">
                        <Icon
                          name={!inspection ? 'grid' : ok ? 'check' : 'info'}
                          className={`h-4 w-4 shrink-0 ${!inspection ? 'text-ink-muted' : ok ? 'text-[#047857]' : 'text-[#B91C1C]'}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-base font-semibold">{t.name}</div>
                          <div className="mt-px truncate text-xs leading-[1.45]">
                            {!inspection ? (
                              <span className="text-ink-muted">{full}</span>
                            ) : ok && found?.role ? (
                              <span className="text-[#047857]">{STAR_ROLE_LABELS[found.role]}</span>
                            ) : found?.recognised && found.role ? (
                              <span className="text-[#B91C1C]">
                                {STAR_ROLE_LABELS[found.role]} — missing {found.missing_columns.join(', ')}
                              </span>
                            ) : (
                              <span className="text-[#B91C1C]">Not one of the 6 tables — remove it</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => toggle(t)}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-status-danger-bg hover:text-[#B91C1C]"
                        >
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {inspection && !inspection.ready && <MissingTables inspection={inspection} />}

            <InstallProgress
              active={install.isPending}
              estimateMs={60_000}
              label="Exporting from Databricks"
              note="The six tables are exported through a SQL warehouse. The fact table is the big one."
            />

            {inspection?.ready && (
              <div className="mt-3.5 flex items-start gap-2 rounded-[var(--r-md)] bg-surface-muted p-[10px_12px] text-sm leading-[1.5] text-ink-muted [&_svg]:mt-px [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0">
                <Icon name="check" />
                <span>
                  All 6 tables recognised. They'll be exported through a SQL warehouse and every
                  dashboard will load from them — the fact table takes about a minute.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-[14px_22px]">
        <span className="text-xs text-ink-muted">
          {locked ? '6 of 6 loaded' : picked.length > 0 ? `${picked.length} selected` : 'Unity Catalog'}
        </span>
        <div className="flex gap-2">
          {locked ? (
            <>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="secondary" onClick={doReset} disabled={reset.isPending}>
                <Icon name="refresh" /> {reset.isPending ? 'Resetting…' : 'Reset'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              {/* Check first, load second. Checking is metadata-only and
                  instant; loading runs a real query against a warehouse. */}
              {!ready ? (
                <Button variant="primary" onClick={runInspect} disabled={picked.length === 0 || busy}>
                  <Icon name="search" /> {inspect.isPending ? 'Checking…' : 'Check tables'}
                </Button>
              ) : (
                <Button variant="primary" onClick={runInstall} disabled={busy}>
                  <Icon name="download" /> {install.isPending ? 'Exporting…' : 'Load 6 tables'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
