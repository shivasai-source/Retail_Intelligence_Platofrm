import { createFilterStore } from './commandFilters'

/** The Simulation Studio's own filter state — the Insights Hub's store shape,
 *  a second instance. The studio never carries a scope in from another page
 *  (Promotion Intelligence, an alert): the reader picks the scope here, with
 *  the same controls the Insights Hub offers minus the three that make no
 *  sense for a forward window — Month, Offer and Promotion Type. Those keys
 *  exist on the shape and stay empty. */
export const useStudioFilters = createFilterStore('tiq.studioFilters')
