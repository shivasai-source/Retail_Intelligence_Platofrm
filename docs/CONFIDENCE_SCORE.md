# The Evidence Score

Every `confidence` percentage this platform serves is computed by
`backend/app/agents/confidence.py`. This document is the specification: what
each formula is, what it measures, what it deliberately does not, and which
numbers in it were chosen rather than derived.

Tests: `backend/tests/test_confidence_score.py`.

---

## 1. Why it exists

Four figures reached the screen as `72% confidence`, beside KPIs the engine had
computed from the fact table:

| Where | Field | Rendered at |
|---|---|---|
| Specialist finding | `FINDING_SCHEMA.confidence` | investigation node detail, handoff context |
| Investigation synthesis | `SYNTHESIS_SCHEMA.confidence` | `Investigations.tsx` — "N% confidence" |
| Intelligence Analyst | `ANALYSIS_SCHEMA.confidence` | `Intelligence.tsx` — "N% confidence" |
| Recommendation | `RECOMMENDATION_SCHEMA.confidence` | `panels.tsx`, `RecommendationHandoffCard.tsx` |

All four were integers the language model wrote, on the strength of a sentence
in its prompt telling it what to consider. Nothing computed them, nothing
checked them, and nothing on screen distinguished them from the measured
figures they sat next to.

This is the same defect the project had already ruled on twice. B9 removed a
"Confidence Score" tile from the Investigation Progress strip and an
`82–87%` figure from the intelligence answers, on the grounds recorded in
`frontend/src/types/orchestration.ts`:

> No engine in this project produces a confidence figure.

`backend/tests/test_upstream_truthfulness.py::test_no_confidence_figure_is_served`
enforces that — but it scans the static seed endpoints, and the live agent path
is the one route it does not reach. So the rule held everywhere except where
the agents actually run.

There were two possible resolutions: delete the field, or make an engine that
produces one. This document specifies the second.

---

## 2. What the score measures — and what it does not

**It scores the EVIDENCE BASE an agent worked from.** Four questions, all
answerable from data the platform already holds:

- How much data stood behind the analysis?
- How much of the scope's money could this lens actually resolve?
- How much of what it was handed was a figure rather than a hole?
- How much of what it wrote traces back to that data?

**It is not a probability that the conclusion is correct.** Nothing in the
module reads the conclusion. Two findings that flatly contradict each other,
drawn from the same table, score identically — because the evidence underneath
them *is* identical. Judging which is right is not something this can do, and a
score that implied otherwise would be the original defect wearing a formula.

**It is not a p-value, a significance test, or a confidence interval.** The
agents receive aggregates, not per-row observations. Without within-group
variance there is no standard error to compute, and no such statistic is
available at this layer. Presenting one would be a fabrication with more
decimal places.

**It is not a forecast quality measure.** This project makes no forecast (B5),
and `test_no_forecast_is_asserted` keeps it that way.

If the UI is ever relabelled, **"Evidence"** is the honest word. The field is
still called `confidence` so that no frontend change was needed to land this.

---

## 3. The components

Each returns a value in `[0, 1]`, or `None` when it cannot be measured for that
agent. **A component that cannot be measured is excluded from the mean, not
scored zero** — the same convention the KPI engine already uses for an
unavailable metric. Every score carries a `confidence_basis` naming the
components used and the ones that were not measurable, so any figure can be
taken apart.

### 3.1 `support` — enough observations behind each compared group

```
observations_per_group = n / groups
support = o / (o + K)     K = OBSERVATIONS_PER_GROUP_HALF_SATURATION = 5
```

`n` is the number of fact rows the investigated scope holds, resolved with
`rows_for` — the same resolver the agents' own data calls go through, so it is
exactly the population they read. `groups` is how many things the lens is
distinguishing between, taken as the longest list of records in its payload.

**This corrects a real mistake, and it is worth stating plainly.** The first
version divided by nothing: it asked how many rows the scope held, with a
half-point at 500, on the reasoning that a bigger sample is better evidence.
That is true of a sample and false of this. An investigation scoped to one
promotion, in one channel, in one week is a **census of the population its
question is about** — all 36 rows *are* the evidence, and there is no larger
sample to be had. Scoring it 0.067 for being specific capped every drill-down
near 40% however good its evidence was, so the figure measured the narrowness
of the question rather than the strength of the answer.

