import { Link, useSearchParams } from 'react-router-dom'
import { Segmented, TYPE } from '../../components/planner/shared'
import { Icon } from '../../icons'
import type { Source } from '../budget'
import { useForecastStatus } from '../forecast'
import { MMM_ROUTES } from '../nav'

/** What the Budget Optimizer and Budget Allocator plan on, kept in the URL
 *  (`?source=forecast`) so the Revenue Forecast can link straight to it. */
export function usePlanSource(): [Source, (s: Source) => void] {
  const [params, setParams] = useSearchParams()
  const source: Source = params.get('source') === 'forecast' ? 'forecast' : 'history'
  return [source, (s) => setParams(s === 'forecast' ? { source: 'forecast' } : {}, { replace: true })]
}

/** Past data or the uploaded future plan. Hidden while there is no plan and
 *  the page is on past data -- there is nothing to switch to. */
export function PlanSourceSwitch({ source, onChange }: { source: Source; onChange: (s: Source) => void }) {
  const status = useForecastStatus()
  const loaded = !!status.data?.loaded
  if (!loaded && source === 'history') return null
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        label="Plan on"
        value={source}
        onChange={onChange}
        options={[
          { value: 'history', label: 'Past data', title: 'Weeks of the installed data, with their actual spend' },
          { value: 'forecast', label: 'Forecast plan', title: 'Weeks of the uploaded future plan, with its planned spend' },
        ]}
      />
      {source === 'forecast' && (
        <span className={`flex items-center gap-1.5 ${TYPE.label} !text-ink-muted [&_svg]:h-4 [&_svg]:w-4`}>
          <Icon name="file" />
          {loaded ? status.data?.name : 'No plan uploaded'} ·{' '}
          <Link to={MMM_ROUTES.forecast} className="text-brand-violet hover:underline">
            {loaded ? 'Revenue Forecast' : 'Upload one'}
          </Link>
        </span>
      )}
    </div>
  )
}
