"""
The investigation pipeline: plan → specialists (parallel) → synthesis.

Shape of the work:

  1. PLAN      one call. Maps this dataset's real column names onto semantic
               roles, picks the investigation archetype, and chooses which
               specialists are worth running *for this question and these
               columns* (no point running a discount-depth agent on a file
               with no discount column).
  2. AGGREGATE pure pandas, no model. See aggregates.py.
  3. SPECIALISTS  N calls in parallel, one per analysis, each seeing only its
               own aggregate table. Each returns a structured finding.
  4. SYNTHESIS one call. Cross-cutting narrative over all findings. The
               confidence beside it is measured, not written — see
               app/agents/confidence.py.

Graph *structure* (node positions, icon choice, progress arithmetic) is
assembled deterministically in Python afterwards — the model supplies
judgement, not layout. That's what keeps the rendered graph stable.
"""
import asyncio
import math
from typing import Any

import pandas as pd

from app.agents.aggregates import ColumnRoles, build_analysis, overall
from app.agents.client import complete_json
from app.agents.confidence import finding_confidence, synthesis_confidence
from app.agents.figures import (
    computed_delta,
    numeric_provenance,
    prose_figures,
    verified_viz_items,
)

# Icons the Investigations graph already ships with (see icons/icons.ts) —
# the model must choose from these or the node renders blank.
VALID_ICONS = [
    "pricing", "retailer", "tag", "trending", "inventory", "users", "history",
    "cannib", "variance", "layers", "package", "pieChart", "shield", "target",
    "calendar", "flow", "zoomIn", "sparkles",
]
INVESTIGATION_TYPES = ["diagnostic", "optimization", "launch", "strategic"]
MAX_SPECIALISTS = 6

PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["investigation_type", "focus_label", "focus_sub", "column_roles", "specialists"],
    "properties": {
        "investigation_type": {"type": "string", "enum": INVESTIGATION_TYPES},
        "focus_label": {"type": "string", "description": "Short name for what's being investigated, e.g. 'South MT Push'"},
        "focus_sub": {"type": "string", "description": "Period or qualifier, e.g. '(Jan – Jun 25)'"},
        "column_roles": {
            "type": "object",
            "additionalProperties": False,
            "required": ["time", "spend", "revenue", "discount", "baseline", "actual", "dimensions"],
            "properties": {
                "time": {"type": ["string", "null"]},
                "spend": {"type": ["string", "null"]},
                "revenue": {"type": ["string", "null"], "description": "Incremental revenue or sales outcome"},
                "discount": {"type": ["string", "null"]},
                "baseline": {"type": ["string", "null"], "description": "Expected/base volume before promo"},
                "actual": {"type": ["string", "null"], "description": "Realised volume after promo"},
                "dimensions": {"type": "array", "items": {"type": "string"}},
            },
        },
        "specialists": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["key", "name", "desc", "analysis", "dimension", "dimensions", "icon"],
                "properties": {
                    "key": {"type": "string", "description": "short slug, e.g. 'discount_depth'"},
                    "name": {"type": "string", "description": "Title case, e.g. 'Discount Depth Analysis'"},
                    "desc": {"type": "string", "description": "One short line on what it examines"},
                    "analysis": {
                        "type": "string",
                        "enum": ["segment", "segment_discount", "dimension", "discount_band", "time", "correlation"],
                    },
                    "dimension": {"type": ["string", "null"], "description": "Column name when analysis is 'dimension'"},
                    "dimensions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Two or more column names when analysis is 'segment' or 'segment_discount'",
                    },
                    "icon": {"type": "string", "enum": VALID_ICONS},
                },
            },
        },
    },
}

