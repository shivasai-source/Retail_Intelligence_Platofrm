"""Module adapters — one authoritative result, one `ReportDoc`.

THE ONE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE. An adapter receives a
SCOPE (a `FilterState` plus whatever control values the screen was set to) and
calls the SAME service function the screen's own endpoint calls. It then copies
figures across. It never computes one.

    app/tpo/*  ->  the endpoint the screen used   ->  the screen
               ->  the adapter below              ->  ReportDoc -> xlsx / pdf

So the export cannot disagree with the screen: both are downstream of the same
call. Nothing here divides, multiplies or compares two KPIs to derive a third —
grep this file for arithmetic and you will find rounding for display and nothing
else.

WHY THE SCOPE TRAVELS AND THE RESULTS DO NOT. The client posts what it SELECTED,
not what it was shown. That is deliberate: a client that posted its own numbers
could put anything in a report carrying this project's name, and no amount of
review would catch it. Posting the scope and re-running the authoritative service
makes a fabricated figure impossible by construction.

WHAT IS NOT EXPORTED. Debug blocks, internal ids that mean nothing to a reader,
and anything a screen does not itself show. See `service.py` for the module
registry and the filename rules.
"""

from __future__ import annotations

from typing import Any

from app.tpo import decision as decision_service
from app.tpo import execution, formatting as F, optimization, rescue, service, simulation
from app.tpo.filters import DIMENSIONS, FilterState
from app.tpo.loader import MONTHS, get_store

from app.reports.model import Column, KpiEntry, ReportDoc, Section, Table

# --- shared scope description -----------------------------------------------

#: Every filter dimension, in the order a reader expects, with the label the
#: application uses for it. Read from `filters.DIMENSIONS` so a dimension added
#: there cannot silently vanish from a report's Filters block.
_DIMENSION_LABELS: dict[str, str] = {
    "year": "Year",
    "month": "Month",
    "channel": "Channel",
    "retailer": "Retailer",
    "region": "Region",
    "state": "State",
    "city": "City",
    "tier": "Tier",
    "distributor": "Distributor",
    "category": "Category",
    "brand": "Brand form",
    "product": "Product",
    "promotion": "Promotion",
    "promotion_type": "Promotion type",
}
assert set(_DIMENSION_LABELS) == set(DIMENSIONS), "a filter dimension has no report label"


def _channel_names(codes: list[str]) -> str:
    store = get_store()
    return ", ".join(
        store.dims.channels[c].name if c in store.dims.channels else c for c in codes
    )


def _product_names(codes: list[str]) -> str:
    store = get_store()
    names = [
        store.dims.products[p].name.strip() if p in store.dims.products else p for p in codes
    ]
    return ", ".join(names) if len(names) <= 3 else f"{len(names)} products"


def _promotion_names(codes: list[str]) -> str:
    store = get_store()
    return ", ".join(
        store.dims.promotions[p].label if p in store.dims.promotions else p for p in codes
    )


def filter_rows(state: FilterState) -> tuple[tuple[str, str], ...]:
    """Every dimension named, EVEN WHEN UNCONSTRAINED.

    A Filters block that lists only what was set leaves the reader guessing
    whether Region was filtered or forgotten. "All" is an answer; silence is not.
    """
    applied = state.applied()
    out: list[tuple[str, str]] = []
    for dimension in DIMENSIONS:
        label = _DIMENSION_LABELS[dimension]
        value = applied.get(dimension)
        if value is None:
            out.append((label, "All"))
        elif dimension == "year":
            out.append((label, f"{value} ({F.fiscal_label(int(value))})"))
        elif dimension == "month":
            out.append((label, MONTHS[int(value) - 1]))
        elif dimension == "channel":
            out.append((label, _channel_names(list(value))))
        elif dimension == "product":
            out.append((label, _product_names(list(value))))
        elif dimension == "promotion":
            out.append((label, _promotion_names(list(value))))
        else:
            out.append((label, ", ".join(map(str, value))))
    return tuple(out)


def scope_line(state: FilterState) -> str:
    """The one-line scope for the cover and the running footer."""
    parts = [F.period_label(state.year, state.month)]
    if state.channel:
        parts.append(_channel_names(sorted(state.channel)))
    else:
        parts.append("All channels")
    if state.category:
        parts.append(", ".join(sorted(state.category)))
    if state.product:
        parts.append(_product_names(sorted(state.product)))
    if state.promotion:
        parts.append(_promotion_names(sorted(state.promotion)))
    return " · ".join(parts)


def base_meta(state: FilterState, currency: str, source: str, extra: tuple = ()) -> tuple:
    """The metadata block every report carries.

    `source` is a plain statement of where the numbers came from. It never says
    "real-time" and never says "AI generated" — this application's figures are
    neither, and the brief forbids claiming either.
    """
    return (
        # The selected currency, and — when it is not the base one — the fact that
        # the conversion happens once at display time in app/tpo/formatting.py.
        # Written in words rather than by slicing a symbol out of a formatted
        # string, which produced "base Rs.INR".
        ("Currency",
         "INR" if currency == "INR"
         else f"{currency}, converted once at display from base currency INR"),
        ("Data period", F.period_label(state.year, state.month)),
        ("Source", source),
        ("Report status", "Generated from the current application view"),
        *extra,
    )


def _kpi(card: dict[str, Any], kind: str) -> KpiEntry:
    """One Insights Hub KPI card, copied — not recomputed.

    Every field here exists on the payload the card itself rendered from, and
    the two the SCREEN shows but a naive copy would drop are picked up
    explicitly:

      * `comparable_events` — how much evidence stood behind the rate;
      * `measured_at` — the wider scope's measurement the tile falls back to
        when the selected scope cannot support one. The Insights Hub renders
        it as "2.3% across all channels · 144 comparable events"; a report
        without it says only "not available" and looks like a missing value.
    """
    events = card.get("comparable_events")
    wider = card.get("measured_at") or {}
    evidence = ""
    if isinstance(events, int):
        evidence = f"{events:,} comparable event{'' if events == 1 else 's'}"
    measured_at = ""
    if wider:
        wider_events = wider.get("comparable_events")
        measured_at = (
            f"{wider.get('display_value', '')} across {wider.get('scope_label', '')}"
            + (f" · {wider_events:,} comparable event{'' if wider_events == 1 else 's'}"
               if isinstance(wider_events, int) else "")
        )

    return KpiEntry(
        label=card.get("label", card.get("key", "")),
        value=card.get("value"),
        # THE CARD'S OWN RENDERING. See KpiEntry: re-formatting `value` is how a
        # report turns the screen's "66" into "66.0".
        display=card.get("display_value", ""),
        kind=kind,  # type: ignore[arg-type]
        previous=card.get("previous_value"),
        previous_display=card.get("previous_display", ""),
        delta_display=card.get("delta_display", "") or "",
        delta_basis=card.get("delta_sub", "") or "",
        trend=card.get("trend", "") or "",
        available=bool(card.get("available", True)),
        unavailable_reason=card.get("unavailable_reason") or "",
        evidence=evidence,
        measured_at=measured_at,
    )


#: KPI key -> the column kind it should be formatted as. The Insights Hub's own
#: `unit` field drives this; the map exists only to translate its vocabulary.
_UNIT_KIND = {"currency": "currency", "percent": "percent", "multiple": "multiple",
              "quantity": "units", "score": "number", "number": "number"}


