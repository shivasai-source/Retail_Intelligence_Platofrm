// What a user needs to know BEFORE uploading — the upload contract in plain words.
//
// starSchema.ts says which columns each table must carry; this adds a one-line
// description of each table and, per column, its type, a real example value
// and what it holds — so the page can show what a good file looks like up
// front instead of only naming what is missing after a failed attempt. The
// minimal guide (opened from the page) uses the examples; the detailed one
// (opened from inside the upload dialog) uses all of it.
//
// The column LISTS are not repeated here. `guideFor` walks ROLE_COLUMNS and
// looks each column up in COLUMN_DOCS, so a column added to the contract
// appears in the guide at once rather than silently missing from it. Examples
// are rows from the shipped dataset.
import type { StarRole } from '../types/dataset'
import { ROLE_COLUMNS, STAR_ROLE_LABELS } from './starSchema'

export type ColumnType = 'id' | 'text' | 'number' | 'integer' | 'date'

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  id: 'ID',
  text: 'Text',
  number: 'Number',
  integer: 'Whole number',
  date: 'Date',
}

export interface ColumnDoc {
  type: ColumnType
  example: string
  note: string
  /** For a foreign key: the table it points at. */
  joins?: StarRole
}

// Keyed by role, then column, because the same name means different things in
// different tables — `Date` in the fact is a sale date, in dim_date a calendar day.
const COLUMN_DOCS: Record<StarRole, Record<string, ColumnDoc>> = {
  fact: {
    Date: { type: 'date', example: '01-01-2024', note: 'Date of the sale, DD-MM-YYYY. Its year is the reporting year.' },
    Week: { type: 'integer', example: '1', note: 'Week of the year. Must exist in the date file for that year.' },
    Month: { type: 'text', example: 'January', note: 'Full month name. The month shown is taken from the date file.' },
    Product_id: { type: 'id', example: 'P11-100ml', note: 'Which product was sold.', joins: 'product' },
    Store_Id: { type: 'id', example: 'S211', note: 'Which store sold it.', joins: 'geo_store' },
    Channel_Id: { type: 'id', example: 'CH001', note: 'Which channel it sold through.', joins: 'channel' },
    Promotion_Id: { type: 'id', example: 'PR001', note: 'Promotion running on the row, or -1 for none.', joins: 'promotion' },
    Base_Quantity: { type: 'number', example: '137', note: 'Units expected without any promotion.' },
    Actual_Quantity: { type: 'number', example: '137', note: 'Units actually sold.' },
    Actual_Price: { type: 'number', example: '180', note: 'Selling price per unit, after any discount.' },
    Base_Revenue: { type: 'number', example: '26030', note: 'Revenue at base quantity and base price.' },
    Actual_Revenue: { type: 'number', example: '24660', note: 'Revenue actually booked.' },
    Total_Cost: { type: 'number', example: '16920', note: 'Cost of the goods sold on the row.' },
    Promotion_Cost: { type: 'number', example: '781', note: 'Trade spend on the promotion. 0 when there is none.' },
  },
  product: {
    Product_id: { type: 'id', example: 'P11-50ml', note: 'Unique per product. The sales file refers to it.' },
    Product_Name: { type: 'text', example: 'Liquid Laundry Detergent 50 mL', note: 'Display name.' },
    Brand: { type: 'text', example: 'Laundry Detergent', note: 'Brand, used as a filter and grouping.' },
    Category: { type: 'text', example: 'Fabric & Home Care', note: 'Category, used as a filter and grouping.' },
    Size: { type: 'text', example: '50 mL', note: 'Pack size as written on the pack.' },
    Cost: { type: 'number', example: '45', note: 'Unit cost of the product.' },
  },
  geo_store: {
    Store_Id: { type: 'id', example: 'S001', note: 'Unique per store. The sales file refers to it.' },
    Channel_Id: { type: 'id', example: 'CH002', note: 'Channel the store trades in.', joins: 'channel' },
    Retailer: { type: 'text', example: 'Reliance Fresh', note: 'Retail banner. Leave blank or write null if none.' },
    Region: { type: 'text', example: 'North', note: 'Sales region.' },
    State: { type: 'text', example: 'Delhi', note: 'State.' },
    City: { type: 'text', example: 'Delhi', note: 'City.' },
    Tier: { type: 'text', example: 'Tier 1', note: 'City tier.' },
  },
  channel: {
    Channel_Id: { type: 'id', example: 'CH001', note: 'Unique per channel.' },
    Channel_Name: { type: 'text', example: 'E-commerce', note: 'Display name.' },
    Channel_Type: { type: 'text', example: 'Retail', note: 'Grouping above the channel.' },
  },
  promotion: {
    Promotion_Id: { type: 'id', example: 'PR001', note: 'Unique per promotion. Include a -1 row for "no promotion".' },
    Promotion_Name: { type: 'text', example: '5% Discount', note: 'Display name.' },
    Promotion_Type: { type: 'text', example: 'Regular', note: 'Mechanic family, e.g. Regular, Festive, Normal.' },
    Promotion_Description: { type: 'text', example: '5% Discount', note: 'Free-text description.' },
  },
  date: {
    Date: { type: 'date', example: '01-01-2024', note: 'One row per calendar day, DD-MM-YYYY.' },
    Year: { type: 'integer', example: '2024', note: 'Calendar year.' },
    Month: { type: 'text', example: 'January', note: 'Full month name.' },
    Week: { type: 'integer', example: '1', note: 'Week of the year the day falls in.' },
  },
}

/** A column no doc covers yet. Shown so a gap is visible, not blank. */
const FALLBACK: ColumnDoc = { type: 'text', example: '', note: 'Required by the loader.' }

const PURPOSE: Record<StarRole, string> = {
  fact: 'Your sales — volumes, revenue and spend by product, store and week.',
  product: 'Your products — name, brand, category, pack size and unit cost.',
  geo_store: 'Your stores — the channel, retailer and location of each one.',
  channel: 'Your sales channels, such as e-commerce or modern trade.',
  promotion: 'Your promotions, plus one row with ID -1 meaning "no promotion".',
  date: 'Your calendar — one row per day with its year, month and week.',
}

export interface TableGuide {
  role: StarRole
  label: string
  purpose: string
  columns: Array<ColumnDoc & { name: string }>
}

export function guideFor(role: StarRole): TableGuide {
  return {
    role,
    label: STAR_ROLE_LABELS[role],
    purpose: PURPOSE[role],
    columns: ROLE_COLUMNS[role].map((name) => ({ name, ...(COLUMN_DOCS[role][name] ?? FALLBACK) })),
  }
}

/** A header row plus example rows — what "Download template" saves. */
export function templateFor(role: StarRole): { headers: string[]; rows: string[][] } {
  const cols = guideFor(role).columns
  const rows = [cols.map((c) => c.example)]
  // The "no promotion" row is part of the contract, not decoration — put it in
  // the template so a user building from it cannot forget it.
  if (role === 'promotion') {
    const none: Record<string, string> = {
      Promotion_Id: '-1',
      Promotion_Name: 'No Discount',
      Promotion_Type: 'Normal',
      Promotion_Description: 'No Discount',
    }
    rows.unshift(cols.map((c) => none[c.name] ?? ''))
  }
  return { headers: cols.map((c) => c.name), rows }
}
