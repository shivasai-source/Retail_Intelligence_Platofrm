// What a user needs to know BEFORE uploading — the upload contract in plain words.
//
// starSchema.ts says which columns each table must carry; this adds a one-line
// description of each table and, per column, its type, a real example value
// and what it holds — so the page can show what a good file looks like up
// front instead of only naming what is missing after a failed attempt. The
// minimal guide (opened from the page) uses the examples; the detailed one
// (opened from inside the upload dialog) uses all of it.
//
// The column LISTS are not repeated here. `guideFor` walks ROLE_COLUMNS (then
// OPTIONAL_COLUMNS, flagged optional) and
// looks each column up in COLUMN_DOCS, so a column added to the contract
// appears in the guide at once rather than silently missing from it. Examples
// are rows from the shipped dataset.
import type { StarRole } from '../types/dataset'
import { EITHER_COLUMNS, OPTIONAL_COLUMNS, ROLE_COLUMNS, STAR_ROLE_LABELS } from './starSchema'

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
  /** Read when present, never required. */
  optional?: boolean
}

// Keyed by role, then column, because the same name means different things in
// different tables — `Date` in the fact is a sale date, in dim_date a calendar day.
const COLUMN_DOCS: Record<StarRole, Record<string, ColumnDoc>> = {
  fact: {
    Date: { type: 'date', example: '01-01-2024', note: 'First day of the sales week, DD-MM-YYYY. Its week and month are worked out from it.' },
    Product_id: { type: 'id', example: 'P11-250ml', note: 'Which product was sold.', joins: 'product' },
    Store_Id: { type: 'id', example: 'S211', note: 'Which store sold it. The channel comes from the store file.', joins: 'geo_store' },
    Promotion_Id: { type: 'id', example: 'PR001', note: 'Promotion running on the row. Leave blank (or write -1) when none was running.', joins: 'promotion' },
    Actual_Quantity: { type: 'number', example: '185', note: 'Units actually sold.' },
    Base_Price: { type: 'number', example: '190', note: 'Regular list price per unit, before any discount.' },
    Actual_Price: { type: 'number', example: '180', note: 'Selling price per unit, after any discount. Equal to Base_Price with no promotion.' },
    Total_Cost: { type: 'number', example: '22940', note: 'Cost of the goods sold on the row. Give this OR CP, whichever your data holds.' },
    CP: { type: 'number', example: '124', note: 'Cost per unit, as a pricing master holds it. Give this OR Total_Cost — this one is multiplied by the quantity.' },
    Promotion_Name: { type: 'text', example: '5% Discount', note: 'Name of the offer on the row. Required when you do not upload a promotion file.' },
    Promotion_Type: { type: 'text', example: 'Regular', note: 'How the offer is classified: Regular, Seasonal or Normal. Required when you do not upload a promotion file.' },
    Promotion_Cost: { type: 'number', example: '1054', note: 'Promotion running cost on top of the discount, when your data books it per line. Leave out and trade spend is the discount alone.' },
    Base_Quantity: { type: 'number', example: '122', note: 'Units expected without the promotion, if your data has it. Almost no source does — leave it out and it is estimated from the nearby non-promoted weeks of each product.' },
  },
  product: {
    Product_id: { type: 'id', example: 'P11-50ml', note: 'Unique per product. The sales file refers to it.' },
    Product_Name: { type: 'text', example: 'Liquid Laundry Detergent 50 mL', note: 'Display name.' },
    Brand: { type: 'text', example: 'Laundry Detergent', note: 'Brand, used as a filter and grouping.' },
    Category: { type: 'text', example: 'Fabric & Home Care', note: 'Category, used as a filter and grouping.' },
    Size: { type: 'text', example: '50 mL', note: 'Pack size as written on the pack. Packs of one brand are ranked by it.' },
  },
  geo_store: {
    Store_Id: { type: 'id', example: 'S001', note: 'Unique per store. The sales file refers to it.' },
    Channel_Id: { type: 'id', example: 'CH002', note: 'Channel the store trades in.', joins: 'channel' },
    Retailer: { type: 'text', example: 'Reliance Fresh', note: 'Retail banner. Leave blank if none, as for distributor-served stores.' },
    Distributor_Name: { type: 'text', example: 'Distributor_01', note: 'Distributor serving the store (B2B). Leave blank if none.' },
    Region: { type: 'text', example: 'North', note: 'Sales region.' },
    State: { type: 'text', example: 'Delhi', note: 'State.' },
    City: { type: 'text', example: 'Delhi', note: 'City.' },
    Tier: { type: 'text', example: 'Tier 1', note: 'City tier.' },
    Country: { type: 'text', example: 'India', note: 'Country.' },
    Channel_Name: { type: 'text', example: 'Modern Trade', note: 'Name of the channel the store trades in. Required when you do not upload a channel file.' },
    Channel_Type: { type: 'text', example: 'Retail', note: 'Grouping above the channel.' },
    Schedule: { type: 'text', example: 'MONTHLY', note: 'How the channel plans promotions: WEEKLY or MONTHLY. The same for every store of a channel.' },
  },
  channel: {
    Channel_Id: { type: 'id', example: 'CH001', note: 'Unique per channel.' },
    Channel_Name: { type: 'text', example: 'E-commerce', note: 'Display name.' },
    Channel_Type: { type: 'text', example: 'Retail', note: 'Grouping above the channel.' },
    Schedule: { type: 'text', example: 'WEEKLY', note: 'How the channel plans promotions: WEEKLY or MONTHLY.' },
  },
  promotion: {
    Promotion_Id: { type: 'id', example: 'PR001', note: 'Unique per promotion. Include a -1 row for "no promotion".' },
    Promotion_Name: { type: 'text', example: '5% Discount', note: 'Display name.' },
    Promotion_Type: { type: 'text', example: 'Regular', note: 'Regular, Seasonal (festival offers) or Normal (the -1 row).' },
    Promotion_Description: { type: 'text', example: '5% Discount', note: 'Free-text description. For a festival offer, its name and year, e.g. "Diwali Special 25".' },
  },
  date: {
    Date: { type: 'date', example: '01-01-2024', note: 'One row per calendar day, DD-MM-YYYY.' },
    Year: { type: 'integer', example: '2024', note: 'Calendar year.' },
    Month: { type: 'text', example: 'January', note: 'Full month name.' },
    Week: { type: 'integer', example: '1', note: 'Business week of the year: week 1 starts on 1 January, each Monday starts the next.' },
    Quarter: { type: 'text', example: 'Q1', note: 'Calendar quarter.' },
    Day: { type: 'text', example: 'Monday', note: 'Day of the week.' },
  },
}