# --- Insights Hub ----------------------------------------------------------


def command_center(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The Insights Hub, as the six cards, the risk summary and the alerts.

    `service.kpis` and `service.risk_alerts` are the SAME functions
    `/api/command-center/kpis` and `/risk-alerts` call. No formula is repeated.
    """
    kpis = service.kpis(state, currency)
    alerts = service.risk_alerts(state, currency, limit=int(options.get("alert_limit", 200)))
    mix = service.promotion_mix(state, currency)
    top = service.top_promotions(state, currency, limit=int(options.get("top_limit", 20)))

    cards = kpis["kpis"]
    entries = tuple(
        _kpi(card, _UNIT_KIND.get(card.get("unit", "number"), "number"))
        for card in cards.values()
    )

    counts = alerts.get("counts") or {}
    rows = alerts.get("alerts") or []

    # THE ALERT TOTAL IS THE SUM OF THE BANDS, AND NEVER A ROW COUNT.
    #
    # This used to read `counts.get("total", len(rows))`. `service.risk_alerts`
    # returns no "total" key -- its counts are critical/high/medium alongside
    # target_achieved and total_events -- so the fallback was taken on EVERY
    # export, and `rows` is the alert list already truncated to `alert_limit`
    # (200 above). The report therefore printed its own page size as the alert
    # population: "Total alerts 200" directly beneath "Critical 897 · High 350
    # · Medium 323". A reader outside this application has nothing to check that
    # against, which is exactly why it had to be caught here.
    #
    # THE BANDS ARE THE AUTHORITATIVE POPULATION, and they are mutually
    # exclusive by construction: `service._severity` returns exactly one of
    # critical/high/medium for an event, and `service.risk_alerts` files each
    # event into exactly one band. Their sum therefore counts every alert once
    # and no alert twice.
    #
    # IT IS NOT `total_events`. That counts every promotion event in scope,
    # on-target ones included -- the denominator the screen reports as
    # "{target_achieved} of {total_events} at target" -- and it is not an alert
    # count.
    #
    # No alert logic, threshold or band is touched here: the three numbers are
    # read back exactly as the service produced them, and the total is derived
    # from those same three numbers so the summary cannot contradict itself.
    # The scope is the report's own, because these counts come from the single
    # `risk_alerts(state, ...)` call above.
    severities = tuple(
        (label, int(counts.get(key) or 0))
        for label, key in (("Critical", "critical"), ("High", "high"), ("Medium", "medium"))
    )
    total_alerts = sum(count for _, count in severities)

    doc = ReportDoc(
        module="Insights Hub",
        title="Trade Promotion Performance Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Measured from fact_sales by the validated KPI engine "
            "(app/tpo/aggregate.py), through the same endpoints the Insights Hub "
            "screen reads.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Every figure is a measurement of the filtered rows. Deltas compare the "
            "same filters against the previous year; a KPI with no comparable prior "
            "period is reported without one rather than against zero.",
        ),
        filename_stem="",
        landscape=False,
    )

    sections: list[Section] = [
        Section("KPI summary", "kpi", entries,
                note="Values, previous period and delta exactly as the Insights Hub "
                     "cards display them."),
        Section("Risk summary", "kv", (
            *((label, str(count)) for label, count in severities),
            ("Total alerts", str(total_alerts)),
        ), note=f"Alerts matching the current filters. Target ROI "
                f"{kpis['meta'].get('target_roi', '')}."),
    ]

    if mix.get("slices"):
        sections.append(Section(
            "Promotion mix", "table", table=Table(
                columns=(
                    Column("label", "Promotion", "text", 30),
                    Column("type", "Type", "text", 14),
                    Column("trade_spend", "Trade spend", "currency", 18),
                    Column("share_pct", "Share of spend", "percent", 14),
                ),
                rows=tuple(
                    {"label": slice_.get("label"), "type": slice_.get("type"),
                     "trade_spend": slice_.get("spend"), "share_pct": slice_.get("pct")}
                    for slice_ in mix["slices"]
                ),
                title="Trade spend by promotion",
                note=f"Total trade spend {mix.get('total_spend_display', '')}.",
            )))

    if top.get("rows"):
        sections.append(Section(
            "Promotion performance", "table", sheet="Promotion Performance", landscape=True,
            table=Table(
                columns=(
                    Column("promotion", "Promotion", "text", 26),
                    Column("product", "Product", "text", 32),
                    Column("channel", "Channel", "text", 15),
                    Column("period", "Period", "text", 12),
                    Column("trade_spend", "Trade spend", "currency", 16),
                    Column("incremental_sales", "Incremental sales", "currency", 18),
                    Column("roi_multiple", "ROI", "multiple", 11),
                    Column("vs_target", "vs target", "multiple", 14),
                    Column("status", "Status", "status", 16),
                ),
                rows=tuple(
                    {"promotion": r.get("promotion"), "product": r.get("product"),
                     "channel": r.get("channel"), "period": r.get("period"),
                     "trade_spend": r.get("trade_spend"),
                     "incremental_sales": r.get("incremental_sales"),
                     "roi_multiple": r.get("roi_multiple"), "vs_target": r.get("vs_target"),
                     "status": r.get("status")}
                    for r in top["rows"]
                ),
                title=f"{len(top['rows'])} promotion events in the current selection",
            )))

    if rows:
        sections.append(Section(
            "Risk alerts", "table", sheet="Risk Alerts", landscape=True,
            table=Table(
                columns=(
                    Column("severity", "Risk", "status", 11),
                    Column("promotion", "Promotion", "text", 26),
                    Column("product", "Product", "text", 30),
                    Column("channel", "Channel", "text", 15),
                    Column("period", "Period", "text", 12),
                    Column("roi_multiple", "ROI", "multiple", 11),
                    Column("target_roi", "Target", "multiple", 11),
                    Column("gap", "Gap", "multiple", 11),
                    Column("trade_spend", "Trade spend", "currency", 16),
                    Column("at_stake", "At stake", "currency", 16),
                ),
                rows=tuple(_alert_row(a, kpis["meta"].get("target_roi")) for a in rows),
                # THE SAME NUMBER THE SUMMARY PRINTS, and the listing says when it
                # is showing fewer rows than that. The title used to read
                # "{len(rows)} alert(s) matching the current filters" -- true of
                # the table, false of the filters, and the second half of the
                # contradiction the Total alerts row created: a capped listing
                # presented as the whole population.
                title=(
                    f"{len(rows)} of {total_alerts} alert(s) matching the current filters"
                    if len(rows) < total_alerts
                    else f"{len(rows)} alert(s) matching the current filters"
                ),
                note="The currently filtered alerts, not the whole dataset.",
            )))
    else:
        sections.append(Section(
            "Risk alerts", "text",
            ("No promotion in this scope falls below the ROI target, so no alert was "
             "raised. This is a measured result, not an empty table.",)))

    doc.sections = tuple(sections)
    return doc


def _alert_row(alert: dict[str, Any], target: Any) -> dict[str, Any]:
    roi = alert.get("roi_multiple")
    gap = None
    if isinstance(roi, (int, float)) and isinstance(target, (int, float)):
        # Presentation subtraction of two figures the payload already carries,
        # not a KPI derivation: the screen shows the same shortfall.
        gap = round(roi - target, 1)
    return {
        "severity": alert.get("severity"),
        "promotion": alert.get("promotion") or alert.get("title"),
        "product": alert.get("product"),
        "channel": alert.get("channel"),
        "period": alert.get("period") or alert.get("week_key"),
        "roi_multiple": roi,
        "target_roi": target,
        "gap": gap,
        "trade_spend": alert.get("trade_spend"),
        "at_stake": alert.get("at_stake"),
    }


# --- Simulation Studio · Investigation Simulation -----------------------------


def simulation_investigation(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The measured Current Plan, and the simulated scenario beside it.

    MEASURED AND SIMULATED ARE NEVER MERGED. They are two labelled columns of one
    comparison, and the simulated one is reported as the approved uplift BAND it
    is — low and high — because `app/tpo/response.py` refuses to collapse a band
    to a midpoint and this report will not do it either.
    """
    baseline = simulation.run(state, levers=None, scenario_name=None, currency=currency)
    measured = baseline["kpis"]

    discount = options.get("discount_pct")
    scenario_name = str(options.get("scenario_name") or "Scenario")
    simulated: dict[str, Any] | None = None
    sim_error = ""
    if discount is not None:
        try:
            simulated = execution.simulate(
                state, scenario_id=str(options.get("scenario_id") or "scenario"),
                discount_pct=float(discount),
                duration_weeks=options.get("duration_weeks"), currency=currency,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced to the reader, not swallowed
            sim_error = str(exc)

    doc = ReportDoc(
        module="Simulation Studio — Investigation Simulation",
        title="Scenario Simulation Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Current Plan measured from fact_sales by the validated KPI engine. "
            "Simulated values are counterfactual rows synthesized at each end of the "
            "approved uplift band and read by that same engine.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Simulated values are scenario estimates and are not historical actuals.",
            "Low and high are the two ends of the approved promotion treatment's uplift "
            "band. They are not a confidence interval and not statistical uncertainty.",
        ),
    )

    sections: list[Section] = [
        Section("Simulation scope", "kv", (
            ("Period", baseline["scope"].get("period", "")),
            ("Rows in scope", str(baseline["scope"].get("row_count", ""))),
            ("Promoted rows", str(baseline["scope"].get("promoted_row_count", ""))),
            ("Promoted weeks", str(baseline["scope"].get("promoted_weeks", ""))),
        )),
        Section("Scenario", "kv", (
            ("Scenario name", scenario_name),
            ("Status", "Simulated" if simulated else "Not simulated"),
            ("Discount lever",
             F.percent(float(discount)) if discount is not None else "Not set"),
            ("Treatment", simulated["treatment"] if simulated else "—"),
            ("Approved uplift band",
             f"{simulated['uplift']['low'] * 100:.0f}–{simulated['uplift']['high'] * 100:.0f}%"
             if simulated else "—"),
        )),
    ]

    # WHY A SIMULATED FIGURE MAY BE ZERO, stated where the zeros are.
    # `execution.simulate` drops a promoted row whose (product, channel) has no
    # non-promoted week to re-base against -- the engine excludes those from every
    # volume KPI for the same reason. When that removes ALL of them the scenario
    # has nothing left to express, and a column of 0.00 would read as "the
    # treatment earns nothing" rather than "the treatment could not be applied
    # here". The payload already carries the count and the reason; both are
    # surfaced rather than left for the reader to infer.
    if simulated:
        excluded = simulated["scope"].get("excluded_rows") or 0
        promoted = simulated["scope"].get("promoted_row_count") or 0
        if excluded:
            note = simulated["scope"].get("excluded_reason") or ""
            exhausted = promoted and excluded >= promoted
            sections.append(Section(
                "Scenario coverage", "kv", (
                    ("Promoted rows in scope", str(promoted)),
                    ("Rows the treatment could not be applied to", str(excluded)),
                    ("Scenario expressible", "No" if exhausted else "Partially"),
                ),
                note=(
                    (note + " ")
                    + ("Every promoted row in this scope was excluded, so the simulated "
                       "figures below are not a measure of what the treatment would earn "
                       "-- they are what remains after exclusion. Read them with this "
                       "coverage in mind."
                       if exhausted else
                       "The simulated figures below cover the remaining promoted rows only.")
                )))

    order = ("trade_spend", "incremental_units", "incremental_sales", "roi_multiple",
             "margin_percent", "cannibalization", "pei")
    comparison_rows = []
    for key in order:
        card = measured.get(key)
        if card is None:
            continue
        low = high = None
        if simulated:
            low = simulated["result"]["low"]["kpis"].get(key, {}).get("value")
            high = simulated["result"]["high"]["kpis"].get(key, {}).get("value")
        comparison_rows.append({
            "metric": card.get("label", key),
            "measured": card.get("value"),
            "sim_low": low,
            "sim_high": high,
            "unit": card.get("unit", ""),
            "note": card.get("unavailable_reason") or "",
        })

    sections.append(Section(
        "Current Plan vs simulated scenario", "table", sheet="Current vs Simulated",
        table=Table(
            columns=(
                Column("metric", "Metric", "text", 28),
                Column("measured", "Measured (Current Plan)", "number", 22),
                Column("sim_low", "Simulated — low", "number", 20),
                Column("sim_high", "Simulated — high", "number", 20),
                Column("unit", "Unit", "text", 12),
                Column("note", "Note", "text", 34),
            ),
            rows=tuple(comparison_rows),
            title="Measured and simulated, side by side and separately labelled",
            note=("Measured is what the data recorded. Simulated is a counterfactual at "
                  "each end of the approved uplift band."
                  + (f" Simulation not run: {sim_error}" if sim_error else "")),
        )))

    if sim_error:
        sections.append(Section("Simulation not available", "text", (sim_error,)))

    doc.sections = tuple(sections)
    return doc


# --- Simulation Studio · General Optimization --------------------------------


def simulation_general_optimization(state: FilterState, currency: str,
                                    options: dict[str, Any]) -> ReportDoc:
    """The optimizer's own plan, exported — never re-solved.

    `optimization.optimize` is the function `/api/simulation/general-optimization`
    calls. The report runs it once with the constraints the screen was set to and
    prints the plan it returns.
    """
    ceiling = options.get("max_trade_spend")
    if ceiling is None:
        reference = optimization.historical_reference(state)
        ceiling = reference.get("average_trade_spend") or 0.0

    result = optimization.optimize(
        state,
        max_trade_spend=float(ceiling),
        min_discount_pct=float(options.get("min_discount_pct", 0.0)),
        max_discount_pct=float(options.get("max_discount_pct", optimization.MAX_DISCOUNT_PCT)),
        currency=currency,
    )

    scope = result["scope"]
    constraints = result["constraints"]
    doc = ReportDoc(
        module="Simulation Studio — General Optimization",
        title="Trade Spend Optimization Report",
        generated_at="", generated_display="",
        # BUILT FROM THE STATE, not from General Optimization's own
        # `period_label`: that field answers "All Time" for a yearless month --
        # true of a period, wrong as a label for June -- and a report is not the
        # place to change a frozen module's copy.
        scope_line=" · ".join(x for x in (
            (MONTHS[state.month - 1] if state.month else "All months"),
            optimization.years_label(scope.get("years") or optimization.reference_years()),
            scope.get("channel_label", ""),
            scope.get("category_label", ""),
        ) if x),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Allocation produced by app/tpo/optimization.py, the same service the "
            "General Optimization screen calls, over the approved promotion treatments.",
            extra=(("Solver", result["provenance"].get("solver", "")),),
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Optimized values are scenario estimates and are not historical actuals.",
            result["provenance"].get("basis", ""),
            result["provenance"].get("cannibalization", ""),
        ),
        landscape=False,
    )

    sections: list[Section] = [
        Section("Optimization scope", "kv", (
            ("Category", scope.get("category_label", "")),
            ("Channel", scope.get("channel_label", "")),
            ("Month", MONTHS[state.month - 1] if state.month else "All months"),
            ("Reference years", ", ".join(map(str, scope.get("years", [])))),
            ("Products considered", str(scope.get("candidate_count", 0))),
            ("Products excluded", str(scope.get("excluded_count", 0))),
        )),
        Section("Constraints", "kv", (
            ("Maximum trade spend", constraints.get("max_trade_spend_display", "")),
            ("Effective ceiling", constraints.get("effective_max_trade_spend_display", "—")),
            ("Clamped to historical average", "Yes" if constraints.get("clamped") else "No"),
            ("Minimum discount", F.percent(constraints.get("min_discount_pct"))),
            ("Maximum discount", F.percent(constraints.get("max_discount_pct"))),
            ("Ceiling basis", constraints.get("ceiling_basis", "")),
        )),
    ]

    if result["status"] != "optimized" or not result.get("optimized"):
        doc.empty_reason = result.get("message") or "No plan could be produced."
        doc.headline = f"No plan — {result['status'].replace('_', ' ')}"
        sections.append(Section("Result", "text", (doc.empty_reason,)))
        doc.sections = tuple(sections)
        return doc

    optimized, historical, comparison = (
        result["optimized"], result["historical"], result["comparison"])
    doc.headline = (
        f"{optimized['promoted_candidates']} products promoted · "
        f"{optimized['untouched_candidates']} left at base · "
        f"{optimized.get('budget_used_pct', 0)}% of the ceiling used")

    sections.append(Section(
        "Optimization summary", "table",
        table=Table(
            # A MIXED-UNIT TABLE, so each row says what its numbers are. Units,
            # rupees and percentages cannot share one column format, and a column
            # of bare numbers leaves the reader to guess which is which.
            columns=(
                Column("metric", "Metric", "text", 22),
                Column("unit", "Unit", "text", 10),
                Column("historical", "Historical", "number", 17),
                Column("low", "Optimized low", "number", 17),
                Column("high", "Optimized high", "number", 17),
                Column("displayed", "Optimized (as displayed)", "text", 22),
                Column("change", "Change vs historical", "text", 17),
            ),
            rows=(
                {"metric": "Units", "unit": "units", "historical": historical["units"],
                 "low": optimized["units"]["low"], "high": optimized["units"]["high"],
                 "displayed": optimized["units"]["display"],
                 "change": _pct_text(comparison["units"]["change_pct_low"])},
                {"metric": "Revenue", "unit": currency, "historical": historical["revenue"],
                 "low": optimized["revenue"]["low"], "high": optimized["revenue"]["high"],
                 "displayed": optimized["revenue"]["display"],
                 "change": _pct_text(comparison["revenue"]["change_pct_low"])},
                {"metric": "Trade spend", "unit": currency,
                 "historical": historical["trade_spend"],
                 "low": optimized["trade_spend"]["low"],
                 "high": optimized["trade_spend"]["high"],
                 "displayed": optimized["trade_spend"]["display"],
                 "change": _pct_text(comparison["trade_spend"]["change_pct_high"])},
                {"metric": "Average discount", "unit": "%",
                 "historical": historical["average_discount_pct"],
                 "low": optimized["average_discount_pct"],
                 "high": optimized["average_discount_pct"],
                 "displayed": optimized["average_discount_display"], "change": ""},
            ),
            title="Revenue is reported at the bottom of the approved band; "
                  "trade spend is funded at the top",
        )))

    sections.append(Section(
        "Optimized product plan", "table", sheet="Optimized Plan", landscape=True,
        table=Table(
            columns=(
                Column("brand_form", "Brand form", "text", 26),
                Column("product_id", "Product ID", "text", 14),
                Column("product", "Product", "text", 32),
                Column("channel", "Channel", "text", 15),
                Column("promoted", "Status", "status", 14),
                Column("discount_pct", "Discount", "percent", 11),
                Column("treatment", "Treatment", "text", 12),
                Column("base_units", "Base units", "units", 14),
                Column("units_low", "Optimized units — low", "units", 18),
                Column("revenue_low", "Optimized revenue — low", "currency", 20),
                Column("spend_high", "Trade spend — high", "currency", 18),
            ),
            rows=tuple(
                {
                    "brand_form": r.get("brand_form"),
                    "product_id": r.get("product_id"),
                    "product": r.get("product"),
                    "channel": r.get("channel"),
                    "promoted": "Yes" if r.get("promoted") else "Not promoted",
                    "discount_pct": r.get("discount_pct") if r.get("promoted") else None,
                    "treatment": r.get("treatment") or "—",
                    "base_units": r.get("base_units"),
                    "units_low": r["optimized_units"]["low"],
                    "revenue_low": r["optimized_revenue"]["low"],
                    "spend_high": r["optimized_trade_spend"]["high"],
                }
                for r in result["rows"]
            ),
            title=f"{len(result['rows'])} products · "
                  f"{result['scope'].get('brand_form_count', 0)} brand forms",
            note="The plan the optimizer returned. It was not re-solved for this report.",
        )))

    doc.sections = tuple(sections)
    return doc


