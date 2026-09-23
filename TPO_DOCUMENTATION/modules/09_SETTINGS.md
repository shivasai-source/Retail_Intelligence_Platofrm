# Module 09 — Settings, and the Portal (Login / Home)

**Routes:** `#/settings` · `#/login` · `#/home`
**Status:** **Static, read-only** · Authentication is a **client-side stand-in**

## Part A — Settings

**Page:** `frontend/src/pages/Settings.tsx`
**Endpoint:** `GET /api/settings` → `backend/app/data/settings.json`

### Three cards

**1. Profile**

| Field | Source |
|---|---|
| Initials avatar | Derived from the signed-in email (`store/portalUser`) |
| Name | Derived from the email's local part, title-cased |
| Email | **The email the visitor typed** |
| Caption | *"Signed in locally — this application has no identity provider, so nothing here is verified."* |
| Region | `settings.json.profile.region` → `"South"` |
| Timezone | `settings.json.profile.timezone` → `"Asia/Kolkata"` |
| Edit button | **Disabled** — *"Editing a profile is not yet available"* |

**2. Preferences** — read-only rows from `settings.json.preferences`:

| Row | Value |
|---|---|
| Theme | `Light` |
| Density | `Comfortable` |
| Default Period | `Q2 FY25` |
| Default Channel | `All Channels` |

> **None of these is a working setting.** There is no theme switcher, no density
> control, and — importantly — **nothing reads `defaultPeriod` or
> `defaultChannel` as a default.** The Command Center's default year is adopted
> from `/api/command-center/filters` (never hardcoded), and its default channel
> is "unconstrained". `"Q2 FY25"` is not even expressible in this application's
> filter model, which has no quarter dimension and treats F25 as calendar 2025.

**3. Integrations** — three rows from `settings.json.integrations`:

| Integration | Status |
|---|---|
| Single sign-on | **Not connected** |
| Slack notifications | **Not connected** |
| Email digests | **Not connected** |

Footnote: *"None of these is connected. Sign-in is a local stand-in with no
identity provider behind it, and this application sends no notification of any
kind."*

### What was corrected (B9)

`pages/Settings.tsx`'s own docstring:

> **IDENTITY.** *"This card used to print 'Sanjay Kumar · Commercial Analyst ·
> sanjay.k@company.com' from `settings.json`, beside the initials of whoever had
> actually signed in — two different people on one card. The only identity this
> application can honestly show is the one the visitor typed at sign-in, so that
> is what it shows now, labelled for what it is. **A role is not shown at all:
> there is no authorization model to source one from.**"*
>
> **INTEGRATIONS.** *"The three rows used to carry a green tick and an 'Active'
> pill. None of them exists — there is no identity provider, no Slack connection
> and no mail sender anywhere in this project. They are listed as Not
> connected."*

`backend/app/data/user.json` still serves the `"Sanjay Kumar" / "Commercial
Analyst" / "SK"` persona at `GET /api/user`, consumed by the `Topbar`.

### Settings — known limitations

| # | Limitation |
|---|---|
| 1 | **Entirely read-only.** No setting can be changed, and nothing is persisted |
| 2 | Preferences are **display strings that drive nothing** |
| 3 | `defaultPeriod` and `defaultChannel` are **not applied** anywhere |
| 4 | No theme or density control exists despite the rows |
| 5 | No role is shown — correctly, since there is no authorization model |
| 6 | No report export — correctly, there is no reportable dataset |

---

## Part B — Authentication

**Status: NOT IMPLEMENTED. A client-side stand-in, deliberately not built on.**

### What `#/login` does

`pages/Login.tsx` + `hooks/useAuth.ts`:

1. Requires a **non-empty** email and a **non-empty** password.
2. Validates neither. Any value is accepted.
3. Derives a display name from the email's local part
   (`abhinav@transorg.com` → `"Abhinav"`), and initials from that.
4. Persists `{ name, initials, email }` to `localStorage` under
   `tiq_portal_user`.
5. Navigates to `#/home` after 450 ms.

There is **no request to the server**, no token, no session and no cookie.
"Forgot password?" shows a toast reading *"Password reset coming soon."*

### What that means

| | |
|---|---|
| Route guards | **None.** `#/command` is reachable without ever visiting `#/login` |
| API guards | **None.** All 63 routes are open, including every write |
| Ownership | Every stored record carries `owner: null` + `NO_OWNER_NOTE` |
| Attribution | Impossible. The decision briefing states this on the printed page |
| Approval | Impossible. No actor can be verified, so no record can be approved |

