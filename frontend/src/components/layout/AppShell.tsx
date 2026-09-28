import { useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar, type Crumb } from './Topbar'
import { useSidebar } from '../../store/sidebar'
import { useAnalystLayout } from '../../store/analystLayout'

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
}: {
  activeKey?: string
  crumbs?: Crumb[]
  children: ReactNode
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pinned = useSidebar((s) => s.pinned)
  // The docked Analyst's width, when it is open beside the page. Padding on
  // this wrapper narrows <main>, so the page's container queries reflow the
  // cards into the space left rather than letting the panel cover them.
  const analystInset = useAnalystLayout((s) => s.inset)
  const analystResizing = useAnalystLayout((s) => s.resizing)

  return (
    <div className="min-h-screen">
      <Sidebar activeKey={activeKey} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div
        style={analystInset ? { paddingRight: analystInset } : undefined}
        className={[
          'flex min-h-screen min-w-0 flex-col bg-surface-page',
          analystResizing
            ? 'transition-none'
            : 'transition-[padding-left,padding-right] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none',
          pinned ? 'md:pl-[var(--sidebar-w)]' : 'md:pl-[var(--sidebar-rail-w)]',
        ].join(' ')}
      >
        <Topbar crumbs={crumbs} onMenuClick={() => setSidebarOpen(true)} />
        <main className="@container min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-10 pt-6 sm:px-8">{children}</main>
      </div>
    </div>
  )
}
