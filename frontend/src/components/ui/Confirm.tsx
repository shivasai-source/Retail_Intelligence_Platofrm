import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../../icons'
import { Modal } from './Modal'
import { Button } from './Button'
import { IconButton } from './IconButton'

// Ported from js/components/ui.js UI.confirm + css/tpo.css .ui-confirm-*. Same call
// shape as the original (`confirm({ title, body, ... })`) via useConfirm().
export interface ConfirmOptions {
  title: string
  body: string
  primaryText?: string
  secondaryText?: string
  icon?: IconName
  onConfirm?: () => void
}

const ConfirmContext = createContext<{ confirm: (opts: ConfirmOptions) => void } | null>(null)

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider')
  return ctx.confirm
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)

  const confirm = useCallback((o: ConfirmOptions) => setOpts(o), [])
  const close = () => setOpts(null)

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Modal open={!!opts} onClose={close} maxWidthClassName="max-w-[460px]">
        {opts && (
          <>
            <div className="grid grid-cols-[40px_1fr_32px] items-start gap-3 border-b border-border-subtle p-[20px_22px_16px]">
              <div className="grid h-10 w-10 place-items-center rounded-[10px] bg-brand-violet-50 text-brand-violet [&_svg]:h-5 [&_svg]:w-5">
                <Icon name={opts.icon ?? 'checkCircle'} />
              </div>
              <div>
                <h3 className="text-md font-medium">{opts.title}</h3>
                <p className="mt-1 text-base leading-[1.5] text-ink-muted">{opts.body}</p>
              </div>
              <IconButton icon="x" onClick={close} />
            </div>
            <div className="flex justify-end gap-2 bg-surface-page p-[12px_22px]">
              <Button variant="ghost" onClick={close}>
                {opts.secondaryText ?? 'Cancel'}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  close()
                  opts.onConfirm?.()
                }}
              >
                {opts.primaryText ?? 'Confirm'}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}
