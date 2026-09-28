import type { AnalystSnapshot } from '../hooks/useAnalyst'

// MOVING A CONVERSATION BETWEEN WINDOWS.
//
// The Analyst's thread lives in component state — the server keeps no session
// — so "open in a new window" has to carry it across by hand. localStorage is
// the channel: it is shared by every window of this origin, and writing a key
// fires a `storage` event in the OTHER windows, which is how an already-open
// pop-out (or the page it came from) hears about a hand-off without a reload.
//
// Each envelope is stamped and consumed once. A stale one — the receiving
// window was never opened, say — is ignored rather than resurrecting an old
// conversation the next time the dashboard loads.

/** The dashboard → the pop-out window. */
export const TO_WINDOW = 'tiq.analyst.toWindow'
/** The pop-out window → back into the dashboard's panel. */
export const TO_PANEL = 'tiq.analyst.toPanel'

const MAX_AGE_MS = 15_000

interface Envelope {
  at: number
  snap: AnalystSnapshot
}

export function sendHandoff(key: string, snap: AnalystSnapshot): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), snap } satisfies Envelope))
    return true
  } catch {
    return false
  }
}

/** Parse an envelope's raw value; null when absent, malformed or stale. */
export function readHandoff(raw: string | null): AnalystSnapshot | null {
  if (!raw) return null
  try {
    const env = JSON.parse(raw) as Envelope
    if (!env?.snap || !Array.isArray(env.snap.messages) || Date.now() - env.at > MAX_AGE_MS) return null
    return env.snap
  } catch {
    return null
  }
}

/** Read and remove — a hand-off is delivered once. */
export function takeHandoff(key: string): AnalystSnapshot | null {
  try {
    const snap = readHandoff(window.localStorage.getItem(key))
    window.localStorage.removeItem(key)
    return snap
  } catch {
    return null
  }
}

export function dropHandoff(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* nothing to drop */
  }
}
