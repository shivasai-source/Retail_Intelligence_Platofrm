// Ported from js/portal.js's connector plumbing (proxyFetch, session-storage helpers,
// Azure Blob REST helpers). As of Phase 6, Databricks/SAP/Power BI/NielsenIQ/OpenAI
// are routed through FastAPI (`backend/app/routers/connectors.py`, ported from the
// standalone `connector_proxy.py`) instead of a separate local proxy process — same
// origin as the rest of the app, via the Vite dev proxy in dev and directly in prod.
// Azure needs no proxy either way: Blob Storage supports CORS directly, so it stays a
// real fetch straight from the browser (see azureListContainers/azureListBlobs below).
export const PROXY_BASE = '/api'

export async function proxyFetch<T = unknown>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${PROXY_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error("Can't reach the backend — is the FastAPI server running?")
  }
  const data = await res.json().catch(() => ({}))
  // FastAPI's HTTPException serializes as {"detail": "..."} — accept that shape,
  // falling back to the old proxy's {"error": "..."} for anything still on the path.
  if (!res.ok) throw new Error((data as { detail?: string; error?: string }).detail || (data as { error?: string }).error || `Request failed (${res.status})`)
  return data as T
}

export function saveProxyConn(kind: string, data: unknown) {
  try {
    sessionStorage.setItem(`tiq_${kind}_conn`, JSON.stringify(data))
  } catch {
    /* ignore */
  }
}
export function loadProxyConn<T>(kind: string): T | null {
  try {
    const raw = sessionStorage.getItem(`tiq_${kind}_conn`)
    if (raw) return JSON.parse(raw) as T
  } catch {
    /* ignore */
  }
  return null
}
export function clearProxyConn(kind: string) {
  try {
    sessionStorage.removeItem(`tiq_${kind}_conn`)
  } catch {
    /* ignore */
  }
}

//: Which connector the installed star schema came from. The backend records
//: the six files but not their provenance, so the browser remembers it — read
//: back only while a dataset is actually loaded, which keeps it from going
//: stale after a Reset. localStorage rather than sessionStorage: the dataset
//: outlives the tab that loaded it.
const DATASET_SOURCE_KEY = 'tiq_dataset_source'

export function saveDatasetSource(key: string) {
  try {
    localStorage.setItem(DATASET_SOURCE_KEY, key)
  } catch {
    /* ignore */
  }
}
export function loadDatasetSource(): string | null {
  try {
    return localStorage.getItem(DATASET_SOURCE_KEY)
  } catch {
    return null
  }
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// ===== Azure Blob Storage — real, backend-free =====
const AZURE_CONN_KEY = 'tiq_azure_conn'
export interface AzureConn {
  account: string
  sas: string
}

export function saveAzureConn(conn: AzureConn) {
  try {
    sessionStorage.setItem(AZURE_CONN_KEY, JSON.stringify(conn))
  } catch {
    /* ignore */
  }
}
export function loadAzureConn(): AzureConn | null {
  try {
    const raw = sessionStorage.getItem(AZURE_CONN_KEY)
    if (raw) return JSON.parse(raw) as AzureConn
  } catch {
    /* ignore */
  }
  return null
}
export function clearAzureConn() {
  try {
    sessionStorage.removeItem(AZURE_CONN_KEY)
  } catch {
    /* ignore */
  }
}

function azureUrl(account: string, sas: string, container?: string) {
  const cleanSas = sas.trim().replace(/^\?/, '')
  const base = container
    ? `https://${account}.blob.core.windows.net/${encodeURIComponent(container)}?restype=container&comp=list`
    : `https://${account}.blob.core.windows.net/?comp=list`
  return `${base}&${cleanSas}`
}

async function azureFetchXml(url: string): Promise<Document> {
  let res: Response
  try {
    res = await fetch(url, { method: 'GET' })
  } catch {
    throw new Error("Network request failed — this usually means CORS isn't enabled on the storage account for this origin, or the account name is wrong.")
  }
  const text = await res.text()
  if (!res.ok) {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    const code = doc.querySelector('Code')?.textContent
    const msg = doc.querySelector('Message')?.textContent
    throw new Error(code ? `${code} — ${msg || res.statusText}` : `Request failed (${res.status} ${res.statusText})`)
  }
  return new DOMParser().parseFromString(text, 'application/xml')
}

export async function azureListContainers(account: string, sas: string) {
  const doc = await azureFetchXml(azureUrl(account, sas))
  return Array.from(doc.querySelectorAll('Containers > Container')).map((el) => ({
    name: el.querySelector('Name')?.textContent || '(unnamed)',
  }))
}

export async function azureListBlobs(account: string, sas: string, container: string) {
  const doc = await azureFetchXml(azureUrl(account, sas, container))
  return Array.from(doc.querySelectorAll('Blobs > Blob')).map((el) => ({
    name: el.querySelector('Name')?.textContent || '(unnamed)',
    size: Number(el.querySelector('Properties > Content-Length')?.textContent || 0),
    modified: el.querySelector('Properties > Last-Modified')?.textContent || '',
  }))
}

// ===== Power BI — MSAL.js loaded from CDN on demand (Azure AD sign-in) =====
declare global {
  interface Window {
    msal?: unknown
  }
}

export function loadMsal(): Promise<unknown> {
  if (window.msal) return Promise.resolve(window.msal)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@3/lib/msal-browser.min.js'
    s.onload = () => resolve(window.msal)
    s.onerror = () => reject(new Error("Couldn't load the Microsoft sign-in library from the CDN — check this machine has internet access."))
    document.head.appendChild(s)
  })
}
