// The star-schema tables the platform's dashboards read, identified BY COLUMN
// HEADERS — mirrored from backend/app/star_dataset.py.
//
// THREE REQUIRED, THREE DERIVED. The sales fact, dim_product and dim_geo_store
// must be uploaded. dim_channel, dim_promotion and dim_date are accepted when a
// source has them and reconstructed by the loader when it does not — a calendar
// is arithmetic, channel names live on the store master, and an offer's name
// and mechanic ride on the fact row. A three-file upload is therefore the
// ordinary shape, not a partial one.
//
// Filenames are never consulted. An Excel export is called `Book1.xlsx` or
// `export (3).csv`, which says nothing about which table it holds; the column
// names say it unambiguously. This module reads just the header line of each
// selected file in the browser so the upload modal can label files and name
// what is still missing without a round trip.
//
// The backend re-decides authoritatively on upload (and via POST
// /api/datasets/star/inspect). Keep ROLE_DISCRIMINATORS and ROLE_COLUMNS in
// step with star_dataset.py — they are the same contract written twice.
import type { StarRole } from '../types/dataset'

export const STAR_ROLE_LABELS: Record<StarRole, string> = {
  fact: 'Sales fact table',
  product: 'Product dimension',
  geo_store: 'Store / geography dimension',
  channel: 'Channel dimension',
  promotion: 'Promotion dimension',
  date: 'Date dimension',
}

// Every column each table MUST carry. Only what a source system records: the
// sales file's week, month and channel come from the date and store files, and
// both revenues are units x price.
export const ROLE_COLUMNS: Record<StarRole, string[]> = {
  fact: [
    'Date', 'Product_id', 'Store_Id', 'Promotion_Id',
    'Actual_Quantity', 'Base_Price', 'Actual_Price',
  ],
  product: ['Product_id', 'Product_Name', 'Brand', 'Category', 'Size'],
  geo_store: ['Store_Id', 'Channel_Id', 'Retailer', 'Region', 'State', 'City', 'Tier'],
  channel: ['Channel_Id', 'Channel_Name', 'Channel_Type'],
  promotion: ['Promotion_Id', 'Promotion_Name', 'Promotion_Type', 'Promotion_Description'],
  date: ['Date', 'Year', 'Month', 'Week'],
}

// The tables an upload cannot do without, and the ones the loader derives when
// they are absent. Display order.
export const REQUIRED_ROLES: StarRole[] = ['fact', 'product', 'geo_store']
export const DERIVABLE_ROLES: StarRole[] = ['channel', 'promotion', 'date']

// Groups of interchangeable columns, each satisfied by ANY one member. Cost of
// goods is the only one: a source states it for the whole line (Total_Cost) or
// per unit (CP, what a pricing master holds), and the loader multiplies the
// latter by the fact's own quantity.
export const EITHER_COLUMNS: Partial<Record<StarRole, string[][]>> = {
  fact: [['Total_Cost', 'CP']],
}

// Columns the loader reads WHEN PRESENT. Never required -- a file without them
// is accepted and the platform works without them.
export const OPTIONAL_COLUMNS: Record<StarRole, string[]> = {
  fact: ['Base_Quantity', 'Promotion_Name', 'Promotion_Type', 'Promotion_Cost'],
  product: [],
  geo_store: ['Distributor_Name', 'Country', 'Channel_Name', 'Channel_Type', 'Schedule'],
  channel: ['Schedule'],
  promotion: [],
  date: ['Quarter', 'Day'],
}

// What a table must carry to stand in for a dimension nobody uploaded:
// [absent role, the role that must cover for it, the columns it needs].
// A calendar needs nothing — it is derived from the fact's Date column.
export const CROSS_FILE_RULES: [StarRole, StarRole, string[]][] = [
  ['channel', 'geo_store', ['Channel_Name']],
  ['promotion', 'fact', ['Promotion_Name', 'Promotion_Type']],
]

// Which columns tell each table apart from the other five. Order matters where
// they overlap: the fact table also carries Product_id/Store_Id, so it is
// tested first on its measures; dim_geo_store carries Channel_Id, so it is
// tested before dim_channel.
const ROLE_DISCRIMINATORS: [StarRole, string[]][] = [
  ['fact', ['Actual_Quantity', 'Promotion_Cost']],
  ['geo_store', ['Store_Id', 'Retailer']],
  ['product', ['Product_id', 'Product_Name']],
  ['promotion', ['Promotion_Id', 'Promotion_Name']],
  ['channel', ['Channel_Id', 'Channel_Name']],
  ['date', ['Date', 'Year', 'Week']],
]

export const STAR_ROLES = Object.keys(ROLE_COLUMNS) as StarRole[]

export interface HeaderMatch {
  role: StarRole | null
  /** Required columns the file does not have. Empty when it is usable. */
  missingColumns: string[]
}

/** Match one header row to a table. Pure — the file reading is separate. */
export function matchHeader(header: string[]): HeaderMatch {
  const present = new Set(header.map((h) => h.trim().toLowerCase()).filter(Boolean))
  for (const [role, discriminators] of ROLE_DISCRIMINATORS) {
    if (discriminators.every((c) => present.has(c.toLowerCase()))) {
      const missingColumns = ROLE_COLUMNS[role].filter((c) => !present.has(c.toLowerCase()))
      // An interchangeable group is missing only when NONE of its members is
      // there, and is then named as the choice it is ('Total_Cost or CP').
      for (const group of EITHER_COLUMNS[role] ?? []) {
        if (!group.some((c) => present.has(c.toLowerCase()))) missingColumns.push(group.join(' or '))
      }
      return { role, missingColumns }
    }
  }
  return { role: null, missingColumns: [] }
}

