import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input, useToast } from '../components/ui'
import { Icon } from '../icons'
import { useCurrentUser, useLogin } from '../hooks/useAuth'
import { ApiError } from '../lib/api'

// Ported from login.html + js/portal.js's Portal.initLogin(), now backed by real
// FastAPI auth (POST /api/auth/login — see backend/app/auth_store.py) instead of a
// client-side stand-in. First login for a given email creates the account on the
// spot (frictionless demo signup, same as before); every login after that actually
// checks the password.
export function Login() {
  const { data: currentUser } = useCurrentUser()
  const login = useLogin()
  const { show } = useToast()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  // Already signed in (valid session cookie) — skip straight past the form.
  useEffect(() => {
    if (currentUser) navigate('/home', { replace: true })
  }, [currentUser, navigate])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter both an email and a password to continue.')
      return
    }
    setError('')
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => navigate('/home'),
        onError: (err) => {
          setError(err instanceof ApiError ? err.message : "Couldn't reach the server — is the backend running?")
        },
      },
    )
  }

  return (
    // A quiet brand wash behind the card -- two low-alpha radial gradients in
    // the brand violet and blue, the same "lights" the Insights Hub header
    // wears -- so the sign-in page belongs to the product rather than to a
    // blank grey screen.
    <div className="flex min-h-screen items-center justify-center bg-surface-page p-6 [background-image:radial-gradient(600px_400px_at_15%_10%,var(--brand-violet-50),transparent_70%),radial-gradient(500px_360px_at_90%_90%,var(--brand-blue-50),transparent_70%)]">
      <div className="fade-in-up w-full max-w-[400px] rounded-[var(--r-xl)] border border-border-subtle bg-surface-card p-[36px_32px_28px] shadow-[var(--shadow-lg)]">
        {/* THE BRAND, in the same voice as everywhere else in the product: a
            mark and a wordmark in title case, not a shout in capitals. */}
        <div className="mb-7 flex items-center gap-2.5">
          <img src="/image.png" alt="" className="h-8 w-8" />
          <span className="text-base font-semibold tracking-[-0.01em] text-ink-primary">TransOrg Analytics</span>
        </div>

        {/* Eyebrow names the product; the heading greets the person; the line
            beneath says what to do. One idea per line, largest to smallest. */}
        <div className="mb-0.5 text-2xs font-bold uppercase tracking-[0.12em] text-brand-violet">Retail Intelligence Platform</div>
        <h1 className="text-2xl font-extrabold leading-[1.15] tracking-[-0.02em]">Welcome back</h1>
        <p className="mb-6 mt-1.5 text-base leading-[1.5] text-ink-muted">Sign in to your workspace.</p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {/* The same alert vocabulary as the rest of the app: alert tokens,
              which hold their contrast in both themes, and a role so a screen
              reader hears it without hunting. */}
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--alert-border)] bg-[var(--alert-bg)] px-3 py-2 text-sm font-medium text-[var(--alert-ink)]">
              <Icon name="alertTriangle" className="mt-px h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Field label="Work email">
            {/* An INSTRUCTION, not a specimen address. The placeholder used to be
                a realistic personal email, which renders as grey text inside an
                otherwise-empty field and reads as a value somebody had already
                filled in. `autoComplete="username"` is deliberately kept — the
                browser's own saved-credential fill is a feature, not a bug. */}
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              autoComplete="username"
              autoFocus
              aria-invalid={Boolean(error) || undefined}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              aria-invalid={Boolean(error) || undefined}
            />
          </Field>

          {/* The "keep me signed in" box that used to sit here did nothing --
              the session is a cookie either way -- so it is gone; a control
              that does not control anything is a small lie. */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => show('Password reset is coming soon. Ask your administrator in the meantime.', { variant: 'info' })}
              className="cursor-pointer text-sm font-semibold text-brand-violet transition-colors hover:text-brand-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
            >
              Forgot password?
            </button>
          </div>

          <Button type="submit" variant="primary" size="lg" block disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 border-t border-border-subtle pt-4 text-center text-sm leading-[1.6] text-ink-muted">
          New here? Your first sign-in creates your workspace.
        </p>
      </div>
    </div>
  )
}