FINDING_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["headline", "body", "evidence", "metric", "delta_basis", "impact", "viz_items"],
    "properties": {
        "headline": {"type": "string", "description": "One line, states the finding"},
        "body": {"type": "string", "description": "1–2 sentences of explanation"},
        "evidence": {"type": "string", "description": "The specific numbers backing it"},
        "metric": {
            "type": "string",
            "description": (
                "Headline figure for the graph node — the number that makes THIS analysis "
                "distinctive, taken from a specific group in your table (e.g. 'Buy3Get1 7.7%'). "
                "NOT the overall/selection total, which every other analysis also sees."
            ),
        },
        # WAS A FREE-TEXT `delta` PLUS A `trend` THE MODEL PICKED. Both are now
        # derived from the two figures named here — see `figures.computed_delta`
        # for the measurements that forced the change.
        "delta_basis": {
            "type": ["object", "null"],
            "additionalProperties": False,
            "required": ["value", "compared_to", "kind", "label"],
            "description": (
                "The comparison behind the delta on your graph node, given as the TWO "
                "FIGURES you are comparing, each copied from your table. Do not subtract "
                "them and do not state the result — the platform computes the difference, "
                "the sign and the arrow. Null when your finding is not a comparison of two "
                "figures, which is better than forcing one."
            ),
            "properties": {
                "value": {"type": "number", "description": "Your subject's figure, copied from the table."},
                "compared_to": {"type": "number", "description": "The figure you are comparing it against, copied from the table."},
                "kind": {
                    "type": "string",
                    "enum": ["percentage_point_gap", "multiple_gap", "relative_change_pct"],
                    "description": (
                        "percentage_point_gap when both figures are already percentages and "
                        "the gap between them is the point (a 13.4% margin against 39.5%). "
                        "multiple_gap when both figures are ROI multiples and the gap between "
                        "them is the point (a 1.12 ROI against a 1.39 norm). "
                        "relative_change_pct when you mean how much smaller or larger one is "
                        "than the other (6,156 units against an expected 6,326)."
                    ),
                },
                "label": {"type": "string", "description": "What it is against, e.g. 'vs whole business'"},
            },
        },
        "impact": {"type": "string", "enum": ["strong", "moderate", "negative", "risk", "data"]},
        # `confidence` was here, as an integer the model chose. It is now
        # measured from the evidence this finding rests on — see
        # app/agents/confidence.py and docs/CONFIDENCE_SCORE.md.
        "viz_items": {
            "type": "array",
            "description": "2–4 bars comparing the key values",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "value", "tone"],
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "number"},
                    "tone": {"type": "string", "enum": ["muted", "accent", "accent2"]},
                },
            },
        },
    },
}

SYNTHESIS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "root_cause", "insight_count", "recommendations"],
    "properties": {
        "summary": {"type": "string", "description": "2–3 sentences answering the question directly"},
        "root_cause": {"type": "string", "description": "The single most likely driver"},
        # KEPT IN THE SCHEMA, DISCARDED ON THE WAY OUT. The strip that renders
        # it is labelled with the number of specialist findings the run
        # produced, which is a property of the run and is counted in
        # `ground_synthesis` — not something the synthesising model is in a
        # position to know, since it never sees how many specialists ran.
        "insight_count": {"type": "integer", "description": "Distinct material insights found"},
        "recommendations": {
            "type": "array",
            "items": {"type": "string"},
            "description": "2–4 concrete actions",
        },
    },
}

