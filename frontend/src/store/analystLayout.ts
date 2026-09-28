import { create } from 'zustand'

/** HOW THE ANALYST SITS ON THE PAGE.
 *
 *  `docked` (the default) is a side panel with NO backdrop that the page makes
 *  room for: the shell insets its content by `inset`, so every card stays
 *  readable — and clickable — beside the conversation. The questions are
 *  about what is on screen; a drawer that dimmed and covered a third of it
 *  was the complaint this replaces.
 *
 *  `expanded` is a large centred workspace over a dimmed page, for reading a
 *  long answer or a wide chart. A third way out, the pop-out window, is not a
 *  mode here: it leaves this page entirely (see AnalystPanel).
 *
 *  Mode and width are remembered per browser. `inset` is live state written by
 *  the panel while it is open and docked on a wide screen, and read by
 *  AppShell — one store so the two can never disagree about the width.
 */

export type AnalystMode = 'docked' | 'expanded'

export const ANALYST_MIN_W = 380
export const ANALYST_MAX_W = 760
const DEFAULT_W = 460

const MODE_KEY = 'tiq.analyst.mode'
const WIDTH_KEY = 'tiq.analyst.width'

function read<T>(key: string, parse: (v: string) => T | null, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key)
    return (v === null ? null : parse(v)) ?? fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* A remembered preference is a convenience, not a requirement. */
  }
}

export const clampAnalystWidth = (w: number) => Math.round(Math.min(ANALYST_MAX_W, Math.max(ANALYST_MIN_W, w)))

interface AnalystLayoutStore {
  mode: AnalystMode
  width: number
  /** Pixels the page shell gives up on the right. 0 unless docked and open. */
  inset: number
  /** True while the edge is being dragged — the shell drops its transition so
   *  the page tracks the pointer instead of trailing it. */
  resizing: boolean
  setMode: (mode: AnalystMode) => void
  setWidth: (width: number, persist?: boolean) => void
  setInset: (inset: number) => void
  setResizing: (resizing: boolean) => void
}

export const useAnalystLayout = create<AnalystLayoutStore>((set) => ({
  mode: read<AnalystMode>(MODE_KEY, (v) => (v === 'expanded' || v === 'docked' ? v : null), 'docked'),
  width: read(WIDTH_KEY, (v) => (Number.isFinite(+v) ? clampAnalystWidth(+v) : null), DEFAULT_W),
  inset: 0,
  resizing: false,
  setMode: (mode) => {
    write(MODE_KEY, mode)
    set({ mode })
  },
  setWidth: (width, persist = true) => {
    const w = clampAnalystWidth(width)
    if (persist) write(WIDTH_KEY, String(w))
    set({ width: w })
  },
  setInset: (inset) => set({ inset }),
  setResizing: (resizing) => set({ resizing }),
}))
