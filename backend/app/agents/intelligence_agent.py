"""
Promotion Intelligence agents: Analyst, then Advisor.

Two calls, deliberately sequential rather than one combined call — the Advisor
sees the Analyst's conclusions and recommends against them, instead of forming
opinions and advice simultaneously from raw tables. Diagnosis before
prescription.

Every figure they cite is computed in app/intelligence_engine.py. Neither agent
does arithmetic; they interpret, rank and advise. Recommendations carry
simulation parameters so the Simulation Studio can pick them up directly —
closing the investigate -> diagnose -> simulate loop rather than ending at a
paragraph of advice.

TWO FIGURES USED TO BE EXCEPTIONS TO THAT, AND ARE NOT ANY MORE:

  * `drivers[].weight_pct` was described in the schema as "your judgement of
    relative contribution", and rendered on a card headed "Driver
    Decomposition" as a percentage against a proportional bar. It is now the
    exact contribution each mechanic makes to the ROI gap against target,
    computed by `intelligence_engine.roi_gap_decomposition`. The Analyst
    selects which drivers to lead with and writes what each one means; it is
    not asked for the number, and the schema it is given cannot express one.
  * `simulation.current_value` was prose, and renders as the measured status
    quo in "<current> -> <proposed>" on two pages. It is now replaced with
    `intelligence_engine.lever_positions`, measured for the same scope. The
    proposal stays the Advisor's; the starting point is not its to state.
"""
import json
import re
from typing import Any

from app.agents.client import complete_json
from app.agents.confidence import analysis_confidence, recommendation_confidence

_ANALYSIS_BASE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["headline", "narrative", "key_insights", "drivers", "uncertainties"],
    "properties": {
        "headline": {"type": "string", "description": "One sentence stating the single most important fact."},
        "narrative": {
            "type": "string",
            "description": (
                "3-5 sentences answering the question directly. Mark tone inline: "
                "[r]bad figures[/r], [g]good figures[/g], [n]neutral figures[/n]. "
                "Use \\n between paragraphs. Every number must come from the facts given."
            ),
        },
        "key_insights": {
            "type": "array",
            "description": "3-5 insights, most material first.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "detail", "impact", "trend", "severity"],
                "properties": {
                    "title": {"type": "string", "description": "Under 60 characters"},
                    "detail": {"type": "string"},
                    "impact": {"type": "string", "description": "The quantified effect, e.g. '45.7% of spend at 1.12 ROI'"},
                    "trend": {"type": "string", "enum": ["up", "down", "flat"]},
                    "severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "positive"]},
                },
            },
        },
        # The array is present but carries only a SELECTION and a NOTE. There
        # is deliberately no field here in which a weight, a share or a rank
        # could be written — see `_analysis_schema`.
        "drivers": {
            "type": "array",
            "description": (
                "One entry per measured driver you want to comment on, taken from the "
                "computed decomposition in the facts. You do not rank them and you do "
                "not weight them — both are already measured. Write what each one means."
            ),
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["driver", "note"],
                "properties": {
                    "driver": {"type": "string"},
                    "note": {
                        "type": "string",
                        "description": (
                            "One sentence on what this driver is doing and why it matters. "
                            "Interpretation, not restatement of the figures beside it."
                        ),
                    },
                },
            },
        },
        "uncertainties": {
            "type": "array",
            "items": {"type": "string"},
            "description": "What this analysis cannot determine from the available data. Empty list only if genuinely none.",
        },
        # `confidence` was here, as an integer the Analyst chose. It is now
        # measured from the facts it was given and from how much of what it
        # writes traces back to them — app/agents/confidence.py.
    },
}


def _analysis_schema(driver_names: list[str]) -> dict[str, Any]:
    """The Analyst's schema, with `driver` closed over the measured drivers.

    An ENUM rather than an instruction. Told in prose to pick from a list, a
    model will occasionally coin a driver of its own — "Deep discounting", say —
    which then has no measured contribution to attach and either drops out
    silently or acquires someone else's weight. Constraining the field makes
    the selection checkable by the API instead of by us.

    When nothing could be decomposed the array is pinned empty, because a
    driver with no measured contribution is exactly the figure this rewrite
    exists to remove. `analyse` says so in `uncertainties` instead.
    """
    schema = json.loads(json.dumps(_ANALYSIS_BASE))  # deep copy; the base is shared
    drivers = schema["properties"]["drivers"]
    if driver_names:
        drivers["items"]["properties"]["driver"]["enum"] = driver_names
        drivers["maxItems"] = len(driver_names)
    else:
        drivers["maxItems"] = 0
        drivers["description"] = (
            "Leave this empty. The ROI gap could not be decomposed for this scope, and "
            "an undecomposed driver would carry no measured contribution."
        )
    return schema


