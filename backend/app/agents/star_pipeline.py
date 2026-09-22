"""
Investigation pipeline over the TPO star schema.

Same four stages as the uploaded-CSV pipeline (plan -> analyse -> specialists
-> synthesis) and the same finding/synthesis schemas, so both produce the
identical orchestration the graph renders. The difference is where the
numbers come from: this one calls app/tpo/service.py through star_tools,
so every figure agrees with the Insights Hub by construction.

The planner's real job here is choosing SEGMENTS. A breakdown alone answers
"which channel is worst"; a filter plus a breakdown answers "within Modern
Trade in the South, which mechanic is bleeding money" — and that is the shape
most promotion problems actually take.
"""
import asyncio
import re
from typing import Any

from app.agents.client import complete_json
from app.agents.confidence import finding_confidence, synthesis_confidence
from app.agents.pipeline import (
    FINDING_SCHEMA,
    MAX_SPECIALISTS,
    SYNTHESIS_SCHEMA,
    SYNTHESIS_SYSTEM,
    assemble_orchestration,
    ground_synthesis,
)
from app.agents.roster import BY_KEY as ROSTER_BY_KEY
from app.agents.roster import KEYS as ROSTER_KEYS
from app.agents.roster import roster_catalogue
from app.agents.star_tools import (
    FILTER_FIELDS, _bounded_int, offers_and_products_named_in, resolve_codes, schema_summary, segment_kpis,
)

INVESTIGATION_TYPES = ["diagnostic", "optimization", "launch", "strategic"]

# Filter dimensions a planner may set. Every property is required and
# nullable because OpenAI strict json_schema demands a closed, fully-specified
# object — "omit what you don't need" is expressed as null, not absence.
_FILTER_PROPS = {
    "year": {"type": ["integer", "null"]},
    "month": {"type": ["integer", "null"]},
    "week": {"type": ["integer", "null"], "description": "Business week number 1-53, as in 'week 52'"},
    "channel": {"type": ["array", "null"], "items": {"type": "string"}, "description": "Channel_Id codes, e.g. CH002"},
    "region": {"type": ["array", "null"], "items": {"type": "string"}},
    "state": {"type": ["array", "null"], "items": {"type": "string"}},
    "city": {"type": ["array", "null"], "items": {"type": "string"}},
    "retailer": {"type": ["array", "null"], "items": {"type": "string"}},
    "category": {"type": ["array", "null"], "items": {"type": "string"}},
    "brand": {"type": ["array", "null"], "items": {"type": "string"}},
    "promotion_type": {"type": ["array", "null"], "items": {"type": "string"}},
    # A question that names an offer ("the 10% Discount", "Dussehra Deal 25")
    # or a SKU is about THAT offer or SKU. Without these two the planner could
    # only scope by geography and channel, so "improve the ROI of the 10%
    # Discount in Modern Trade" investigated every promotion in Modern Trade.
    # The codes come from the schema summary's `offers` and `products` lists;
    # build_filter_state already accepted both, only the schema withheld them.
    "promotion": {"type": ["array", "null"], "items": {"type": "string"},
                  "description": ("Promotion_Id codes from `offers`, e.g. PR002 for the 10% Discount, "
                                  "PBDU25 for Dussehra Deal 25. A mechanic shared by several offers "
                                  "(`mechanic`, e.g. Buy3Get1) means every offer that runs it.")},
    "product": {"type": ["array", "null"], "items": {"type": "string"},
                "description": "Product_id codes from `products`, e.g. P13-240ct"},
}
FILTER_OBJECT = {
    "type": "object",
    "additionalProperties": False,
    "required": list(_FILTER_PROPS),
    "properties": _FILTER_PROPS,
}

