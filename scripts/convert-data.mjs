// One-off Phase 1 migration script: loads the vanilla app's data.js in a
// Node context, splits window.DATA into domain JSON files, and drops the
// two things that don't belong in JSON:
//   - lever.fmt (an arrow function) -> replaced with a `decimals` number,
//     detected by actually calling fmt(3.14159) and counting the digits.
//   - the window.getActiveInvType() etc. localStorage helpers at the
//     bottom of the file -> these aren't data at all, they're client
//     session state; they become a Zustand store on the frontend instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'TPO_Sushane_Frontend', 'TPO-New-Frontend-tpo-focused', 'js', 'data.js');
const OUT = path.join(__dirname, '..', 'backend', 'app', 'data');

const src = fs.readFileSync(SRC, 'utf-8');

// Minimal shim: data.js does `window.DATA = {...}`, `DATA.intelligenceAnswers = {...}`,
// then defines window.getActiveInvType etc as functions (harmless to evaluate,
// we just never call them — they touch a `localStorage` we don't provide).
const sandbox = { localStorage: { getItem: () => null, setItem: () => {} } };
sandbox.window = sandbox; // so `window.DATA = ...` and bare `DATA` refer to the same object, like in a real browser
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const DATA = sandbox.DATA;

function detectDecimals(fmt) {
  // Read the formatter's own source rather than probing it with a test
  // value — v => `${v.toFixed(1)}` unambiguously means 1 decimal, but
  // v => `${v}` (no rounding at all) would misreport as "however many
  // decimals happened to be in whatever probe value we picked," which
  // silently broke on levers like duration/spend that only ever hold
  // integers in practice (their fmt is a no-op, correctly 0 decimals).
  if (typeof fmt !== 'function') return 0;
  const m = fmt.toString().match(/\.toFixed\((\d+)\)/);
  return m ? Number(m[1]) : 0;
}

function stripLeverFns(levers) {
  return levers.map(({ fmt, ...rest }) => ({ ...rest, decimals: detectDecimals(fmt) }));
}

function writeJson(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', name);
}

// ---- nav + identity ----
writeJson('nav.json', { navMain: DATA.navMain, navSecondary: DATA.navSecondary });
writeJson('user.json', DATA.user);
writeJson('focus.json', DATA.focus);

// ---- insights hub ----
writeJson('command.json', DATA.command);

// ---- investigation types (the 4 archetypes) ----
writeJson('investigation-types.json', DATA.investigationTypes);

// ---- investigations: legacy single block + per-type orchestrations ----
writeJson('investigations.json', {
  legacyDefault: DATA.investigation,
  orchestrations: DATA.investigationOrchestrations,
});

// ---- per-type intelligence / simulation / decision (the real per-type data) ----
const pagesByType = {};
for (const [type, block] of Object.entries(DATA.pagesByType)) {
  pagesByType[type] = {
    intelligence: block.intelligence,
    simulation: {
      ...block.simulation,
      levers: stripLeverFns(block.simulation.levers),
    },
    decision: block.decision,
  };
}
writeJson('pages-by-type.json', pagesByType);

// ---- top-level default intelligence/simulation/decision (pre-multi-type baseline) ----
writeJson('intelligence.json', DATA.intelligence);
writeJson('simulation.json', { ...DATA.simulation, levers: stripLeverFns(DATA.simulation.levers) });
writeJson('decision.json', DATA.decision);

// ---- AI synthesis text per type ----
writeJson('intelligence-answers.json', DATA.intelligenceAnswers);

// ---- secondary pages ----
writeJson('calendar.json', DATA.calendar);
writeJson('reports.json', DATA.reports);
writeJson('connections.json', DATA.connections);
writeJson('ai-watch.json', DATA.aiWatch);
writeJson('recommendations.json', DATA.smartRecommendations);
writeJson('settings.json', DATA.settings);

console.log('\nDone.', Object.keys(DATA).length, 'top-level DATA keys processed.');
