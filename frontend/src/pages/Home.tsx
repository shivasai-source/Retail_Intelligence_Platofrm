import { Link, useNavigate } from 'react-router-dom'
import { Dropdown, IconButton, ThemeToggle, useToast } from '../components/ui'
import { useCurrentUser, useLogout } from '../hooks/useAuth'
import { useStarStatus } from '../hooks/useDatasets'
import { HeroArt } from '../components/portal/HeroArt'
import { ModuleGrid } from '../components/portal/ModuleGrid'

// Ported from home.html + js/portal.js's Portal.initHome(). Same topbar/hero/module
// grid layout as the vanilla app, state-driven instead of direct DOM mutation.
//
// NO CONNECTOR RAIL. The portal used to carry a "Connected Data Sources" card
// beside the modules, which meant two screens offered the same four connectors
// and neither was clearly the one to use. Connecting now lives only on
// /connections, which owns the catalog, the dialogs and the dataset's state —
// and the TPO card routes there while the platform has no data, so the rail's
// job is done by the one card that was already the way in.
export function Home() {
  const { data: user } = useCurrentUser()
  const { data: starStatus } = useStarStatus()
  const logout = useLogout()
  const navigate = useNavigate()
  const { show } = useToast()

  // Where the live module goes. With no dataset installed every TPO page is a
  // locked door (RequireDataset), so the card sends a first-time user to the
  // connectors instead of to a gate; once the six tables are in it opens the
  // Insights Hub directly, as it always did.
  const complete = Boolean(starStatus?.complete)
  const tpoHref = complete ? '/command' : '/connections'

  const signOut = () => {
    logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  // RequireAuth (see App.tsx) only mounts this page once /auth/me has already
  // resolved, so this is effectively always populated — just a type-safety guard.
  if (!user) return null

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="portal-header flex h-[76px] items-center gap-3 border-b border-border-subtle bg-surface-card px-4 sm:px-8">
        <Link to="/home" className="flex min-w-0 items-center gap-3">
          <img src="/image.png" alt="TransOrg" className="h-[38px] w-[38px] shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate text-lg leading-[1.22] sm:text-xl">Agentic CPG &amp; Retail Intelligence Platform</h1>
            {/* One step up and one shade darker. At 13px in `ink-muted` this
                sat under a 21px wordmark and read as fine print rather than as
                the product's description. */}
            <p className="mt-0.5 hidden truncate text-md text-ink-secondary sm:block">Enterprise decision intelligence for FMCG/CPG</p>
          </div>
        </Link>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <IconButton icon="bell" onClick={() => show('No notifications yet — this is a fresh workspace.')} title="Notifications" />
          <IconButton icon="help" onClick={() => show('Help center coming soon.')} title="Help" />
          <Dropdown
            selected=""
            options={[{ label: `Signed in as ${user.email}`, value: 'noop' }, { label: 'Sign out' }]}
            onSelect={(val) => {
              if (val === 'noop') return
              signOut()
            }}
            trigger={
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full bg-[linear-gradient(135deg,#6B47FF,#8C6EFF)] text-sm font-bold text-white"
                title={user.name}
                aria-label={`Account menu — ${user.name}`}
              >
                {user.initials}
              </button>
            }
          />
        </div>
      </header>

      {/* `@container` so this page's `@max-[...]` breakpoints have something to
          resolve against. AppShell's main carries it and this one never did, so
          every container query on the portal — the module grid's own columns —
          silently never fired at any width.

          The bottom padding was 64px of nothing below the fold. On a 1366x768
          laptop at 100% zoom the viewport is ~625px tall and this page wanted
          828px, so the second row of modules was cut through its titles. */}
      <main className="portal-main @container mx-auto max-w-[1920px] p-[20px_16px_28px] sm:p-[28px_40px_30px]">
        <div className="portal-hero fade-in-up mb-5 flex items-center justify-between gap-6">
          <div className="min-w-0 flex-1">
            {/* The person's name as they gave it -- capitals shout, and mangle
                names that are not meant to be uppercased. */}
            <h2 className="mb-2 text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl">Good to see you, {user.name}.</h2>
            {/* ONE LINE. The sentence measures 1059px at this size, and the
                column it sits in is 1286px wide at 1366 and 1200px at 1280, so
                the cap is what was wrapping it — 72ch is 582px. Raised to clear
                the sentence with slack, not removed: below ~1150px of column
                there is genuinely no room for it and it should wrap rather than
                overflow. */}
            <p className="max-w-[1100px] text-md leading-[1.55] text-ink-secondary">
              Trade Promotion Optimization is live — measure, diagnose and simulate every promotion against its baseline.
              Five more modules are on the roadmap.
            </p>
          </div>
          {/* Decoration yields to content on a short screen. The art is a
              fixed 112px SVG beside 73px of text, so on a laptop viewport it
              was the tallest thing in the hero and pushed the module grid
              down by the difference -- for a drawing. Above 800px of viewport
              height there is room for both and it stays. */}
          <div className="hidden shrink-0 md:block [@media(max-height:800px)]:!hidden">
            <HeroArt />
          </div>
        </div>

        <ModuleGrid tpoHref={tpoHref} needsData={!complete} />
      </main>
    </div>
  )
}
