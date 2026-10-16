import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch, apiPost } from '../lib/api'

/** The MMM Budget Optimizer's API (backend app/mmm/budget.py).
 *
 *  A period is a run of ISO weeks, each keyed year * 100 + week (202614). The
 *  budget is fixed, so every change is a move of money:
 *    week     within a channel, to its other weeks
 *    channel  to other channels, in the same week
 *    both     to other channels, in other weeks */

export interface Range {
  p10: number
  p90: number
  display: string
}

export interface Figure {
  value: number | null
  display: string
  /** P10 - P90 over the model's refits; null for ad spend (chosen, not estimated). */
  range: Range | null
}

export type FigureKey = 'profit' | 'profit_pct' | 'revenue' | 'baseline' | 'incremental' | 'spend' | 'roas'
export type Figures = Record<FigureKey, Figure>

export interface Delta {
  value: number
  display: string
  percent: number | null
  percent_display: string | null
  direction: 'up' | 'down' | 'unchanged'
  range: Range | null
}

export type MoveKind = 'week' | 'channel' | 'both'
/** What is planned: the installed data, or the uploaded future plan (Revenue Forecast). */
export type Source = 'history' | 'forecast'
export type Mode = 'anywhere' | 'within_channel' | 'across_channels'

/** One week of the week-by-week view; `after` is the carryover after the period. */
export interface WeekPoint {
  week: string
  start: string
  days: number
  after: boolean
  baseline: number
  baseline_range: [number, number]
  spend_now: number
  spend_plan: number
  revenue_now: number
  revenue_now_range: [number, number]
  revenue_plan: number
  revenue_plan_range: [number, number]
  profit_now: number
  profit_now_range: [number, number]
  profit_plan: number
  profit_plan_range: [number, number]
}

export interface CurvePoint {
  spend: number
  incremental: number
  p10: number
  p90: number
}

export interface CurveMark {
  spend: number
  spend_display: string
  incremental: number
  incremental_display: string
  incremental_range: Range
  roas: number | null
  roas_display: string
  /** What the next rupee returns at this spend. */
  marginal: number
  marginal_display: string
}

export interface ChannelCurve {
  key: string
  label: string
  /** With today's week-by-week timing. */
  points: CurvePoint[]
  /** With the best plan's timing. */
  plan_points: CurvePoint[]
  current: CurveMark
  plan: CurveMark
}

export interface ChannelMoves {
  key: string
  label: string
  net: number
  gives_display: string
  receives_display: string
  net_display: string
  kinds: MoveKind[]
  spend_now_display: string
  spend_plan_display: string
  incremental_change_display: string
  weeks: { label: string; now: number; plan: number; changed: boolean; deeper: boolean }[]
}

export interface Move {
  from_channel: string
  from_week: number
  to_channel: string
  to_week: number
  amount: number
  amount_display: string
  kind: MoveKind
}

export interface ModelCard {
  holdout_last_year: { mape_pct: number; r2: number; days: number } | null
  media_share_pct: number | null
  bootstraps: number | null
  fit_seconds: number | null
}

export interface BudgetOptions {
  calendar: { year: number; weeks: { week: number; start: string; month: number }[] }[]
  channels: { key: string; label: string }[]
  default: { start: number; end: number }
  modes: { key: Mode; label: string }[]
}

export interface BudgetSummary {
  scope: { start: number; end: number; weeks: { key: number; label: string; start: string }[]; carryover_tail_days: number }
  channels: { key: string; label: string }[]
  current: { budget: number; budget_display: string }
  currency: string
  /** Display-currency units per rupee. */
  exchange_rate: number
  figures: Figures
  model: ModelCard
}

export interface BestPlan {
  mode: Mode
  currency: string
  /** Display-currency units per rupee; chart axes are in rupees. */
  exchange_rate: number
  matrix: number[][]
  figures: Figures
  current_figures: Figures
  deltas: Record<FigureKey, Delta | null>
  chance_gain_pct: number
  draws: number
  impact: {
    kinds: Record<MoveKind, { count: number; amount_display: string }>
    moved_display: string
    moved_share_pct: number
    channels_touched: number
    cells_changed: number
  }
  moves: Move[]
  channels: ChannelMoves[]
  weekly: WeekPoint[]
  curves: ChannelCurve[]
  budget: { value: number; display: string }
}

export interface ModelStatus {
  status: 'idle' | 'training' | 'ready' | 'error'
  stage: string
  progress: number
  error: string | null
}

/** The model's training state, polled every second until it is ready. */
export function useBudgetStatus() {
  return useQuery({
    queryKey: ['mmm', 'budget', 'status'],
    queryFn: () => apiFetch<ModelStatus>('/mmm/budget/status'),
    refetchInterval: (q) => (q.state.data?.status === 'ready' || q.state.data?.status === 'error' ? false : 1000),
  })
}

export function useBudgetOptions(enabled: boolean, source: Source = 'history') {
  return useQuery({
    queryKey: ['mmm', 'budget', 'options', source],
    queryFn: () => apiFetch<BudgetOptions>(`/mmm/budget/options?source=${source}`),
    enabled,
    staleTime: Infinity,
  })
}

export function useBudgetSummary(start: number | null, end: number | null, currency: string, source: Source = 'history') {
  return useQuery({
    queryKey: ['mmm', 'budget', 'summary', start, end, currency, source],
    queryFn: () => apiFetch<BudgetSummary>(`/mmm/budget/summary?start=${start}&end=${end}&currency=${currency}&source=${source}`),
    enabled: start != null && end != null,
    placeholderData: keepPreviousData,
  })
}

/** The best plan for the period and mode -- computed as soon as either is
 *  chosen, as TPO's Best plan is. */
export function useBestPlan(start: number | null, end: number | null, currency: string, mode: Mode, source: Source = 'history') {
  return useQuery({
    queryKey: ['mmm', 'budget', 'best', start, end, currency, mode, source],
    queryFn: () => apiPost<BestPlan>('/mmm/budget/optimize', { start, end, currency, mode, source }),
    enabled: start != null && end != null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })
}