STAR_PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "answerable", "refusal_reason", "investigation_type",
        "focus_label", "focus_sub", "global_filters", "specialists",
    ],
    "properties": {
        "answerable": {
            "type": "boolean",
            "description": (
                "True only if this question can be answered from trade promotion data "
                "(promotions, channels, retailers, regions, products, spend, ROI). False "
                "for anything else — general knowledge, people, weather, chit-chat, or "
                "other marketing channels this dataset does not cover."
            ),
        },
        "refusal_reason": {
            "type": "string",
            "description": (
                "When answerable is false, one plain sentence telling the user what this "
                "data can and cannot answer. Empty string when answerable is true."
            ),
        },
        "investigation_type": {"type": "string", "enum": INVESTIGATION_TYPES},
        "focus_label": {"type": "string", "description": "Short name for what's investigated, e.g. 'South Modern Trade'"},
        "focus_sub": {"type": "string", "description": "Period or qualifier, e.g. '(F25)'"},
        "global_filters": FILTER_OBJECT,
        "specialists": {
            "type": "array",
            "description": "Which specialists to assign, in the order they should be read.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["specialist", "assignment"],
                "properties": {
                    "specialist": {"type": "string", "enum": list(ROSTER_KEYS)},
                    "assignment": {
                        "type": "string",
                        "description": (
                            "One sentence telling this specialist what to look for in THIS "
                            "investigation — the part of the question it owns."
                        ),
                    },
                },
            },
        },
    },
}

STAR_PLANNER_SYSTEM = """You are the planning agent for a trade promotion intelligence platform,
working over a finalised star schema of real promotion data.

FIRST, decide whether the question is answerable at all.

This platform holds trade promotion data: promotions and their mechanics,
channels, retailers, regions, states, cities, products, brands, categories,
trade spend, incremental sales and ROI, for 2024, 2025 and January-August 2026.

Set `answerable` to false for anything outside that — questions about people,
places, current events, weather, other marketing channels (digital, TV, social),
or greetings and chit-chat. Give a one-sentence `refusal_reason` naming what the
data does cover. Do NOT try to be helpful by finding some tenuous link to
promotion data: answering "who is <person>" with a promotion ROI figure invents
a connection that does not exist, and is far worse than saying you cannot answer.

BEFORE refusing, check the question's words against the VALUES listed in the
schema summary below — offer names, brands, categories, retailers, regions,
channels, promotion types. Those values are drawn from the data itself, and a
question naming one of them is answerable even when the word also means
something else in the world.

Festival and seasonal names are the common trap: the offer list contains names
like "Dussehra Deal 25" and "Diwali Special 24", so a question mentioning
dussehra or diwali is asking about THOSE PROMOTIONS, not about the festival.
Refusing it because the word sounds cultural is wrong.

A question can also be terse, vague or ungrammatical and still be answerable.
Judge the subject against the data, not the phrasing.

When answerable is true, continue:
1. Classify it into one of the four investigation archetypes.
2. Set `global_filters` to the scope the question implies (a year, a channel,
   a region). Use ONLY codes/values present in the schema summary. Set every
   field you are not constraining to null.
   `month` is a calendar month, 1-12; `week` is a business week number, 1-53.
   They are DIFFERENT FIELDS. A question naming a WEEK ("week 41", "W41")
   sets `week`, never `month` — a week number in `month` scopes the whole
   investigation to the wrong period, or to no valid month at all. A question
   naming a week but no month leaves `month` null.
3. Assign the specialists who should investigate it.

You do NOT invent analyses. You ASSIGN work to a standing team of specialists,
each of whom owns one link in the promotion-ROI causal chain and pulls their own
data. Your skill is choosing which lenses this question actually needs, and
telling each specialist what to look for.

YOUR TEAM:
%s

HOW TO ASSIGN — this decides whether the investigation is a real RCA:

  - Pick %d or fewer. Prefer a CHAIN over a crowd: one that establishes whether
    the problem is real, one or two that localise it, one that names specifics,
    one that quantifies what is at stake. Four well-chosen beats six overlapping.
  - ALWAYS include `benchmark` on a diagnostic question. Without it nobody can
    tell whether a bad-looking number is actually unusual, and every other
    finding risks being over-read.
  - Choose lenses that can DISAGREE with each other. If `mechanic_efficiency`
    blames the offer design and `geography` finds it only breaks at one
    retailer, that tension is the most informative thing the investigation can
    produce. Picking four lenses that all point the same way tells you nothing.
  - Match the lens to the question. "Why did ROI fall" wants benchmark +
    mechanic_efficiency + spend_allocation. "Where is money leaking" wants
    offer_forensics + risk_exposure. "Is our lift real" wants cannibalization.
    "Did it fade" wants temporal.
  - `assignment` must be specific to THIS question, naming what that specialist
    should look for. Not "analyse mechanics" but "check whether Buy3Get1 fails
    only in the South or everywhere".

Set `global_filters` to the scope the question implies, using ONLY values from
the schema summary. A question that names an offer or mechanic ("the 10%%
Discount", "Buy3Get1", "Dussehra Deal 25") scopes `promotion` to those offer
codes; one that names a product ("Cruisers Diapers Size 3 84 ct") scopes
`product` to that SKU's code from `products` — the SKU itself, not merely
its brand or category, which would answer for every pack size; do not add a
brand or category beside a product, the SKU already implies them. Every
specialist analyses
that scope, and those that need a comparison pull the whole-business baseline
themselves.

Archetypes: diagnostic (why did X happen), optimization (how do we improve X),
launch (new product/SKU decisions), strategic (portfolio/long-term mix).""" % (
    roster_catalogue(),
    MAX_SPECIALISTS,
)

