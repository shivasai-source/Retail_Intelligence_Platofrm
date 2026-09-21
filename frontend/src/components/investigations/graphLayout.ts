import type { OrchNode } from '../../types/orchestration'

// Ported from js/pages/investigations.js's `impactStyle` + `layoutGraph`.
export interface ImpactStyle {
  color: string
  dash: 'none' | string
  accent: string
  bg: string
}

export function impactStyle(impact: OrchNode['impact']): ImpactStyle {
  switch (impact) {
    case 'strong':
      return { color: '#4F7CFF', dash: 'none', accent: 'var(--brand-blue)', bg: 'rgba(79,124,255,0.1)' }
    case 'moderate':
      return { color: '#4F7CFF', dash: '6 4', accent: 'var(--brand-blue)', bg: 'rgba(79,124,255,0.1)' }
    case 'negative':
      return { color: '#EF4444', dash: '6 4', accent: 'var(--status-danger)', bg: 'rgba(239,68,68,0.08)' }
    case 'risk':
      return { color: '#F97316', dash: '6 4', accent: '#F97316', bg: 'rgba(249,115,22,0.08)' }
    case 'data':
      return { color: '#9CA3AF', dash: '4 4', accent: 'var(--text-muted)', bg: 'var(--surface-muted)' }
    default:
      return { color: '#9CA3AF', dash: 'none', accent: 'var(--text-muted)', bg: 'var(--surface-muted)' }
  }
}

export interface LaidOutNode {
  key: string
  px: number
  py: number
  edgeX2: number
  edgeY2: number
  style: ImpactStyle
}

/** Nodes evenly spaced around an ellipse (starting at top, clockwise); edges land just
 *  outside the center hub box rather than at its exact center. Recomputed on resize —
 *  this is why nodes are absolutely positioned in px, not the data's `pos.x/y` percentages
 *  (those only exist so the first paint isn't empty before layout runs). */
export function computeRadialLayout(nodes: OrchNode[], width: number, height: number): LaidOutNode[] {
  const N = nodes.length
  // Half the node's 156px diameter (InvestigationGraph draws it), so the
  // ring keeps a node's full width inside the stage.
  const nodeR = 78
  const pad = 18
  const hubRx = 104
  const hubRy = 50
  const hx = width / 2
  const hy = height / 2
  const rx = Math.max(140, width / 2 - nodeR - pad)
  const ry = Math.max(120, height / 2 - nodeR - pad)

  return nodes.map((n, i) => {
    const ang = -Math.PI / 2 + i * ((2 * Math.PI) / N)
    const px = hx + rx * Math.cos(ang)
    const py = hy + ry * Math.sin(ang)
    const dx = hx - px
    const dy = hy - py
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const dHub = 1 / Math.sqrt((ux / hubRx) ** 2 + (uy / hubRy) ** 2)
    return {
      key: n.key,
      px,
      py,
      edgeX2: hx - ux * dHub,
      edgeY2: hy - uy * dHub,
      style: impactStyle(n.impact),
    }
  })
}

