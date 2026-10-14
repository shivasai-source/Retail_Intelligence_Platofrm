import { type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from 'react'
import { Icon } from '../../icons'

// Ported from css/components.css .field / .field-label / .input / .select / .textarea
export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel required={required}>{label}</FieldLabel>
      {children}
    </div>
  )
}

export function FieldLabel({
  children,
  required,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className="text-sm font-medium text-ink-secondary" {...props}>
      {children}
      {required && <span className="ml-0.5 text-status-danger">*</span>}
    </label>
  )
}

const inputBase =
  'w-full rounded-[var(--r-md)] border border-border-default bg-surface-card px-3 py-2 text-base text-ink-primary ' +
  'outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-disabled ' +
  'focus:border-brand-violet focus:shadow-[0_0_0_3px_rgba(20,58,99,0.12)]'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...props },
  ref,
) {
  return <input ref={ref} className={`${inputBase} ${className}`} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...props }, ref) {
    return <textarea ref={ref} className={`${inputBase} resize-none leading-normal ${className}`} {...props} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={`${inputBase} cursor-pointer appearance-none pr-8 ${className}`}
        {...props}
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted"
      />
    </div>
  )
})
