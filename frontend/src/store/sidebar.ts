import { create } from 'zustand'

/** WHETHER THE NAVIGATION IS PINNED OPEN.
 *
 *  Pinned: the full 224px column, the content inset by it, exactly the chrome
 *  the app has had. Unpinned (the default): a 68px icon rail, the content
 *  inset by only that, and the labels shown as an OVERLAY while the pointer
 *  or keyboard focus is inside the rail. The overlay is what makes an
 *  expanding rail acceptable: the old one widened the inset itself, so every
 *  page reflowed under the pointer, and that -- not the rail -- was the
 *  complaint. Nothing outside the rail moves now unless the reader pins it.
 *
 *  Remembered per browser. One store, read by both the shell (for the inset)
 *  and the sidebar (for its width), so the two can never disagree. */

const STORAGE_KEY = 'tiq.sidebar.pinned'

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

interface SidebarStore {
  pinned: boolean
  setPinned: (pinned: boolean) => void
  togglePinned: () => void
}

export const useSidebar = create<SidebarStore>((set, get) => ({
  pinned: readPinned(),
  setPinned: (pinned) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, pinned ? '1' : '0')
    } catch {
      /* A remembered preference is a convenience, not a requirement. */
    }
    set({ pinned })
  },
  togglePinned: () => get().setPinned(!get().pinned),
}))
