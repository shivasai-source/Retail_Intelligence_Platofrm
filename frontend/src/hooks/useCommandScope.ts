import { useEffect } from 'react'
import { useFilterOptions } from './useCommandCenter'
import { useCommandFilters } from '../store/commandFilters'

/** MAKE SURE THE INSIGHTS HUB'S SCOPE EXISTS, from a page that is not the Hub.
 *
 *  Every alert query reads the Hub's filter store and is gated on
 *  `initialised` — the default year is only known once /filters answers, and
 *  fetching before that would pull the whole dataset and then refetch the
 *  real year (see useScope in hooks/useCommandCenter). The Hub initialises the
 *  store on its own mount; a reader who lands on Investigations cold has never
 *  mounted it, so without this the alerts dialog and the "From an alert" menu
 *  would sit waiting for a page the reader has not visited.
 *
 *  THE RULE IS THE HUB'S, NOT A SECOND ONE: the most recent COMPLETED year the
 *  data holds, falling back to the latest year when only the running one
 *  exists. `initialise` is a no-op once the store is initialised, so mounting
 *  this on a page the Hub already set up changes nothing. It was inlined in
 *  AlertPicker; the alerts dialog needs the same thing, so it lives here once.
 *
 *  Returns whether the scope is ready, so a caller can tell "loading alerts"
 *  from "the scope is not resolved yet" — the two look identical otherwise. */
export function useEnsureCommandScope(): boolean {
  const initialised = useCommandFilters((s) => s.initialised)
  const initialise = useCommandFilters((s) => s.initialise)
  const options = useFilterOptions()
  useEffect(() => {
    if (initialised) return
    const years = options.data?.years
    if (!years?.length) return
    const completed = years.filter((y) => y < new Date().getFullYear())
    initialise(Math.max(...(completed.length ? completed : years)))
  }, [initialised, options.data?.years, initialise])
  return initialised
}
