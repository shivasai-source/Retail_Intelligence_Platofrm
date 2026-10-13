import { useEffect, useState } from 'react'

/** A value that follows `value` after it has stopped changing for `ms`.
 *
 *  A slider updates on every pointer move; the request goes out once the
 *  hand pauses. 120ms is below what reads as lag and above what a drag emits
 *  between frames. */
export function useDebounced<T>(value: T, ms = 120): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return settled
}
