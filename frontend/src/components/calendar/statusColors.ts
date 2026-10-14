import type { CSSProperties } from 'react'
import type { CellKind } from '../../types/promotionCalendar'

/** THE promotion-status palette for the whole Calendar.
 *
 *  One definition, imported by the matrix cells, the legend, the promotion
 *  details panel and the Upcoming feed — so a status cannot end up a different
 *  shade in one place than another. Nothing else in the app defines these.
 *
 *  Deliberately NOT the app's theme tokens. `status-success` / `brand-violet` /
 *  `status-warning` serve the KPI and alert surfaces and shift with them; the
 *  calendar's four statuses are their own semantic set and are pinned here.
 *
 *  The SOLID colour carries the meaning — legend dot, cell title, badge, border
 *  accent. The tint is only a wash behind the cell, kept light so a twelve-month
 *  grid reads as a plan rather than a block of colour.
 *
 *  Colour is never the only signal: every cell also states its promotion name,
 *  ids and product count, and every badge is labelled. */
export interface StatusColor {
  /** Indicator, title, badge text, border accent. */
  solid: string
  /** Cell / badge background wash. */
  tint: string
  /** Hover wash — the same hue, one step up. */
  hover: string
  /** Border at the cell's own tint strength. */
  border: string
}

export const STATUS: Record<CellKind, StatusColor> = {
  regular: {
    solid: 'var(--status-success)',
    tint: 'rgba(85,157,10, 0.08)',
    hover: 'rgba(85,157,10, 0.14)',
    border: 'rgba(85,157,10, 0.30)',
  },
  seasonal: {
    solid: 'var(--brand-violet)',
    tint: 'rgba(20,58,99, 0.08)',
    hover: 'rgba(20,58,99, 0.14)',
    border: 'rgba(20,58,99, 0.30)',
  },
  festival: {
    solid: 'var(--status-warning)',
    tint: 'rgba(228,162,57, 0.10)',
    hover: 'rgba(228,162,57, 0.16)',
    border: 'rgba(228,162,57, 0.32)',
  },
  no_data: {
    solid: 'var(--border-strong)',
    tint: 'transparent',
    hover: 'rgba(148, 163, 184, 0.06)',
    border: 'rgba(148, 163, 184, 0.35)',
  },
  none: {
    solid: 'var(--text-muted)',
    tint: 'rgba(148, 163, 184, 0.08)',
    hover: 'rgba(148, 163, 184, 0.14)',
    border: 'rgba(148, 163, 184, 0.30)',
  },
}

/** Custom properties so hover can stay in CSS while the value stays here. */
export function statusVars(kind: CellKind): CSSProperties {
  const c = STATUS[kind]
  return {
    '--st-solid': c.solid,
    '--st-tint': c.tint,
    '--st-hover': c.hover,
    '--st-border': c.border,
  } as CSSProperties
}

/** A promotion Type from dim_promotion mapped onto the status palette, so
 *  "Seasonal" is the same violet in the Upcoming feed and the details badge as
 *  it is in the grid. */
export function statusForPromotionType(type: string): CellKind {
  return type === 'Seasonal' ? 'seasonal' : 'regular'
}

/** Business-event types (review / launch / extension / data / closure) are a
 *  different taxonomy from promotion status, but they reuse this palette
 *  wherever the meaning lines up so the panel stays one colour system. Review
 *  has no promotion-status equivalent and keeps its own blue. */
const REVIEW_BLUE: StatusColor = {
  solid: 'var(--brand-blue)',
  tint: 'rgba(37,104,178, 0.10)',
  hover: 'rgba(37,104,178, 0.16)',
  border: 'rgba(37,104,178, 0.30)',
}

export function toneForEventType(type: string): StatusColor {
  switch (type) {
    case 'Regular':
    case 'launch':
      return STATUS.regular
    case 'Seasonal':
    case 'data':
      return STATUS.seasonal
    case 'extension':
      return STATUS.festival
    case 'closure':
      return STATUS.none
    case 'review':
      return REVIEW_BLUE
    default:
      return STATUS.none
  }
}
