import type { CommandFilters } from '../store/commandFilters'

/** The request-body form of the Insights Hub's filter state — the shape every
 *  POST body (`filters`) and every report `scope` carries. */
export type ApiFilters = {
  year?: number
  month?: number
} & Partial<Record<keyof Omit<CommandFilters, 'year' | 'month'>, string[]>>

/** The Insights Hub's filter state, as the API wants it in a body.
 *
 *  Empty lists are dropped rather than sent as `[]`: an absent dimension means
 *  unconstrained, which is a different request from one constrained to
 *  nothing. `year: null` is likewise omitted — the backend reads an absent
 *  year as All Years, exactly as the Insights Hub's own query strings do.
 */
export function toApiFilters(filters: CommandFilters): ApiFilters {
  const out: ApiFilters = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length) out[key as 'channel'] = value
    } else {
      out[key as 'year'] = value as number
    }
  }
  return out
}
