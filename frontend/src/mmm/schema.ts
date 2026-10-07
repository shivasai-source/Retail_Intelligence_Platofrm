/** THE MMM COLUMN CONTRACT, for the upload guide and the in-browser check.
 *
 *  Mirror of backend/app/mmm/schema.py — the two must list the same columns
 *  in the same groups. The backend is the authority: it re-checks every upload
 *  and validates every row, so this file only lets the dialog say what is
 *  missing BEFORE a file is sent.
 *
 *  One daily table, taken from the reference MMM_Final_Daily_Dataset.csv
 *  (41 columns). Required: Date, Revenue, and at least one `*_Spend` column.
 *  Everything else is optional; the calendar fields are derived from Date.
 *  The channel totals (Channel_*_Spend, Total_Spend) are sums of the
 *  sub-channels: recognised and checked, never counted as further channels. */

export type MmmGroup = 'core' | 'media' | 'rollup' | 'promo' | 'calendar'
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
  rollup: 'Channel totals',
  promo: 'Promotions & events',
  calendar: 'Calendar fields',
}

export const GROUP_PURPOSE: Record<MmmGroup, string> = {
  core: 'The two columns MMM cannot work without: one row per day, and what that day sold.',
  media:
    'Spend per channel per day. At least one is required; any further column ending in _Spend is read as an extra channel.',
  rollup:
    'Spend per channel (each the sum of its sub-channels) and the day’s total. Optional — checked against the sub-channels, which every MMM figure is computed from, so a total is never counted twice.',
  promo: 'What else was going on that day. Optional — the hub shows promotion and event breakdowns, and the baseline uses the three flags, when these are present.',
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

/** The channel totals — one per channel family, then the day's total. */
export const CHANNEL_TOTALS: Array<[string, string]> = [
  ['Channel_Broadcast_Video_Spend', 'Broadcast & Video'],
  ['Channel_Social_Video_Platforms_Spend', 'Social & Video Platforms'],
  ['Channel_Search_Programmatic_Spend', 'Search & Programmatic'],
  ['Channel_Out_of_Home_Spend', 'Out of Home'],
  ['Channel_Print_Spend', 'Print'],
  ['Channel_Commerce_Retail_Media_Spend', 'Commerce & Retail Media'],
  ['Channel_Influencer_Content_Spend', 'Influencer & Content'],
]
export const TOTAL_SPEND = 'Total_Spend'

const ROLLUP_EXAMPLES: Record<string, string> = {
  'Broadcast & Video': '280460',
  'Social & Video Platforms': '2171308',
  'Search & Programmatic': '2652117',
  'Out of Home': '3299010',
  'Print': '2128133',
  'Commerce & Retail Media': '740600',
  'Influencer & Content': '0',
}

/** A channel total or Total_Spend — any Channel_*_Spend, listed or not. */
export function isRollup(column: string): boolean {
  const name = column.trim().toLowerCase()
  return name === 'total_spend' || (name.startsWith('channel_') && name.endsWith('_spend') && name.length > 14)
}

/** Earlier names of the event flags, read as the current ones. */
const ALIASES: Record<string, string> = { holiday_flag: 'Festival_Flag', trending_flag: 'Seasonal_Flag' }

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
  ...CHANNEL_TOTALS.map(
    ([name, family]): MmmColumn => ({
      name,
      group: 'rollup',
      type: 'currency',
      required: false,
      description: `${family} spend for the day — the sum of its sub-channels.`,
      example: ROLLUP_EXAMPLES[family] ?? '0',
    }),
  ),
  { name: TOTAL_SPEND, group: 'rollup', type: 'currency', required: false, description: 'All media spend for the day — the sum of every sub-channel.', example: '11271628' },
  { name: 'Festival_Flag', group: 'promo', type: 'flag', required: false, description: '1 if the day falls in a festival period, otherwise 0. (Holiday_Flag is also read.)', example: '1' },
  { name: 'Seasonal_Flag', group: 'promo', type: 'flag', required: false, description: '1 if the day is in a seasonal demand peak, otherwise 0. (Trending_Flag is also read.)', example: '0' },
  { name: 'Promotion_Flag', group: 'promo', type: 'flag', required: false, description: '1 if a consumer promotion was live that day, otherwise 0.', example: '1' },
  { name: 'Discount_Percentage', group: 'promo', type: 'percent', required: false, description: 'Headline discount on the day, as a number (10 means 10%). 0 when no offer.', example: '10' },
  { name: 'Promotion_Type', group: 'promo', type: 'text', required: false, description: 'The offer that ran, e.g. 10% Discount or Buy3Get1. "No Offer" when none.', example: '10% Discount' },
  { name: 'Month', group: 'calendar', type: 'integer', required: false, description: 'Month number 1-12. Worked out from Date when missing.', example: '1' },
  { name: 'Quarter', group: 'calendar', type: 'text', required: false, description: 'Q1-Q4. Worked out from Date when missing.', example: 'Q1' },
  { name: 'Week_of_Year', group: 'calendar', type: 'integer', required: false, description: 'Week number of the year. Worked out from Date when missing.', example: '1' },
  { name: 'Year', group: 'calendar', type: 'integer', required: false, description: 'Calendar year. Worked out from Date when missing.', example: '2015' },
]