### Why it was deferred rather than faked (B11)

`backend/app/routers/store.py`:

> *"B11 was DEFERRED: this project has no identity provider, and building access
> control on a self-asserted email would be an enforcement claim with nothing
> behind it. So no route here is guarded… This is stated rather than fixed
> because the fix requires authentication, which does not exist."*

`tests/test_unauthenticated_disclosure.py` (10 tests) asserts the **disclosure**
— that every store route repeats it in its OpenAPI description and every
response carries `owner: null` with the note.

---

## Part C — The Portal

### `#/login`

Covered above. Branded "TRANSORG ANALYTICS · Retail Intelligence Platform".

### `#/home`

`pages/Home.tsx` — the module selector, ported from the predecessor's
`home.html` + `js/portal.js`.

**Six intelligence modules** (`components/portal/modules.ts`):

| Module | Live |
|---|---|
| Demand & Sales Forecasting Intelligence | ✗ |
| **Trade Promotion Optimization (TPO)** | **✓** |
| Market Mix & Marketing Intelligence (MMM) | ✗ |
| Assortment & Pricing Intelligence | ✗ |
| Customer & Channel Intelligence | ✗ |
| Supply, Inventory & Network Intelligence | ✗ |

Only TPO is `live: true`; its card links straight to `#/command` as a same-app
navigation. Commit `3a4881f` renamed the platform and **dropped the "COMING
SOON" badges** from the other five.

Also on the page:

- **`ConnectorRail`** — six connectors with working modals and live proxies.
  See [modules/08_DATA_CONNECTIONS.md](08_DATA_CONNECTIONS.md).
- **`AdvisorCard`** — an OpenAI capability chat via
  `POST /api/proxy/openai/chat`. **The one genuinely live LLM path in this
  application**; the Promotion Intelligence "AI answer" is a typing animation
  over static text.
- **`HeroArt`** — decorative.

### Application shell

`components/layout/AppShell.tsx` wraps the nine in-app routes with
`Sidebar` + `Topbar` + breadcrumbs.

`Sidebar` reads `GET /api/nav` → `nav.json`:

| Group | Items |
|---|---|
| **navMain** | Command Center · Investigations · Promotion Intelligence · Simulation Studio · Decision Center |
| **navSecondary** | Calendar · Reports · Data Connections · Settings |

Collapsible, with the collapsed state persisted in `store/sidebar.ts`
(commit `870bec5`).

`Topbar` shows breadcrumbs and the user chip from `GET /api/user`
(**the static persona**, not the signed-in email — the two differ, which is the
same class of mismatch B9 corrected on the Settings card).

### Portal — known limitations

Rows 1-3 describe the PREDECESSOR and have since been corrected; they are
kept because the rest of this file explains what was done about them. Rows 4
and 5 are still true of the app today.

| # | Limitation | Status |
|---|---|---|
| 1 | **Sign-in validates nothing** and reaches no server | Fixed — `auth_store.verify_or_create_user` hashes with a per-user salt and `hmac.compare_digest`-checks it on every sign-in after the first |
| 2 | **No route guard** anywhere | Fixed — every route but `/login` is wrapped in `RequireAuth`, and the data routes in `RequireDataset` too |
| 3 | `DEFAULT_USER` is `"Abhinav"`; the Topbar shows `"Sanjay Kumar"` from `user.json`; Settings shows the typed email. **Three different identities are reachable in one session** | Fixed — `DEFAULT_USER` is gone; the signed-in account is the only identity |
| 4 | Five of the six portal modules are placeholders | Still true |
| 5 | The advisor forwards a caller-supplied OpenAI key through the server | Still true |

## File map

| Concern | File |
|---|---|
| Settings page | `frontend/src/pages/Settings.tsx` |
| Login page | `frontend/src/pages/Login.tsx` |
| Home page | `frontend/src/pages/Home.tsx` |
| Portal components | `frontend/src/components/portal/*` (12 files) |
| Layout | `frontend/src/components/layout/{AppShell,Sidebar,Topbar}.tsx` |
| Stores | `frontend/src/store/{portalUser,sidebar}.ts` |
| Hooks | `frontend/src/hooks/{useMisc,useNav}.ts` |
| Types | `frontend/src/types/{settings,portal,nav}.ts` |
| Routers | `backend/app/routers/{misc,nav}.py` |
| Data | `backend/app/data/{settings,user,nav,focus}.json` |
| Tests | `backend/tests/test_unauthenticated_disclosure.py` |