STAR_SPECIALIST_SYSTEM = """You are a specialist analyst on a trade promotion intelligence platform.

You are given one pre-computed breakdown. Every figure was produced by the
platform's validated KPI engine — the same one the Insights Hub displays.
Analyse ONLY what is in front of you.

Rules:
- Never invent figures. Every number you cite must appear in the data given.
- CURRENCY: every monetary figure is Indian Rupees. Write ₹ or "INR", never $ —
  the figures are not dollars and showing them as such is a factual error.
- `roi` is a MULTIPLE of trade spend: 1.00 is break-even and 1.50 is the
  target hurdle. Quote it to TWO decimals exactly as the table carries it
  ("1.12", never "1.1" and never a percent sign). An ROI of 1.12 means the
  promotion returned well under target; anything below 1.00 lost money.
- Read `applied_filters`: your table may describe one segment, not the whole
  business. Say which. A headline that implies company-wide scope when you
  were given one channel is wrong.
- Groups are a RANKING, not a composition — incremental sales do not sum to
  the total, because the baseline is re-derived per selection. Never present
  group figures as shares of a whole beyond the given share_pct.
- If differences between groups are small, or a group carries very little
  trade spend, that ordering is probably noise. SAY SO IN THE BODY. A large ROI
  on trivial spend is not a finding. You are not asked for a confidence score
  and cannot set one — it is measured from the evidence you were given and from
  how much of what you write traces back to it — so any hedge has to be in your
  own words to appear at all.
- `metric` and `headline` must come from a GROUP in your table, naming it —
  "Buy3Get1 at 1.12", not "ROI is 1.12". The selection total in
  `selection_totals` is context you share with every other specialist; leading
  with it means your analysis contributed nothing the others didn't. Your value
  is which group inside your dimension explains the total.
- viz_items must use real values COPIED from the table. Every bar is checked
  against the data you were given before it is drawn, and a value that is not
  in it is discarded — so a bar you worked out rather than read will simply not
  appear on the chart.
- YOU DO NO ARITHMETIC. Do not subtract two figures, take a ratio, or average
  anything, in any field. Where you want to report a comparison, put the two
  figures in `delta_basis` and the platform computes the difference, its sign
  and the arrow. Set `delta_basis` to null rather than forcing a comparison
  your data does not contain — an absent delta is correct, a computed one is
  not yours to make.
- Keep headline under 60 characters; it renders on a graph node."""