def _pct_text(value: Any) -> str:
    if value is None:
        return "—"
    return f"{value:+.1f}%"


# --- Simulation Studio · Target Rescue ---------------------------------------


def simulation_target_rescue(state: FilterState, currency: str,
                             options: dict[str, Any]) -> ReportDoc:
    """The month's target position and the recovery ladder, as Target Rescue
    computed them.

    `rescue.rescue` is the function `/api/simulation/target-rescue` calls.
    """
    target_units = options.get("target_units")
    if target_units is None:
        raise ValueError(
            "Target Rescue needs the monthly unit target that was on screen. "
            "Enter a target before exporting."
        )

    result = rescue.rescue(
        state,
        target_units=float(target_units),
        current_discount_pct=float(options.get("current_discount_pct", 0.0)),
        checkpoint=options.get("checkpoint"),
        max_additional_trade_spend=options.get("max_additional_trade_spend"),
        currency=currency,
    )

    scope = result["scope"]
    doc = ReportDoc(
        module="Simulation Studio — Target Rescue",
        title="Monthly Target Recovery Report",
        generated_at="", generated_display="",
        scope_line=scope.get("scope_summary", scope_line(state)),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Progress measured from fact_sales over the completed business weeks; the "
            "intervention ladder priced by app/tpo/rescue.py over the approved promotion "
            "treatments — the same service the Target Rescue screen calls.",
            extra=(("Cadence", result["cadence"]["label"]),),
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Run-rate projection is a planning indicator, not a forecast.",
            "Simulated recovery values are scenario estimates and are not historical "
            "actuals.",
            result["provenance"]["day_grain"],
        ),
    )

    if result["status"] == "no_data" or not result.get("progress"):
        doc.empty_reason = result.get("message") or "This scope selects no sales rows."
        doc.sections = (Section("Result", "text", (doc.empty_reason,)),)
        return doc

    progress, status, pace, gap = (
        result["progress"], result["target_status"], result["pace"], result["gap"])
    current = result["current_treatment"]
    doc.headline = f"{status['label']} — {status['action']}"
    doc.headline_tone = status["intent"]

    sections: list[Section] = [
        Section("Scope", "kv", (
            ("Year", str(scope.get("year", ""))),
            ("Month", scope.get("month_label", "")),
            ("Channel", scope.get("channel_label", "")),
            ("Category", scope.get("category_label", "")),
            ("Product", scope.get("product_label", "")),
            ("Cadence", result["cadence"]["label"]),
            ("Checkpoint", f"{progress['checkpoint_label']} "
                           f"({progress['checkpoint_type']})"),
        )),
        # A TYPED TABLE, NOT A LIST OF STRINGS. The recipient of a workbook needs
        # to sort, sum and chart these; "50,000 units" in a text cell cannot be.
        # The display string travels alongside so the PDF still reads the way the
        # screen does.
        Section("Target progress", "table", sheet="Target Progress", table=Table(
            columns=(
                Column("metric", "Metric", "text", 30),
                Column("value", "Value", "number", 18),
                Column("unit", "Unit", "text", 12),
                Column("display", "As displayed", "text", 20),
            ),
            rows=(
                {"metric": "Monthly target", "value": progress["target_units"],
                 "unit": "units", "display": progress["target_units_display"]},
                {"metric": "Current quantity (month to date)",
                 "value": progress["units_mtd"], "unit": "units",
                 "display": progress["units_mtd_display"]},
                {"metric": "Target attainment", "value": progress["attainment_pct"],
                 "unit": "%", "display": progress["attainment_display"]},
                {"metric": "Units remaining",
                 "value": None if gap["on_track"] else gap["units"], "unit": "units",
                 "display": "On track" if gap["on_track"] else gap["units_display"]},
                {"metric": "Daily pace", "value": pace["daily_pace"],
                 "unit": "units/day", "display": pace["daily_pace_display"]},
                {"metric": "Projected month-end (run-rate)",
                 "value": pace["projected_month_end"], "unit": "units",
                 "display": pace["projected_month_end_display"]},
                {"metric": "Projected achievement",
                 "value": pace["projected_achievement_pct"], "unit": "%",
                 "display": F.percent(pace["projected_achievement_pct"])},
                {"metric": "Completed business weeks",
                 "value": progress["weeks_completed"], "unit": "weeks",
                 "display": f"{progress['weeks_completed']} of {progress['weeks_total']}"},
                {"metric": "Weeks remaining", "value": progress["weeks_remaining"],
                 "unit": "weeks", "display": str(progress["weeks_remaining"])},
            ),
            title=f"{status['label']} — {status['action']}",
            note="Run-rate projection is a planning indicator, not a forecast.",
        )),
        # SECTION 12C: the two clocks are reported SEPARATELY and each is labelled
        # for what it counts, so a business-week figure can never be read as a
        # calendar day.
        Section("Time position", "kv", (
            ("Analytical checkpoint",
             f"Week {progress['weeks_completed']} of {progress['weeks_total']} "
             f"(completed business weeks)"),
            ("Business-week coverage",
             f"Day {progress['days_elapsed']} of {progress['days_in_month']} "
             f"— days the month's business weeks cover, not calendar days"),
            ("Calendar month length",
             f"{_calendar_days(scope.get('year'), scope.get('month'))} calendar days"),
            ("Weeks remaining", str(progress["weeks_remaining"])),
        ), note=result["provenance"]["days_in_month_basis"]),
        Section("Run-rate", "kv", (
            ("Daily pace", f"{pace['daily_pace_display']} units/day"),
            ("Projected month-end", f"{pace['projected_month_end_display']} units"),
            ("Projected achievement",
             F.percent(pace["projected_achievement_pct"])),
        ), note="Run-rate projection — not a forecast. " + pace["note"]),
        Section("Current treatment", "kv", (
            ("Current discount", current["discount_display"]),
            ("Approved treatment", current["treatment"] or "No treatment"),
            ("Measured depth over completed weeks", current["measured_depth_display"]),
            ("At approved ceiling", "Yes" if current["at_ceiling"] else "No"),
        )),
    ]

    recommendation = result.get("recommendation") or {}
    chosen = recommendation.get("intervention")
    if chosen and chosen.get("kind") != "maintain":
        sections.append(Section("Recommended recovery", "kv", (
            ("Action", chosen["ladder_label"]),
            ("Current treatment", current["discount_display"]),
            ("Recommended treatment",
             f"{chosen['discount_display']}"
             + (f" · {chosen['mechanic']}" if chosen.get("mechanic") else "")),
            ("Expected recovery", f"{chosen['recovery_units']['display']} units"),
            ("Projected month-end", f"{chosen['projected_month_end']['display']} units"),
            ("Additional trade spend", chosen["additional_trade_spend_display"]),
            ("ROI", chosen["roi_display"]),
            ("Margin impact", chosen["margin_display"]),
        ), note=recommendation.get("reason", "")))
    else:
        sections.append(Section("Recommended recovery", "text", (
            recommendation.get("reason", "No intervention recommended."),)))

    if result.get("interventions"):
        sections.append(Section(
            "Intervention comparison", "table", sheet="Interventions", landscape=True,
            table=Table(
                columns=(
                    Column("action", "Action", "text", 30),
                    Column("discount", "Discount / mechanic", "text", 18),
                    Column("units", "Expected units (remaining)", "text", 20),
                    Column("projected", "Projected month-end", "text", 20),
                    Column("achievement", "Target achievement", "percent", 14),
                    Column("reaches", "Reaches target", "status", 13),
                    Column("trade_spend", "Trade spend", "currency", 16),
                    Column("additional", "Additional spend", "currency", 16),
                    Column("incremental_sales", "Incremental sales", "currency", 18),
                    Column("roi", "ROI", "multiple", 11),
                    Column("margin", "Margin impact", "percent", 13),
                ),
                rows=tuple(
                    {
                        "action": r["ladder_label"],
                        "discount": ("Current" if r["kind"] == "maintain"
                                     else (f"{r['mechanic']} · {r['discount_display']}"
                                           if r.get("mechanic") else r["discount_display"])),
                        "units": r["remaining_units"]["display"],
                        "projected": r["projected_month_end"]["display"],
                        "achievement": r["achievement_pct"]["low"],
                        "reaches": "Yes" if r["reaches_target"] else "No",
                        "trade_spend": r["trade_spend"],
                        "additional": r["additional_trade_spend"],
                        "incremental_sales": r["incremental_sales"],
                        "roi": r["roi_multiple"],
                        "margin": r["margin_pct"],
                    }
                    for r in result["interventions"]
                ),
                title=f"Acting on {result['remaining_scope']['opportunity_label']}"
                      if result.get("remaining_scope") else "",
                note="Reaching the target is judged at the BOTTOM of each approved "
                     "uplift band. Bands are reported as ranges, never as a midpoint.",
            )))

    if result.get("evidence"):
        sections.append(Section("Why this recommendation?", "text",
                                tuple(result["evidence"])))

    doc.sections = tuple(sections)
    return doc