What actually threatens a lens is too few observations behind each of the
groups it is ranking. Thirty-six rows across six mechanics is thin but readable;
the same thirty-six across thirty retailers is one row each and cannot support
a ranking at all. Measuring per group says so, and says it per lens.

| observations per group | support |
|---:|---:|
| 1 | 0.167 |
| 5 | 0.500 |
| 20 | 0.800 |
| 200 | 0.976 |

### 3.2 `breadth` — how much of the money the lens resolved

```
breadth = SUM(trade_spend of groups with a defined ROI) / scope trade spend
```

A lens that can only place a third of the spend into groups is describing a
third of the problem, however clear that third looks.

Trade Spend is the denominator because it is **the one additive money measure
in this engine**. Incremental Sales is re-baselined per selection and does not
sum across groups — `service.breakdown` documents this and computes `share_pct`
on Trade Spend for the same reason — so a share of it would not mean what it
appears to.

Read off the stable shape `star_tools.run_analysis` returns (`groups` beside
`selection_totals`), wherever one appears in the payload. Where a lens holds
several breakdowns, **the weakest one is taken, not the average**: an agent
reasoning across two tables is limited by the thinner of them.

Lenses that return no breakdown at all — individual promotion events, risk
alerts, a monthly series — have no breadth to measure and report `None`.

### 3.3 `completeness` — figures versus holes

```
completeness = defined / (defined + missing)
```

`defined` counts the numbers present. `missing` counts the holes this engine
reports honestly and by name:

- a `null` where a metric belongs
- `"available": false`
- `"computable": false`
- an `"error"` key

The Cannibalization lens is where this matters most. A brand form with no
non-promoted weeks reports `computable: false` rather than a zero, and a
finding resting on three such brand forms is standing on far less than its
prose suggests.

### 3.4 `traceability` — how much of what it wrote came from what it was given

```
traceability = traceable citations / checkable citations
```

The only component that scores the *agent* rather than the data, and the reason
a well-supported lens can still produce a low-scoring finding. Both the chart
bars and the figures in the prose are counted, because a reader takes both for
measurements.

Tracing is done by `app/agents/figures.traceable`, and it applies **two
policies, because a figure in a sentence and a figure that gets drawn are not
the same claim**:

- **Prose** may rescale. ₹32,717,886.4 is correctly written 3.3 Cr, 327.2 L,
  32,717.9 K or 32717886, so every display scale is accepted within a rounding
  tolerance.
- **A chart bar or a delta operand may not.** The popover prints bar values raw
  and never labels a unit, so the bars of one chart cannot declare different
  scales — a bar in crores beside one in rupees renders as comparable when it
  is not — and a delta cannot subtract across two scales either. These are
  checked at the scale they were given.

That split is also what makes the guard worth having. Measured over 60,000
trials against the six specialists' real payloads, and against 601 chart bars
taken from recorded runs:

| | before | now |
| --- | ---: | ---: |
| fabrications wrongly accepted | 7.29% | **1.20%** |
| real chart bars wrongly rejected | 0/601 | 0/601 |

It cost nothing because the allowance it removed was never used: of those 601
real bars, 590 matched at the raw scale and 11 matched at no scale at all. Five
scales meant five chances to collide per supplied value, so a lens holding 88
numbers was far leakier than one holding 8.

The residual ~1.2% is almost entirely the 0.05 absolute tolerance, which exists
to accept the one-decimal-place rounding this project applies everywhere.
Closing it would discard correct figures to catch a rare invented one. **This is
a net, not a proof of provenance.**

Two token shapes are ignored to keep the signal usable, following the precedent
in `decision_brief.unverified_figures`: a bare single digit, and a four-digit
year.

An agent that cited nothing checkable has no ratio to compute and reports
`None`. Silence is not evidence either way.

---

## 4. How the components combine

```
evidence = ( PRODUCT of measured components ) ^ (1 / number of them)
score    = 100 x ( SCORE_FLOOR + evidence x (SCORE_CEILING - SCORE_FLOOR) )
```

An **unweighted geometric mean**, reported on a band. The evidence ratio is
measured on 0..1; the reported score maps it linearly onto
`SCORE_FLOOR`..`SCORE_CEILING` (60–95). No evidence reports the floor, a
perfect base the ceiling, and the ordering between any two runs is the
ordering of their evidence. The ratio itself is in `confidence_basis`.

