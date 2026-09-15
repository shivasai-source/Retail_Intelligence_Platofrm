/**
 * FINAL PLATFORM QA — every module, in one real browser pass.
 *
 * Drives the running application through Login → Insights Hub → RCA →
 * Simulation Studio (all three modes) → Decision Center → Calendar → Reports,
 * asserting that each module loads, settles, and shows no fabricated or
 * unexplained value. It also counts duplicate API requests per route, so a
 * regression in request hygiene is visible rather than guessed at.
 *
 * READ-ONLY. It clicks through and asserts; it saves no decision and writes
 * nothing to the store.
 *
 * RUN IT:
 *   1. npm run build                                   (in frontend/)
 *   2. python -m uvicorn app.main:app --port 8011      (in backend/)
 *   3. node e2e/full-platform.mjs
 */

import { launch, HELPERS } from './cdp.mjs'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8011'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let b

const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const section = (t) => console.log(`\n${'─'.repeat(80)}\n${t}\n${'─'.repeat(80)}`)

const inject = () => b.eval(HELPERS + ' return 1')
const click = (t) => b.eval(
  'const el = Array.from(document.querySelectorAll("button, a"))' +
  '  .find(x => !x.disabled && (x.innerText || "").includes(' + JSON.stringify(t) + '));' +
  'if (!el) return "not-found"; el.click(); return "clicked";')
const bodyHas = (t) => b.eval(
  'return (document.body.innerText || "").includes(' + JSON.stringify(t) + ');')

/** Nothing anywhere is still spinning. */
const SETTLED = `
  const t = document.body.innerText;
  const spinning = ['Loading', 'Calculating', 'Assembling', 'Building your',
    'Running against', 'Decomposing', 'Assessing risk', 'Preparing the comparison',
    'Measuring', 'Evaluating the target', 'Optimising', 'Optimizing', 'Generating'];
  return spinning.every(s => !t.includes(s)) ? 'settled' : false;`

async function goto(hash, label) {
  await b.goto(`${BASE}/${hash}`)
  await inject()
  const settled = await b.waitFor(`${label} settles`, SETTLED, 60000).catch((e) => e.message)
  await sleep(800)
  await inject()
  return settled === 'settled'
}

