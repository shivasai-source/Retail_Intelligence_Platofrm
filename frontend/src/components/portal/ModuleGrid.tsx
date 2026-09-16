import { Link } from 'react-router-dom'
import { Icon } from '../../icons'
import { Pill, useToast } from '../ui'
import { MODULES } from './modules'

// Ported from js/portal.js's renderModules + css/portal.css .module-*.
export function ModuleGrid() {
  const { show } = useToast()

  return (
    <div className="grid grid-cols-3 gap-4 @max-[900px]:grid-cols-2 @max-[620px]:grid-cols-1">
      {MODULES.map((m) => {
        const card = (
          <div
            className={`flex h-full flex-col gap-3 rounded-[var(--r-xl)] border bg-surface-card p-5 transition-[box-shadow,border-color,transform] duration-150 ${
              m.live
                ? 'cursor-pointer border-brand-violet shadow-[var(--shadow-violet)] hover:-translate-y-px hover:shadow-[var(--shadow-md)]'
                : 'cursor-default border-border-subtle'
            }`}
          >
            <div
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl [&_svg]:h-[22px] [&_svg]:w-[22px]"
              style={{ background: `var(--tint-${m.tint})`, color: `var(--tint-${m.tint}-icon)` }}
            >
              <Icon name={m.icon} />
            </div>
            <h3 className="text-md leading-[1.3]">{m.title}</h3>
            <p className="flex-1 text-base leading-[1.55] text-ink-muted">{m.desc}</p>
            {/* HONEST AFFORDANCES. The live module gets its status and an
                arrow that goes somewhere. A roadmap module says so in a
                muted chip and gets NO arrow -- a button-shaped arrow that
                only raises a toast is a promise the card cannot keep. */}
            <div className="mt-0.5 flex items-center justify-between">
              {m.live ? (
                <Pill tone="success" dot pulse>
                  Live
                </Pill>
              ) : (
                <Pill tone="neutral">Roadmap</Pill>
              )}
              {m.live && (
                <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-brand-violet text-white transition-colors [&_svg]:h-4 [&_svg]:w-4">
                  <Icon name="arrowRight" />
                </span>
              )}
            </div>
          </div>
        )
        return m.live && m.href ? (
          <Link key={m.key} to={m.href}>
            {card}
          </Link>
        ) : (
          <div key={m.key} onClick={() => show(`${m.title} is on the roadmap — Trade Promotion Optimization is live today.`)}>
            {card}
          </div>
        )
      })}
    </div>
  )
}
