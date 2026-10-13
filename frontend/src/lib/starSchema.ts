// The six star-schema tables the platform's dashboards read, identified BY
// COLUMN HEADERS — mirrored from backend/app/star_dataset.py.
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
    'Actual_Quantity', 'Base_Price', 'Actual_Price', 'Total_Cost', 'Promotion_Cost',
  ],
  product: ['Product_id', 'Product_Name', 'Brand', 'Category', 'Size'],
  geo_store: ['Store_Id', 'Channel_Id', 'Retailer', 'Region', 'State', 'City', 'Tier'],
  channel: ['Channel_Id', 'Channel_Name', 'Channel_Type'],
  promotion: ['Promotion_Id', 'Promotion_Name', 'Promotion_Type', 'Promotion_Description'],
  date: ['Date', 'Year', 'Month', 'Week'],
}

// Columns the loader reads WHEN PRESENT. Never required -- a file without them
// is accepted and the platform works without them.
export const OPTIONAL_COLUMNS: Record<StarRole, string[]> = {
  fact: ['Base_Quantity'],
  product: [],
  geo_store: ['Distributor_Name'],
  channel: ['Schedule'],
  promotion: [],
  date: [],
}

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
      return {
        role,
        missingColumns: ROLE_COLUMNS[role].filter((c) => !present.has(c.toLowerCase())),
      }
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
  /** True when the header could not be read here (a workbook). */
  undetermined: boolean
}

export async function classifyFiles(files: File[]): Promise<ClassifiedFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const header = await readHeader(file)
      if (!header.length) return { file, role: null, missingColumns: [], undetermined: true }
      const { role, missingColumns } = matchHeader(header)
      return { file, role, missingColumns, undetermined: false }
    }),
  )
}
