"""
The Analyst — the dashboard's question-answering bot.

WHAT IT IS. A reader asks "what did we spend on Modern Trade last year" in
their own words; this turns that into a scope, runs it through the SAME KPI
engine the Insights Hub renders, and says the answer back in a sentence.

WHAT IT IS NOT. It does not explain WHY a number moved. Causal attribution is
what the Investigations module is for — it runs six specialists over the star
schema and carries confidence and evidence with every claim. A chat turn has
none of that behind it, so a "why" question here is handed to Investigations
rather than answered with a plausible-sounding guess. The line is enforced in
the prompt and, for the flat causal asks, before the model is ever called
(`deflect_why`).

HOW THE NUMBERS STAY REAL. The model never does the aggregation. It picks a
scope and a breakdown; `app/tpo/service.py` computes, through `star_tools.py`'s
existing memoised adapter — the same functions the investigation specialists
call, which sit on the same engine as the KPI cards. So the bot cannot
contradict the dashboard on the same dataset: they are not two implementations,
they are one. The model's job is turning words into a scope, and the result
back into a sentence.
"""
import json
import logging
import re
from datetime import date
from typing import Any

from app.agents import analyst_knowledge as knowledge
from app.agents import analyst_memory as memory_store
from app.agents import star_tools as T
from app.agents.analyst_charts import CHART_TYPES, build_chart
from app.agents.client import chat_completion, get_client
from app.tpo import formatting as F

log = logging.getLogger(__name__)

#: How many times the model may call a tool before we stop and make it answer
#: with what it has. A question needing more than this is a report, not a chat
#: turn — and an unbounded loop is a way to spend the user's money on a mistake.
MAX_STEPS = 5

#: How many prior turns to carry. Enough for "and what about Modern Trade?" to
#: resolve against the question before it; short enough that a long session
#: does not grow the prompt without bound.
HISTORY_TURNS = 8


class AnalystError(RuntimeError):
    """A question that could not be answered, with a reader-facing message."""


# --- the "why" line ----------------------------------------------------------
#
# A question that is ONLY a causal ask is turned away before the model is
# called: no key is spent, and the answer is instant and identical every time.
# The test is deliberately narrow — it fires on an opening interrogative, not
# on the word "why" anywhere in the sentence, so "what drove volume, why do you
# ask" and a passing mention are not caught by it.
_WHY_OPENERS = (
    "why ", "why's", "whys ", "why?",
    "how come", "what caused", "what's causing", "what is causing",
    "what drove", "what's driving", "what is driving",
    "explain why", "reason for", "reasons for", "root cause",
    "what led to", "what made",
)

WHY_DEFLECTION = (
    "I can't answer *why* something happened — I look numbers up and do the "
    "arithmetic on them, but I don't do causal analysis.\n\n"
    "**Investigations** is built for that question: it runs six specialists "
    "over the same data and carries evidence and a confidence level with every "
    "finding.\n\n"
    "I can give you the numbers underneath it, though — try asking me *what* "
    "the figure was, how it compares across channels or regions, or how it "
    "moved versus last year."
)


def deflect_why(question: str) -> str | None:
    """The reader-facing reply for a purely causal question, or None.

    Returns the message rather than raising: this is a normal answer the bot
    gives, not an error, and it renders in the thread like any other reply.
    """
    text = " ".join((question or "").casefold().split())
    if not text:
        return None
    return WHY_DEFLECTION if text.startswith(_WHY_OPENERS) else None


# --- tools -------------------------------------------------------------------
#
# Three, not thirty. Every question this bot is for is a selection plus
# optionally a grouping, and the engine already expresses exactly that. More
# tools would only add ways for the model to pick the wrong one.