RECOMMENDATION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["recommendations", "do_not_do", "expected_combined_impact"],
    "properties": {
        "recommendations": {
            "type": "array",
            "maxItems": 3,
            "description": (
                "Two or three concrete, mutually executable decisions, highest expected "
                "value first. Not monitoring, not further investigation, not warnings."
            ),
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "action", "rationale", "evidence", "expected_impact",
                    "priority", "effort", "simulation",
                ],
                "properties": {
                    "action": {"type": "string", "description": "Imperative and specific: 'Shift Buy3Get1 spend to 10% Discount in Modern Trade'"},
                    "rationale": {"type": "string", "description": "Why this follows from the diagnosis"},
                    "evidence": {"type": "string", "description": "The specific figures that justify it"},
                    "expected_impact": {"type": "string", "description": "What should change, with a number where the data supports one"},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    "effort": {"type": "string", "enum": ["low", "medium", "high"]},
                    # `confidence` was here too, and is now derived from the
                    # diagnosis this rests on — a recommendation cannot be
                    # better evidenced than the analysis behind it.
                    "simulation": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["lever", "current_value", "proposed_value", "scope", "metric_to_watch"],
                        "properties": {
                            "lever": {
                                "type": "string",
                                "enum": ["discount_depth", "mechanic_mix", "spend_allocation", "channel_mix", "product_mix", "promotion_calendar"],
                            },
                            # WRITE THE MEASURED STRING FOR YOUR LEVER, COPIED
                            # FROM `lever_positions` IN THE FACTS. It is
                            # replaced with that string server-side before
                            # anything renders it, so an approximation here is
                            # discarded rather than shown — but copying it
                            # keeps your proposal anchored to the real
                            # starting point rather than a remembered one.
                            "current_value": {
                                "type": "string",
                                "description": (
                                    "The `display` string of this lever's entry in "
                                    "`lever_positions`, copied exactly."
                                ),
                            },
                            "proposed_value": {
                                "type": "string",
                                "description": (
                                    "What you propose it become. Yours to choose — but state "
                                    "ONE unambiguous value where the lever takes one, because "
                                    "a range or a hedge pre-selects nothing in the studio."
                                ),
                            },
                            "scope": {"type": "string", "description": "Where it applies, e.g. 'Modern Trade / South'"},
                            "metric_to_watch": {"type": "string"},
                        },
                    },
                },
            },
        },
        "do_not_do": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Plausible-sounding actions the evidence does NOT support, with the reason. Empty list if none apply.",
        },
        "expected_combined_impact": {"type": "string"},
    },
}

ANALYST_SYSTEM = """You are the Promotion Intelligence Analyst for a trade promotion platform.

You are given a complete, pre-computed factual picture of a promotion portfolio.
Every number was calculated by the platform's KPI engine. Your job is to
interpret it — you never calculate.

How to read the facts:
- roi_multiple is a MULTIPLE of trade spend, quoted to TWO decimals exactly as
  the payload carries it ("1.12", never "1.1" and never a percent sign), and
  `target_roi` is the hurdle it must clear. 1.00 is break-even: an ROI of 1.12
  means the promotion returned far below a 1.50 target, and anything under
  1.00 lost money.
- The saturation curve plots ROI against discount depth. If it declines
  monotonically, deeper discounting is systematically destroying value, and
  `saturation_depth_pct` is where it stops clearing the target.
- `spend_share_pct` matters as much as ROI. A poor return on a large share of
  budget is the story; the same return on 2% of budget is trivia. Always pair
  them.
- Incremental sales are re-baselined per selection, so group figures rank
  contribution — never present them as shares summing to a total.
- `drivers` in the facts is a MEASURED decomposition, not a starting point for
  one. Each entry's `contribution` is that mechanic's exact share, in
  multiples, of the distance between the portfolio's spend-weighted ROI and
  the target, and
  `weight_pct` is that share as a percentage. The formula is stated in the
  payload. `is_primary` is already decided, by the Pareto rule the payload
  names. Read them; do not recompute, re-rank or re-weight them.
- `driver_lenses` decomposes the SAME gap by channel, region, category and
  brand. Comparing lenses tells you where the gap really concentrates — if one
  channel carries most of it while every mechanic looks similar, the mechanic
  reading is the misleading one. Say which lens explains the most.

Rules:
- Cite only numbers present in the facts. Never estimate or extrapolate. There
  is no figure you are expected to work out: if a number is not in the payload,
  it is not available, and saying so is the correct answer.
- CURRENCY: every monetary figure is Indian Rupees. Write ₹ or "INR". Never
  write $ or "dollars" — the figures are not dollars and presenting them as
  such is a factual error.
- The `narrative` field MUST carry tone markup. Wrap every figure or clause in
  [r]...[/r] when it is bad news, [g]...[/g] when it is good, [n]...[/n] when
  it is neutral context. A narrative without markup renders as flat grey text
  and fails its purpose. Example: "ROI is [r]1.34, against a 1.50 target[/r],
  while [g]5% Discount returns 1.78[/g]."
- Weight findings by money at stake, not by how extreme the multiple looks.
- State what you cannot determine. The `uncertainties` field is not optional
  padding — an analysis that admits its blind spots is more useful than one
  that implies completeness it does not have.
- You are not asked for a confidence score and cannot set one. It is measured
  from the evidence you were handed and from how much of what you write traces
  back to it, so a hedge has to be in your words — in `narrative` and in
  `uncertainties` — to reach the reader at all."""

