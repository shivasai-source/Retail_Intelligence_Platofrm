import {
  siAirtable,
  siBox,
  siClickhouse,
  siDatabricks,
  siDropbox,
  siElasticsearch,
  siGooglebigquery,
  siGoogledrive,
  siGooglesheets,
  siHubspot,
  siJira,
  siMongodb,
  siMysql,
  siNotion,
  siPostgresql,
  siSnowflake,
} from 'simple-icons'

// Provider logos for the connector catalog, ported from the connector-template's
// components/connector-logo.tsx.
//
// Brand marks come from `simple-icons`, which ships the official path and hex
// for each brand. Amazon, Microsoft and Salesforce marks were removed from that
// package for trademark reasons, so those are compact in-house glyphs drawn in
// the provider's brand colour rather than their registered logo.
//
// The `fill` here is a presentational SVG attribute carrying brand identity, the
// one place in this UI that steps outside the design tokens — which is the point
// of a logo. Everything around it (chip, border, background) stays on the system.
//
// THE CHIP IS WHITE IN BOTH THEMES. Several of these marks are near-black
// (Notion) or very dark (Elasticsearch), and they disappear on a dark card. A
// brand mark sitting on its own light plate is the normal treatment and the only
// one that stays legible when the theme flips.

interface Brand {
  hex: string
  /** One or more 24×24 path definitions. */
  paths: string[]
}

const brand = (icon: { hex: string; path: string }, hexOverride?: string): Brand => ({
  hex: `#${(hexOverride ?? icon.hex).replace(/^#/, '')}`,
  paths: [icon.path],
})

/* ---------------------------------------------------------------- glyphs for
   brands simple-icons no longer ships. Simplified, not official marks. */

const BUCKET = ['M2.8 3h18.4l-1.9 16.3A3 3 0 0 1 16.3 22H7.7a3 3 0 0 1-3-2.7L2.8 3Zm2.4 2 .4 3.2h12.8L18.8 5H5.2Z']

const CYLINDER = [
  'M12 2C7.6 2 4 3.34 4 5s3.6 3 8 3 8-1.34 8-3-3.6-3-8-3Z',
  'M20 8.4c-1.7 1.2-4.7 1.9-8 1.9s-6.3-.7-8-1.9V12c0 1.66 3.6 3 8 3s8-1.34 8-3V8.4Z',
  'M20 15c-1.7 1.2-4.7 1.9-8 1.9S5.7 16.2 4 15v4c0 1.66 3.6 3 8 3s8-1.34 8-3v-4Z',
]

const CLOUD = ['M10.6 5.5a5.4 5.4 0 0 1 5 3.4 4 4 0 0 1 4.3 3.6A3.4 3.4 0 0 1 18.9 19H6.1a4.5 4.5 0 0 1-.7-8.9 5.4 5.4 0 0 1 5.2-4.6Z']

const AZURE_A = ['M13.1 3 6.4 17.4H2.1L8.8 3h4.3Z', 'M14.3 6.2 22 20.9H8.5l7.9-1.5-3.6-4.3 1.5-8.9Z']

const SERVER = [
  'M3 4h18a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 2v2h2V6H5Z',
  'M3 14h18a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm2 2v2h2v-2H5Z',
]

const FOLDER = ['M3 5a2 2 0 0 1 2-2h4.6l2 2.4H19a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z']

/** A spreadsheet grid — a header band over four cells. */
const SHEET = [
  'M3 4.5A1.5 1.5 0 0 1 4.5 3h15A1.5 1.5 0 0 1 21 4.5V7H3V4.5Z',
  'M3 9h7.2v4.2H3V9Zm9.2 0H21v4.2h-8.8V9Z',
  'M3 15.2h7.2v4.3A1.5 1.5 0 0 1 8.7 21H4.5A1.5 1.5 0 0 1 3 19.5v-4.3Zm9.2 0H21v4.3A1.5 1.5 0 0 1 19.5 21h-5.8a1.5 1.5 0 0 1-1.5-1.5v-4.3Z',
]

/** Three ascending columns. */
const BARS = ['M3 13h4.2v8H3z', 'M9.9 8h4.2v13H9.9z', 'M16.8 3H21v18h-4.2z']

/* ---------------------------------------------------------------- registry */

const LOGOS: Record<string, Brand> = {
  // simple-icons brands
  snowflake: brand(siSnowflake),
  // simple-icons ships PostgreSQL as royal blue (#4169E1); the elephant's own
  // brand colour is the darker slate blue below, which also reads better as a
  // small mark on white.
  postgres: brand(siPostgresql, '336791'),
  mysql: brand(siMysql),
  gdrive: brand(siGoogledrive),
  dropbox: brand(siDropbox),
  box: brand(siBox),
  bigquery: brand(siGooglebigquery),
  databricks: brand(siDatabricks),
  mongodb: brand(siMongodb),
  // ClickHouse yellow fails contrast on a white chip; darkened one step.
  clickhouse: brand(siClickhouse, 'B38F00'),
  elasticsearch: brand(siElasticsearch),
  gsheets: brand(siGooglesheets),
  airtable: brand(siAirtable),
  hubspot: brand(siHubspot),
  notion: brand(siNotion),
  jira: brand(siJira),
  // GCS ships a pale tint (#AECBFA) that is unreadable on white; using the
  // Google Cloud blue the product is branded under instead.
  gcs: { hex: '#4285F4', paths: [siGooglebigquery.path] },

  // in-house glyphs
  s3: { hex: '#569A31', paths: BUCKET },
  redshift: { hex: '#8C4FFF', paths: CYLINDER },
  sqlserver: { hex: '#CC2927', paths: CYLINDER },
  'azure-blob': { hex: '#0078D4', paths: AZURE_A },
  onedrive: { hex: '#0078D4', paths: CLOUD },
  salesforce: { hex: '#00A1E0', paths: CLOUD },
  sftp: { hex: '#475569', paths: SERVER },
  'local-fs': { hex: '#475569', paths: FOLDER },
  excel: { hex: '#217346', paths: SHEET },
  // Power BI's own yellow (#F2C811) fails contrast on a white chip, the same
  // problem the template solved for ClickHouse; darkened the same way.
  powerbi: { hex: '#B08900', paths: BARS },
}

export function ConnectorLogo({
  connectorId,
  label,
  mark,
  size = 'default',
  className = '',
}: {
  connectorId: string
  label: string
  /** Two-letter fallback when a connector has no logo registered. */
  mark: string
  size?: 'default' | 'lg'
  className?: string
}) {
  const logo = LOGOS[connectorId]
  const chip = [
    'grid shrink-0 place-items-center rounded-[10px] border border-border-subtle bg-white',
    size === 'lg' ? 'h-12 w-12' : 'h-11 w-11',
    className,
  ].join(' ')

  if (!logo) {
    return <span className={`${chip} text-xs font-bold tracking-tight text-[#475569]`}>{mark}</span>
  }

  return (
    <span className={chip}>
      <svg
        viewBox="0 0 24 24"
        // Fill ~65% of the chip: brand marks are drawn to the edge of their
        // viewBox, so a small glyph in a large chip reads as faint and lost.
        className={size === 'lg' ? 'h-8 w-8' : 'h-[26px] w-[26px]'}
        fill={logo.hex}
        role="img"
        aria-label={`${label} logo`}
      >
        {logo.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  )
}