#: The filter vocabulary, shared by both data tools. One definition so the two
#: cannot drift into accepting different scopes.
_FILTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "Scope. Omit a field to leave that dimension unconstrained; omit the whole "
        "object for the entire business. year/month/week are integers, every other "
        "field is a list of strings drawn from the schema's real values."
    ),
    "properties": {
        "year": {"type": "integer"},
        "month": {"type": "integer", "description": "1-12"},
        "week": {"type": "integer", "description": "1-53"},
        "channel": {"type": "array", "items": {"type": "string"}},
        "retailer": {"type": "array", "items": {"type": "string"}},
        "region": {"type": "array", "items": {"type": "string"}},
        "state": {"type": "array", "items": {"type": "string"}},
        "city": {"type": "array", "items": {"type": "string"}},
        "tier": {"type": "array", "items": {"type": "string"}},
        "category": {"type": "array", "items": {"type": "string"}},
        "brand": {"type": "array", "items": {"type": "string"}},
        "product": {"type": "array", "items": {"type": "string"}},
        "promotion": {"type": "array", "items": {"type": "string"}},
        "promotion_type": {"type": "array", "items": {"type": "string"}},
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_kpis",
            "description": (
                "Headline KPIs for one selection: trade_spend, incremental_sales, "
                "promotion_roi, margin_impact, pei, cannibalization_rate, volume_uplift, "
                "net_incremental_profit and target_hit_rate, plus *_delta_pct versus the "
                "prior comparable period where one exists. Use for any 'what was X' "
                "question."
            ),
            "parameters": {"type": "object", "properties": {"filters": _FILTER_SCHEMA}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare",
            "description": (
                "Rank a metric across one dimension, optionally inside a selection. Use for "
                "'which / top / best / worst / by channel / by region / compare' questions, "
                "and to see what a dimension contains. Returns the groups AND the "
                "selection's own totals."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filters": _FILTER_SCHEMA,
                    "by": {
                        "type": "string",
                        "enum": list(T.BREAKDOWN_DIMENSIONS),
                        "description": "The dimension to group by.",
                    },
                    "metric": {
                        "type": "string",
                        "enum": list(T.BREAKDOWN_METRICS),
                        "description": "What to rank by. Defaults to incremental_sales.",
                    },
                    "limit": {"type": "integer", "description": "Max groups, 1-25. Default 12."},
                },
                "required": ["by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "draw_chart",
            "description": (
                "Draw a chart of a breakdown. Use when the reader asks to see/plot/graph "
                "something, or when a comparison across 3+ groups is easier to read as a "
                "picture than as a table. You supply the SHAPE (type, dimension, metric); the "
                "server computes the numbers from the same engine as every other figure, so "
                "never pass data yourself. Say one sentence about what the chart shows — do "
                "not also list every value the chart already displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_type": {
                        "type": "string",
                        "enum": list(CHART_TYPES),
                        "description": (
                            "ONE metric across groups: bar = ranked categories (the default, "
                            "and best for long names, because the labels read horizontally); "
                            "column = vertical bars for an ordered sequence such as months; "
                            "line = change over time; area = the same with the volume under it "
                            "filled, for a cumulative reading; pie/donut = share of a whole, "
                            "ONLY valid for trade_spend or incremental_units, whose groups "
                            "genuinely sum to the total. "
                            "TWO OR MORE metrics across the same groups (pass `metrics`): "
                            "grouped = side-by-side bars, the right choice for comparing "
                            "metrics per group; stacked = segments summing to a per-group "
                            "total, ONLY valid when every metric is additive. "
                            "SHAPE OF A POPULATION: histogram = how one metric is DISTRIBUTED "
                            "across a dimension's members (bar height is a COUNT of groups, "
                            "not a total) — use it for 'spread', 'distribution', 'how many "
                            "promotions had an ROI of'; scatter = two metrics plotted against "
                            "each other, one dot per group, for 'is spend related to return'."
                        ),
                    },
                    "by": {
                        "type": "string",
                        "enum": list(T.BREAKDOWN_DIMENSIONS),
                        "description": "The dimension to group by.",
                    },
                    "metric": {
                        "type": "string",
                        "enum": list(T.BREAKDOWN_METRICS),
                        "description": (
                            "What to measure, for the single-metric charts. Defaults to "
                            "incremental_sales. Ignored when `metrics` is given."
                        ),
                    },
                    "metrics": {
                        "type": "array",
                        "items": {"type": "string", "enum": list(T.BREAKDOWN_METRICS)},
                        "description": (
                            "Two or more metrics, for grouped/stacked comparison charts and "
                            "for scatter. For a scatter the FIRST is the x axis and the "
                            "SECOND is the y axis."
                        ),
                    },
                    "filters": _FILTER_SCHEMA,
                    "title": {"type": "string", "description": "A short, specific chart title."},
                    "limit": {"type": "integer", "description": "Groups to draw, 2-6. Default 6."},
                    "bins": {
                        "type": "integer",
                        "description": "Histogram bins, 3-20. Default 8. Ignored by every other type.",
                    },
                },
                "required": ["chart_type", "by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_schema",
            "description": (
                "The dimensions that exist and the real values they take — years, channels, "
                "regions, brands, offers, products. Call this FIRST whenever a question names "
                "something you are not certain is a real value, so a filter is never guessed."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "define_kpi",
            "description": (
                "What a KPI MEANS: its exact formula, how to read it, its direction (is "
                "higher better), the target where one exists, and the caveats that make it "
                "easy to misread. Call this whenever the reader asks what a metric is, how "
                "it is calculated, whether a value is good, what counts as break-even, or "
                "why two figures disagree — and whenever you are about to explain a metric "
                "in your own words. NEVER invent a definition or a formula: the definitions "
                "here are transcribed from the code that computes the numbers, and a "
                "plausible-sounding formula you made up would be wrong in a way the reader "
                "cannot check."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "term": {
                        "type": "string",
                        "description": (
                            "The metric or concept — 'roi', 'trade spend', 'PEI', "
                            "'cannibalization', 'baseline', 'break-even'."
                        ),
                    }
                },
                "required": ["term"],
            },
        },
    },
]


def _clamp_limit(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 12
    return max(1, min(25, n))


# --- display strings ---------------------------------------------------------
#
# WHY THE MODEL IS NOT ALLOWED TO CONVERT UNITS. Asked to render 801,946,066 as
# crore, a language model divides by the wrong power of ten often enough to be
# unusable — observed here calling ₹80.2 Cr "₹801.9 Cr" in one turn and getting
# it right in the next, and reporting a ₹9.0 Cr difference as "₹89.9 L". It is
# arithmetic on the magnitude of a number, which is precisely the operation
# these models are least reliable at and which no amount of prompting fixes.
#
# So every figure is handed over WITH the string the dashboard would print for
# it, straight from `app/tpo/formatting.py` — the same function behind the KPI
# cards. The model copies that string rather than computing one. The raw number
# stays alongside it, because real arithmetic (differences, shares, ratios) has
# to happen on the number, not on a rounded display value.

#: Which formatter each KPI takes. Keys mirror `service.kpis()`; anything not
#: listed is left as a bare number, which is right for counts and indices.
_MONEY_KEYS = {"trade_spend", "incremental_sales", "net_incremental_profit", "baseline_sales", "actual_sales"}
_PERCENT_KEYS = {"margin_impact", "cannibalization_rate", "volume_uplift", "target_hit_rate"}
_MULTIPLE_KEYS = {"promotion_roi", "roi"}
_SCORE_KEYS = {"pei"}


def _display_for(key: str, value: Any, currency: str) -> str | None:
    """The string the dashboard would show for this figure, or None if the key
    carries no unit of its own."""
    if not isinstance(value, (int, float)):
        return None
    if key.endswith("_delta_pct"):
        return F.percent(value, signed=True)
    if key in _MONEY_KEYS:
        return F.money(value, currency)
    if key in _PERCENT_KEYS:
        return F.percent(value)
    if key in _MULTIPLE_KEYS:
        return F.multiple(value)
    if key in _SCORE_KEYS:
        return F.score(value)
    if key.endswith("_units") or key.endswith("_volume"):
        return F.quantity(value)
    return None


def _with_display(payload: dict[str, Any], currency: str) -> dict[str, Any]:
    """`{trade_spend: 801946066.0}` -> `{trade_spend: 801946066.0,
    trade_spend_display: "₹80.2 Cr"}`."""
    out: dict[str, Any] = {}
    for key, value in (payload or {}).items():
        out[key] = value
        shown = _display_for(key, value, currency)
        if shown is not None:
            out[f"{key}_display"] = shown
    return out


def _run_tool(name: str, args: dict[str, Any], currency: str) -> dict[str, Any]:
    """Dispatch one tool call to the KPI engine.

    Filter values go through `resolve_codes` first, so a model that writes a
    display name ("Modern Trade") where the engine wants a code still selects
    the rows it meant. Anything unrecognised is left as written and surfaces
    downstream as an empty scope, rather than being quietly coerced into a
    different selection.

    Every figure that leaves here carries a `*_display` string beside it — see
    `_with_display` for why the model is not trusted to make one.
    """
    filters = T.resolve_codes(args.get("filters") or {})
    if name == "get_kpis":
        payload = T.segment_kpis(filters)
        if not payload:
            return {"error": "no rows matched this selection", "applied_filters": filters}
        return {"applied_filters": filters, "kpis": _with_display(payload, currency)}
    if name == "compare":
        result = T.run_analysis(
            filters,
            str(args.get("by") or "channel"),
            str(args.get("metric") or "incremental_sales"),
            _clamp_limit(args.get("limit")),
        )
        if "error" in result:
            return result
        result["groups"] = [
            {**_with_display(g, currency), "group": g.get("group")}
            for g in (result.get("groups") or [])
        ]
        result["selection_totals"] = _with_display(result.get("selection_totals") or {}, currency)
        return result
    if name == "draw_chart":
        metrics = args.get("metrics")
        return build_chart(
            chart_type=str(args.get("chart_type") or "bar"),
            by=str(args.get("by") or "channel"),
            metric=str(args.get("metric") or "incremental_sales"),
            metrics=metrics if isinstance(metrics, list) else None,
            filters=filters,
            title=args.get("title"),
            limit=args.get("limit", 6),
            bins=args.get("bins"),
            currency=currency,
        )
    if name == "get_schema":
        return T.schema_summary()
    if name == "define_kpi":
        return knowledge.define(str(args.get("term") or ""))
    return {"error": f"unknown tool {name!r}"}


def _period_grounding() -> str:
    """Today's date and the years the dataset actually holds.

    WHY THIS IS NOT OPTIONAL. A model has no clock and no view of the data, so
    "last year" resolved against its training cutoff — observed answering a
    "last year" question about 2022, a year this dataset does not contain, and
    reporting it as "no rows matched" rather than as its own mistake. The years
    come from the loaded dataset, so this cannot drift when the data is
    replaced.

    The running year is called out separately: it is partial, and comparing a
    part-year against a full one is the mistake this grounding exists to stop.
    The Insights Hub's own default period follows the same rule.
    """
    today = date.today()
    try:
        years = sorted(int(y) for y in schema_years())
    except Exception:  # a dataset that cannot be read must not break the turn
        return f"Today is {today:%-d %B %Y}."
    if not years:
        return f"Today is {today:%-d %B %Y}."

    complete = [y for y in years if y < today.year]
    latest_complete = max(complete) if complete else max(years)
    lines = [
        f"Today is {today:%d %B %Y}.",
        f"The data covers {', '.join(str(y) for y in years)}.",
        f'"Last year" means {latest_complete} — the most recent COMPLETE year in the data.',
    ]
    if today.year in years:
        lines.append(
            f"{today.year} is still in progress and holds only part of a year, so never compare it "
            f"against a full year without saying so."
        )
    lines.append("Never filter to a year outside that list; say the data does not cover it instead.")
    return "\n".join(lines)


def schema_years() -> list[Any]:
    """The years the loaded dataset holds. Split out so the grounding above can
    fail softly if the dataset is not readable."""
    return T.schema_summary()["filter_dimensions"]["year"]


def _system_prompt(currency: str) -> str:
    # The examples are generated by the REAL formatter, not written by hand, so
    # the prompt cannot describe a rendering the code does not produce.
    sample = F.money(801946066.0, currency)
    derived = F.money(89946066.0, currency)
    period = _period_grounding()
    glossary = knowledge.glossary_lines()
    return f"""You are the Analyst, the assistant inside a trade-promotion dashboard (TIQ).
You answer questions about promotion performance data by looking numbers up and
doing arithmetic on them.

THE ONE RULE: never state a figure you were not given by a tool. You cannot see
the data. If you have not called a tool, you do not know the answer. Never
estimate, never illustrate with a plausible number, and never carry a figure
from an earlier turn into a new scope — re-fetch it.

THE ONE EXCEPTION, and it is not a loophole: you may explain what a metric
MEANS without a lookup, using the glossary below. A definition is not a figure.
Saying "ROI is incremental sales divided by trade spend" states no number about
this business; saying "ROI was 1.34" does, and needs a tool.

WHAT YOU DO
- Look up KPIs for any selection (get_kpis).
- Rank and compare across a dimension (compare).
- Explain what a metric means, how it is calculated, and whether a value is
  good (define_kpi). Use it for "what is", "how is X calculated", "is that
  good", "what's break-even", and whenever you are about to describe a metric
  in your own words. NEVER improvise a formula — the definitions are
  transcribed from the code that computes the numbers, and an invented one is
  wrong in a way the reader cannot check.
- Draw a chart (draw_chart) when the reader asks to see/plot/graph something,
  or when a comparison across three or more groups reads better as a picture.

  THE CHART IS ALREADY DRAWN AND ALREADY ON SCREEN once the tool returns. It
  is rendered by the application, directly above your reply. So:
    * NEVER write an image, a data: URI, a base64 string, a markdown image
      link, ASCII art, or a link to a chart. You cannot produce an image and
      nothing you write becomes one — it renders as pasted gibberish.
    * Do not re-list the values the chart already shows — NO table, NO bullet
      list of the same groups, and no "followed by X and Y" tour of the
      ranking. Every label and figure is already on screen directly above your
      sentence, and repeating them is pure duplication.
    * ONE sentence, naming at most ONE figure: the leader, or whatever the
      reader actually asked about. "General Trade leads at ₹50.3 Cr, 63% of
      the total." is a complete answer. Then stop.
    * Do not describe the chart's own existence either — "the bar chart
      displays…" tells the reader what they can see. Lead with the finding.
  CHOOSING THE SHAPE. Match the chart to the question, not to habit:
    * Ranking named things (channels, brands, retailers) -> bar. Long labels
      read horizontally; this is the default and usually the right answer.
    * An ordered sequence — months, weeks — read left to right -> column,
      or line/area when the point is the movement rather than the levels.
    * Share of a whole -> pie or donut, and ONLY for trade_spend or
      incremental_units. Ask for one of incremental_sales and it comes back as
      a bar, which you should mention rather than hide.
    * Comparing TWO OR MORE metrics across the same groups -> grouped (pass
      `metrics`), e.g. spend against incremental sales per channel. Use
      stacked only when every metric is additive, or it downgrades to grouped.
    * How something is SPREAD across many members — "distribution", "spread",
      "how many promotions had an ROI of" -> histogram. Its bars are COUNTS of
      groups, not totals, so never read a bar as a rupee figure.
    * Whether two metrics move together — "does more spend bring more back"
      -> scatter, with `metrics` as [x, y]. Describe the pattern you see; do
      NOT explain why it holds, which is a causal claim you cannot make.
  When a grouped chart mixes units (rupees against a multiple), each series is
  scaled separately — say so if you comment on it, and never invite the reader
  to compare bar lengths between two series.
  Every chart carries its own download button, so never offer to send a file.
- Arithmetic ON the returned numbers: differences, shares, ratios, per-unit
  figures, "how much more than", "what percent of". Do that maths yourself and
  give the result — it is why you are here.

WHAT YOU DON'T DO
- Explain WHY a number moved, or attribute a cause. You have totals, not causal
  evidence. If asked, say so in one line and point to the Investigations module,
  which is built for it. Do not offer a theory anyway.
- Predict, forecast, or recommend an action.

WHAT THE METRICS MEAN
{glossary}
Use these to phrase an answer correctly. For anything more than a one-line
gloss — the full formula, the caveats, whether a value is good — call
define_kpi rather than elaborating from these lines.

TWO THINGS READERS GET WRONG, AND YOU SHOULD NOT
- Trade Spend includes the PRICE CUT as well as the promotion cost. The
  discount is usually the larger half. Never describe it as just the fees.
- Incremental Sales measures uplift against each product's own non-promoted
  baseline — it is NOT total revenue during the promotion, and its groups do
  not add up to the selection's total.

WHEN THE QUESTION SAYS "LAST YEAR", "THIS YEAR" OR "RECENTLY"
{period}

SCOPE
Answer across the whole dataset unless the question names a scope; when it names
one, filter to it. If you are not certain a named value really exists, call
get_schema before filtering — a guessed filter silently selects nothing, or the
wrong rows. If a selection returns no rows, say so plainly and say what you
filtered on. Never present zeros as a result.

READING THE NUMBERS
- Every figure arrives with a `*_display` string beside it — `trade_spend:
  801946066.0` comes with `trade_spend_display: "{sample}"`. ALWAYS quote the
  display string verbatim when stating a figure. Never convert a raw number
  into crore, lakh, millions or thousands yourself: you get the power of ten
  wrong, and the display string is already exactly what the dashboard shows.
- Do arithmetic (differences, shares, ratios) on the RAW numbers, never on the
  display strings — then write the RESULT in the same style as a display
  string. A raw difference of 89946066 is written {derived}. Check the
  magnitude before writing it: a nine-digit rupee figure is crore, not lakh.
  Keep the raw digits and the long division out of the answer — show the
  figures a reader needs, not the calculation you did to get them.
- promotion_roi and roi are a MULTIPLE of trade spend: 1.00 is break-even, 1.50
  is the target. Write it as "1.34" or "1.34x", never as a percentage.
- *_delta_pct is percent change against the prior comparable period.
  margin_impact, cannibalization_rate, volume_uplift and target_hit_rate are
  themselves percentages.
- In a `compare` result, Trade Spend sums back to the total but Incremental
  Sales does NOT — its baseline is re-derived per group. Treat groups as a
  RANKING, never as a composition, and do not present them as shares of a whole.
- Lower is better for trade_spend and cannibalization_rate; higher for the rest.

HOW TO ANSWER
Never emit an image, a data: URI, a base64 blob or a markdown image link under
any circumstances — charts are drawn by the application, not by you.
Lead with the number. One or two short sentences for a simple lookup. Name the
scope you used whenever it is anything other than the whole dataset, so the
reader knows what the figure describes. Use a short markdown table for three or
more groups, and **bold** the figures that answer the question. No preamble, no
"based on the data", no restating the question. Never mention tools, filters as
JSON, or that you called anything."""


def _history_messages(history: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Prior turns, trimmed and flattened into plain user/assistant messages."""
    out: list[dict[str, Any]] = []
    for turn in (history or [])[-HISTORY_TURNS:]:
        role = turn.get("role")
        content = str(turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content[:4000]})
    return out


#: A model that has been told it may "draw a chart" sometimes tries to draw one
#: itself, and emits a markdown image whose src is an invented base64 blob —
#: observed here as a ~100KB fake PNG that took two minutes to generate and
#: rendered as a broken image. The prompt forbids it; this makes it impossible,
#: because a rule the model can ignore is not a guarantee.
_IMAGE_MARKDOWN = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_DATA_URI = re.compile(r"(?:data:[a-zA-Z0-9.+/-]+;base64,)[A-Za-z0-9+/=\s]{40,}")
#: A bare base64 run with no data: prefix — the same failure, half-emitted.
_BARE_BASE64 = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")


def strip_images(text: str) -> str:
    """Remove anything the model emitted that pretends to be an image.

    The charts the reader sees come from `draw_chart` and are rendered by the
    UI; nothing in the prose is ever an image. Runs on every answer, not only
    chart turns, because the failure is cheap to prevent and expensive to ship.
    """
    cleaned = _IMAGE_MARKDOWN.sub("", text)
    cleaned = _DATA_URI.sub("", cleaned)
    cleaned = _BARE_BASE64.sub("", cleaned)
    # Collapse the blank lines the removal leaves behind.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _result(
    text: str,
    steps: list[dict[str, Any]],
    charts: list[dict[str, Any]],
    store: dict[str, Any],
    question: str,
) -> dict[str, Any]:
    """One turn's reply, with the conversation's memory folded forward.

    THE MEMORY IS BUILT FROM WHAT WAS COMPUTED, NOT FROM WHAT WAS SAID. The
    scope and the figures come out of the tool calls this turn actually made,
    so a sentence the model phrased loosely cannot put a wrong number into the
    context of every later turn. The reader's question is kept verbatim as the
    thread of what they are working on.
    """
    scope: dict[str, Any] | None = None
    figures: list[str] = []

    for step in steps:
        applied = (step.get("result") or {}).get("applied_filters")
        if isinstance(applied, dict) and applied:
            scope = applied
        kpis = (step.get("result") or {}).get("kpis")
        if isinstance(kpis, dict):
            # Only the display strings — the formatted figure is what a reader
            # refers back to, and it carries its own unit.
            where = _scope_phrase(applied if isinstance(applied, dict) else {})
            for key, value in kpis.items():
                if key.endswith("_display") and not key.endswith("_delta_pct_display"):
                    figures.append(f"{key[:-8].replace('_', ' ')}{where} = {value}")

    facts = [f"Asked: {question[:160]}"]
    for chart in charts:
        if chart.get("title"):
            facts.append(f"Drew a chart: {chart['title']}")
        # The chart's top group, so "what was the biggest one again?" resolves
        # without redrawing it. Only the leader: the rest are on screen.
        points = chart.get("points") or []
        if points:
            top = max(points, key=lambda pt: pt.get("value") or 0)
            if top.get("display"):
                figures.append(f"{chart.get('title', 'chart')} — largest: {top['label']} {top['display']}")

    updated = memory_store.remember(
        store,
        scope=scope,
        facts=facts,
        # Cap what one turn can contribute, so a nine-KPI lookup cannot fill
        # the whole store in a single question.
        figures=figures[:6],
    )

    return {
        "answer": strip_images(text),
        "steps": steps,
        "charts": charts,
        "memory": updated,
        "memory_usage": memory_store.usage(updated),
    }


def _scope_phrase(applied: dict[str, Any]) -> str:
    """" in 2025, Modern Trade" — so a remembered figure carries the selection
    it described and can never be read as the whole business's number."""
    if not applied:
        return ""
    parts: list[str] = []
    for key, value in list(applied.items())[:4]:
        if value in (None, "", []):
            continue
        text = ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
        parts.append(text if key == "year" else f"{text}")
    return f" in {', '.join(parts)}" if parts else ""


async def answer(
    question: str,
    *,
    history: list[dict[str, Any]] | None = None,
    currency: str = "INR",
    memory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One chat turn.

    Returns `{answer, steps, charts, memory, memory_usage}`:

      * `steps`  what was actually computed, so the UI can show the reader
                 which figures the sentence stands on.
      * `charts` any chart specs drawn this turn, already computed from the
                 KPI engine — the UI renders these, it never parses them out
                 of the prose.
      * `memory` the conversation's fact store with this turn folded in. The
                 CLIENT owns it and sends it back next turn; nothing is kept
                 server-side (see analyst_memory for why).
    """
    question = (question or "").strip()
    if not question:
        raise AnalystError("Ask me something about the promotion data.")

    currency = F.normalise_currency(currency)
    get_client()  # fail fast when no key is configured

    store = memory_store.normalise(memory)
    remembered = memory_store.render(store)

    system = _system_prompt(currency)
    if remembered:
        system = system + "\n\n" + remembered

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        *_history_messages(history),
        {"role": "user", "content": question},
    ]

    steps: list[dict[str, Any]] = []
    charts: list[dict[str, Any]] = []

    for _ in range(MAX_STEPS):
        response = await chat_completion(
            messages=messages,
            tools=TOOLS,
            # Low, not zero: the same question twice should stand on the same
            # figures, and phrasing variety buys nothing in an analytics answer.
            temperature=0.1,
        )
        message = response.choices[0].message
        calls = message.tool_calls or []

        if not calls:
            text = (message.content or "").strip()
            if not text:
                raise AnalystError("I couldn't put an answer together. Try rephrasing the question.")
            return _result(text, steps, charts, store, question)

        messages.append(
            {
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.function.name, "arguments": c.function.arguments},
                    }
                    for c in calls
                ],
            }
        )

        for call in calls:
            name = call.function.name
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            try:
                result = _run_tool(name, args, currency)
            except Exception as e:  # a bad scope must not take the whole turn down
                log.warning("analyst tool %s failed: %s", name, e, exc_info=True)
                result = {"error": f"{type(e).__name__}: {e}"}

            # A chart is for the reader, not evidence to be re-read: pulled out
            # here so the UI renders it beside the answer.
            if isinstance(result, dict) and isinstance(result.get("chart"), dict):
                charts.append(result["chart"])

            # The schema dump is context for the model, not evidence for the
            # reader — kept out of `steps`.
            if name != "get_schema":
                steps.append({"tool": name, "arguments": args, "result": result})

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, default=str)[:24000],
                }
            )

    # Out of steps. Make it answer from what it already has rather than
    # returning nothing — by this point the figures are usually all in hand.
    messages.append(
        {
            "role": "user",
            "content": "Answer now, using only the figures you already have. Do not call anything else.",
        }
    )
    final = await chat_completion(messages=messages, temperature=0.1)
    text = (final.choices[0].message.content or "").strip()
    if not text:
        raise AnalystError("That question needed more digging than I can do in one go. Try narrowing it.")
    return _result(text, steps, charts, store, question)