def _plan_prompt(
    question: str,
    summary: dict[str, Any],
    totals: dict[str, Any],
    fixed_scope: dict[str, Any] | None = None,
) -> str:
    import json

    dims = summary["filter_dimensions"]
    matches = question_names_data(question, summary)
    match_lines: list[str] = []
    if matches:
        match_lines = [
            "",
            "WORDS IN THIS QUESTION THAT NAME REAL VALUES IN THIS DATASET:",
            *[f'  "{word}" -> {", ".join(vals[:4])}' for word, vals in matches.items()],
            "These are matches against the data itself, not guesses. A word listed here",
            "refers to that value, whatever else it may mean in the world — do not refuse",
            "the question on the grounds that the word sounds cultural, personal or",
            "unrelated. (A match alone does not make a question answerable: asking about",
            "the weather in a city we happen to sell in is still about weather. Judge what",
            "is being ASKED, now that you know what the words name.)",
        ]
    lines = [
        f"QUESTION: {question}",
        *match_lines,
        "",
        "DATASET: finalised TPO star schema (fact_sales joined to product, store, "
        "channel, promotion and date dimensions).",
        f"OVERALL KPIS: {json.dumps(totals)}",
        "",
        "AVAILABLE FILTER VALUES:",
        f"  year: {dims['year']}   month: 1-12",
        f"  channel: {json.dumps(dims['channel'])}",
        f"  region: {dims['region']}",
        f"  state: {dims['state']}",
        f"  city: {dims['city']}",
        f"  category: {dims['category']}",
        f"  brand: {dims['brand']}",
        f"  promotion_type: {dims['promotion_type']}",
        f"  retailer (first 30): {dims['retailer']}",
        f"  offers: {json.dumps(dims['offers'])}",
        "",
        f"BREAKDOWN DIMENSIONS: {summary['breakdown_dimensions']}",
        f"METRICS: {summary['breakdown_metrics']}",
    ]
    if fixed_scope:
        # The caller drilled in from a specific event and handed over the
        # codes that event was measured on. Those ARE the scope; the planner
        # is told so it can name the focus and brief its specialists on the
        # right population, not so it can re-derive filters from the sentence.
        lines += [
            "",
            f"SCOPE ALREADY FIXED BY THE CALLER: {json.dumps(fixed_scope)}",
            "That scope is authoritative and is applied whatever you emit in "
            "`global_filters`. Describe THAT population in `focus_label`, "
            "`focus_sub` and in every specialist assignment.",
        ]
    return "\n".join(lines)



# Words that appear in so many dataset values they identify nothing on their own.
_GENERIC_VALUE_WORDS = {
    "deal", "discount", "special", "offer", "savings", "promotion", "promo",
    "trade", "care", "home", "liquid", "size", "count", "pack", "buy", "get",
    "the", "and", "for", "with", "all",
}


def _value_index(summary: dict[str, Any]) -> dict[str, list[str]]:
    """word -> the dataset values it appears in, e.g. dussehra -> Dussehra Deal 24/25."""
    dims = summary.get("filter_dimensions") or {}
    labelled: list[tuple[str, str]] = []
    for key in ("region", "state", "city", "retailer", "category", "brand", "promotion_type", "distributor"):
        labelled += [(key, str(v)) for v in (dims.get(key) or [])]
    labelled += [("channel", str(e.get("name", ""))) for e in dims.get("channel") or []]
    labelled += [("offer", str(e.get("name", ""))) for e in dims.get("offers") or []]

    index: dict[str, list[str]] = {}
    for dim, value in labelled:
        for word in re.split(r"[^a-z0-9]+", value.lower()):
            if len(word) >= 4 and word not in _GENERIC_VALUE_WORDS:
                entry = f"{value} ({dim})"
                if entry not in index.setdefault(word, []):
                    index[word].append(entry)
    return index


def question_names_data(question: str, summary: dict[str, Any]) -> dict[str, list[str]]:
    """Which dataset values the question's words actually name.

    The planner refused "is dussehra good or bad?" because the word reads as a
    festival — even with the offer list in front of it and an instruction not to
    do that. Rather than force the verdict (which would also let "weather in
    Mumbai" through, since Mumbai is a city here), this hands the planner the
    specific match so the ambiguity is resolved before it decides. The judgement
    stays with the model; only the evidence improves.
    """
    asked = set(re.split(r"[^a-z0-9]+", question.lower()))
    index = _value_index(summary)
    return {w: index[w] for w in sorted(asked & set(index))}


