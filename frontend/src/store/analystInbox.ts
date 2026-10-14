import { create } from 'zustand'

/** A QUESTION SENT TO THE INSIGHTS HUB ANALYST FROM ELSEWHERE.
 *
 *  Investigations hands a plain figure lookup ("ROI by channel in 2025") to
 *  the Analyst rather than planning an investigation for it. It drops the
 *  question here and navigates to the Insights Hub; the Analyst panel opens
 *  itself, asks the question and clears the slot. One question at a time --
 *  a newer hand-off replaces an older one that was never picked up. */
interface AnalystInbox {
  question: string | null
  send: (question: string) => void
  clear: () => void
}

export const useAnalystInbox = create<AnalystInbox>()((set) => ({
  question: null,
  send: (question) => set({ question }),
  clear: () => set({ question: null }),
}))