def _calendar_days(year: Any, month: Any) -> int:
    """Calendar length of the month, for the Time position block.

    Reported BESIDE the business-week coverage precisely so the two are never
    confused — the brief is explicit that "Day 20 of 36" must not appear when 36
    is business-week coverage.
    """
    import calendar as _cal

    try:
        return _cal.monthrange(int(year), int(month))[1]
    except (TypeError, ValueError):
        return 0


# --- Decision Center ----------------------------------------------------------


def decision_center(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """The current decision record, with its draft semantics preserved.

    TWO WAYS IN, ONE RECORD OUT.

      * `options["decision_record"]` -- a record that ALREADY exists, handed
        over whole. This is what a decision read back out of the store carries:
        the stored bytes, which must be exported exactly as they were saved.
        Re-assembling one from a live dataset would silently republish a
        historical decision at today's numbers, which is the one thing the
        dataset fingerprint exists to prevent.
      * `options["record"]` -- the four Simulation Studio payloads, assembled
        here by `app/tpo/decision.build_record`, the SAME function
        `/api/decision/record` calls. This is the live path.

    Either way this adapter decides nothing about approval -- it prints what the
    record says, and the record says this project has no approval criteria.
    """
    board = options.get("comparison_board")
    assembled = options.get("decision_record")
    if isinstance(assembled, dict) and assembled.get("expected_impact") is not None:
        record = assembled
    else:
        payloads = options.get("record") or {}
        required = ("context", "simulation", "recommendation", "risk")
        missing = [k for k in required if not payloads.get(k)]
        if missing:
            # A COMPARISON IS A REPORTABLE THING ON ITS OWN.
            #
            # Decision Center now holds several candidate scenarios, and only
            # those from Simulation Studio can become a governed record -- the
            # optimizer, Target Rescue and the measured plan produce none of the
            # four payloads `build_record` needs. Refusing to export the board
            # because of that would mean the comparison the user is actually
            # looking at is the one thing they cannot take away.
            if isinstance(board, dict) and board.get("scenarios"):
                return _comparison_only_doc(state, currency, board)
            raise ValueError(
                "A decision record needs the Simulation Studio results it is assembled "
                f"from. Missing: {', '.join(missing)}. Open the decision in Decision "
                "Center before exporting."
            )

        record = decision_service.build_record(
            context=payloads["context"],
            scenario=payloads["simulation"],
            recommendation=payloads["recommendation"],
            risk=payloads["risk"],
            weekly=payloads.get("weekly"),
            comparison=payloads.get("comparison"),
            baseline=payloads.get("baseline"),
        )

    doc = ReportDoc(
        module="Decision Center",
        title="Decision Record",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Assembled by app/tpo/decision.py from the Simulation Studio results the "
            "screen already holds. Nothing is recalculated when a record is assembled.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Decision status reflects the current application record and does not imply "
            "approval unless explicitly shown.",
            "Simulated values are scenario estimates and are not historical actuals.",
        ),
    )
    doc.sections = _decision_sections(record, options)
    # The board travels WITH the record when both exist: the record says what
    # is being decided, the comparison says what it was chosen over.
    if isinstance(board, dict) and board.get("scenarios"):
        doc.sections = doc.sections + _comparison_sections(board)
    return doc