**Why geometric.** The components are conditions that must all hold, not a
basket where a strong one buys off a weak one. A finding drawn from ample rows
whose figures do not trace back to its table is not "mostly fine"; the
geometric mean drops it hard where an arithmetic mean would hide it. A zero in
any component takes the score to zero, which is the correct reading of
"nothing this agent wrote came from its data".

**Why unweighted.** Any weighting would be a claim about which kind of weakness
matters more, and there is no measurement behind such a claim. Equal weights
are the only choice that needs no justification.

**Why capped.** `completeness` and `traceability` are ratios that legitimately
reach exactly 1.0, and on a wide scope `support` reaches 0.997 — so a
year-scoped run scored **100%**. That is a claim about certainty, not about
evidence, and no evidence base earns it: the method cannot see whether the
conclusion drawn from that evidence is right. Clamped rather than scaled, so
the informative middle of the range is untouched and only the overclaiming top
is pulled in.

---

## 5. The four scores

### 5.1 Specialist finding — `finding_confidence`

All four components. This is the only agent that receives a single bounded
dataset and writes about that dataset alone.

A specialist whose fetch raised never reached a model and gathered no evidence.
It scores **0** explicitly rather than through the components, because
`support` is a property of the *scope* and would otherwise hand a lens that ran
no analysis whatever the run's row count implies.

Findings are scored **before the synthesis call**, because the synthesis prompt
shows each finding's confidence and is told to weigh by it. A measured figure
there is the difference between weighing evidence and weighing assertion.

### 5.2 Investigation synthesis — `synthesis_confidence`

```
synthesis = geomean( geomean(scores of the lenses that ran),
                     lenses that ran / attempted )
```

The synthesis introduces no evidence of its own — it reads the specialists'
conclusions and nothing else — so the first term is the evidence beneath it.
The second is the one thing it cannot see for itself: a run where two of six
lenses failed reached its root cause with two thirds of the panel.

**A lens that could not run is counted once, in the second term only.** A zero
inside a geometric mean takes the whole product to zero, so leaving it in the
first term made five sound findings and one failed fetch read as *no confidence
at all*, while also docking the panel ratio for the same failure. Its absence
is exactly what `panel_completed` measures.

A lens that *did* run and still scored low stays in — including one that scored
zero because nothing it wrote traced back to its table. The synthesis read that
prose and may have built on it.

| panel | score |
|---|---:|
| 6 of 6 strong | 99% |
| 5 strong + 1 thin | 96% |
| 5 strong + 1 failed | 91% |
| 3 strong + 3 failed | 70% |

### 5.3 Intelligence Analyst — `analysis_confidence`

All four components, against the fact bundle it was given.

`breadth` is read from the driver decomposition rather than by walking for
breakdowns: `trade_spend_decomposed / kpis.trade_spend` is exactly the money the
mechanic lens could resolve, and that decomposition is the Analyst's primary
evidence.

`traceability` covers the headline, the narrative, every key insight and every
driver note — scored *after* the measured drivers are attached, so it reads the
drivers as they will actually be served.

### 5.4 Recommendation — `recommendation_confidence`

```
recommendation = diagnosis x traceability x lever_factor
```

**The one score that multiplies rather than taking a geometric mean**, because
here the terms are not peers. The Advisor produces no new evidence — it is
handed a completed diagnosis and the same facts — so the diagnosis is a
**ceiling**, and the other terms can only spend it down.

A geometric mean does the opposite: it pulls upward from a weak term. Under one,
a well-cited recommendation resting on a 20%-confidence diagnosis scored 45%,
which is precisely the claim this score must never make. `test_a_recommendation_
cannot_outrank_its_diagnosis` caught that during development, and pins it.

Two fields are deliberately **not** scored for traceability:

- `proposed_value` — the one number in a recommendation that is *supposed* to
  be new. Checking it against the facts would mark the Advisor down for
  proposing any change at all, which is the entire job.
- `current_value` — measured and substituted by `lever_positions` before this
  runs, so it can only ever trace.

---

## 6. The two stated conventions

Everything above is a ratio of two measured quantities, with two exceptions.
They are declared here rather than buried, because a reader is entitled to know
exactly which numbers were chosen rather than derived.