async def run_star_pipeline(
    question: str, on_event: Any = None, scope: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Investigate the star schema. Mirrors run_pipeline's return shape so the
    router and the frontend treat both sources identically.

    `scope` is the validated FilterState the CALLER drilled in with. A risk
    alert and an underperforming row both carry the promotion, product and
    channel codes of the event they measured; when that scope is supplied it
    REPLACES the planner's `global_filters` rather than merging with them.
    The codes are the event's own, the planner's are inferred from the
    sentence, and an inferred brand sitting beside a real product code can
    intersect to nothing. Without this the run — and everything downstream
    that reads its stored scope, Promotion Intelligence included — answered
    for a wider population than the row that was clicked."""
    import json

    async def emit(kind: str, payload: dict[str, Any]) -> None:
        if on_event:
            await on_event(kind, payload)

    # Both are whole-business passes (~1.8s and ~1.0s here) and neither needs
    # the other, so they run together and off the loop — this is the very start
    # of a run, when the user is watching the progress card and nothing else
    # has happened yet.
    summary, overall = await asyncio.gather(
        asyncio.to_thread(schema_summary),
        asyncio.to_thread(segment_kpis, None),
    )

    # ---- 1. Plan -----------------------------------------------------------
    plan = await complete_json(
        STAR_PLANNER_SYSTEM,
        _plan_prompt(question, summary, overall, scope),
        STAR_PLAN_SCHEMA,
        "star_investigation_plan",
        temperature=0.1,
    )

    # The question is outside what this data can answer. Stop here rather than
    # running specialists — they would analyse promotions regardless and the
    # synthesis would attach real figures to a subject that is not in the data.
    if plan.get("answerable") is False:
        reason = (plan.get("refusal_reason") or "").strip() or (
            "This platform analyses trade promotion performance — promotions, channels, "
            "retailers, regions, products, spend and ROI. That question falls outside it."
        )
        await emit("planned", {"plan": plan, "specialists": [], "totals": {}})
        return {
            "plan": plan,
            "source": "star_schema",
            "answerable": False,
            "refusal": reason,
            "question": question,
            "findings": [],
            "orchestration": None,
            "synthesis": None,
            "investigation_type": plan.get("investigation_type", "diagnostic"),
        }

    def clean_filters(raw: dict[str, Any] | None) -> dict[str, Any]:
        """Drop empties, and drop year/month that fall outside real ranges.

        A question mentioning "week 41" reliably tempts the planner into
        month=41. Sanitising here keeps the bad value out of the stored scope,
        the UI's scope label and the /facts query — not just out of FilterState.
        """
        out = {k: v for k, v in (raw or {}).items() if v not in (None, [], "")}
        for key, low, high in (("year", 1900, 2200), ("month", 1, 12), ("week", 1, 53)):
            if key in out:
                if _bounded_int(out[key], low, high) is None:
                    out.pop(key)
        return out

    # The caller's scope wins when there is one; otherwise the planner's guess
    # is all there is. Both go through the same sanitiser, and unknown keys are
    # dropped so a caller cannot widen the filter vocabulary the engine takes.
    if scope:
        global_filters = clean_filters({k: v for k, v in scope.items() if k in FILTER_FIELDS})
    else:
        # Names the planner wrote where codes belong ("Cruisers Diapers Size 3
        # 84 ct" for P-code, "10% Discount" for PR002) are resolved before the
        # scope is checked, so a correctly identified SKU is not refused as
        # "no rows" for having been spelled out.
        planned = resolve_codes(plan.get("global_filters"))
        # And what the question itself names, when the planner left it out:
        # an offer, a mechanic or a SKU spelled out in the question is the
        # subject of the investigation, not a detail the planner may drop.
        for field, codes in offers_and_products_named_in(question).items():
            if not planned.get(field):
                planned[field] = codes
        global_filters = clean_filters(resolve_codes(planned))

    # AN EMPTY SCOPE IS NOT AN INVESTIGATION. A planner can compose a filter
    # combination that is valid in the vocabulary but matches no rows at all — a
    # retailer that never carried the brand form, a promotion type absent from
    # the channel. Left to run, `segment_kpis` returns {} while the six
    # specialists still write confident prose, because several of their fetches
    # carry whole-business context that ignores the scope. The page then shows a
    # full graph, six findings and a root cause beside "Total Records Analyzed:
    # 0" — an answer about a segment that does not exist.
    #
    # Checked with `rows_for`, the same resolver the specialists' own data calls
    # go through, so this is exactly the population they would have read. An
    # empty `global_filters` means the whole business and is left alone.
    #
    # Returned in the shape the refusal above already uses, so the UI shows it
    # through the same card rather than needing a third outcome to render.
    if global_filters:
        from app.agents.star_tools import build_filter_state as _scope_state
        from app.tpo.filters import rows_for as _scope_rows

        if not _scope_rows(_scope_state(global_filters)):
            named = ", ".join(
                f"{k}={v}" for k, v in sorted(global_filters.items())
            )
            await emit("planned", {"plan": plan, "specialists": [], "totals": {}})
            return {
                "plan": plan,
                "source": "star_schema",
                "answerable": False,
                "refusal": (
                    "No rows in the dataset match the scope this question implies, so "
                    "there is nothing to analyse. Every filter is a real value, but "
                    "together they select nothing: " + named + ". Try widening it " + "— "
                    "dropping the retailer, the promotion type or the period."
                ),
                "question": question,
                "findings": [],
                "orchestration": None,
                "synthesis": None,
                "investigation_type": plan.get("investigation_type", "diagnostic"),
            }

    # THE STANDING PANEL. Every investigation runs these six, in this order, so
    # the Investigation Graph shows the same six agents every time.
    #
    # It used to be whatever subset the planner chose, capped at MAX_SPECIALISTS.
    # That made the panel vary run to run — an alert-driven question ("Why did X
    # underperform?") drew five and never included cannibalization, because the
    # planner only reached for it when the question itself said "cannibalize".
    # The neighbour check is not an optional lens; it is part of reading a
    # promotion, so it is no longer left to the question's wording.
    #
    # The planner still BRIEFS the panel: where it assigned one of the six, that
    # assignment is kept verbatim. Only the choice of who runs is fixed.
    PANEL: tuple[tuple[str, str], ...] = (
        ("benchmark", "Establish whether this segment is genuinely abnormal."),
        ("mechanic_efficiency", "Find which mechanics under- and over-perform here."),
        ("offer_forensics", "Examine how the offers themselves were constructed."),
        ("risk_exposure", "Quantify how much money is still at stake."),
        ("geography", "Find where this performs best and worst."),
        ("cannibalization", "Check whether same-brand-form neighbours lost sales while it ran."),
    )
    briefs: dict[str, str] = {}
    for assigned in plan.get("specialists") or []:
        key = assigned.get("specialist")
        brief = (assigned.get("assignment") or "").strip()
        if key and brief and key not in briefs:
            briefs[key] = brief

    specialists: list[dict[str, Any]] = [
        {"spec": ROSTER_BY_KEY[key], "assignment": briefs.get(key) or fallback}
        for key, fallback in PANEL
    ]

    scoped_totals = segment_kpis(global_filters) if global_filters else overall
    await emit(
        "planned",
        {
            "plan": plan,
            # Specialist is a frozen dataclass holding a callable — flatten to
            # the plain fields the run record and the UI actually need.
            "specialists": [
                {
                    "key": a["spec"].key,
                    "name": a["spec"].name,
                    "desc": a["spec"].desc,
                    "icon": a["spec"].icon,
                    "assignment": a.get("assignment", ""),
                }
                for a in specialists
            ],
            "totals": scoped_totals,
        },
    )

    # ---- 2/3. Each specialist pulls its own data, in parallel --------------
    async def run_specialist(assigned: dict[str, Any]) -> dict[str, Any]:
        spec = assigned["spec"]
        await emit("specialist_started", {"key": spec.key})
        try:
            # OFF THE EVENT LOOP, WHICH IS WHAT MAKES THE PANEL PARALLEL AT ALL.
            # `fetch` is synchronous and does real work — the benchmark lens
            # alone runs two whole-business breakdowns — so calling it directly
            # inside this coroutine meant `asyncio.gather` below started six
            # tasks that then ran one after another. Measured on one alert's
            # scope: 12.04s serialised against 6.32s genuinely parallel, and
            # the loop served 0 heartbeats during the former against 61 during
            # the latter. That freeze is also why the progress card could not
            # update while the specialists were "running".
            data = await asyncio.to_thread(spec.fetch, global_filters)
            error = None
        except Exception as e:  # one lens failing must not sink the whole RCA
            data, error = {}, f"{type(e).__name__}: {e}"

        if error:
            result = {
                "headline": f"{spec.name} unavailable",
                "body": f"This analysis could not run: {error}.",
                "evidence": "",
                "metric": "n/a",
                "delta_basis": None,
                "impact": "data",
                "viz_items": [],
                # No evidence was gathered, so there is nothing to score.
                "analysis_failed": True,
            }
        else:
            result = await complete_json(
                f"{STAR_SPECIALIST_SYSTEM}\n\nYOUR SPECIALISM — {spec.name}:\n{spec.focus}",
                (
                    f"QUESTION UNDER INVESTIGATION: {question}\n\n"
                    f"YOUR ASSIGNMENT: {assigned.get('assignment') or spec.role}\n\n"
                    f"SCOPE: {json.dumps(global_filters) if global_filters else 'whole business'}\n\n"
                    f"YOUR DATA:\n{json.dumps(data, indent=1, default=str)}"
                ),
                FINDING_SCHEMA,
                "specialist_finding",
                temperature=0.2,
            )
        # Roster fields are applied AFTER the model's result: both carry a
        # `metric` key meaning different things (the model's is the headline
        # figure for the graph node). Merging the other way lost one silently.
        finding = {
            **result,
            "key": spec.key,
            "name": spec.name,
            "desc": spec.desc,
            "icon": spec.icon,
            "role": spec.role,
            "assignment": assigned.get("assignment", ""),
            "analysis": spec.key,
            "_filters": global_filters,
            "analysis_data": data,
        }
        await emit("specialist_done", {"key": spec.key, "finding": finding})
        return finding

    results = await asyncio.gather(*(run_specialist(s) for s in specialists), return_exceptions=True)
    findings = [f for f in results if isinstance(f, dict)]
    failed = [(s["spec"].key, repr(e)) for s, e in zip(specialists, results) if isinstance(e, Exception)]
    if not findings:
        raise RuntimeError(f"All specialists failed: {failed}")

    # THE ROWS THE SCOPE ACTUALLY HOLDS, resolved once. `rows_for` is the same
    # resolver the specialists' own data calls went through, so this is the
    # population they read — and it is the `support` term of every finding's
    # evidence score as well as the run's "records analysed" figure below.
    from app.agents.star_tools import build_filter_state as _rows_state
    from app.tpo.filters import rows_for as _rows_for

    rows_in_scope = len(_rows_for(_rows_state(global_filters)))
    for finding in findings:
        finding.update(finding_confidence(finding, rows_in_scope))

    # ---- 4. Synthesis ------------------------------------------------------
    synthesis = await complete_json(
        SYNTHESIS_SYSTEM,
        (
            f"QUESTION: {question}\n\n"
            f"SCOPE: {json.dumps(global_filters) if global_filters else 'whole dataset'}\n"
            f"KPIS FOR THAT SCOPE: {json.dumps(scoped_totals)}\n\n"
            f"SPECIALIST FINDINGS:\n"
            + "\n\n".join(
                f"[{f['name']}] (confidence {f['confidence']}, impact {f['impact']})\n"
                f"  Lens: {f['role']}\n"
                f"  {f['headline']}\n  {f['body']}\n  Evidence: {f['evidence']}"
                for f in findings
            )
        ),
        SYNTHESIS_SCHEMA,
        "investigation_synthesis",
        temperature=0.3,
    )
    # The findings this run actually produced, counted rather than asserted --
    # the panel is fixed at six, but a specialist can fail and drop out.
    synthesis = ground_synthesis(synthesis, findings)
    synthesis.update(synthesis_confidence(findings, attempted=len(specialists)))

    # Real fact-table size, not a literal — assemble_orchestration formats
    # `rows` with a thousands separator, so it must be a number.
    from app.tpo.loader import MONTHS, get_store

    row_count = get_store().row_count
    orchestration = assemble_orchestration(plan, findings, synthesis, {"rows": row_count, **scoped_totals})

    # --- the Business Question card's fields -------------------------------
    #
    # DISPLAY METADATA, DERIVED FROM THE SCOPE THAT WAS ACTUALLY INVESTIGATED.
    # Every value below comes from `global_filters` (the scope the specialists
    # ran on) or from `scoped_totals` (the validated KPI bundle for that same
    # scope). Nothing here is inferred from the question's wording and nothing
    # is computed: `service._group_label` is the SAME code->name resolver the
    # Insights Hub's breakdowns use, so a channel is named identically in
    # both places.
    from app.tpo import service as _service

    store = get_store()

    def _named(dimension: str, codes: Any) -> str | None:
        """Codes -> the names a reader recognises, or None when unconstrained.

        None is meaningful: it is the difference between "this scope selected
        no region" and "the region is unknown", and the card renders the two
        differently."""
        values = [c for c in (codes or []) if c]
        if not values:
            return None
        labels = [_service._group_label(store, dimension, str(c)) for c in values]
        return labels[0] if len(labels) == 1 else f"{len(labels)} selected"

    chips: dict[str, Any] = {}

    # PERIOD. The F24/F25 shorthand is this project's internal label for a
    # calendar year and means nothing to a reader on a projector, so the card
    # gets the plain year, narrowed by month when the scope carries one.
    year = global_filters.get("year")
    month = global_filters.get("month")
    week = global_filters.get("week")
    # A week is narrower than a month, so it names the period when present.
    # The chip has to say so: a scope of one week reported as the full year is
    # what let a neighbour comparison covering nine promotion weeks read as if
    # it described the single week the question asked about.
    if year and week:
        chips["period"] = f"W{int(week):02d} {year}"
    elif year and month:
        chips["period"] = f"{MONTHS[int(month) - 1]} {year}"
    elif year:
        chips["period"] = f"{year} (Full Year)"
    else:
        chips["period"] = "All Years"

    # CHANNEL / REGION. Absent before this: the card asked for them and the
    # payload never carried them, which is why both rendered blank.
    chips["channel"] = _named("channel", global_filters.get("channel")) or "All Channels"
    chips["region"] = _named("region", global_filters.get("region")) or "All Regions"

    if scoped_totals.get("trade_spend") is not None:
        chips["spend"] = f"₹{scoped_totals['trade_spend'] / 1e7:,.2f} Cr"
    if scoped_totals.get("promotion_roi") is not None:
        chips["roi"] = f"{scoped_totals['promotion_roi']:.2f}"  # the multiple's own two decimals
    chips["source"] = "TPO star schema"
    orchestration["contextChips"] = chips

    # RECORDS ANALYSED. The rows the SCOPE holds, not the whole fact table.
    # `progress.sources` carried 205,920 for every investigation regardless of
    # what it looked at, which is the size of the dataset rather than a fact
    # about the run. Resolved once above, where the evidence scores also read
    # it, so the figure on the strip and the one inside every confidence
    # cannot describe different populations.
    orchestration["progress"]["sources"] = rows_in_scope

    return {
        "plan": plan,
        "source": "star_schema",
        "global_filters": global_filters,
        "totals": scoped_totals,
        "findings": findings,
        "failed_specialists": failed,
        "synthesis": synthesis,
        "orchestration": orchestration,
        "investigation_type": plan.get("investigation_type", "diagnostic"),
    }