def investigation(state: FilterState, currency: str, options: dict[str, Any]) -> ReportDoc:
    """A finished investigation: the question, the agents' answer, and the
    findings that answer rests on.

    THE RUN IS HANDED OVER WHOLE, in `options["run"]`, the way a decision
    record is: it is what the screen is showing, it is the reader's own run
    (the runs store is per user and the Report Center is not, so loading one
    here by id would let any signed-in reader export any run), and nothing
    is re-run. Every sentence and figure below is copied off the run's
    stored synthesis and findings; this adapter computes nothing.

    `options["source_label"]` names the data the agents analysed, exactly as
    the page names it -- "TPO star schema (built-in)" or an upload's filename
    and row count -- because the run record holds only a dataset id.
    """
    run = options.get("run")
    if not isinstance(run, dict) or run.get("status") != "done" or not isinstance(run.get("result"), dict):
        raise ValueError(
            "An investigation report needs a finished run. Ask a question, let the "
            "specialist agents complete, then export."
        )
    result = run["result"]
    synthesis = result.get("synthesis")
    if not isinstance(synthesis, dict):
        raise ValueError(
            "This run produced no answer to report: "
            + str(result.get("refusal") or "the question was out of scope.")
        )
    findings = [f for f in (result.get("findings") or []) if isinstance(f, dict)]
    totals = result.get("totals") or {}
    global_filters = result.get("global_filters") or {}

    def pct(value: Any) -> str:
        return f"{int(value)}%" if isinstance(value, (int, float)) and not isinstance(value, bool) else "—"

    about = [
        ("Question", _text(run.get("question"))),
        ("Investigation type", _text(result.get("investigation_type") or "diagnostic").replace("_", " ").title()),
        ("Data analysed", _text(options.get("source_label") or "TPO star schema (built-in)")),
    ]
    # The week the event ran, when the run was pinned to one. It is a label
    # on the run, not a report dimension (see FilterState), so it is named
    # here rather than in the filter list.
    if global_filters.get("week"):
        about.append(("Week", _text(global_filters["week"])))
    rows = totals.get("rows")
    if isinstance(rows, (int, float)) and not isinstance(rows, bool):
        about.append(("Rows analysed", f"{int(rows):,}"))
    about += [
        ("Specialists run", str(len(findings))),
        ("Findings", str(synthesis.get("insight_count") if synthesis.get("insight_count") is not None else len(findings))),
        ("Confidence", pct(synthesis.get("confidence"))),
    ]

    recommendations = [str(r) for r in (synthesis.get("recommendations") or []) if r]
    actions = Table(
        title="Recommended actions",
        columns=(
            Column("n", "#", "units", 4),
            Column("action", "Action", "text", 90),
        ),
        rows=tuple({"n": i, "action": text} for i, text in enumerate(recommendations, 1)),
        note="In the order the synthesis gave them." if recommendations else "The synthesis made no recommendation.",
    )

    finding_rows = tuple(
        {
            "specialist": _text(f.get("name")),
            "headline": _text(f.get("headline")),
            "body": _text(f.get("body")),
            "evidence": _text(f.get("evidence")),
            "metric": _text(f.get("metric")),
            "delta": _text(f.get("delta")),
            "impact": _text(f.get("impact")).title(),
            "confidence": pct(f.get("confidence")),
        }
        for f in findings
    )
    specialists = Table(
        title="Specialist findings",
        columns=(
            Column("specialist", "Specialist", "text", 18),
            Column("headline", "Finding", "text", 30),
            Column("body", "Detail", "text", 44),
            Column("evidence", "Evidence", "text", 34),
            Column("metric", "Metric", "text", 12),
            Column("delta", "Change", "text", 10),
            Column("impact", "Impact", "status", 8),
            Column("confidence", "Confidence", "text", 10),
        ),
        rows=finding_rows,
        note=(
            "Each specialist analysed one lens of the scoped data and reported what it "
            "found; confidence is the share of its claims the data could verify."
        ),
    )

    doc = ReportDoc(
        module="Investigations",
        title="Promotion Investigation Report",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "The stored result of the specialist-agent run shown on the Investigations "
            "page. Nothing is re-run or recalculated when a report is generated.",
        ),
        headline=_text(synthesis.get("root_cause")),
        headline_tone="warning",
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "Findings are the specialist agents' reading of the scoped data at the time "
            "the investigation ran, and are not a substitute for the underlying figures.",
        ),
    )
    return doc.with_sections(
        Section("Investigation", "kv", tuple(about)),
        Section("Summary", "text", tuple(p for p in (_text(synthesis.get("summary")),) if p)),
        Section("Root cause", "text", tuple(p for p in (_text(synthesis.get("root_cause")),) if p)),
        Section("Recommended actions", "table", table=actions),
        Section("Specialist findings", "table", table=specialists, landscape=True, page_break=True),
    )


