import { useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar, type Crumb } from './Topbar'
import { useSidebar } from '../../store/sidebar'
import { useAnalystLayout } from '../../store/analystLayout'
import type { NavData } from '../../types/nav'

/** The page shell. Ported from css/layout.css #app / .main / .content.
 *
 *  THE CONTENT IS INSET BY THE NAVIGATION'S PINNED WIDTH on the left, and on
 *  the right by the docked Analyst while it is open (store/analystLayout.ts):
 *
 *      below md      ->  none                       (off-canvas drawer)
 *      md, unpinned  ->  --sidebar-rail-w  (68px)   the icon rail
 *      md, pinned    ->  --sidebar-w       (224px)  the full column
 *
 *  Only PINNING changes the inset, and pinning is a click. The rail's hover
 *  and focus expansion is an overlay drawn by the sidebar over the content
 *  (see Sidebar.tsx), so no pointer movement, route change or breakpoint
 *  reflows a page -- the failure of the earlier expanding rail, whose inset
 *  followed the pointer. The one transition here runs when the pin changes.
 *
 *  BELOW `md` there is no inset at all: the sidebar is an off-canvas drawer
 *  there, and a permanent column is what used to leave no room for any page's
 *  content on phone widths.
 */
export function AppShell({
  activeKey,
  crumbs,
  children,
  nav,
  brand,
  brandHref,
  datasetComplete,
  settingsHref,
  tpoTools,
}: {
  activeKey?: string
  crumbs?: Crumb[]
  children: ReactNode
  /** Passed straight to Sidebar — an intelligence module other than TPO
   *  supplies its own navigation and wordmark. Omitted, the rail is TPO's. */
  nav?: NavData
  brand?: string
  brandHref?: string
  /** See Sidebar — a module that does not read TPO's star schema answers the
   *  padlock question itself. */
  datasetComplete?: boolean
  /** See Topbar — a module's own settings route, and whether TPO's alert bell
   *  and sync pill belong in its top bar. Omitted, both are TPO's. */
  settingsHref?: string
  tpoTools?: boolean
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pinned = useSidebar((s) => s.pinned)
  // The docked Analyst's width, when it is open beside the page. Padding on
  // this wrapper narrows <main>, so the page's container queries reflow the
  // cards into the space left rather than letting the panel cover them.
  const analystInset = useAnalystLayout((s) => s.inset)
  const analystResizing = useAnalystLayout((s) => s.resizing)

  return (
    // THE FLOATING FRAME (the house layout). The app is a window with large
    // rounded corners, a hairline and a soft shadow on a canvas one step
    // deeper than the page. From `md` the frame is the viewport less the
    // canvas gap and <main> scrolls inside it, so the rail and the top bar
    // stay put. Below `md` it goes edge to edge and the page scrolls as before.
    <div className="min-h-svh bg-canvas md:p-[var(--frame-gap)]">
      <div className="relative flex min-h-svh flex-col overflow-hidden bg-surface-page md:h-[calc(100svh_-_2*var(--frame-gap))] md:min-h-0 md:rounded-[var(--r-2xl)] md:border md:border-border-default md:shadow-[var(--shadow-frame)]">
        <Sidebar
          activeKey={activeKey}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          nav={nav}
          brand={brand}
          brandHref={brandHref}
          datasetComplete={datasetComplete}
          settingsHref={settingsHref}
        />
        <div
          style={analystInset ? { paddingRight: analystInset } : undefined}
          className={[
            'flex min-h-0 min-w-0 flex-1 flex-col bg-surface-page',
            analystResizing
              ? 'transition-none'
              : 'transition-[padding-left,padding-right] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
            pinned ? 'md:pl-[var(--sidebar-w)]' : 'md:pl-[var(--sidebar-rail-w)]',
          ].join(' ')}
        >
          <Topbar
            crumbs={crumbs}
            onMenuClick={() => setSidebarOpen(true)}
            settingsHref={settingsHref}
            tpoTools={tpoTools}
          />
          <main
            data-scroll-root
            className="@container min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pb-10 pt-7 md:px-10"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
