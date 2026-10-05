import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SettingsPage } from '../../pages/Settings'
import { Button, Card, CardHeader, Pill } from '../../components/ui'
import { Icon } from '../../icons'
import { fmtSize } from '../../lib/portalConnectors'
import { useMmmStatus } from '../hooks'
import { MMM_ROUTES } from '../nav'
import { MmmShell } from '../components/MmmShell'
import { MmmUploadModal } from '../components/MmmUploadModal'

/** MMM — SETTINGS. The platform's settings page (profile, preferences,
 *  integrations are shared with TPO) in MMM's shell, led by a card about
 *  MMM's own dataset: what is loaded, where it lives, and the way to manage
 *  it. TPO's default period and channel preferences mean nothing here and
 *  are hidden. */
export function MmmSettings() {
  return (
    <SettingsPage
      tpoPreferences={false}
      moduleCard={<MmmDatasetCard />}
      shell={(children) => (
        <MmmShell activeKey="settings" page="Settings">
          {children}
        </MmmShell>
      )}
    />
  )
}

function MmmDatasetCard() {
  const { data: s } = useMmmStatus()
  const [managing, setManaging] = useState(false)
  const navigate = useNavigate()

  const rows: Array<[string, string]> = s?.complete
    ? [
        ['Source file', s.source_name ?? '—'],
        ['Period', `${s.period.from} – ${s.period.to}`],
        ['Days', s.rows.toLocaleString()],
        ['Media channels', String(s.media_channels)],
        ['Size', fmtSize(s.size_bytes)],
        ['Stored in', s.data_dir],
      ]
    : [['Stored in', s?.data_dir ?? '—']]

  return (
    <Card className="fade-in col-span-2 @max-[900px]:col-span-1">
      <CardHeader
        title="MMM dataset"
        actions={
          <Pill tone={s?.complete ? 'success' : 'neutral'} dot={Boolean(s?.complete)}>
            {s?.complete ? 'Loaded' : 'Not loaded'}
          </Pill>
        }
      />
      <div className="p-5">
        <div className="flex flex-col">
          {rows.map(([k, v], i) => (
            <div
              key={k}
              className={`flex justify-between gap-4 py-2.5 text-base ${i < rows.length - 1 ? 'border-b border-dashed border-border-subtle' : ''}`}
            >
              <span className="shrink-0 text-ink-muted">{k}</span>
              <span className="truncate font-bold text-ink-primary" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <span className="text-sm leading-[1.5] text-ink-muted">
            MMM's data is kept apart from TPO's — loading or removing it never touches the promotion dataset.
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => navigate(MMM_ROUTES.connections)}>
              Data Connections
            </Button>
            <Button variant="secondary" onClick={() => setManaging(true)}>
              <Icon name="database" /> {s?.complete ? 'Manage dataset' : 'Upload file'}
            </Button>
          </div>
        </div>
      </div>
      {managing && <MmmUploadModal onClose={() => setManaging(false)} />}
    </Card>
  )
}
