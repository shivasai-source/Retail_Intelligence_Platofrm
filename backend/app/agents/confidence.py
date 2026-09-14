"""The evidence score behind every `confidence` figure this platform serves.

WHAT THIS REPLACES. Every agent used to be asked for its own confidence, as an
integer between 0 and 100, on the strength of a sentence in its prompt telling
it what to consider. Four separate figures reached the screen that way — a
specialist finding's, the synthesis's, the Intelligence Analyst's and each
recommendation's — and all four rendered as "72% confidence" beside numbers the
KPI engine had computed. Nothing distinguished the measured from the asserted.

WHAT IT IS. A deterministic score over the EVIDENCE BASE an agent worked from:
how much data stood behind it, how much of the scope's money its lens could
actually resolve, how much of what it was handed was defined rather than
missing, and how much of what it wrote traces back to that data. Same inputs,
same score, every time, with no model involved.

WHAT IT IS EMPHATICALLY NOT — and the documentation in docs/CONFIDENCE_SCORE.md
says this at greater length because it is the part that matters:

  * NOT a probability that the conclusion is correct. Nothing here reads the
    conclusion. Two findings that disagree, drawn from the same table, score
    identically, because the evidence under them IS identical.
  * NOT a p-value, a significance test or a confidence interval. The agents are
    given aggregates, not per-row observations, so no within-group variance is
    available and no such statistic can be computed. Presenting one would be
    the same defect this file exists to remove.
  * NOT a forecast quality measure. This project makes no forecast (B5).

WHY A GEOMETRIC MEAN. The components are conditions that must ALL hold, not a
basket where a strong one buys off a weak one. A finding drawn from ample rows,
whose figures do not trace back to its table, is not "mostly fine" — the
geometric mean drops it hard, where an average would hide it. Equal weights
are used deliberately: any weighting would be a judgement about which kind of
weakness matters more, and that judgement has no measurement behind it.

COMPONENTS THAT CANNOT BE MEASURED ARE EXCLUDED, NOT ZEROED. A lens that
returns no group breakdown has no `breadth` to measure; scoring it zero would
punish it for the shape of its own question. The mean is taken over the
components that were measurable and the payload names them, so any score can
be read back to the reason for it. This is the same convention the KPI engine
already uses for an unavailable metric — see `_compact_kpis`.
"""

from __future__ import annotations

from typing import Any

from app.agents.figures import cited_figures, numeric_provenance, traceable

# --- the two stated conventions ---------------------------------------------
#
# Everything else in this module is a ratio of two measured quantities. These
# two are conventions, declared here rather than buried, because a reader is
# entitled to know exactly which numbers were chosen rather than derived.

#: Observations PER COMPARED GROUP at which a lens counts as half as supported
#: as one with unlimited data. A convention, not a measurement.
#:
#: THIS REPLACED A RAW ROW COUNT, WHICH WAS THE WRONG QUESTION. The first
#: version asked how many fact rows the scope held, with a half-point at 500,
#: on the reasoning that a bigger sample is better evidence. That is true of a
#: sample and false of this: an investigation scoped to one promotion, in one
#: channel, in one week is a CENSUS of the population its question is about.
#: All 36 rows are the evidence; there is no larger sample to be had. Scoring
#: it 0.067 for being specific meant every drill-down — the thing this product
#: is for — was capped near 40% however good its evidence was, and the figure
#: measured the narrowness of the question rather than the strength of the
#: answer.
#:
#: What actually threatens a lens is too few observations behind each of the
#: groups it is DISTINGUISHING. Thirty-six rows split across six mechanics is
#: thin but readable; the same thirty-six split across thirty retailers is one
#: row each and cannot support a ranking. So support is measured per group, and
#: 5 is the point where a comparison starts to mean something on this grain of
#: (product, channel, week, offer).
OBSERVATIONS_PER_GROUP_HALF_SATURATION = 5