ADVISOR_SYSTEM = """You are the Promotion Intelligence Advisor for a trade promotion platform.

You receive a completed diagnosis and the facts behind it. Your job is to turn
it into actions a commercial team can actually take this quarter.

Rules for a good recommendation:
- Address a PRIMARY driver from the diagnosis. Do not invent new problems.
- Be specific and quantified. "Optimise promotions" is worthless. "Move the
  45.7% of spend on Buy3Get1 toward 10% Discount, which returns 59.5% against
  Buy3Get1's 6.8%" is actionable.
- Prefer reallocating existing spend over asking for more budget — the former
  is usually approvable, the latter usually is not.
- Every recommendation must carry `simulation` parameters so the Simulation
  Studio can model it before anyone commits money.
- The starting point of every lever is MEASURED for you, in `lever_positions`.
  Pick a lever whose entry says `available: true`, and copy its `display`
  string into `current_value` unchanged. Do not describe the status quo from
  memory of the tables — that is the one number in a recommendation a reader
  will assume is a fact rather than a proposal.
- CURRENCY: all figures are Indian Rupees. Write ₹ or "INR", never $.

What is NOT a recommendation — these are the four ways this output goes wrong:
- "Monitor the results", "track performance", "set up a dashboard". That is
  business-as-usual, not a decision. Omit it.
- "Investigate why X is failing". If the data cannot support a remedy, that
  belongs in the diagnosis's uncertainties, not here.
- "Do not do X". That is what `do_not_do` is for. Never phrase a warning as a
  recommendation — it double-counts and pads the list.
- Two actions that draw on the same pot of money. This is the most common
  failure, so check for it explicitly before answering.

  WRONG (these sum to more than the pot):
    1. Shift all ₹357 Cr of Buy3Get1 spend to 10% Discount
    2. Shift ₹95 Cr of Buy3Get1 spend to 15% Discount

  RIGHT (one recommendation, one budget, an explicit split):
    1. Reallocate the ₹357 Cr on Buy3Get1: ₹250 Cr to 10% Discount and
       ₹107 Cr to 15% Discount

  If two of your recommendations name the same source budget, merge them into
  one with the split stated. Recommendations must be independently executable —
  a team should be able to approve one, both, or neither.

Give two or three real decisions rather than four padded ones. A short list
that a team can act on beats a long one they have to triage.

On expected impact, be careful about scale. A mechanic returning a high ROI on
a small share of spend will not necessarily hold that ROI at four times the
volume — the saturation curve is itself evidence that returns fall as a lever
is pushed harder. Frame the upside as directional, or bound it, rather than
projecting the current rate onto a much larger base.

`do_not_do` is important: name the obvious-sounding actions this evidence does
NOT justify, and why. Steering a team away from a plausible mistake is often
worth more than one more suggestion — and it demonstrates the analysis was read
rather than pattern-matched."""


def _prior_block(prior: dict[str, Any] | None) -> str:
    """The investigation this analysis is deepening.

    Promotion Intelligence is downstream of Investigations: the investigation
    establishes WHAT went wrong, and this layer explains the mechanism behind
    it. Handing the Analyst the prior findings is what makes it a second,
    deeper pass rather than an unrelated re-derivation of the same headline.
    """
    if not prior:
        return ""
    syn = prior.get("synthesis") or {}
    findings = [
        f"    - [{f.get('name')}] {f.get('headline')} (confidence {f.get('confidence')})"
        for f in (prior.get("findings") or [])
    ]
    return (
        "\n\nTHE INVESTIGATION YOU ARE DEEPENING\n"
        f"  Question asked: {prior.get('question')}\n"
        f"  Root cause found: {syn.get('root_cause')}\n"
        f"  Summary: {syn.get('summary')}\n"
        f"  Confidence: {syn.get('confidence')}\n"
        "  Specialist findings:\n" + "\n".join(findings)
    )