| Constant | Value | What it is |
|---|---|---|
| `OBSERVATIONS_PER_GROUP_HALF_SATURATION` | 5 | Observations per compared group at which a lens counts as half as supported. There is no count at which promotion data becomes objectively sufficient; 5 is the point where a comparison starts to mean something on this dataset's `(product, channel, week, offer)` grain. |
| `SCORE_CEILING` | 0.95 | The highest score any evidence base can earn, because a perfect set of ratios is still not certainty — see **Why capped** above. |
| `SCORE_FLOOR` | 0.60 | The lowest score a scored evidence base reports. A week-scoped drill-down on a census of its own scope measured ~0.45 and printed "45%", which read as a coin toss when it was the platform's normal working figure; the band puts that figure where it belongs relative to the ceiling. A lens that could not run is not scored at all and stays 0. |
| `UNMEASURED_LEVER_FACTOR` | 0.5 | What a recommendation keeps when the lever it moves has no measured current position. Not zero, because the diagnosis behind it is unaffected by the lever being unmeasurable. Not one, because a recommendation whose starting point is unknown cannot be simulated as written. |

Changing any of them changes every score. `METHOD` (`"evidence_score_v2"`) is
recorded in every `confidence_basis` so a stored run says which version
produced its figures; bump it when a formula changes.

---

## 7. Two related figures fixed at the same time

Both were model arithmetic rendered as measurement, and both are now computed.

### 7.1 Driver weights — `intelligence_engine.roi_gap_decomposition`

The Analyst's `drivers[].weight_pct` was described in its own schema as *"your
judgement of relative contribution"*, and rendered on a card titled **Driver
Decomposition** as a percentage against a proportional bar.

Since `ROI_pct = (Incremental Sales − Trade Spend) / Trade Spend × 100` and
Trade Spend is additive:

```
weighted_roi     = SUM(spend_g x roi_g) / SUM(spend_g)

contribution_pp  = spend_g x (roi_g - target) / SUM(spend)

SUM(contribution_pp) = weighted_roi - target = gap_pp
```

`weight_pct` is `|contribution_pp|` as a share of the total absolute
contribution, apportioned to integers summing to 100 by largest remainder.

Because `spend_g` is in the numerator, a mechanic holding half the budget at a
small shortfall outranks a tiny one at a catastrophic ROI — the ranking every
prompt in the codebase had been asking for in words.

On the real 2025 dataset `weighted_roi_pct` comes out at **34.1%**, identical to
the headline Promotion ROI KPI: the decomposition reconciles with the Command
Center.

`is_primary` is decided by a stated Pareto rule: the adverse drivers that,
taken largest first, account for 80% of the adverse movement.

The Analyst now picks drivers from a **schema enum** of the measured ones and
writes only the prose. A driver it invents is rejected by the API.

### 7.2 Node delta — `figures.computed_delta`

`delta` was free text. `frontend/src/components/investigations/comparisonDelta.ts`
records what came back across the recorded runs:

> a point difference 86% of the time, a relative percentage 6%, and neither 7%
> — all of it labelled "%"

A point difference wearing a percent sign is the wrong reading, and the
frontend already computes around it for two of the six agents. Now the
specialist supplies `delta_basis` — the two figures it is comparing and which
comparison it means — both operands must trace to its own table, and the
subtraction, the sign and the arrow are done in Python.

---

## 8. Worked example

The Geography lens on a single week of one channel: 36 rows in scope, split
across 10 retailer/region groups, with a few unmeasurable entries and every
cited figure traceable.

```
observations per group = 36 / 10           = 3.6
support                = 3.6 / (3.6 + 5)   = 0.419
completeness           = 54 / (54 + 7)     = 0.885
traceability           = 4 / 4             = 1.000

score = 100 x (0.419 x 0.885 x 1.000) ^ (1/3)
      = 100 x (0.371) ^ 0.333
      = 72%
```

The same 36 rows through the Mechanic lens, which distinguishes 5 groups rather
than 10, score 83% — because 7.2 observations per group supports a ranking that
3.6 does not. `confidence_basis` shows which term made the difference.

Measured across the whole panel on that scope: individual findings 61–76%, and
a synthesis of 83%. A year-scoped run sits at the 95% ceiling.