PLANNER_SYSTEM = """You are the planning agent for a trade promotion intelligence platform.

Given a business question and the schema of an uploaded dataset, you must:
1. Classify the question into one of the four investigation archetypes.
2. Map the dataset's ACTUAL column names onto semantic roles. Use exact column
   names from the schema, or null when no column fits. Never invent a name.
3. Choose up to %d specialist analyses that fit BOTH the question and the
   available columns. Skip any analysis whose required column is missing.

CHOOSING ANALYSES — this matters more than anything else you do:

Real promotion problems are usually INTERACTIONS, not single-factor effects.
A channel that underperforms only in one region, or only at deep discounts,
looks completely normal in any single-dimension average. If you only break the
data down one column at a time you will miss the actual cause and report noise.

So, when the question names or implies a specific segment (a channel, a region,
a combination), or asks "why did X underperform":
  - ALWAYS include a `segment` analysis across the relevant dimensions.
  - If a discount column exists, ALSO include `segment_discount`, which splits
    those segments by discount depth.
These two find interaction effects. Single-dimension analyses cannot.

Use `dimension` (one column) only for genuinely one-factor questions, and at
most twice. Use `time` for trend/decay questions, `correlation` for "what drives
X" questions. Prefer a spread of analysis kinds over repeating one.

For `segment` and `segment_discount`, put the relevant column names in
`dimensions` (2 or more). For `dimension`, set `dimension` to the one column.

Archetypes: diagnostic (why did X happen), optimization (how do we improve X),
launch (new product/SKU decisions), strategic (portfolio/long-term mix).""" % MAX_SPECIALISTS

SPECIALIST_SYSTEM = """You are a specialist analyst on a trade promotion intelligence platform.

You are given a pre-computed aggregate table — every number in it was calculated
in pandas from the full dataset. Analyse ONLY what the numbers show.

Rules:
- Never invent figures. Every number you cite must appear in the data given.
- ROI is revenue divided by spend. uplift_pct is percentage lift over baseline.
  roi_index is the segment's ROI as a % of overall (100 = on par, 60 = 40% worse).
- Your headline must describe what YOUR table shows. Do not restate the user's
  question as a finding. If your table is broken down by promotional mechanic,
  your headline is about mechanics — not about a region or channel the question
  happened to mention. A headline your own data cannot support is a failure.
- Beware of ranking noise. If the spread between best and worst is small, or the
  segments have few rows, that ordering is probably random variation, not a real
  effect. SAY SO IN THE BODY. You are not asked for a confidence score and
  cannot set one — it is measured from the evidence you were given and from how
  much of what you write traces back to it — so hedging has to be in your words
  to appear at all.
- If the data does not support a strong conclusion, say that plainly. A hedged
  accurate finding beats a confident wrong one.
- viz_items must use real values COPIED from the table. Every bar is checked
  against your table before it is drawn and a value that is not in it is
  discarded, so a bar you worked out rather than read will simply not appear.
- Do NOT subtract, divide or average anything. `delta_basis` takes the two
  figures you are comparing and the platform does the arithmetic; set it to
  null rather than forcing a comparison your table does not contain.
- Keep headline under 60 characters; it renders on a graph node."""

SYNTHESIS_SYSTEM = """You are the lead analyst synthesising specialist findings on a
trade promotion investigation.

Answer the user's actual question directly in the summary. Identify the single
most likely root cause, weighing findings by the confidence and impact shown
against each one. Those confidences are MEASURED — they score the evidence each
specialist worked from and how much of its prose traces back to that evidence —
so a low one means thin ground, not a hesitant author.
Do not introduce numbers that no specialist reported.

Monetary figures are Indian Rupees — write ₹ or "INR", never $.

Never attribute figures to a subject that does not appear in the data. If the
question named something the specialists never found, say so plainly instead of
associating real numbers with it. If findings conflict, say
which is better supported and why.

Weight interaction findings (segment / segment-by-discount) above single-factor
ones. A specific underperforming combination is a far more credible root cause
than a small difference in some column's overall average, which is usually noise.

If no finding is well supported, say the data does not identify a clear cause.
Do not manufacture a root cause to have one. You are not asked for a confidence
figure: the one shown beside your summary is computed from the findings beneath
it and from how much of the panel actually reported."""


