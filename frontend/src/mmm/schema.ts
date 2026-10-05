/** THE MMM COLUMN CONTRACT, for the upload guide and the in-browser check.
 *
 *  Mirror of backend/app/mmm/schema.py — the two must list the same columns
 *  in the same groups. The backend is the authority: it re-checks every upload
 *  and validates every row, so this file only lets the dialog say what is
 *  missing BEFORE a file is sent.
 *
 *  One daily table, taken from the reference MMM_Final_Daily_Dataset.csv
 *  (33 columns). Required: Date, Revenue, and at least one `*_Spend` column.
 *  Everything else is optional; the calendar fields are derived from Date. */

export type MmmGroup = 'core' | 'media' | 'promo' | 'calendar'
export type MmmColumnType = 'date' | 'currency' | 'flag' | 'percent' | 'text' | 'integer'

export interface MmmColumn {
  name: string
  group: MmmGroup
  type: MmmColumnType
  required: boolean
  description: string
  example: string
}

export const GROUP_LABELS: Record<MmmGroup, string> = {
  core: 'Date & revenue',
  media: 'Media spend',
  promo: 'Promotions & events',
  calendar: 'Calendar fields',
}

export const GROUP_PURPOSE: Record<MmmGroup, string> = {
  core: 'The two columns MMM cannot work without: one row per day, and what that day sold.',
  media:
    'Spend per channel per day. At least one is required; any further column ending in _Spend is read as an extra channel.',
  promo: 'What else was going on that day. Optional — the hub shows promotion and event breakdowns when these are present.',
  calendar: 'Convenience fields. Optional — when missing they are worked out from Date.',
}

export const COLUMN_TYPE_LABELS: Record<MmmColumnType, string> = {
  date: 'Date · DD-MM-YYYY',
  currency: 'Number · rupees',
  flag: '0 or 1',
  percent: 'Number · percent',
  text: 'Text',
  integer: 'Whole number',
}

/** Media channels in the reference file's column order. */
export const MEDIA_CHANNELS = [
  'TV_Spend',
  'OTT_Spend',
  'Streaming_Audio_Spend',
  'Cinema_Advertising_Spend',
  'Meta_Ads_Spend',
  'YouTube_Ads_Spend',
  'Google_Ads_Spend',
  'TikTok_Ads_Spend',
  'Billboard_Spend',
  'Transit_Advertising_Spend',
  'Airport_Advertising_Spend',
  'Newspaper_Spend',
  'Magazine_Spend',
  'Google_Search_Spend',
  'Programmatic_Display_Spend',
  'Native_Advertising_Spend',
  'Ecommerce_Ads_Spend',
  'Quick_Commerce_Ads_Spend',
  'In_Store_Digital_Ads_Spend',
  'Influencer_Marketing_Spend',
  'Creator_Content_Spend',
  'Sponsored_Content_Spend',
] as const

/** "In_Store_Digital_Ads_Spend" -> "In-Store Digital Ads" (as the backend). */
export function channelLabel(column: string): string {
  const base = column.toLowerCase().endsWith('_spend') ? column.slice(0, -'_Spend'.length) : column
  return base.replace(/_/g, ' ').trim().replace('In Store', 'In-Store').replace('Ecommerce', 'E-commerce')
}

const SPEND_EXAMPLES: Record<string, string> = {
  TV_Spend: '2981128',
  OTT_Spend: '691790',
  Meta_Ads_Spend: '1494598',
  Google_Ads_Spend: '0',
  YouTube_Ads_Spend: '406139',
}

export const MMM_COLUMNS: MmmColumn[] = [
  {
    name: 'Date',
    group: 'core',
    type: 'date',
    required: true,
    description:
      'The day the row describes. One row per day, no repeats. DD-MM-YYYY (YYYY-MM-DD and DD/MM/YYYY are also read).',
    example: '02-01-2015',
  },
  {
    name: 'Revenue',
    group: 'core',
    type: 'currency',
    required: true,
    description: 'Total sales revenue for the day, in rupees, as a plain number.',
    example: '17364174',
  },
  ...MEDIA_CHANNELS.map(
    (name): MmmColumn => ({
      name,
      group: 'media',
      type: 'currency',
      required: false,
      description: `${channelLabel(name)} spend for the day, in rupees. 0 on days the channel did not run.`,
      example: SPEND_EXAMPLES[name] ?? '0',
    }),
  ),
  { name: 'Holiday_Flag', group: 'promo', type: 'flag', required: false, description: '1 if the day is a holiday, otherwise 0.', example: '1' },
  { name: 'Trending_Flag', group: 'promo', type: 'flag', required: false, description: '1 if the brand or category was trending that day, otherwise 0.', example: '0' },
  { name: 'Promotion_Flag', group: 'promo', type: 'flag', required: false, description: '1 if a consumer promotion was live that day, otherwise 0.', example: '1' },
  { name: 'Discount_Percentage', group: 'promo', type: 'percent', required: false, description: 'Headline discount on the day, as a number (10 means 10%). 0 when no offer.', example: '10' },
  { name: 'Promotion_Type', group: 'promo', type: 'text', required: false, description: 'The offer that ran, e.g. 10% Discount or Buy3Get1. "No Offer" when none.', example: '10% Discount' },
  { name: 'Month', group: 'calendar', type: 'integer', required: false, description: 'Month number 1-12. Worked out from Date when missing.', example: '1' },
  { name: 'Quarter', group: 'calendar', type: 'text', required: false, description: 'Q1-Q4. Worked out from Date when missing.', example: 'Q1' },
  { name: 'Week_of_Year', group: 'calendar', type: 'integer', required: false, description: 'Week number of the year. Worked out from Date when missing.', example: '1' },
  { name: 'Year', group: 'calendar', type: 'integer', required: false, description: 'Calendar year. Worked out from Date when missing.', example: '2015' },
]