#: What a recommendation keeps when the lever it moves has no measured current
#: position. A convention. It is not zero because the diagnosis behind the
#: recommendation is unaffected by the lever being unmeasurable, and not one
#: because a recommendation whose starting point is unknown cannot be simulated
#: as written — `lever_positions` said so, and the card shows it.
UNMEASURED_LEVER_FACTOR = 0.5

#: The highest score any evidence base can earn. A convention, and the one that
#: stops this becoming the thing it replaced.
#:
#: `completeness` and `traceability` are ratios that legitimately reach exactly
#: 1.0 — a payload with no holes, an agent every one of whose figures traces —
#: and with a wide scope `support` reaches 0.997. A year-scoped run therefore
#: scored 100%, which is a claim about certainty rather than about evidence, and
#: no evidence base earns it: the method cannot see whether the conclusion drawn
#: from that evidence is right, and says so at the top of this file.
#:
#: Clamped rather than scaled, so the informative middle of the range is
#: untouched and only the overclaiming top is pulled in. The same reasoning the
#: connectors' `InstallProgress` applies to its own bar.
SCORE_CEILING = 0.95

#: The lowest score any evidence base that was scored at all can report. A
#: convention, and the other end of the band the ceiling opens.
#:
#: The evidence ratio underneath is still measured on 0..1 exactly as before;
#: what changed is how it is REPORTED. A week-scoped drill-down on one
#: promotion in one channel -- the thing this product is for -- measured
#: around 0.45 and printed "45% confidence" beside a root cause the panel had
#: reached from a census of its scope, which read as a coin toss when it was
#: the platform's normal working figure. The reported score is therefore the
#: ratio mapped linearly onto FLOOR..CEILING: no evidence at all reports the
#: floor, a perfect base the ceiling, and the ordering between any two runs is
#: unchanged. The ratio itself still travels in `confidence_basis.components`,
#: so a reader can always see the measurement the reported figure came from.
#:
#: A lens that could not run is not "no evidence"; it is no score, and stays
#: an explicit 0 -- see `finding_confidence`.
SCORE_FLOOR = 0.60