def _plan_user_prompt(question: str, profile: dict[str, Any], filename: str) -> str:
    cols = []
    for c in profile["columns"]:
        bits = [f"- {c['name']} ({c['kind']}, dtype={c['dtype']}, nulls={c['null_count']}, unique={c['unique_count']}"]
        if c["kind"] == "numeric":
            bits.append(f", min={c.get('min')}, max={c.get('max')}, mean={c.get('mean')}")
        elif c["kind"] == "categorical" and c.get("top_values"):
            vals = ", ".join(str(v["value"]) for v in c["top_values"][:6])
            bits.append(f", values=[{vals}]")
        elif c["kind"] == "datetime":
            bits.append(f", range={c.get('min')} to {c.get('max')}")
        bits.append(")")
        cols.append("".join(bits))
    return (
        f"QUESTION: {question}\n\n"
        f"DATASET: {filename} — {profile['rows']} rows, {profile['column_count']} columns\n\n"
        f"COLUMNS:\n" + "\n".join(cols)
    )


async def run_pipeline(
    question: str,
    df: pd.DataFrame,
    profile: dict[str, Any],
    filename: str,
    on_event: Any = None,
) -> dict[str, Any]:
    """Execute the full pipeline. `on_event(kind, payload)` is called as
    stages complete so the caller can stream real progress."""

    async def emit(kind: str, payload: dict[str, Any]) -> None:
        if on_event:
            await on_event(kind, payload)

    # ---- 1. Plan -----------------------------------------------------------
    plan = await complete_json(
        PLANNER_SYSTEM,
        _plan_user_prompt(question, profile, filename),
        PLAN_SCHEMA,
        "investigation_plan",
        temperature=0.1,
    )
    valid_columns = {c["name"] for c in profile["columns"]}
    roles = ColumnRoles.from_dict(plan.get("column_roles") or {}, valid_columns)

    # Drop specialists whose analysis can't actually run against these columns.
    specialists: list[dict[str, Any]] = []
    for spec in (plan.get("specialists") or [])[:MAX_SPECIALISTS]:
        kind = spec.get("analysis")
        dims = [d for d in (spec.get("dimensions") or []) if d in valid_columns]
        if kind == "dimension" and spec.get("dimension") not in valid_columns:
            continue
        if kind in ("discount_band", "segment_discount") and not roles.discount:
            continue
        if kind == "time" and not roles.time:
            continue
        if kind == "segment":
            # Needs 2+ real dimensions; fall back to the dataset's own dimension
            # list before discarding an otherwise valid interaction analysis.
            if len(dims) < 2:
                dims = roles.dimensions[:2]
            if len(dims) < 2:
                continue
        if kind == "segment_discount" and not dims:
            dims = roles.dimensions[:2]
        spec["dimensions"] = dims
        specialists.append(spec)
    if not specialists:  # nothing fit — fall back to the always-available view
        specialists = [
            {
                "key": "correlation",
                "name": "Driver Correlation Analysis",
                "desc": "What moves the outcome most",
                "analysis": "correlation",
                "dimension": None,
                "icon": "variance",
            }
        ]

    totals = overall(df, roles)
    await emit("planned", {"plan": plan, "specialists": specialists, "totals": totals, "roles": roles.__dict__})

    # ---- 2/3. Aggregate + specialists in parallel --------------------------
    async def run_specialist(spec: dict[str, Any]) -> dict[str, Any]:
        await emit("specialist_started", {"key": spec["key"]})
        # Off the loop, for the same reason as the star pipeline's fetches: this
        # is pandas work inside a coroutine, and leaving it here serialised the
        # specialists that `gather` is meant to overlap.
        data = await asyncio.to_thread(
            build_analysis, df, roles, spec["analysis"], spec.get("dimension"), spec.get("dimensions")
        )
        if data.get("error"):
            result = {
                "headline": f"{spec['name']} unavailable",
                "body": f"This analysis could not run: {data['error']}.",
                "evidence": "",
                "metric": "n/a",
                "delta_basis": None,
                "impact": "data",
                "viz_items": [],
                # No evidence was gathered, so there is nothing to score.
                "analysis_failed": True,
            }
        else:
            import json as _json

            result = await complete_json(
                SPECIALIST_SYSTEM,
                (
                    f"QUESTION: {question}\n\n"
                    f"YOUR ANALYSIS: {spec['name']} — {spec['desc']}\n\n"
                    f"DATASET TOTALS: {_json.dumps(totals)}\n\n"
                    f"YOUR AGGREGATE TABLE:\n{_json.dumps(data, indent=1)}"
                ),
                FINDING_SCHEMA,
                "specialist_finding",
                temperature=0.2,
            )
        finding = {**spec, **result, "analysis_data": data}
        await emit("specialist_done", {"key": spec["key"], "finding": finding})
        return finding

    findings = await asyncio.gather(*(run_specialist(s) for s in specialists), return_exceptions=True)
    ok_findings = [f for f in findings if isinstance(f, dict)]
    failed = [(s["key"], repr(e)) for s, e in zip(specialists, findings) if isinstance(e, Exception)]
    if not ok_findings:
        raise RuntimeError(f"All specialists failed: {failed}")

    # SCORED BEFORE THE SYNTHESIS SEES THEM, because the synthesis prompt shows
    # each finding's confidence and is told to weigh by it. A measured figure
    # there is the difference between weighing evidence and weighing assertion.
    for finding in ok_findings:
        finding.update(finding_confidence(finding, totals.get("rows")))

    # ---- 4. Synthesis ------------------------------------------------------
    import json as _json

    synthesis = await complete_json(
        SYNTHESIS_SYSTEM,
        (
            f"QUESTION: {question}\n\n"
            f"DATASET TOTALS: {_json.dumps(totals)}\n\n"
            f"SPECIALIST FINDINGS:\n"
            + "\n\n".join(
                f"[{f['name']}] (confidence {f['confidence']}, impact {f['impact']})\n"
                f"  {f['headline']}\n  {f['body']}\n  Evidence: {f['evidence']}"
                for f in ok_findings
            )
        ),
        SYNTHESIS_SCHEMA,
        "investigation_synthesis",
        temperature=0.3,
    )
    synthesis = ground_synthesis(synthesis, ok_findings)
    synthesis.update(synthesis_confidence(ok_findings, attempted=len(specialists)))

    orchestration = assemble_orchestration(plan, ok_findings, synthesis, totals)
    return {
        "plan": plan,
        "roles": roles.__dict__,
        "totals": totals,
        "findings": ok_findings,
        "failed_specialists": failed,
        "synthesis": synthesis,
        "orchestration": orchestration,
        "investigation_type": plan.get("investigation_type", "diagnostic"),
    }