def _comparison_only_doc(state: FilterState, currency: str, board: dict[str, Any]) -> ReportDoc:
    """The candidate board on its own, when no governed record exists for it."""
    doc = ReportDoc(
        module="Decision Center",
        title="Scenario Comparison",
        generated_at="", generated_display="",
        scope_line=scope_line(state),
        filters=filter_rows(state),
        meta=base_meta(
            state, currency,
            "Compared in Decision Center from results each module computed. Every figure is "
            "the one its own engine produced and is reprinted here unchanged; the ranking is "
            "the Decision Center's own deterministic rule, stated with the result.",
        ),
        disclaimers=(
            "Generated from the selected TPO Intelligence view and its authoritative "
            "calculation results.",
            "This is a comparison of candidate scenarios, not an approved decision, and it "
            "implies no approval.",
            "Simulated values are scenario estimates and are not historical actuals.",
        ),
    )
    doc.sections = _comparison_sections(board)
    return doc


def _comparison_sections(board: dict[str, Any]) -> tuple[Section, ...]:
    """Print the board exactly as the screen shows it.

    NOTHING IS RECOMPUTED HERE, and nothing is filled in. Each scenario carries
    the display strings its own module formatted; a metric a module does not
    produce arrives as an empty cell and stays empty, because the alternative --
    a zero -- would read as a measurement.
    """
    sections: list[Section] = []
    scenarios = [s for s in board.get("scenarios") or [] if isinstance(s, dict)]
    labels = [str(x) for x in (board.get("metric_labels") or [])]

    sections.append(Section(
        "Scenarios compared", "table",
        table=Table(
            columns=(
                Column("name", "Scenario"),
                Column("source", "Source"),
                Column("scope", "Scope"),
                Column("plan", "Plan"),
            ),
            rows=tuple(
                {
                    "name": _text(s.get("name")),
                    "source": _text(s.get("source")),
                    "scope": _text(s.get("scope")),
                    "plan": _text(s.get("plan")),
                }
                for s in scenarios
            ),
        ),
    ))

    if labels and scenarios:
        # One column per scenario, one row per metric -- the shape on screen.
        columns = [Column("metric", "Metric")]
        for index, s in enumerate(scenarios):
            columns.append(Column(f"s{index}", _text(s.get("name"))))
        rows = []
        for label in labels:
            row: dict[str, Any] = {"metric": label}
            for index, s in enumerate(scenarios):
                metrics = s.get("metrics") or {}
                row[f"s{index}"] = _text(metrics.get(label))
            rows.append(row)
        sections.append(Section("Comparison", "table", table=Table(columns=tuple(columns), rows=tuple(rows))))

    recommendation = board.get("recommendation") or {}
    if recommendation:
        kv: list[tuple[str, str]] = []
        if recommendation.get("name"):
            kv.append(("Recommended scenario", _text(recommendation.get("name"))))
            kv.append(("Source", _text(recommendation.get("source"))))
            kv.append(("Points", _text(recommendation.get("points"))))
            if recommendation.get("tie_break"):
                kv.append(("Tie-break", _text(recommendation.get("tie_break"))))
        else:
            kv.append(("Recommended scenario", "None"))
            kv.append(("Why not", _text(recommendation.get("blocked"))))
        kv.append(("Ranking rule", _text(recommendation.get("rule"))))
        kv.append(("Method", "Deterministic ranking in the Decision Center. No model was called."))
        sections.append(Section("Recommendation", "kv", tuple(kv)))

    why = board.get("why") or {}
    lines = [(f"Leads on", str(x)) for x in (why.get("strengths") or [])]
    lines += [(f"Does not lead on", str(x)) for x in (why.get("caveats") or [])]
    if lines:
        sections.append(Section("Why this plan is recommended", "kv", tuple(lines)))

    return tuple(sections)


