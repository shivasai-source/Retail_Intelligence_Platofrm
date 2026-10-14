import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Icon } from '../icons'
import { Button } from './ui'

/** THE ERROR SCREEN.
 *
 *  Without it, any error thrown while a page renders unmounts the whole React
 *  tree and the user is left looking at a white page with no clue why -- it
 *  reads as "the app is dead". This catches the error, says what happened in
 *  plain words, and offers the two things that actually help: Reload, and a
 *  way back to the portal. The technical details are one click away, with a
 *  Copy button, for whoever has to fix it.
 *
 *  ONE CASE IS NAMED ON PURPOSE: a tab left open while the app was updated.
 *  The dev server (and a fresh deploy) replaces the code the tab was loaded
 *  with, and the next page the tab opens fails to load its modules. That is
 *  not a bug in the page -- a reload fixes it -- so the screen says exactly
 *  that instead of sounding an alarm.
 *
 *  `RouteErrorBoundary` resets on navigation, so one broken page never takes
 *  the rest of the app down with it: click another item in the rail and that
 *  page renders normally. */

const STALE_CODE = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Outdated Optimize Dep',
  'ChunkLoadError',
]

function isStaleCode(error: Error): boolean {
  const text = `${error.name} ${error.message}`
  return STALE_CODE.some((s) => text.includes(s))
}

interface State {
  error: Error | null
  componentStack: string
}

class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still reported to the console, for the developer tools.
    console.error('Page render failed:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    return <ErrorScreen error={error} componentStack={componentStack} />
  }
}

/** The boundary, reset whenever the route changes. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
}

function ErrorScreen({ error, componentStack }: { error: Error; componentStack: string }) {
  const stale = isStaleCode(error)
  const [copied, setCopied] = useState(false)
  const details = [
    `${error.name}: ${error.message}`,
    `Page: ${window.location.hash || '/'}`,
    `Time: ${new Date().toISOString()}`,
    '',
    (error.stack ?? '').split('\n').slice(0, 8).join('\n'),
    componentStack ? `\nComponent stack:${componentStack.split('\n').slice(0, 8).join('\n')}` : '',
  ].join('\n')

  const copy = () => {
    navigator.clipboard?.writeText(details).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className="grid min-h-svh place-items-center bg-canvas p-6">
      <div
        role="alert"
        className="w-full max-w-lg rounded-[var(--r-2xl)] border border-border-default bg-surface-card p-8 shadow-[var(--shadow-frame)]"
      >
        <span
          className={`grid h-12 w-12 place-items-center rounded-[var(--r-md)] [&_svg]:h-6 [&_svg]:w-6 ${
            stale ? 'bg-brand-violet-50 text-brand-violet' : 'bg-status-danger-bg text-status-danger'
          }`}
        >
          <Icon name={stale ? 'refresh' : 'alertTriangle'} />
        </span>
        <h1 className="mt-5 text-2xl font-normal tracking-[-0.02em] text-ink-primary">
          {stale ? 'The app was updated' : 'This page hit a problem'}
        </h1>
        <p className="mt-2 text-base leading-relaxed text-ink-secondary">
          {stale
            ? 'A newer version of the app was loaded while this tab was open, so this page could not start. Reload to pick up the latest version — nothing you were working on is lost.'
            : 'Something went wrong while showing this page. Reloading usually fixes it. If it keeps happening, copy the details below and send them to the team.'}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            <Icon name="refresh" /> Reload
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              window.location.hash = '#/home'
            }}
          >
            <Icon name="home" /> Go to Home
          </Button>
        </div>

        <details className="mt-6 rounded-[var(--r-md)] border border-border-subtle bg-surface-muted">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-ink-secondary">Technical details</summary>
          <div className="border-t border-border-subtle px-4 py-3">
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-secondary">{details}</pre>
            <Button variant="ghost" size="sm" className="mt-2" onClick={copy}>
              <Icon name={copied ? 'check' : 'file'} /> {copied ? 'Copied' : 'Copy details'}
            </Button>
          </div>
        </details>
      </div>
    </div>
  )
}