def ground_synthesis(
    synthesis: dict[str, Any], findings: list[dict[str, Any]]
) -> dict[str, Any]:
    """Replace the synthesis's self-reported counts with the run's real ones.

    `insight_count` is rendered on the Investigation Progress strip, beside the
    row count, as the number of findings the run produced. The synthesising
    model does not receive that number — it sees the findings' prose, not a
    tally, and it has no way to know whether a specialist failed and dropped
    out. Anything it writes there is therefore a guess at a figure Python is
    holding, so Python supplies it.
    """
    return {**synthesis, "insight_count": len(findings)}


def assemble_orchestration(
    plan: dict[str, Any], findings: list[dict[str, Any]], synthesis: dict[str, Any], totals: dict[str, Any]
) -> dict[str, Any]:
    """Turn findings into the exact orchestration shape the Investigations page
    already renders (see data/investigations.json).

    Node positions are computed here, not by the model: a ring around the
    centre at 50,50, matching the hand-authored layout. Asking an LLM for
    coordinates produces overlapping nodes and drifts between runs.

    CHART BARS ARE CHECKED AGAINST THE SPECIALIST'S OWN TABLE. `viz_items` is
    the one place a specialist writes a raw number that is then DRAWN: the
    popover prints it to one decimal place and scales a bar to it, with nothing
    beside it to say where it came from. The prompt has always required real
    values, but a schema that types the field as a number cannot enforce that,
    and a mistyped digit renders identically to a measurement. So each bar is
    traced back to the payload that specialist was given (`app/agents/figures`),
    and one that cannot be traced is dropped rather than drawn — recorded on the
    finding as `unverified_viz_items` so a run can still be audited.
    """
    nodes: list[dict[str, Any]] = []
    accelerators: list[dict[str, Any]] = []
    node_details: dict[str, Any] = {}

    count = max(1, len(findings))
    for i, f in enumerate(findings):
        key = f["key"]
        # Everything this specialist was actually shown. One scan per finding,
        # reused by the delta, the bars and the prose check below.
        supplied = numeric_provenance(f.get("analysis_data"))
        delta, trend = computed_delta(f.get("delta_basis"), supplied)
        # Start at the top (-90°) and go clockwise; radius in the same 0-100
        # coordinate space the original layout uses.
        angle = -math.pi / 2 + (2 * math.pi * i / count)
        x = round(50 + 34 * math.cos(angle), 2)
        y = round(50 + 36 * math.sin(angle), 2)

        nodes.append(
            {
                "key": key,
                "label": f["name"].replace(" Analysis", ""),
                "metric": f.get("metric", ""),
                "delta": delta,
                "trend": trend,
                "impact": f.get("impact", "data"),
                "icon": f.get("icon", "variance"),
                "pos": {"x": x, "y": y},
            }
        )
        accelerators.append(
            {
                "key": key,
                "name": f["name"],
                "desc": f.get("desc", ""),
                "status": "Completed",
                "icon": f.get("icon", "variance"),
                "tone": "warning" if f.get("impact") in ("negative", "risk") else "success",
                "node": key,
            }
        )
        traceable_bars, invented_bars = verified_viz_items(f.get("viz_items"), supplied)
        # Recorded on the finding so the drop is visible in the stored run
        # rather than silent. The finding dict is the pipeline's own, already
        # about to be persisted, so this adds a field rather than a side effect.
        f["unverified_viz_items"] = invented_bars
        f["delta_computed"] = {"delta": delta, "trend": trend}
        # Prose is flagged, not edited — see `figures.prose_figures`.
        f["unverified_figures"] = sorted({
            token
            for field in ("metric", "headline", "body", "evidence")
            for token in prose_figures(str(f.get(field) or ""), supplied)
        })
        detail: dict[str, Any] = {
            "headline": f.get("headline", ""),
            "body": f.get("body", ""),
            "evidence": f.get("evidence", ""),
        }
        # `viz` is optional in the rendered type. Omitted rather than emptied
        # when nothing survives, so the popover skips the panel instead of
        # drawing an empty one.
        if traceable_bars:
            detail["viz"] = {"type": "bars", "unit": "", "items": traceable_bars}
        node_details[key] = detail

    chips: dict[str, Any] = {}
    if totals.get("period_start") and totals.get("period_end"):
        chips["period"] = f"{totals['period_start']} → {totals['period_end']}"
    if totals.get("total_spend") is not None:
        chips["spend"] = f"{totals['total_spend']:,.0f}"
    if totals.get("overall_roi") is not None:
        chips["roi"] = f"{totals['overall_roi']:.2f}"
    chips["rows"] = f"{totals.get('rows', 0):,}"

    return {
        "center": {"label": plan.get("focus_label", "Investigation"), "sub": plan.get("focus_sub", "")},
        "contextChips": chips,
        "nodes": nodes,
        "accelerators": accelerators,
        # `confidence` and `confidenceDelta` used to sit here, carrying the
        # synthesising model's self-assessment and a "{n}% supported" string
        # built from it. B9 removed both from the rendered type and from the
        # seed data on the grounds that no engine in this project produces a
        # confidence figure; the live agent path kept emitting them anyway,
        # which is the one route that test does not scan. Every number below
        # is now counted rather than asserted.
        "progress": {
            "completed": len(findings),
            "total": len(findings),
            "pct": 100,
            "insights": len(findings),
            "sources": int(totals.get("rows", 0)),
        },
        "nodeDetails": node_details,
    }