def _clamp(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def _report(evidence: float) -> int:
    """The evidence ratio, mapped onto the reported band -- see SCORE_FLOOR."""
    return int(round((SCORE_FLOOR + _clamp(evidence) * (SCORE_CEILING - SCORE_FLOOR)) * 100))


def _evidence_of(confidence: int) -> float:
    """The inverse of `_report`: a reported score back to its evidence ratio,
    for the two scores that read other scores as inputs. Feeding a reported
    figure straight back in would map it onto the band a second time."""
    return _clamp((confidence / 100 - SCORE_FLOOR) / (SCORE_CEILING - SCORE_FLOOR))


def _geometric_mean(components: dict[str, float]) -> float:
    """The mean of the measurable components, or 0.0 when none were."""
    values = [_clamp(v) for v in components.values() if v is not None]
    if not values:
        return 0.0
    product = 1.0
    for value in values:
        product *= value
    return product ** (1.0 / len(values))


#: Bumped when a formula changes, so a stored run says which one produced it.
#: v2: the reported figure is the evidence ratio mapped onto SCORE_FLOOR..
#: SCORE_CEILING rather than 0..SCORE_CEILING.
METHOD = "evidence_score_v2"


def _score(components: dict[str, float | None], **extra: Any) -> dict[str, Any]:
    """One score plus its workings.

    THE WORKINGS TRAVEL WITH THE SCORE. `confidence_basis` is nested rather
    than merged so it cannot collide with a finding's own fields, and it is
    always present: a number a reader cannot take apart is exactly what this
    module replaced, so every score carries the components it came from and
    the list of what could not be measured for it.
    """
    measured = {k: round(_clamp(v), 4) for k, v in components.items() if v is not None}
    unmeasured = [k for k, v in components.items() if v is None]
    return {
        "confidence": _report(_geometric_mean(measured)),
        "confidence_basis": {
            "method": METHOD,
            "components": measured,
            "not_measurable": unmeasured,
            **extra,
        },
    }


# --- the components ----------------------------------------------------------


def comparison_groups(payload: Any) -> int:
    """How many things this lens is distinguishing between.

    The longest list of records anywhere in what it was given: the mechanics in
    a breakdown, the retailers in a geography split, the events in a forensic
    list. An approximation on purpose — the exact figure is not what matters,
    the ORDER OF MAGNITUDE is. Six groups and sixty groups are different
    questions of the same rows, and only the second one can run out of evidence.
    """
    widest = 0

    def walk(node: Any) -> None:
        nonlocal widest
        if isinstance(node, dict):
            for item in node.values():
                walk(item)
            return
        if isinstance(node, (list, tuple)):
            if any(isinstance(item, dict) for item in node):
                widest = max(widest, len(node))
            for item in node:
                walk(item)

    walk(payload)
    return max(1, widest)


def support(rows_in_scope: int | None, groups: int = 1) -> float | None:
    """Whether there are enough observations behind each compared group.

        observations_per_group = rows_in_scope / groups
        support = o / (o + K)

    The standard shrinkage form: monotone, never quite 0 and never quite 1, and
    worth exactly 0.5 at o = K. Used instead of a threshold because there is no
    count at which evidence switches from bad to good, and instead of a raw
    count because a score has to be bounded.

    Divided by the number of groups because that, not the size of the scope, is
    what decides whether a lens can tell its groups apart — see
    `OBSERVATIONS_PER_GROUP_HALF_SATURATION` for the reasoning, which is the
    correction of a real mistake rather than a refinement.
    """
    if rows_in_scope is None or rows_in_scope < 0:
        return None
    per_group = rows_in_scope / max(1, groups)
    return per_group / (per_group + OBSERVATIONS_PER_GROUP_HALF_SATURATION)


def breadth(payload: Any) -> float | None:
    """How much of the scope's Trade Spend this lens actually resolved.

        breadth = SUM(trade_spend of groups with a defined ROI) / scope trade spend

    A lens that can only put a third of the money into groups is describing a
    third of the problem, however clear that third looks. Trade Spend is used
    as the denominator because it is the one additive money measure in this
    engine — Incremental Sales is re-baselined per selection and does not sum
    across groups, so a share of it would not mean what it appears to.

    Read off the stable shape `star_tools.run_analysis` returns (`groups` beside
    `selection_totals`), wherever one appears in the payload. Lenses that return
    no breakdown — individual promotion events, risk alerts, a monthly series —
    have no breadth to measure and report None rather than a fabricated 1.0.
    """
    covered: list[float] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            groups, totals = node.get("groups"), node.get("selection_totals")
            if isinstance(groups, list) and isinstance(totals, dict):
                scope_spend = totals.get("trade_spend")
                if isinstance(scope_spend, (int, float)) and scope_spend > 0:
                    resolved = sum(
                        g.get("trade_spend") or 0.0
                        for g in groups
                        if isinstance(g, dict) and g.get("roi") is not None
                    )
                    covered.append(_clamp(resolved / scope_spend))
            for item in node.values():
                walk(item)
            return
        if isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(payload)
    if not covered:
        return None
    # The WEAKEST breakdown, not the average of them. A lens holding one
    # complete table and one that resolved a tenth of the money is reasoning
    # across both, and the incomplete one is the limit on what it can conclude.
    return min(covered)


def completeness(payload: Any) -> float | None:
    """How much of what the lens was handed is a figure rather than a gap.

        completeness = defined / (defined + missing)

    `defined` counts the numbers actually present. `missing` counts the holes
    the engine reports honestly and by name: a null where a metric belongs, an
    `available: false`, a `computable: false`, an `error`. The Cannibalization
    lens is the one this matters most for — a brand form with no non-promoted
    weeks reports `computable: false` rather than a zero, and a finding resting
    on three such brand forms is standing on much less than its prose suggests.
    """
    defined = 0
    missing = 0

    def walk(node: Any) -> None:
        nonlocal defined, missing
        if isinstance(node, bool):
            return
        if isinstance(node, (int, float)):
            defined += 1
            return
        if node is None:
            missing += 1
            return
        if isinstance(node, dict):
            for key, item in node.items():
                if key in ("available", "computable") and item is False:
                    missing += 1
                    continue
                if key == "error" and item:
                    missing += 1
                    continue
                walk(item)
            return
        if isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(payload)
    total = defined + missing
    return (defined / total) if total else None


def traceability(texts: list[str], supplied: set[float], viz_items: Any = None) -> float | None:
    """How much of what the agent WROTE comes from what it was GIVEN.

        traceability = traceable citations / checkable citations

    The only component that scores the agent rather than the data, and the
    reason a well-supported lens can still produce a low-scoring finding. Both
    the chart bars and the figures in the prose are counted, because both are
    read as measurements. An agent that cited nothing checkable has no ratio to
    compute and reports None — silence is not evidence either way.
    """
    checked = 0
    traced = 0
    for item in viz_items or []:
        if not isinstance(item, dict):
            continue
        checked += 1
        traced += 1 if traceable(item.get("value"), supplied) else 0
    for text in texts:
        for _, value in cited_figures(str(text or "")):
            checked += 1
            traced += 1 if traceable(value, supplied) else 0
    return (traced / checked) if checked else None


# --- the four scores this platform serves ------------------------------------


def finding_confidence(finding: dict[str, Any], rows_in_scope: int | None) -> dict[str, Any]:
    """One specialist finding, scored against the table it was given.

    All four components apply here: this is the only agent that receives a
    single bounded dataset and writes about that dataset alone.

    A specialist whose fetch raised never reached a model and gathered no
    evidence. It scores zero explicitly, rather than through the components,
    because `support` is a property of the SCOPE and would otherwise hand a
    lens that ran no analysis whatever the run's row count implies.
    """
    if finding.get("analysis_failed"):
        return {
            "confidence": 0,
            "confidence_basis": {
                "method": METHOD,
                "components": {},
                "not_measurable": ["support", "breadth", "completeness", "traceability"],
                "reason": "This lens could not run, so it gathered no evidence to score.",
            },
        }
    data = finding.get("analysis_data")
    supplied = numeric_provenance(data)
    return _score({
        "support": support(rows_in_scope, comparison_groups(data)),
        "breadth": breadth(data),
        "completeness": completeness(data),
        "traceability": traceability(
            [finding.get(f) for f in ("metric", "headline", "body", "evidence")],
            supplied,
            finding.get("viz_items"),
        ),
    })


def synthesis_confidence(
    findings: list[dict[str, Any]], attempted: int
) -> dict[str, Any]:
    """The synthesis, scored on the findings beneath it.

        synthesis = geomean( geomean(scores of the lenses that ran),
                             lenses that ran / attempted )

    Two measured terms and no new evidence, because the synthesis introduces
    none: it reads the specialists' conclusions and nothing else. The second
    term is the one thing it cannot see for itself — a run where two of six
    lenses failed reached its root cause with two thirds of the panel, and
    should not read as confidently as one where all six reported.

    The two combine as a geometric mean, like every other score here except
    `recommendation_confidence`, where the diagnosis is a ceiling rather than a
    peer. Neither term is a ceiling on the other: a complete panel of thin
    findings and a thin panel of strong ones are both weakened, neither capped.

    A LENS THAT COULD NOT RUN IS COUNTED ONCE, IN THE SECOND TERM ONLY. It
    scores zero, and a zero inside a geometric mean takes the whole product to
    zero — so leaving it in the first term made five sound findings and one
    failed fetch read as no confidence at all, while also docking the panel
    ratio for the same failure. Its absence is exactly what `panel_completed`
    measures, so that is where it belongs.

    A lens that DID run and still scored low stays in, including one that
    scored zero because nothing it wrote traced back to its table: the
    synthesis read that prose and may have built on it.
    """
    scored = [
        f for f in findings
        if isinstance(f.get("confidence"), int) and not f.get("analysis_failed")
    ]
    evidence = _geometric_mean(
        {str(i): _evidence_of(f["confidence"]) for i, f in enumerate(scored)}
    ) if scored else None
    return _score(
        {
            "findings_evidence": evidence,
            "panel_completed": (len(scored) / attempted) if attempted else None,
        },
        findings_scored=len(scored),
        specialists_attempted=attempted,
    )


def analysis_confidence(
    facts: dict[str, Any], analysis: dict[str, Any]
) -> dict[str, Any]:
    """The Intelligence Analyst, scored against the fact bundle it was given.

    `breadth` is read from the driver decomposition rather than by walking for
    breakdowns: `trade_spend_decomposed` is exactly the money the mechanic lens
    could resolve, and the decomposition is the Analyst's primary evidence.
    """
    supplied = numeric_provenance(facts)
    decomposition = facts.get("drivers") or {}
    scope_spend = (facts.get("kpis") or {}).get("trade_spend")
    decomposed = decomposition.get("trade_spend_decomposed")
    resolved = (
        decomposed / scope_spend
        if isinstance(decomposed, (int, float))
        and isinstance(scope_spend, (int, float))
        and scope_spend > 0
        else None
    )

    texts = [analysis.get("headline"), analysis.get("narrative")]
    for insight in analysis.get("key_insights") or []:
        if isinstance(insight, dict):
            texts += [insight.get("title"), insight.get("detail"), insight.get("impact")]
    for driver in analysis.get("drivers") or []:
        if isinstance(driver, dict):
            texts.append(driver.get("note"))

    return _score({
        "support": support(
            facts.get("rows_in_scope"), len(decomposition.get("drivers") or []) or 1
        ),
        "breadth": resolved,
        "completeness": completeness(facts),
        "traceability": traceability(texts, supplied),
    })


def recommendation_confidence(
    recommendation: dict[str, Any],
    facts: dict[str, Any],
    diagnosis_confidence: int,
) -> dict[str, Any]:
    """One recommendation, which cannot outrank the diagnosis it rests on.

        recommendation = diagnosis x traceability x lever factor

    THE ONE SCORE THAT MULTIPLIES RATHER THAN TAKING A GEOMETRIC MEAN, because
    here the terms are not peers. The Advisor produces no new evidence — it is
    handed a completed diagnosis and the same facts — so the diagnosis is a
    CEILING, and the other terms can only spend it down. A geometric mean does
    the opposite: it pulls upward from a weak term, so a well-cited
    recommendation resting on a 20%-confidence diagnosis scored 45%, which is
    the specific claim this docstring says it must never make.

    Within that ceiling, a recommendation quoting figures that do not trace is
    weaker than one quoting figures that do. The lever factor is the one
    convention: see `UNMEASURED_LEVER_FACTOR`.
    """
    supplied = numeric_provenance(facts)
    simulation = recommendation.get("simulation") or {}
    measured_lever = bool(simulation.get("current_value_measured"))

    components: dict[str, float | None] = {
        "diagnosis": _evidence_of(diagnosis_confidence),
        # `proposed_value` is DELIBERATELY NOT CHECKED. It is the one number in
        # a recommendation that is supposed to be new — the depth to move to,
        # the share to shift. Scoring it against the facts would mark the
        # Advisor down for proposing anything the business is not already
        # doing, which is the entire job. `current_value` is not checked either,
        # for the opposite reason: it is measured and substituted before this
        # runs, so it can only ever trace.
        "traceability": traceability(
            [
                recommendation.get("rationale"),
                recommendation.get("evidence"),
                recommendation.get("expected_impact"),
            ],
            supplied,
        ),
    }
    measured = {k: round(_clamp(v), 4) for k, v in components.items() if v is not None}
    factor = 1.0 if measured_lever else UNMEASURED_LEVER_FACTOR
    product = factor
    for value in measured.values():
        product *= value
    return {
        "confidence": _report(product),
        "confidence_basis": {
            "method": METHOD,
            "components": {**measured, "lever_factor": factor},
            "not_measurable": [k for k, v in components.items() if v is None],
            "lever_has_measured_position": measured_lever,
        },
    }
