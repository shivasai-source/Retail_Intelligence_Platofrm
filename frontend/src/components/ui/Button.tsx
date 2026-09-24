import { type ButtonHTMLAttributes, forwardRef } from 'react'

// Ported from css/components.css .btn / .btn-primary / .btn-secondary / .btn-ghost /
// .btn-violet-soft / .btn-sm / .btn-lg / .btn-block.
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'violet-soft'
export type ButtonSize = 'sm' | 'md' | 'pill' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--r-md)] font-semibold ' +
  'tracking-[-0.005em] whitespace-nowrap select-none border border-transparent cursor-pointer ' +
  'transition-[background,color,transform,box-shadow] duration-150 active:translate-y-px ' +
  'disabled:cursor-not-allowed [&_svg]:w-4 [&_svg]:h-4 [&_svg]:stroke-2 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-violet)]'

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-violet text-white shadow-[var(--shadow-violet)] hover:bg-brand-violet-600 ' +
    'disabled:bg-[var(--btn-disabled-bg)] disabled:text-white disabled:shadow-none disabled:opacity-70',
  secondary:
    'bg-surface-card text-ink-primary border-border-default hover:bg-surface-hover hover:border-border-strong',
  ghost: 'bg-transparent text-ink-secondary hover:bg-surface-hover hover:text-ink-primary',
  'violet-soft': 'bg-brand-violet-50 text-brand-violet hover:bg-[#E6DEFF]',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-3 text-sm',
  md: 'h-9 px-4 text-base',
  // A TOOLBAR PILL: `md`'s height, so it lines up with Export and the icon
  // buttons beside it, but the `text-sm` label and tighter padding the Target
  // ROI control and the currency toggle already use. At `md` the filter row's
  // seven controls came to more than the row could hold and the last one
  // wrapped to a line of its own; this is also the size that makes the row
  // read as one set of controls rather than two.
  pill: 'h-9 px-3 text-sm',
  lg: 'h-[42px] px-5 text-base',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, className = '', ...props },
  ref,
) {
  const classes = [base, variants[variant], sizes[size], block ? 'w-full' : '', className]
    .filter(Boolean)
    .join(' ')
  return <button ref={ref} className={classes} {...props} />
})