def _text(value: Any) -> str:
    """One cell, printed as it is -- never zero-filled and never rounded."""
    return "" if value is None else str(value)


def _decision_sections(
    record: dict[str, Any], options: dict[str, Any] | None = None
) -> tuple[Section, ...]:
    """Flatten the record into sections WITHOUT reinterpreting any of it.

    EVERY STRING BELOW COMES OUT OF THE RECORD. No label is rewritten, no band
    is collapsed to a midpoint, no unavailable metric is filled with a zero and
    no governance verdict is synthesised. Where the record has a reason instead
    of a value, the reason is what is printed -- a blank cell beside an explained
    absence is what makes an export honest rather than merely short.
    """
    options = options or {}
    sections: list[Section] = []

    scenario = record.get("scenario") or {}
    scope = record.get("scope") or {}
    investigation = record.get("investigation") or {}
    storage = options.get("storage") or {}

    # --- 1. what is being decided
    identity: list[tuple[str, str]] = [
        ("Decision ID", _text(storage.get("decision_id")) or "Not saved"),
        ("Version", _text(storage.get("version")) or "Not saved"),
        ("Status", _text(record.get("status"))),
        ("Scenario", _text(scenario.get("name"))),
        ("Treatment", _text(scenario.get("treatment"))),
        ("Discount depth", _text(scenario.get("discount_pct"))),
        ("Investigation", _text(investigation.get("investigation_type")) or "Not specified"),
        ("Investigation question",
         _text(investigation.get("question"))
         or _text(investigation.get("question_unavailable_reason"))
         or "Not recorded"),
        ("Investigation ID",
         _text(investigation.get("investigation_id"))
         or _text(investigation.get("investigation_id_unavailable_reason"))
         or "Not assigned"),
        ("Period", _text(scope.get("period"))),
        ("Rows in scope", _text(scope.get("row_count"))),
        ("Promoted rows", _text(scope.get("promoted_row_count"))),
    ]
    # The same fact the screen shows above the impact figures. A report that
    # printed the zeros without it would be the version that outlives the page.
    if scope.get("excluded_rows"):
        identity.append(("Excluded from scenario", _text(scope.get("excluded_rows"))))
        identity.append(("Exclusion reason", _text(scope.get("excluded_reason"))))
        if scope.get("all_promoted_rows_excluded"):
            identity.append((
                "Note",
                "Every promoted row was excluded, so this scenario had nothing to "
                "compute over. The expected-impact figures below are the absence of a "
                "simulated result, not a measured outcome.",
            ))
    if storage.get("dataset_version"):
        identity.append(("Dataset version", _text(storage.get("dataset_version"))))
        identity.append(("Data freshness", "Stale" if storage.get("stale") else "Current"))
    sections.append(Section("Decision", "kv", tuple(identity)))

    # --- 2. strategy, only the levers the scenario actually carries
    strategy = record.get("strategy") or {}
    if strategy.get("levers"):
        sections.append(Section(
            "Strategy", "table",
            table=Table(
                columns=(
                    Column("lever", "Lever"),
                    Column("current", "Current (measured)"),
                    Column("selected", "Selected"),
                    Column("recommended", "Recommended"),
                    Column("basis", "Basis"),
                ),
                rows=tuple(
                    {
                        "lever": _text(lever.get("label")),
                        "current": (
                            _text(lever.get("current_display"))
                            if lever.get("current_available")
                            else _text(lever.get("current_unavailable_reason"))
                        ),
                        "selected": (
                            _text(lever.get("selected_value"))
                            if lever.get("selected_available")
                            else _text(lever.get("selected_unavailable_reason"))
                        ),
                        "recommended": (
                            (_text(lever.get("recommended_display"))
                             or _text(lever.get("recommended_value")))
                            + (" (measured plan)"
                               if lever.get("recommended_is_measured_plan") else "")
                            if lever.get("recommended_available")
                            else _text(lever.get("recommended_unavailable_reason"))
                        ),
                        "basis": _text(lever.get("note") or lever.get("current_derivation")),
                    }
                    for lever in strategy["levers"]
                ),
                note=_text(strategy.get("note")),
            ),
        ))

    # --- 3. expected impact, BOTH ends of the band
    impact = record.get("expected_impact") or []
    if impact:
        sections.append(Section(
            "Expected impact (simulated)", "table",
            table=Table(
                columns=(
                    Column("metric", "Metric"),
                    Column("low", "Low"),
                    Column("high", "High"),
                    Column("note", "Note"),
                ),
                rows=tuple(
                    {
                        "metric": _text(metric.get("label") or metric.get("metric")),
                        "low": _text(metric.get("display_low")) if metric.get("available") else "",
                        "high": _text(metric.get("display_high")) if metric.get("available") else "",
                        "note": "" if metric.get("available") else _text(metric.get("unavailable_reason")),
                    }
                    for metric in impact
                ),
                note=(
                    "Both ends of the approved uplift range. There is no midpoint and no "
                    "expected value between them, and this is not a confidence interval. "
                    "These are simulated values, not historical actuals."
                ),
            ),
        ))

    # --- 4. scenario comparison, measured baseline beside simulated bands
    comparison = record.get("comparison") or {}
    if comparison.get("available") and comparison.get("metrics"):
        entries = [
            entry for entry in comparison.get("scenarios", [])
            if entry.get("status") != "excluded"
        ]
        columns = [Column("metric", "Metric"), Column("baseline", "Current (measured)")]
        for entry in entries:
            columns.append(Column(
                f"s_{entry.get('scenario_id')}",
                f"{entry.get('name')}{' (selected)' if entry.get('is_selected') else ''}",
            ))
        rows = []
        for metric in comparison["metrics"]:
            baseline_side = metric.get("baseline") or {}
            row = {
                "metric": _text(metric.get("label")),
                "baseline": (
                    _text(baseline_side.get("display_value"))
                    if baseline_side.get("available") else ""
                ),
            }
            by_id = {m.get("scenario_id"): m for m in metric.get("scenarios", [])}
            for entry in entries:
                cell = by_id.get(entry.get("scenario_id")) or {}
                low, high = cell.get("low") or {}, cell.get("high") or {}
                if low.get("available") and high.get("available"):
                    text = f"{low.get('display_value')} - {high.get('display_value')}"
                elif low.get("available"):
                    text = _text(low.get("display_value"))
                else:
                    text = ""
                row[f"s_{entry.get('scenario_id')}"] = text
            rows.append(row)
        sections.append(Section(
            "Scenario comparison", "table", landscape=True,
            table=Table(
                columns=tuple(columns), rows=tuple(rows),
                note=_text(comparison.get("measured_note")),
            ),
        ))

    # --- 5. recommendation, verbatim
    recommendation = record.get("recommendation") or {}
    sections.append(Section("Recommendation", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Recommended scenario", recommendation.get("recommended_scenario_name")
             or recommendation.get("recommended_scenario_id")),
            ("Recommended scenario id", recommendation.get("recommended_scenario_id")),
            ("Is this scenario", "Yes" if recommendation.get("is_this_scenario") else "No"),
            ("Objective", recommendation.get("objective")),
            ("Primary metric", recommendation.get("primary_metric")),
            ("Primary endpoint", recommendation.get("primary_endpoint")),
            ("Reason", recommendation.get("reason")),
            ("Note", recommendation.get("note")),
        )
    )))

    # --- 6. risk and governance, B6's own findings
    governance = record.get("governance") or {}
    sections.append(Section("Risk and governance", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Overall status", governance.get("overall_status")),
            ("Rule", governance.get("overall_status_rule")),
            ("Summary", governance.get("summary")),
        )
    )))
    if governance.get("findings"):
        sections.append(Section(
            "Risk findings", "table",
            table=Table(
                columns=(
                    Column("finding", "Finding"), Column("severity", "Severity"),
                    Column("status", "Status"), Column("reason", "Reason"),
                ),
                rows=tuple(
                    {
                        "finding": _text(f.get("title")),
                        "severity": _text(f.get("severity")),
                        "status": _text(f.get("status")),
                        "reason": _text(f.get("reason")),
                    }
                    for f in governance["findings"]
                ),
            ),
        ))
    if governance.get("governance_gaps"):
        sections.append(Section(
            "Governance considerations", "text",
            tuple(
                f"{gap.get('label')} - {gap.get('statement')}"
                for gap in governance["governance_gaps"]
            ),
            note=(
                "These boundaries are not defined anywhere in this project, so nothing "
                "above is judged against them."
            ),
        ))

    # --- 7. readiness, and why nothing here is approved
    readiness = record.get("readiness") or {}
    states = readiness.get("states") or {}
    sections.append(Section("Decision readiness", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Can be approved", "Yes" if readiness.get("can_be_approved") else "No"),
            ("Reason", readiness.get("reason")),
            ("Recommended", "Yes" if states.get("recommended") else "No"),
            ("Governed", "Yes" if states.get("governed") else "No"),
            ("Ready to review", "Yes" if states.get("ready_to_review") else "No"),
            ("Approved", "Yes" if states.get("approved") else "No"),
            ("Note", readiness.get("states_note")),
        )
    )))
    if readiness.get("blockers"):
        sections.append(Section(
            "Blocking approval", "text",
            tuple(f"{b.get('title')} - {b.get('detail')}" for b in readiness["blockers"]),
        ))
    if readiness.get("unverified"):
        sections.append(Section(
            "Unverified before execution", "text",
            tuple(f"{u.get('title')} - {u.get('detail')}" for u in readiness["unverified"]),
        ))

    # --- 8. provenance
    provenance = record.get("provenance") or {}
    sections.append(Section("Record provenance and limits", "kv", tuple(
        (label, _text(value)) for label, value in (
            ("Assembled from", ", ".join(provenance.get("assembled_from") or [])),
            ("KPI engine", provenance.get("kpi_engine")),
            ("Response rule", provenance.get("response_rule")),
            ("Method", provenance.get("method")),
            ("Persistence", (record.get("meta") or {}).get("persistence_note")),
        )
    )))
    return tuple(sections)
