import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { Link } from 'react-router-dom'

// Ported from css/tpo.css .tpo-alert-banner* — the coral risk banner on the 5 main
// pages, with a periodic attention "flash" (box-shadow pulse every 18s, matching the
// vanilla app's `window._cmdWobble` interval).
export function AlertBanner({
  title,
  desc,
  ctaTo,
  onClick,
}: {
  title: string
  desc: string
  ctaTo: string
  onClick?: () => void
}) {
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => {
      setFlash(true)
      window.setTimeout(() => setFlash(false), 600)
    }, 18000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div
      onClick={onClick}
      className={`fade-in my-[18px] flex cursor-pointer items-center gap-4 rounded-[var(--r-lg)] border border-[var(--alert-border)] bg-[var(--alert-bg)] p-[18px_24px] transition-shadow duration-500 ${
        flash ? 'shadow-[0_0_0_6px_rgba(228,68,57,0.2)]' : 'shadow-[0_0_0_0_rgba(228,68,57,0)]'
      }`}
    >
      <div className="grid h-11 w-11 shrink-0 animate-[pulseDot_2s_ease-in-out_infinite] place-items-center rounded-full bg-white/50 text-[var(--alert-ink)] [&_svg]:h-[22px] [&_svg]:w-[22px] [&_svg]:stroke-2">
        <Icon name="warning" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-md font-medium text-[var(--alert-ink)]">
          <strong className="mr-1.5 font-medium text-[var(--alert-ink)]">ALERT:</strong>
          {title}
        </div>
        <div className="mt-[3px] text-base font-medium text-[var(--alert-ink-soft)]">{desc}</div>
      </div>
      <Link
        to={ctaTo}
        // The CTA must do what the banner does, AND NOTHING ELSE. `stopPropagation`
        // alone left the Link navigating while the banner's `onClick` never ran, so
        // "View Details" -- the obvious affordance -- arrived at the target page
        // with NO scope handed over, while clicking the banner body handed one over
        // correctly. Calling the handler fixed that half; `preventDefault` fixes the
        // other. `onClick` navigates to `ctaTo` ITSELF, carrying the clicked alert
        // in router state, and a Link whose default is left intact then navigates to
        // the same path a second time with no state -- landing on a page that had
        // just been handed the alert and now sees nothing. The handler owns the
        // navigation whenever there is one; without one the Link is the navigation
        // and its default must stand.
        onClick={(e) => {
          e.stopPropagation()
          if (!onClick) return
          e.preventDefault()
          onClick()
        }}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--alert-border)] bg-surface-card px-[18px] text-base font-medium text-[var(--alert-ink)] transition-colors hover:border-[var(--alert-ink)] hover:bg-[var(--alert-cta-hover)] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-[var(--alert-ink)]"
      >
        View Details
        <Icon name="arrowRight" />
      </Link>
    </div>
  )
}