export const MMM_GROUPS: MmmGroup[] = ['core', 'media', 'rollup', 'promo', 'calendar']

export const columnsIn = (group: MmmGroup) => MMM_COLUMNS.filter((c) => c.group === group)

/** The upload rules, in the order upload problems usually happen. */
export const MMM_RULES: Array<{ title: string; body: string }> = [
  { title: 'One file, one row per day', body: 'MMM reads a single daily table. A date that appears twice is refused; uploading a new file replaces the current one.' },
  { title: 'Headers identify the columns — the file name doesn’t matter', body: 'Put the column names in row 1. Upper or lower case both work. Columns MMM does not read are ignored.' },
  { title: 'Date, Revenue and at least one _Spend column', body: 'These are required. Everything else is optional and is matched by name when present.' },
  { title: 'Write dates as DD-MM-YYYY', body: '02-01-2015 means 2 January 2015. In Excel, set the Date column to Text before saving so it keeps this format.' },
  { title: 'Keep numbers plain', body: 'No ₹ signs or units. Thousand separators are tolerated. Blank spend cells are read as 0; a blank Revenue is refused.' },
  { title: 'Flags are 0 or 1', body: 'Festival_Flag, Seasonal_Flag and Promotion_Flag only accept 0 or 1.' },
  { title: 'Channel totals must add up', body: 'Each Channel_*_Spend and Total_Spend should equal the sum of its sub-channels. A mismatch is reported; MMM always computes from the sub-channels.' },
  { title: 'Use CSV (UTF-8) or Excel', body: '.csv, .xlsx and .xls are accepted. For Excel files, only the first sheet is read.' },
]

/** Three real rows from the reference file — a dark day, a media day and a
 *  promotion day — so the template shows every kind of value. */
const TEMPLATE_ROWS: string[][] = [
  ['01-01-2015', '17696945', ...Array(30).fill('0'), '1', '0', '0', '0', 'No Offer', '1', 'Q1', '1', '2015'],
  ['02-01-2015', '17364174', '0', '0', '280460', '0', '1368385', '802923', '915602', '0', '2092093', '701170', '505747', '0', '2128133', '1122666', '457124', '156725', '479463', '0', '261137', '0', '0', '0', '280460', '2171308', '2652117', '3299010', '2128133', '740600', '0', '11271628', '1', '0', '0', '0', 'No Offer', '1', 'Q1', '1', '2015'],
  ['03-01-2015', '16351899', '0', '0', '176106', '0', '892388', '578722', '948091', '0', '1344381', '1092974', '424793', '0', '1632385', '895138', '472627', '99871', '252982', '0', '108191', '0', '0', '0', '176106', '1471110', '2415727', '2862148', '1632385', '361173', '0', '8918649', '0', '0', '1', '10', '10% Discount', '1', 'Q1', '1', '2015'],
]

export function mmmTemplate() {
  return { headers: MMM_COLUMNS.map((c) => c.name), rows: TEMPLATE_ROWS }
}

/** The client-side twin of app/mmm/schema.py#match_header. */
export interface MmmHeaderCheck {
  media: string[]
  /** Channel totals present — recognised, never counted as channels. */
  rollups: string[]
  /** Promotion & event columns present. */
  promo: string[]
  missingRequired: string[]
  missingOptional: string[]
  ignored: string[]
  ok: boolean
}

export function checkHeader(header: string[]): MmmHeaderCheck {
  const byName = new Map(MMM_COLUMNS.map((c) => [c.name.toLowerCase(), c]))
  const found = new Set<string>()
  const media: string[] = []
  const rollups: string[] = []
  const ignored: string[] = []
  for (const raw of header) {
    const name = raw.trim()
    if (!name) continue
    const lower = name.toLowerCase()
    const spec = byName.get(lower) ?? byName.get((ALIASES[lower] ?? '').toLowerCase())
    if (spec) {
      if (found.has(spec.name)) continue
      found.add(spec.name)
      if (spec.group === 'media') media.push(spec.name)
      if (spec.group === 'rollup') rollups.push(spec.name)
    } else if (isRollup(name)) {
      rollups.push(name)
    } else if (lower.endsWith('_spend') && name.length > 6) {
      media.push(name)
    } else {
      ignored.push(name)
    }
  }
  const missingRequired = MMM_COLUMNS.filter((c) => c.required && !found.has(c.name)).map((c) => c.name)
  return {
    media,
    rollups,
    promo: MMM_COLUMNS.filter((c) => c.group === 'promo' && found.has(c.name)).map((c) => c.name),
    missingRequired,
    // Channel totals are a convenience, so their absence is not reported.
    missingOptional: MMM_COLUMNS.filter(
      (c) => !c.required && c.group !== 'media' && c.group !== 'rollup' && !found.has(c.name),
    ).map((c) => c.name),
    ignored,
    ok: missingRequired.length === 0 && media.length > 0,
  }
}
