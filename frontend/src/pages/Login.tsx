import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, useToast } from '../components/ui'
import { Icon } from '../icons'
import { useCurrentUser, useLogin } from '../hooks/useAuth'
import { ApiError } from '../lib/api'

// Ported from login.html + js/portal.js's Portal.initLogin(), now backed by real
// FastAPI auth (POST /api/auth/login — see backend/app/auth_store.py) instead of a
// client-side stand-in. First login for a given email creates the account on the
// spot (frictionless demo signup, same as before); every login after that actually
// checks the password.

// The browser's "Save password?" prompt is asked for in hooks/useAuth.ts, on the
// login mutation itself — see the note there for why it cannot live in this
// page's onSuccess. What this page owes it is the form shape: a real <form>
// with a submit button, and `name` + `autoComplete` on both fields.
export function Login() {
  const { data: currentUser } = useCurrentUser()
  const login = useLogin()
  const { show } = useToast()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const errorId = useId()
  const emailId = useId()
  const passwordId = useId()

  // Already signed in (valid session cookie) — skip straight past the form.
  useEffect(() => {
    if (currentUser) navigate('/home', { replace: true })
  }, [currentUser, navigate])

  // AN ERROR IS ABOUT WHAT WAS SUBMITTED, so the moment either field changes it
  // is describing something that is no longer on screen. It used to survive
  // until the next submit, which left "check your password" sitting above a
  // password the reader had already corrected.
  const edit = (set: (v: string) => void) => (value: string) => {
    if (error) setError('')
    set(value)
  }

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
    // ONE CARD, CENTRED, on a quiet brand wash -- two low-alpha radial
    // gradients in the brand violet and blue, the same "lights" the Insights
    // Hub header wears, so the sign-in page belongs to the product rather than
    // to a blank grey screen. `min-h-screen` with `items-center` centres the
    // card on tall screens and lets the page scroll on short ones instead of
    // clipping the form.
    <div className="flex min-h-screen items-center justify-center bg-surface-page p-6 max-[480px]:p-4 [background-image:radial-gradient(620px_420px_at_18%_8%,var(--brand-violet-50),transparent_70%),radial-gradient(540px_380px_at_88%_92%,var(--brand-blue-50),transparent_70%)]">
      {/* THE CARD'S PADDING IS ONE NUMBER, 40px, on all four sides. Everything
          inside is measured from that edge, so the border sits the same
          distance from the heading, the fields and the footer rule alike. It
          drops to 28px below 480px, where 40 would leave the fields too
          narrow to read a long email in. */}
      <div className="fade-in-up w-full max-w-[460px] rounded-[var(--r-xl)] border border-border-subtle bg-surface-card p-10 shadow-[var(--shadow-lg)] max-[480px]:p-7">
        {/* THE BRAND, in the same voice as everywhere else in the product: a
            mark and a wordmark in title case, not a shout in capitals. */}
        <div className="flex items-center gap-2.5">
          <img src="/image.png" alt="" className="h-9 w-9" />
          <span className="text-md font-bold tracking-[-0.01em] text-ink-primary">TransOrg Analytics</span>
        </div>

        {/* Eyebrow names the product; the heading greets the person; the line
            beneath says what to do. One idea per line, largest to smallest. */}
        <div className="mt-8 text-sm font-bold uppercase tracking-[0.14em] text-brand-violet">Retail Intelligence Platform</div>
        {/* `!text-3xl`, not `text-3xl`: index.css states `h1 { font-size: 26px }`
            as a bare element rule, and an unlayered rule beats anything in
            Tailwind's utilities layer. Moving those base rules into
            `@layer base` is the real fix, but it would also let the text-*
            utilities on ~20 headings across the frozen modules finally
            apply — shrinking most of them — so it is not this page's to make. */}
        <h1 className="mt-2 !text-3xl font-extrabold tracking-[-0.025em]">Welcome back</h1>
        <p className="mt-2 text-md leading-[1.55] text-ink-muted">
          Sign in to pick your workspace up where you left it.
        </p>

        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-5" noValidate>
          {/* The same alert vocabulary as the rest of the app: alert tokens,
              which hold their contrast in both themes, and a role so a screen
              reader hears it without hunting. */}
          {error && (
            <div
              id={errorId}
              role="alert"
              className="flex items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--alert-border)] bg-[var(--alert-bg)] px-3.5 py-3 text-base font-medium leading-[1.45] text-[var(--alert-ink)]"
            >
              <Icon name="alertTriangle" className="mt-px h-[18px] w-[18px] shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <LoginField label="Work email" htmlFor={emailId}>
            {/* An INSTRUCTION, not a specimen address. The placeholder used to be
                a realistic personal email, which renders as grey text inside an
                otherwise-empty field and reads as a value somebody had already
                filled in. `autoComplete="username"` is deliberately kept — the
                browser's own saved-credential fill is a feature, not a bug. */}
            <Input
              id={emailId}
              // `name` is what Chrome's parser actually classifies on — see the
              // note above the component.
              name="username"
              type="email"
              value={email}
              onChange={(e) => edit(setEmail)(e.target.value)}
              placeholder="name@company.com"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              className={FIELD_CLASS}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </LoginField>

          <LoginField label="Password" htmlFor={passwordId}>
            <div className="relative">
              <Input
                // THE READER CHOOSES whether the password is on screen. The
                // page is a real password check, not the "any password works"
                // the README used to claim, so a typo here costs a failed
                // attempt — and a field nobody can read is where typos live.
                id={passwordId}
                name="password"
                type={revealed ? 'text' : 'password'}
                value={password}
                onChange={(e) => edit(setPassword)(e.target.value)}
                onKeyUp={(e) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)}
                onBlur={() => setCapsLock(false)}
                placeholder="Your password"
                autoComplete="current-password"
                className={`${FIELD_CLASS} pr-11`}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? errorId : undefined}
              />
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                aria-label={revealed ? 'Hide password' : 'Show password'}
                aria-pressed={revealed}
                className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 cursor-pointer place-items-center rounded-[var(--r-sm)] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
              >
                <Icon name={revealed ? 'eyeOff' : 'eye'} className="h-[18px] w-[18px]" />
              </button>
            </div>
            {/* CAPS LOCK IS THE COMMONEST WRONG PASSWORD, and the one thing a
                masked field cannot show. Said before the attempt, not after. */}
            {capsLock && (
              <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-status-warning">
                <Icon name="alertTriangle" className="h-3.5 w-3.5 shrink-0" />
                Caps Lock is on.
              </p>
            )}
          </LoginField>

          {/* The "keep me signed in" box that used to sit here did nothing --
              the session is a cookie either way -- so it is gone; a control
              that does not control anything is a small lie. */}
          <div className="-mt-1 flex justify-end">
            <button
              type="button"
              onClick={() => show('Password reset is coming soon. Ask your administrator in the meantime.', { variant: 'info' })}
              className="cursor-pointer rounded-[var(--r-sm)] text-base font-semibold text-brand-violet transition-colors hover:text-brand-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet"
            >
              Forgot password?
            </button>
          </div>

          {/* The page's one action, at the page's one hero size. `!h-12` and
              `!text-md` override `lg` deliberately: every other screen in the
              product puts its primary button in a row of other controls, and
              this one has the screen to itself. */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={login.isPending}
            className="!h-12 !text-md"
          >
            {login.isPending ? (
              <>
                <Icon name="refresh" className="animate-spin" />
                Signing in…
              </>
            ) : (
              <>
                Sign in
                <Icon name="arrowRight" />
              </>
            )}
          </Button>
        </form>

        <p className="mt-7 border-t border-border-subtle pt-6 text-center text-base leading-[1.6] text-ink-muted">
          New here? Your first sign-in creates your workspace.
        </p>
      </div>
    </div>
  )
}

/** A LABEL THAT IS ACTUALLY A LABEL. The shared `Field` renders its <label>
 *  as a sibling of the control with no `htmlFor`, so clicking the word does
 *  not focus the input and a screen reader announces the input as unnamed.
 *  Sign-in is the one form in the product a reader cannot skip, so it gets
 *  the association — and the 13px label the page's scale calls for.
 *  (The same gap is in every other form; fixing it there is its own change.) */
function LoginField({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-base font-semibold text-ink-secondary">
        {label}
      </label>
      {children}
    </div>
  )
}

/** The fields, a step up from the app's default. Everywhere else an Input sits
 *  in a dense form inside a modal or a settings card; here there are two of
 *  them on an otherwise empty screen, and the 13px/33px default read as a
 *  disabled control rather than as the thing to type in. 44px is also the
 *  smallest comfortable touch target. */
const FIELD_CLASS = 'h-11 px-3.5 text-md'