export const MMM_GROUPS: MmmGroup[] = ['core', 'media', 'promo', 'calendar']

export const columnsIn = (group: MmmGroup) => MMM_COLUMNS.filter((c) => c.group === group)

/** The upload rules, in the order upload problems usually happen. */
export const MMM_RULES: Array<{ title: string; body: string }> = [
  { title: 'One file, one row per day', body: 'MMM reads a single daily table. A date that appears twice is refused; uploading a new file replaces the current one.' },
  { title: 'Headers identify the columns — the file name doesn’t matter', body: 'Put the column names in row 1. Upper or lower case both work. Columns MMM does not read are ignored.' },
  { title: 'Date, Revenue and at least one _Spend column', body: 'These are required. Everything else is optional and is matched by name when present.' },
  { title: 'Write dates as DD-MM-YYYY', body: '02-01-2015 means 2 January 2015. In Excel, set the Date column to Text before saving so it keeps this format.' },
  { title: 'Keep numbers plain', body: 'No ₹ signs or units. Thousand separators are tolerated. Blank spend cells are read as 0; a blank Revenue is refused.' },
  { title: 'Flags are 0 or 1', body: 'Holiday_Flag, Trending_Flag and Promotion_Flag only accept 0 or 1.' },
  { title: 'Use CSV (UTF-8) or Excel', body: '.csv, .xlsx and .xls are accepted. For Excel files, only the first sheet is read.' },
]

/** Three real rows from the reference file — a dark day, a full-media day and
 *  a promotion day — so the template shows every kind of value. */
const TEMPLATE_ROWS: string[][] = [
  ['01-01-2015', '17696945', ...Array(22).fill('0'), '1', '0', '0', '0', 'No Offer', '1', 'Q1', '1', '2015'],
  ['02-01-2015', '17364174', '2981128', '691790', '555688', '712188', '1494598', '406139', '0', '459663', '1024566', '0', '211339', '84163', '158319', '183750', '292317', '198019', '368522', '534419', '529729', '0', '385291', '0', '1', '0', '0', '0', 'No Offer', '1', 'Q1', '1', '2015'],
  ['03-01-2015', '16351899', '607246', '496467', '77724', '0', '478653', '1133603', '1789905', '177249', '686954', '544665', '129375', '0', '82039', '398761', '180476', '407851', '627438', '189761', '0', '191182', '554482', '164818', '0', '0', '1', '10', '10% Discount', '1', 'Q1', '1', '2015'],
]

export function mmmTemplate() {
  return { headers: MMM_COLUMNS.map((c) => c.name), rows: TEMPLATE_ROWS }
}

/** The client-side twin of app/mmm/schema.py#match_header. */
export interface MmmHeaderCheck {
  media: string[]
  missingRequired: string[]
  missingOptional: string[]
  ignored: string[]
  ok: boolean
}

export function checkHeader(header: string[]): MmmHeaderCheck {
  const byName = new Map(MMM_COLUMNS.map((c) => [c.name.toLowerCase(), c]))
  const found = new Set<string>()
  const media: string[] = []
  const ignored: string[] = []
  for (const raw of header) {
    const name = raw.trim()
    if (!name) continue
    const spec = byName.get(name.toLowerCase())
    if (spec) {
      if (found.has(spec.name)) continue
      found.add(spec.name)
      if (spec.group === 'media') media.push(spec.name)
    } else if (name.toLowerCase().endsWith('_spend') && name.length > 6) {
      media.push(name)
    } else {
      ignored.push(name)
    }
  }
  const missingRequired = MMM_COLUMNS.filter((c) => c.required && !found.has(c.name)).map((c) => c.name)
  return {
    media,
    missingRequired,
    missingOptional: MMM_COLUMNS.filter(
      (c) => !c.required && c.group !== 'media' && !found.has(c.name),
    ).map((c) => c.name),
    ignored,
    ok: missingRequired.length === 0 && media.length > 0,
  }
}