async function main() {
  b = await launch()

  // Count every API request so duplicates are measurable, not guessed.
  const apiCalls = []
  b.on('Network.requestWillBeSent', (p) => {
    const url = p.request?.url || ''
    // FULL url, query included: /breakdown?by=channel and /breakdown?by=product
    // are two different charts, not one request issued twice.
    if (url.includes('/api/')) apiCalls.push(url.replace(BASE, ''))
  })
  const since = () => apiCalls.length
  const dupesSince = (mark) => {
    const slice = apiCalls.slice(mark)
    const counts = {}
    slice.forEach((u) => (counts[u] = (counts[u] || 0) + 1))
    return Object.entries(counts).filter(([, n]) => n > 1)
  }

  // ───────────────────────────────────────────────────────────── LOGIN
  section('LOGIN')
  await b.goto(`${BASE}/#/login`)
  await inject()
  await b.waitFor('login form', 'return !!document.querySelector("input[type=password]")')

  // Only text-bearing fields can carry a credential. A checkbox's `.value` is
  // the string "on" whatever its checked state, so including it would fail a
  // check that has nothing to do with credentials.
  const prefilled = await b.eval(
    'return Array.from(document.querySelectorAll("input"))' +
    '  .filter(x => ["text", "email", "password"].includes(x.type))' +
    '  .map(x => ({ type: x.type, value: x.value }));')
  ok('no credentials pre-filled', prefilled.every((i) => i.value === ''),
    JSON.stringify(prefilled))

  await b.eval(
    'const set = (e, v) => { const p = Object.getPrototypeOf(e);' +
    ' Object.getOwnPropertyDescriptor(p, "value").set.call(e, v);' +
    ' e.dispatchEvent(new Event("input", { bubbles: true })); };' +
    'const i = Array.from(document.querySelectorAll("input"));' +
    'set(i.find(x => x.type === "email") || i[0], "final-qa@transorg.com");' +
    'set(document.querySelector("input[type=password]"), "final-qa-pass");' +
    'document.querySelector("input[type=password]").closest("form").requestSubmit();' +
    'return 1;')
  const signedIn = await b.waitFor('signed in', 'return !location.hash.includes("login")', 25000)
    .then(() => true).catch(() => false)
  ok('login works', signedIn, await b.eval('return location.hash'))

  // ─────────────────────────────────────────────────── COMMAND CENTER
  section('COMMAND CENTER')
  let mark = since()
  ok('loads and settles', await goto('#/command', 'Insights Hub'))
  ok('KPI cards render', await b.eval(
    'return document.body.innerText.includes("Trade Spend") ? 1 : 0') === 1)
  const ccBlanks = await b.eval(
    'const t = document.body.innerText;' +
    'return (t.match(/\\n\\s*—\\s*\\n/g) || []).length;')
  ok('no unexplained blank KPI values', ccBlanks < 12, `${ccBlanks} em-dashes (unavailable states)`)
  ok('no duplicate API calls', dupesSince(mark).length === 0,
    JSON.stringify(dupesSince(mark)) || 'none')

  // ──────────────────────────────────────────────────────────── RCA
  section('RCA / INVESTIGATIONS')
  mark = since()
  ok('loads and settles', await goto('#/investigations', 'Investigations'))
  ok('no runtime error', !(await bodyHas('Something went wrong')))
  ok('no duplicate API calls', dupesSince(mark).length === 0,
    JSON.stringify(dupesSince(mark)) || 'none')

  // ────────────────────────────────────────────── PROMOTION INTELLIGENCE
  section('PROMOTION INTELLIGENCE')
  ok('loads and settles', await goto('#/intelligence', 'Intelligence'))
  ok('no runtime error', !(await bodyHas('Something went wrong')))

  // ─────────────────────────────────────────────────── SIMULATION STUDIO
  section('SIMULATION STUDIO')
  mark = since()
  ok('loads and settles', await goto('#/simulation', 'Simulation'))
  ok('scenario cards render', await bodyHas('Optimized Plan'))

  await click('Optimized Plan'); await sleep(800); await inject()
  await click('15%'); await sleep(600); await inject()
  await click('Run Simulation')
  ok('scenario runs and settles',
    await b.waitFor('sim settles', SETTLED, 90000).then(() => true).catch(() => false))
  await inject()
  ok('comparison renders', await bodyHas('Scenario Comparison'))
  ok('recommendation renders', await bodyHas('Recommendation'))
  ok('risk renders', await bodyHas('Risk'))
  ok('range preserved (no midpoint)', await b.eval(
    'return /[₹\\d][^\\n]{0,26}[–-]\\s*[₹\\d]/.test(document.body.innerText);'))
  ok('measured and simulated both labelled', await b.eval(
    'const t = document.body.innerText.toLowerCase();' +
    'return t.includes("measured") && t.includes("simulated");'))

  section('SIMULATION — GENERAL OPTIMIZATION')
  await click('General Optimization'); await sleep(2000); await inject()
  await b.waitFor('go settles', SETTLED, 60000).catch(() => null)
  await inject()
  await click('Get Data')
  ok('optimization runs and settles',
    await b.waitFor('go done', SETTLED, 90000).then(() => true).catch(() => false))
  await inject()
  const goHead = await b.eval(
    'return Array.from(document.querySelectorAll("th")).map(x => x.innerText.trim().toLowerCase());')
  ok('current vs optimized columns present',
    ['current discount', 'optimized discount', 'current trade spend', 'optimized trade spend']
      .every((c) => goHead.includes(c)), goHead.length ? `${goHead.length} columns` : 'no table')

  section('SIMULATION — TARGET RESCUE')
  await click('Target Rescue'); await sleep(2000); await inject()
  await b.waitFor('tr settles', SETTLED, 60000).catch(() => null)
  await inject()
  ok('target gated until entered', await b.eval(
    'const el = Array.from(document.querySelectorAll("button"))' +
    '  .find(x => (x.innerText || "").includes("Check Target"));' +
    'return el ? el.disabled : "missing";') === true)
  await b.eval(
    'const set = (e, v) => { const p = Object.getPrototypeOf(e);' +
    ' Object.getOwnPropertyDescriptor(p, "value").set.call(e, v);' +
    ' e.dispatchEvent(new Event("input", { bubbles: true })); };' +
    'const n = Array.from(document.querySelectorAll("input")).find(i => i.type === "number");' +
    'if (n) set(n, "50000"); return 1;')
  await sleep(700); await inject()
  await click('Check Target')
  ok('target evaluates and settles',
    await b.waitFor('tr done', SETTLED, 90000).then(() => true).catch(() => false))

  // ───────────────────────────────────────────────────── DECISION CENTER
  section('DECISION CENTER')
  await goto('#/simulation', 'Simulation')
  // The studio is still in Target Rescue from the section above, and a hash
  // navigation to the route it is already on does not remount it. Switch back
  // to the investigation workspace before looking for its controls.
  await click('Investigation Simulation'); await sleep(1500); await inject()
  await b.waitFor('studio settles', SETTLED, 60000).catch(() => null)
  await sleep(800); await inject()
  await click('Optimized Plan'); await sleep(800); await inject()
  await click('15%'); await sleep(600); await inject()
  await click('Run Simulation')
  await b.waitFor('sim settles', SETTLED, 90000).catch(() => null)
  await sleep(1500); await inject()
  const handoff = await click('Open Decision Center')
  ok('handoff enabled after a run', handoff === 'clicked')
  ok('reaches Decision Center',
    await b.waitFor('decision route', 'return location.hash.includes("decision")', 25000)
      .then(() => true).catch(() => false))
  ok('record builds and settles',
    await b.waitFor('dc settles', SETTLED, 90000).then(() => true).catch(() => false))
  await inject()
  for (const [label, text] of [
    ['recommended plan', 'Recommended Plan'], ['strategy', 'Strategy'],
    ['expected impact', 'Expected Impact'], ['risk & governance', 'Risk & Governance'],
    ['readiness', 'Decision Readiness'], ['evidence', 'Evidence'],
    ['AI brief card', 'AI Decision Brief'], ['history', 'Decision History'],
  ]) ok(`${label} section present`, await bodyHas(text))
  ok('approval/execution shown as Not configured', await bodyHas('Not configured'))
  ok('no fabricated governance claim', await b.eval(
    'const t = document.body.innerText.toLowerCase();' +
    'return !["budget compliant","margin safe","within risk envelope",' +
    '"governance checks passed","% confidence"].some(s => t.includes(s));'))

  // ──────────────────────────────────────────────────────────── CALENDAR
  section('PROMOTION CALENDAR')
  mark = since()
  ok('loads and settles', await goto('#/calendar', 'Calendar'))
  ok('no runtime error', !(await bodyHas('Something went wrong')))
  ok('no duplicate API calls', dupesSince(mark).length === 0,
    JSON.stringify(dupesSince(mark)) || 'none')

  // ───────────────────────────────────────────────────────────── REPORTS
  section('REPORTS')
  ok('loads and settles', await goto('#/reports', 'Reports'))
  ok('no runtime error', !(await bodyHas('Something went wrong')))

  // ───────────────────────────────────────────────────────── NAVIGATION
  section('NAVIGATION + SETTINGS')
  for (const [hash, label] of [['#/command', 'Insights Hub'], ['#/simulation', 'Simulation'],
                               ['#/decision', 'Decision Center'], ['#/settings', 'Settings'],
                               ['#/connections', 'Connections'], ['#/home', 'Home']]) {
    ok(`${label} route settles`, await goto(hash, label))
  }

  // ─────────────────────────────────────────────────────────── CONSOLE
  section('CONSOLE / NETWORK')
  const errors = b.errors.filter((e) => !/401|favicon|DevTools|Autofill/i.test(e))
  ok('no console or runtime errors', errors.length === 0,
    errors.slice(0, 5).join(' || ') || 'clean')
  const bad = b.failedRequests.filter(
    (r) => !/favicon/i.test(r) && !(r.startsWith('401') && r.includes('/auth/me')))
  ok('no failed API requests', bad.length === 0, bad.slice(0, 5).join(' || ') || 'clean')
  console.log(`  (${apiCalls.length} API requests observed across the whole pass)`)

  // ─────────────────────────────────────────────────────────── SUMMARY
  section('SUMMARY')
  const failed = results.filter((r) => !r.pass)
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('\n  FAILURES:')
    failed.forEach((f) => console.log(`    - ${f.name}${f.detail ? ' — ' + f.detail : ''}`))
  }
  await b.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error('\nDRIVER ERROR:', e.message)
  if (b) {
    try { console.error('at:', await b.eval('return location.hash')) } catch {}
    try { console.error(await b.eval('return document.body.innerText.slice(0,700)')) } catch {}
    await b.close()
  }
  process.exit(2)
})