def _facts_prompt(question: str, facts: dict[str, Any], prior: dict[str, Any] | None = None) -> str:
    return (
        f"QUESTION: {question}\n\n"
        f"SCOPE: {json.dumps(facts.get('scope') or {}) or 'whole business'}"
        f"{_prior_block(prior)}\n\n"
        f"FACTS (all pre-computed):\n{json.dumps(facts, indent=1, default=str)}"
    )


_TONE_TAG = re.compile(r"\[/?[grn]\]")


def _strip_tone(value: Any) -> Any:
    """Remove [r]/[g]/[n] markup from everything except the narrative.

    Only AiAnswerCard parses those tags. Asking for them in `narrative` reliably
    leaks them into insight titles and driver notes too, where they render
    literally as "[r]29.2%[/r]". Stripping server-side is more robust than
    hoping the model confines them, and keeps the tags out of any future
    consumer that doesn't know about them.
    """
    if isinstance(value, str):
        return _TONE_TAG.sub("", value)
    if isinstance(value, list):
        return [_strip_tone(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip_tone(v) for k, v in value.items()}
    return value


def _clean_analysis(analysis: dict[str, Any]) -> dict[str, Any]:
    narrative = analysis.get("narrative")
    cleaned = {k: _strip_tone(v) for k, v in analysis.items()}
    if isinstance(narrative, str):
        cleaned["narrative"] = narrative  # the one field where the tags belong
    return cleaned


#: The fields the Intelligence page's Driver Decomposition card renders. Every
#: one is arithmetic from `intelligence_engine.roi_gap_decomposition`; the
#: model contributes `note` and nothing else.
_DRIVER_FIELDS = ("driver", "weight_pct", "direction", "is_primary")


def _measured_drivers(
    decomposition: dict[str, Any], written: list[dict[str, Any]] | Any
) -> list[dict[str, Any]]:
    """The computed decomposition, carrying the Analyst's notes.

    THE COMPUTED LIST IS THE LIST. Every measured driver is emitted, in
    measured order, whether or not the Analyst chose to comment on it — so the
    weights the card shows are a complete decomposition rather than the subset
    the model found interesting, and they still add up.

    The model's contribution is the `note`. Where it wrote one for a driver,
    that note is used; where it did not, the driver falls back to
    `measured_note`, which the engine built from that driver's own figures. A
    row with no interpretation is worth less than one with it, and worth much
    more than a row invented to fill the gap.
    """
    drivers = decomposition.get("drivers") or []
    notes: dict[str, str] = {}
    for entry in written if isinstance(written, list) else []:
        if not isinstance(entry, dict):
            continue
        name, note = entry.get("driver"), (entry.get("note") or "").strip()
        if isinstance(name, str) and note and name not in notes:
            notes[name] = note

    out: list[dict[str, Any]] = []
    for measured in drivers:
        row = {field: measured[field] for field in _DRIVER_FIELDS}
        row["note"] = _strip_tone(notes.get(measured["driver"]) or measured["measured_note"])
        # Carried through so the card, an export or a reader can check the
        # weight rather than trust it.
        row["contribution"] = measured["contribution"]
        row["trade_spend"] = measured["trade_spend"]
        row["roi_multiple"] = measured["roi_multiple"]
        row["vs_target"] = measured["vs_target"]
        row["share_of_decomposed_spend_pct"] = measured["share_of_decomposed_spend_pct"]
        out.append(row)
    return out


async def analyse(question: str, facts: dict[str, Any], prior: dict[str, Any] | None = None) -> dict[str, Any]:
    system = ANALYST_SYSTEM
    if prior:
        system += """

YOU ARE DEEPENING AN EXISTING INVESTIGATION.

The investigation already established the root cause. Restating it is not your
job and adds nothing. Your job is the MECHANISM and the CONSEQUENCES:

- WHY does the root cause behave this way? The saturation curve, the spend
  concentration, the trend — explain what is actually happening underneath.
- WHERE does it bite hardest? Name the channels, regions, retailers, products
  the investigation did not have room to examine.
- HOW MUCH is it worth? Quantify the gap in money, not only in percentage points.
- Does the deeper data CONFIRM or COMPLICATE the investigation's conclusion? If
  the finer breakdown disagrees with the headline, say so — that is the single
  most valuable thing this second pass can produce.

Your drivers should decompose the root cause into its components, not repeat it
as one line."""
    # The measured decomposition decides what a driver may BE, before the call
    # rather than after it. `facts` always carries `drivers` when the core
    # section was computed, which is every path that reaches this function.
    decomposition = facts.get("drivers") or {"available": False, "drivers": []}
    names = [d["driver"] for d in decomposition.get("drivers") or []]

    analysis = await complete_json(
        system,
        _facts_prompt(question, facts, prior),
        _analysis_schema(names),
        "intelligence_analysis",
        temperature=0.2,
    )
    cleaned = _clean_analysis(analysis)
    cleaned["drivers"] = _measured_drivers(decomposition, analysis.get("drivers"))

    # An empty decomposition is a fact about the scope, not a blank panel. Say
    # why, in the field that already exists for what the analysis cannot do.
    if not cleaned["drivers"]:
        reason = decomposition.get("reason") or (
            "The ROI gap could not be decomposed for this scope."
        )
        uncertainties = cleaned.get("uncertainties")
        cleaned["uncertainties"] = ([*uncertainties] if isinstance(uncertainties, list) else []) + [
            f"No driver decomposition is available. {reason}"
        ]

    # Scored last, so `traceability` reads the drivers as they will actually be
    # served — the measured notes included, the model's invented ones gone.
    cleaned.update(analysis_confidence(facts, cleaned))
    return cleaned


def _apply_measured_levers(
    advice: dict[str, Any], positions: dict[str, Any]
) -> dict[str, Any]:
    """Replace each recommendation's `current_value` with the measured one.

    REPLACED, NOT CHECKED. `current_value` is rendered as plain fact on the
    Intelligence panel and again on the Simulation handoff card — "45.7% of
    spend -> 30%" — where a reader has no way to tell the left-hand side is
    the Advisor's recollection of a table. Verifying it and flagging a
    mismatch would still leave the wrong figure on screen; substituting the
    measured string cannot.

    `proposed_value` is left exactly as written. It is a proposal, not a
    measurement, and `intelligenceHandoff.proposedDiscountPct` on the frontend
    already refuses to read a depth out of anything ambiguous.
    """
    for rec in advice.get("recommendations") or []:
        simulation = rec.get("simulation")
        if not isinstance(simulation, dict):
            continue
        measured = positions.get(simulation.get("lever"))
        if not isinstance(measured, dict):
            # A lever outside the enum: the schema should have prevented it,
            # so say plainly that nothing measured it rather than keeping prose.
            simulation["current_value"] = "Not measured for this scope."
            simulation["current_value_measured"] = False
            continue
        simulation["current_value"] = measured.get("display") or "Not measured for this scope."
        simulation["current_value_measured"] = bool(measured.get("available"))
        simulation["current_value_basis"] = measured.get("basis")
    return advice


async def recommend(question: str, facts: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    primary = [d for d in analysis.get("drivers", []) if d.get("is_primary")]
    positions = facts.get("lever_positions") or {}
    advice = await complete_json(
        ADVISOR_SYSTEM,
        (
            f"QUESTION: {question}\n\n"
            f"DIAGNOSIS\n"
            f"  Headline: {analysis.get('headline')}\n"
            f"  Narrative: {analysis.get('narrative')}\n"
            f"  Primary drivers (measured contributions, not estimates): {json.dumps(primary)}\n"
            f"  Uncertainties: {json.dumps(analysis.get('uncertainties'))}\n"
            f"  Confidence: {analysis.get('confidence')}\n\n"
            "MEASURED CURRENT POSITION OF EVERY LEVER — copy the `display` string of the\n"
            "one you move into `current_value`, and choose a lever marked available:\n"
            f"{json.dumps(positions, indent=1, default=str)}\n\n"
            f"SUPPORTING FACTS:\n{json.dumps(facts, indent=1, default=str)}"
        ),
        RECOMMENDATION_SCHEMA,
        "intelligence_recommendations",
        temperature=0.3,
    )
    advice = _apply_measured_levers(_strip_tone(advice), positions)

    # A RECOMMENDATION CANNOT OUTRANK ITS DIAGNOSIS. Scored after the levers are
    # substituted, because whether the lever has a measured position is one of
    # the terms — see `confidence.recommendation_confidence`.
    diagnosis = analysis.get("confidence")
    for rec in advice.get("recommendations") or []:
        rec.update(
            recommendation_confidence(
                rec, facts, diagnosis if isinstance(diagnosis, int) else 0
            )
        )
    return advice
