// Lucide-style line icon set, ported verbatim from the vanilla app's js/icons.js.
// Each entry is the inner SVG markup (paths/shapes only); <Icon name="..."/> wraps it
// in the shared <svg> shell. Content is static/trusted, never derived from user input.
export const ICON_PATHS = {
  // ====== Navigation
  home: `<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/>`,
  investigations: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  promotions: `<path d="M20 12V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4"/><path d="M2 12h20v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/><path d="M12 6v14M8 6a2 2 0 0 1 0-4c2 0 4 4 4 4M16 6a2 2 0 0 0 0-4c-2 0-4 4-4 4"/>`,
  dashboards: `<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>`,
  simulations: `<path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/><circle cx="12" cy="12" r="3"/>`,
  marketplace: `<path d="M3 9 4 3h16l1 6"/><path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M3 9h18"/><path d="M9 21v-6h6v6"/>`,
  alerts: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  knowledge: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`,
  admin: `<circle cx="12" cy="8" r="3.5"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="m18 7 .8 1.6L20.5 9l-1.3 1L19.5 12l-1.5-.8L16.5 12l.3-2-1.3-1 1.7-.4z"/>`,

  // ====== Top bar
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.7.5-2 1-2 2.5"/><circle cx="11.5" cy="17.5" r=".5" fill="currentColor"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  filter: `<path d="M3 5h18l-7 8v6l-4-2v-4z"/>`,
  download: `<path d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16"/>`,
  edit: `<path d="M14 4 18 8l-10 10H4v-4z"/><path d="m13 5 4 4"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  chevronRight: `<path d="m9 6 6 6-6 6"/>`,
  chevronLeft: `<path d="m15 6-6 6 6 6"/>`,
  arrowRight: `<path d="M5 12h14M13 5l7 7-7 7"/>`,
  arrowUp: `<path d="M12 19V5M5 12l7-7 7 7"/>`,
  arrowDown: `<path d="M12 5v14M5 12l7 7 7-7"/>`,
  arrowUpRight: `<path d="M7 17 17 7M9 7h8v8"/>`,
  arrowTransform: `<path d="M3 7h13l-3-3M21 17H8l3 3"/>`,
  check: `<path d="M5 12.5 10 17 19 7"/>`,
  checkCircle: `<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v5h1"/>`,
  sparkles: `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>`,
  cpu: `<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>`,
  zap: `<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`,
  // The Analyst's send control and its avatar glyph.
  send: `<path d="M21.5 2.5 11 13"/><path d="M21.5 2.5 15 21l-4-8-8-4z"/>`,
  analyst: `<rect x="3.5" y="7" width="17" height="12" rx="3"/><path d="M12 7V3.8"/><circle cx="12" cy="2.9" r="1.3"/><path d="M8.6 12.4v1.6M15.4 12.4v1.6"/><path d="M1.6 12.2v2.6M22.4 12.2v2.6"/>`,
  target: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>`,
  trending: `<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>`,
  trendingDown: `<path d="m3 7 6 6 4-4 8 8"/><path d="M14 17h7v-7"/>`,
  warning: `<path d="m12 3 10 18H2z"/><path d="M12 10v5M12 18v.01"/>`,
  alertTriangle: `<path d="m12 3 10 18H2z"/><path d="M12 10v5M12 18v.01"/>`,
  package: `<path d="m3 7 9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>`,
  layers: `<path d="m12 3 10 5-10 5L2 8z"/><path d="m2 13 10 5 10-5M2 18l10 5 10-5"/>`,
  flow: `<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M9 6h6M9 18h6M6 9v6M18 9v6"/>`,
  grid: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  pieChart: `<path d="M21 12A9 9 0 1 1 12 3v9z"/>`,
  barChart: `<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7"/><rect x="12" y="7" width="3" height="11"/><rect x="17" y="14" width="3" height="4"/>`,
  database: `<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>`,
  shoppingCart: `<circle cx="9" cy="21" r="1.5"/><circle cx="18" cy="21" r="1.5"/><path d="M3 3h2l3 13h11l3-9H6"/>`,
  file: `<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  calendar: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>`,
  users: `<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0"/><circle cx="17" cy="7" r="3"/><path d="M22 19a5 5 0 0 0-8-4"/>`,
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.6 3.75"/><path d="M6.6 6.6A17.6 17.6 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.4-1.1"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  book: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`,

  // Module-specific
  uplift: `<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>`,
  variance: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/>`,
  cannib: `<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>`,
  retailer: `<circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/>`,
  inventory: `<rect x="3" y="7" width="18" height="13" rx="1"/><path d="M3 11h18M9 7V4h6v3"/>`,
  timing: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="M12 13v3l2 1"/>`,
  pricing: `<path d="M20 13.5 13.5 20a2 2 0 0 1-2.8 0L3 12.3V4h8.3l8.7 8.7a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="9" r="1.5" fill="currentColor"/>`,
  history: `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>`,
  shield: `<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`,
  lock: `<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>`,
  play: `<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>`,
  expand: `<path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6"/>`,
  zoomIn: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>`,
  zoomOut: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>`,
  fullscreen: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
  more: `<circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>`,
  workspace: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  flame: `<path d="M12 2c0 5 5 6 5 12a5 5 0 0 1-10 0c0-2 1-4 3-4-1 3 1 5 2 5 0-3-3-5-3-9 0-2 1-3 3-4z"/>`,
  tag: `<path d="M20 12 13 4H4v9l8 8z"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>`,

  // Not in the vanilla app's icon set — added for the responsive Sidebar drawer toggle
  // (Phase 4/5 never needed a mobile nav; this is a genuinely new UI affordance).
  menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,

  // Inline one-offs from specific pages (e.g. js/pages/command.js's refresh button,
  // which doesn't go through the shared ICONS map in the vanilla app either).
  // Theme toggle. Lucide 'sun' and 'moon', same line style as the rest.
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
  moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>`,
  refresh: `<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>`,

  // KPI tile icons
  wallet: `<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M21 12h-5a2 2 0 0 0 0 4h5a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z"/>`,
  coins: `<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>`,
  gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
} as const;

export type IconName = keyof typeof ICON_PATHS;
