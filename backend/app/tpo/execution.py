"""Scenario execution -- B2.2.

The first phase in which a hypothetical scenario can actually be evaluated.

    scenario (an approved discount)
        -> app/tpo/response.py resolves the treatment and its uplift BAND
        -> counterfactual WeekRows are synthesized at each end of the band
        -> app/tpo/aggregate.calculate_kpis reads those rows
        -> a low/high result range

THE ONE RULE THIS MODULE OBEYS. It computes no KPI. Not ROI, not Trade Spend,
not Incremental Sales or Units, not Margin, not PEI, not Cannibalization.
It builds rows and hands them to the engine that already owns every one of
those definitions. What it does is answer a different question -- "what would
the rows have looked like under this treatment?" -- and that question has
nothing to do with how a KPI is defined.

WHY SYNTHESIZING ROWS IS THE RIGHT SHAPE. The alternative is a closed-form
`simulated_roi = ...`, which would be a second ROI definition living beside the
validated one and drifting from it. Feeding rows in instead means the scenario
inherits every decision the engine already makes -- the per-(product, channel)
baseline, the Brand-Form widening cannibalization needs, the negative-uplift
policy, the rounding -- for free and identically.

THE RANGE IS NOT A CONFIDENCE INTERVAL. `low` and `high` are the two ends of
the approved uplift band for the chosen treatment. They are not a prediction
interval, not statistical uncertainty and not model confidence: the bands are
the project's approved promotion rules, and B2.1's `response.PROVENANCE` says
exactly that. Nothing here is estimated from variation in the data.

WHAT IS NOT MODELLED, and is not quietly modelled anyway:

  * DURATION. No approved rule maps weeks to uplift. `duration_weeks` is
    accepted, echoed and ignored by the arithmetic. A scenario runs over the
    promotion weeks the scope already contains.
  * SPEND. In the approved economics Trade Spend is b(1+u)P(d+c) -- an OUTPUT
    of a treatment. It is not accepted as an input; it emerges from the
    synthesized rows and is measured by the engine like any other KPI.
  * CANNIBALIZATION RESPONSE. The engine still MEASURES cannibalization on the
    counterfactual rows and that value is returned, but no rule here says how
    cannibalization responds to a discount. See `CANNIBALIZATION_NOTE`.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import formatting as F
from app.tpo import response, service, simulation
from app.tpo.filters import FilterState, baseline_rows_for, rows_for

#: What `low`/`high` mean. Deliberately not the word "confidence".
RANGE_LABEL = "Approved uplift range"

#: Carried on the cannibalization figure of every scenario result.
CANNIBALIZATION_NOTE = (
    "Engine-derived scenario cannibalization: measured by the existing KPI "
    "engine from the counterfactual rows. The approved promotion rules define "
    "no cannibalization response to discount depth, so this is not an "
    "estimated response -- the promoted SKU's volume moves with the treatment "
    "while its neighbours are left exactly as the data recorded them."
)

#: Why duration is echoed but changes nothing.
DURATION_NOTE = (
    "Recorded, not modelled. No approved rule maps promotion duration to "
    "uplift, so the scenario runs over the promotion weeks already present in "
    "the scope."
)

#: Why no spend can be submitted.
SPEND_NOTE = (
    "Trade spend is derived from scenario economics. In the approved rules it "
    "is b(1+u)P(d+c) -- an output of the treatment, not an independent input -- "
    "so it is measured by the KPI engine from the synthesized rows."
)


# --- counterfactual row synthesis ------------------------------------------


#: One promoted observation, identified the way the KPI grain identifies it.
#: Only rows carrying one of these keys are rewritten; everything else in a row
#: set -- the non-promoted baseline rows, and any sibling SKU's own promotion
#: pulled in by the Brand-Form widening -- is passed through untouched.
TargetKey = tuple[str, str, str, str]  # product, channel, week, promotion


def _target_keys(rows: Iterable[A.WeekRow]) -> set[TargetKey]:
    return {
        (r.product_id, r.channel_id, r.week_key, r.promotion_id)
        for r in rows
        if r.is_promoted
    }


def _baselines(rows: Sequence[A.WeekRow]) -> dict[tuple[str, str], float]:
    """Each (product, channel)'s non-promotional baseline, FROM THE ENGINE.

    `aggregate._volume` is the primitive every volume KPI derives from, and
    calling it here means the counterfactual is re-based on exactly the number
    the engine would have measured against. Re-deriving "mean Base_Quantity
    over non-promoted rows" locally would be a second baseline rule, and the
    project has already been bitten once by a baseline computed two ways
    (see DEV.md on the per-channel keying).
    """
    return {
        (p.product_id, p.channel_id): p.baseline_average
        for p in A._volume(rows).products
    }


@dataclass(frozen=True)
class Synthesis:
    rows: tuple[A.WeekRow, ...]
    #: Promoted rows that could not be re-based because their (product,
    #: channel) has no non-promoted row in this set to form a baseline from.
    #: The engine already excludes these from every volume KPI; a scenario
    #: cannot express them at all, so they are dropped and counted rather than
    #: left at their measured values beside counterfactual ones.
    excluded: int


def synthesize(
    rows: Sequence[A.WeekRow],
    targets: set[TargetKey],
    baselines: dict[tuple[str, str], float],
    uplift: float,
    discount: float,
    cost_rate: float = None,  # type: ignore[assignment]
) -> Synthesis:
    """Rewrite the targeted promoted rows as they would look under `uplift`
    and `discount`; pass everything else through unchanged.

    `baselines` is supplied rather than derived from `rows`, and that is
    load-bearing. Under an Offer filter the SELECTION contains promoted rows
    only -- that is the whole reason `filters.baseline_rows_for` exists -- so
    deriving baselines from whatever set is being rewritten would find none and
    silently drop every row. One baseline map, computed once from the
    baseline-widened set, is used for all three sets.

    THE ARITHMETIC, and why each line is what it is. For a row covering `n`
    transactions of one (product, channel, week, offer), with `b` the engine's
    per-transaction baseline and `P` the row's list price:

        quantity        = b . n . (1 + u)      the treatment's volume
        price           = P . (1 - d)          the treatment's price
        actual_revenue  = quantity . price
        base_revenue    = quantity . P         the same volume at list
        discount_value  = base_revenue - actual_revenue
        promotion_cost  = c . base_revenue     the standing overhead
        total_cost      = unit_cost . quantity COGS follows volume
        base_quantity   = quantity             Base_Quantity == Actual_Quantity
                                               on every promoted row in this
                                               dataset; verified, not assumed

    `actual_price_sum` is the SUM of per-transaction prices, so it is
    `price . n` -- the engine reads it to value each promoted row at its own
    price rather than a pooled one.

    Nothing here computes a KPI: Trade Spend is not summed, ROI is not divided.
    The row simply records what it would have recorded, and the engine reads it.
    """
    if cost_rate is None:
        cost_rate = config.PROMOTION_COST_RATE

    out: list[A.WeekRow] = []
    excluded = 0

    for row in rows:
        key = (row.product_id, row.channel_id, row.week_key, row.promotion_id)
        if not row.is_promoted or key not in targets:
            out.append(row)
            continue

        baseline = baselines.get((row.product_id, row.channel_id))
        if baseline is None or not row.base_quantity or not row.actual_quantity:
            excluded += 1
            continue

        n = row.transaction_count
        list_price = (row.actual_revenue + row.discount_value) / row.base_quantity
        unit_cost = row.total_cost / row.actual_quantity

        quantity = baseline * n * (1 + uplift)
        price = list_price * (1 - discount)
        base_revenue = quantity * list_price
        actual_revenue = quantity * price

        out.append(
            dataclasses.replace(
                row,
                base_quantity=quantity,
                actual_quantity=quantity,
                actual_revenue=actual_revenue,
                actual_price_sum=price * n,
                discount_value=base_revenue - actual_revenue,
                promotion_cost=cost_rate * base_revenue,
                total_cost=unit_cost * quantity,
            )
        )

    return Synthesis(rows=tuple(out), excluded=excluded)


# --- running the engine over the counterfactual ----------------------------


#: KPI key -> the Insights Hub spec that names and explains it. Read from
#: service.KPI_SPECS so a scenario cannot describe a KPI differently from the
#: way the Insights Hub and the measured baseline describe it.
_SPEC_BY_CARD = {spec.key: spec for spec in service.KPI_SPECS}


def _kpis_from_bundle(bundle: A.KpiBundle, currency: str) -> dict[str, Any]:
    """A KpiBundle in the same seven-key shape /run returns.

    Presentation only. Every value is read off the bundle the engine produced;
    nothing is recomputed, adjusted or defaulted, and a KPI the engine could
    not produce stays null with the engine's own reason.
    """
    out: dict[str, Any] = {}
    for kpi in simulation.SIMULATION_KPIS:
        if kpi.card_key is not None:
            spec = _SPEC_BY_CARD[kpi.card_key]
            metric: A.KpiMetric = getattr(bundle, service._BUNDLE_FIELD[kpi.card_key])
            label, unit, formula = spec.label, spec.unit, spec.formula
            reason = None if metric.value is not None else service._why_unavailable(kpi.card_key, bundle)
            value = metric.value
            if kpi.card_key == "cannibalization_rate":
                # THE EVIDENCE FLOOR, and only the floor. A scenario's rate is
                # reported on the same terms as a measured one -- a share
                # computed over one or two comparable events is not a rate.
                #
                # The MEASUREMENT LADDER deliberately does not run here.
                # Widening the scope would hand this scenario a different
                # population to re-base, and Phase A models no scenario
                # response over rows the user did not select. The studio shows
                # the resolved MEASURED figure beside these cells instead.
                comparable = bundle.debug.get("comparable_events", 0)
                if comparable < service.CANNIBALIZATION_MIN_EVENTS:
                    value = None
                    reason = service._thin_evidence_reason(comparable, bundle)
        else:
            value = bundle.incremental_quantity.value
            label, unit, formula = kpi.label, kpi.unit, kpi.formula
            reason = None if value is not None else "No promoted rows in this scenario."

        entry: dict[str, Any] = {
            "key": kpi.key,
            "label": label,
            "unit": unit,
            "value": value,
            "display_value": simulation._display(value, unit, currency),
            "available": value is not None,
            "unavailable_reason": reason,
            "formula": formula,
        }
        if kpi.key == "cannibalization":
            entry["note"] = CANNIBALIZATION_NOTE
            entry["comparable_events"] = bundle.debug.get("comparable_events", 0)
        out[kpi.key] = entry
    return out


def _evaluate(
    state: FilterState,
    uplift: float,
    discount: float,
    currency: str,
) -> tuple[dict[str, Any], int]:
    """One end of the band: synthesize, then hand the rows to the engine.

    The three row sets mirror `service._bundle` exactly -- the selection, the
    baseline-widened set the volume chain reads, and the Brand-Form widened set
    cannibalization needs -- because a scenario has to be scoped the same way a
    measurement is, or the two are not comparable.

    NO COMPARISON PERIOD is passed. A hypothetical has no last year; comparing
    a counterfactual against real prior-year trading would be a growth figure
    about nothing, so every delta on the bundle stays undefined.
    """
    rows = rows_for(state)
    volume_rows = baseline_rows_for(state)
    # Both widenings, exactly as `service._bundle` resolves them -- the Brand
    # Form for the neighbours, and `baseline_rows_for` for the non-promoted
    # rows every baseline is derived from. A scenario has to be scoped the same
    # way a measurement is, and a scenario scope names a promotion by
    # definition, so the un-widened set holds no non-promoted row at all.
    widened = state.widened_to_brand_form()
    family_rows = baseline_rows_for(widened)

    # Targets are taken from the SELECTION. A sibling SKU's own promotion,
    # pulled in only by the Brand-Form widening, is not this scenario's
    # promotion and keeps its measured values.
    targets = _target_keys(rows)

    # ONE baseline map for all three sets, from the baseline-widened set. The
    # selection alone cannot supply it under an Offer filter -- it holds no
    # non-promoted row -- and a per-set map could also re-base the same
    # (product, channel) two different ways.
    baselines = _baselines(volume_rows)

    cf_rows = synthesize(rows, targets, baselines, uplift, discount)
    cf_volume = synthesize(volume_rows, targets, baselines, uplift, discount)
    cf_family = (
        synthesize(family_rows, targets, baselines, uplift, discount)
        if family_rows
        else Synthesis((), 0)
    )
    # `targets` come from the selection, so the siblings the widening brought
    # in keep their measured values and only this scenario's own promoted rows
    # are re-based.

    bundle = A.calculate_kpis(
        cf_rows.rows,
        (),
        family_rows=cf_family.rows,
        previous_family_rows=(),
        promoted_products=frozenset(state.product) if state.product else None,
        volume_rows=cf_volume.rows,
        previous_volume_rows=(),
    )
    return _kpis_from_bundle(bundle, currency), cf_rows.excluded


# --- the endpoint payload --------------------------------------------------


class NoApplicableRows(ValueError):
    """The scope holds nothing a treatment could be applied to."""


def simulate(
    state: FilterState,
    scenario_id: str,
    discount_pct: float,
    duration_weeks: float | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """Execute one hypothetical scenario over one scope.

    Raises `response.UnapprovedDiscount` for a discount depth no approved
    treatment defines, and `NoApplicableRows` when the scope contains no
    promoted row to re-base. Neither returns a zeroed result: a scenario that
    could not run has no numbers, and saying so is the answer.
    """
    currency = F.normalise_currency(currency)
    rule = response.get_treatment_response(discount_pct)  # raises if unapproved

    rows = rows_for(state)
    if not rows:
        raise NoApplicableRows("This scope selects no sales rows, so there is nothing to simulate.")
    if not any(r.is_promoted for r in rows):
        raise NoApplicableRows(
            "Nothing in this scope was promoted, so there is no promotion for a "
            "treatment to replace. Select a scope containing a promotion."
        )

    low_kpis, low_excluded = _evaluate(state, rule.uplift_low, rule.discount_pct / 100, currency)
    high_kpis, high_excluded = _evaluate(state, rule.uplift_high, rule.discount_pct / 100, currency)

    return {
        "scenario_id": scenario_id,
        # B2.2 is the first phase in which this status is legitimate: it is set
        # here, on the way out of an execution that actually happened.
        "status": "simulated",
        "kind": "hypothetical",
        "treatment": rule.treatment,
        "discount_pct": rule.discount_pct,
        "uplift": {"low": rule.uplift_low, "high": rule.uplift_high},
        "breakeven_uplift": rule.breakeven_uplift,
        "headroom": {"low": rule.headroom_low, "high": rule.headroom_high},
        "range_label": RANGE_LABEL,
        "result": {
            "low": {"uplift": rule.uplift_low, "kpis": low_kpis},
            "high": {"uplift": rule.uplift_high, "kpis": high_kpis},
        },
        "levers": {
            "discount_pct": {"value": rule.discount_pct, "modelled": True},
            "duration_weeks": {"value": duration_weeks, "modelled": False, "note": DURATION_NOTE},
            "spend_amount": {"value": None, "derived": True, "note": SPEND_NOTE},
        },
        "scope": {
            "period": F.period_label(state.year, state.month),
            "filters_applied": state.applied(),
            "row_count": len(rows),
            "promoted_row_count": sum(1 for r in rows if r.is_promoted),
            "excluded_rows": low_excluded,
            "excluded_reason": (
                "Promoted rows whose (product, channel) has no non-promoted row to "
                "form a baseline from cannot be re-based, and are excluded from the "
                "scenario."
                if low_excluded
                else None
            ),
        },
        "provenance": {
            "response_rule": response.PROVENANCE,
            "treatment": rule.treatment,
            "discount_pct": rule.discount_pct,
            "uplift_low": rule.uplift_low,
            "uplift_high": rule.uplift_high,
            "promotion_cost_rate": rule.promotion_cost_rate,
            "kpi_engine": "app/tpo/aggregate.calculate_kpis",
            "method": (
                "Counterfactual WeekRows synthesized at each end of the approved "
                "uplift band and passed through the existing validated KPI engine. "
                "No KPI is computed in the simulation service."
            ),
            "range_label": RANGE_LABEL,
        },
        "meta": {
            "currency": currency,
            "base_currency": config.BASE_CURRENCY,
            "target_roi": config.PROMOTION_TARGET_ROI,
            "phase": "B2.2",
        },
    }