// Split a CSV header line on commas that aren't inside quotes, so a quoted
// column name containing a comma stays one field.
function splitCsvHeader(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/**
 * Read one file's header row in the browser.
 *
 * Only the first 64 KB is read for a CSV, so selecting a 21 MB fact table
 * doesn't pull it all into memory just to label it. Returns [] for a workbook:
 * .xlsx is a zip whose directory sits at the end of the file, so it cannot be
 * parsed from a prefix without a library — those are labelled by the backend's
 * inspect endpoint instead.
 */
export async function readHeader(file: File): Promise<string[]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) return []
  try {
    const text = await file.slice(0, 64 * 1024).text()
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
    // Strip a UTF-8 BOM — dim_promotion carries one, and it would otherwise
    // corrupt the first column name.
    return splitCsvHeader(firstLine.replace(/^﻿/, ''))
  } catch {
    return []
  }
}

export interface ClassifiedFile {
  file: File
  role: StarRole | null
  missingColumns: string[]
  /** Every column the file carries. Needed for the CROSS_FILE_RULES checks,
   *  which are about the selection as a whole rather than one file. */
  columns: string[]
  /** True when the header could not be read here (a workbook). */
  undetermined: boolean
}

export async function classifyFiles(files: File[]): Promise<ClassifiedFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const header = await readHeader(file)
      if (!header.length) {
        return { file, role: null, missingColumns: [], columns: [], undetermined: true }
      }
      const { role, missingColumns } = matchHeader(header)
      return { file, role, missingColumns, columns: header, undetermined: false }
    }),
  )
}

/**
 * Re-state a selection in the light of a mapping the user has settled.
 *
 * WHY THIS IS NEEDED. The browser labels files by matching their headers
 * against our own column names, so a client's export — `UnitsSold`, `TxnDate`,
 * `MRP` — comes back with no role and looks like a wrong-file slip. Once the
 * mapping screen has established what those columns are, the modal has to stop
 * saying so: this folds the mapping back in, so a mapped file reads as the
 * table it is and the upload button stops being disabled over a problem that
 * has been answered.
 *
 * The mapping is `StarColumnMapping`-shaped (filename, role, canonical ->
 * that file's column), carrying the WHOLE picture rather than only the user's
 * edits — see ColumnMappingPanel's `effective`. The backend re-decides
 * authoritatively on upload either way; this is about what the screen says.
 */
export function withMapping(
  classified: ClassifiedFile[],
  mapping: { filename: string; role: StarRole | null; columns: Record<string, string> }[],
): ClassifiedFile[] {
  const byName = new Map(mapping.map((m) => [m.filename, m]))
  return classified.map((c) => {
    const settled = byName.get(c.file.name)
    if (!settled?.role) return c
    const mapped = new Set(Object.keys(settled.columns).filter((k) => settled.columns[k]))
    const groups = EITHER_COLUMNS[settled.role] ?? []
    const inGroup = new Set(groups.flat())
    const missingColumns = [
      ...ROLE_COLUMNS[settled.role].filter((col) => !inGroup.has(col) && !mapped.has(col)),
      ...groups.filter((g) => !g.some((m) => mapped.has(m))).map((g) => g.join(' or ')),
    ]
    return {
      ...c,
      role: settled.role,
      missingColumns,
      // The columns the loader will SEE once the rename is applied, so the
      // CROSS_FILE_RULES check below reads a mapped file correctly: a store
      // file whose channel name arrives as `ChannelDesc` does carry
      // Channel_Name by the time anything reads it.
      columns: [...c.columns, ...mapped],
      undetermined: false,
    }
  })
}

/**
 * Leaving a derivable dimension out is fine; leaving it out when nothing
 * stands in for it is not. Returns one sentence per unmet rule, so the upload
 * modal can say what to add before the request is made rather than after the
 * backend refuses it. The backend re-checks authoritatively either way.
 */
export function crossFileProblems(classified: ClassifiedFile[]): string[] {
  const usable = new Map<StarRole, ClassifiedFile>()
  for (const c of classified) {
    if (c.role && !c.missingColumns.length) usable.set(c.role, c)
  }
  const problems: string[] = []
  for (const [absent, carrier, needed] of CROSS_FILE_RULES) {
    const cover = usable.get(carrier)
    if (usable.has(absent) || !cover) continue
    const have = new Set(cover.columns.map((h) => h.trim().toLowerCase()))
    const lacking = needed.filter((c) => !have.has(c.toLowerCase()))
    if (lacking.length) {
      problems.push(
        `No ${STAR_ROLE_LABELS[absent].toLowerCase()} was selected, so ` +
          `${STAR_ROLE_LABELS[carrier].toLowerCase()} must carry ` +
          `${lacking.length === 1 ? 'column' : 'columns'} ${lacking.join(', ')}.`,
      )
    }
  }
  return problems
}