/** A column no doc covers yet. Shown so a gap is visible, not blank. */
const FALLBACK: ColumnDoc = { type: 'text', example: '', note: 'Required by the loader.' }

const PURPOSE: Record<StarRole, string> = {
  fact: 'Your sales — units, prices, cost and the offer running, by product, store and week.',
  product: 'Your products — name, brand, category and pack size.',
  geo_store: 'Your stores — the channel, retailer and location of each one.',
  channel: 'Optional. Your sales channels, such as e-commerce or modern trade. Leave it out and they are read from the store file, which then needs Channel_Name.',
  promotion: 'Optional. Your promotions. Leave it out and each offer is read from the sales file, which then needs Promotion_Name and Promotion_Type.',
  date: 'Optional. A calendar, one row per day. Leave it out and it is worked out from the sales dates: week 1 starts on 1 January and each Monday starts the next.',
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
    columns: [
      ...ROLE_COLUMNS[role].map((name) => ({ name, ...(COLUMN_DOCS[role][name] ?? FALLBACK) })),
      // Each member of an interchangeable group is listed, because the user
      // supplies one of them and their notes say so.
      ...(EITHER_COLUMNS[role] ?? []).flat().map((name) => ({ name, ...(COLUMN_DOCS[role][name] ?? FALLBACK) })),
      ...OPTIONAL_COLUMNS[role].map((name) => ({ name, ...(COLUMN_DOCS[role][name] ?? FALLBACK), optional: true })),
    ],
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
