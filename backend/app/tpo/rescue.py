"""Target Rescue -- is this month's unit target on track, and if not, what is
the LEAST AGGRESSIVE approved intervention that recovers it?

A THIRD, SEPARATE simulation mode. It shares with the other two exactly the
things that must not be written down twice, and nothing else:

  * the ONE `FilterState` (app/tpo/filters.py),
  * the APPROVED PROMOTION ECONOMICS (app/tpo/response.py, app/tpo/config.py),
  * the VALIDATED KPI DEFINITIONS (app/tpo/aggregate.py),
  * the per-candidate baseline rule General Optimization already established
    (`optimization._price_and_baseline`), CALLED rather than restated.

Nothing in app/tpo/simulation.py, execution.py, scenarios.py, comparison.py,
recommendation.py, risk.py or optimization.py is modified by this module. It
imports from two of them and calls them; it changes neither.

------------------------------------------------------------------------------
IT RECOMMENDS. IT NEVER EXECUTES.
------------------------------------------------------------------------------
This module creates no promotion, writes no row, touches no dimension and
activates nothing. Every function here reads. Final execution stays a Decision
Center action, as it does everywhere else in this project.

------------------------------------------------------------------------------
THE MONTH IS MEASURED IN BUSINESS WEEKS, BECAUSE THAT IS THE GRAIN THAT EXISTS
------------------------------------------------------------------------------
The brief asks for a DAY 20 checkpoint. This project has no trustworthy daily
grain to answer it at: `loader.Dimensions.week_start` documents that CH002,
CH004 and CH005 carry a scrambled `Date` -- 51.9% of their rows disagree with
the week start dim_date gives for their own (Year, Week) -- which is why the
analytical month is recovered from the WEEK and never from the date. Sales are
knowable at complete-business-week boundaries and nowhere finer.

So the checkpoint SNAPS to the nearest complete business week, exactly as the
discount control snaps to the nearest approved treatment depth, and for the
same reason: a value between two measurable points is not a shallower version
of either, it is a number nobody can measure. Prorating a straddling week
across its days would be inventing a daily sales distribution.

`days_in_month` is likewise the days the analytical month's business weeks
actually cover (28 or 35, occasionally 36-37 for January), read from dim_date.
It is NOT the calendar length of the month, because the calendar month's first
days belong to a business week the project files under the PREVIOUS month --
and a target is a target for the trading the month contains.

Two useful consequences, both asserted in tests:

  * A day-20 checkpoint in a 28-day analytical month resolves to day 21, i.e.
    75% of the month elapsed -- which is exactly the brief's own canonical
    example of 75 units against a 100 unit target reading as WATCH.
  * "Maintain current treatment" reproduces the MEASURED full-month units for
    the scope to the unit, because it is the measured remainder.

------------------------------------------------------------------------------
TWO DIFFERENT QUESTIONS, KEPT APART
------------------------------------------------------------------------------
PACE is a run-rate projection: units sold / days elapsed x days in month. It is
labelled `Run-rate projection` on every response and it is NOT a forecast --
there is no model behind it, only division. It answers "at this rate, where
does the month land?"

RECOVERY is a counterfactual over the month's REMAINING business weeks under an
approved treatment. It answers "what would the rest of the month do at this
depth?", and every figure in it comes from the approved rules and the validated
KPI definitions.

They are reported side by side and never averaged into one number.

------------------------------------------------------------------------------
THE ECONOMICS ARE NOT REDEFINED HERE
------------------------------------------------------------------------------
For a candidate whose non-promoted per-transaction baseline is `b`, with `n`
transactions in the remaining weeks, list price `P`, unit cost `k`, under
approved treatment `(d, u)` and the standing promotion cost rate `c`:

    units      = b.n.(1 + u)
    gross      = units . P
    revenue    = gross . (1 - d)
    discount   = gross . d
    overhead   = gross . c
    total cost = k . units

which is `execution.synthesize`'s per-row arithmetic, term for term. Those
values are assembled into real `aggregate.WeekRow`s and handed to the engine:

    Trade Spend   = aggregate.calculate_trade_spend(rows)
    Margin Impact = aggregate.calculate_margin(rows)
    ROI           = aggregate.roi_multiple(incremental_sales, trade_spend)

Incremental Units and Incremental Sales are `aggregate._volume`'s definitions --
(quantity - baseline), and (quantity - baseline) x that row's own price -- with
the baseline SUPPLIED rather than re-derived. That is deliberate, and it is the
one figure the engine cannot simply be handed a row set for: `_volume` derives
each baseline from the non-promoted rows inside the set it is given, and a set
in which every row carries the treatment has none. `execution.py` supplies
baselines for the same reason and documents it; the number supplied here is the
same per-transaction mean `_volume` would have produced, and
`tests/test_target_rescue.py` asserts that against `_volume.baseline_average`.

WHAT IS NOT MODELLED, and is not quietly modelled anyway. No elasticity, no
forecast, no seasonality, no duration response, no cannibalization response.
Cannibalization in particular is absent: the approved rules define none, so a
rescue plan describes the treated products only and says so.
"""

from __future__ import annotations

import dataclasses
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Sequence

from app.tpo import aggregate as A
from app.tpo import config
from app.tpo import formatting as F
from app.tpo import optimization, response
from app.tpo import filters as FL
from app.tpo.filters import FilterState, rows_for
from app.tpo.loader import MONTHS, get_store
from app.tpo.promo_calendar import CADENCE

#: Carried on every response so a client can never mistake a rescue evaluation
#: for a budget allocation or an investigation scenario.
MODE = "target_rescue"

# --- cadence ----------------------------------------------------------------
#
# THE CADENCE IS THE PROJECT'S, READ NOT REDECLARED. `promo_calendar.CADENCE` is
# the authoritative channel structure -- CH001/CH004/CH006 WEEKLY, CH002/CH003/
# CH005 MONTHLY -- and its own docstring says it is "declared once HERE so the frontend
# never carries its own copy". The same applies to this module: it is imported,
# never restated, and nothing here infers a cadence from the transaction pattern,
# which would make a business rule depend on a data accident.
#
# It agrees with `fact_sales.Schedule`, which carries exactly one value per
# channel; `tests/test_target_rescue.py` asserts that agreement so the declared
# structure and the recorded one cannot drift apart.

CADENCE_WEEKLY = "WEEKLY"
CADENCE_MONTHLY = "MONTHLY"
#: More than one cadence in scope -- an all-channels selection, or two channels
#: that plan differently. Reported as its own value rather than silently taking
#: one channel's rule for the other's.
CADENCE_MIXED = "MIXED"

#: Checkpoint selector values that are not a week ordinal.
CHECKPOINT_AUTO = "auto"
CHECKPOINT_LATEST = "latest"
CHECKPOINT_WEEK = "week"

#: The mid-month checkpoint for a MONTHLY-cadence channel, as an ORDINAL over the
#: month's business weeks.
#:
#: STATED AS A WEEK, NOT A DAY, and that is the whole point. The brief's day-20
#: checkpoint is what the third completed business week works out to in a
#: four-week month -- approximately day 20 or 21 depending on how the weeks fall
#: -- and the week is what this dataset can actually measure. See the module
#: docstring on why there is no trustworthy daily grain to read a day from.
MONTHLY_CHECKPOINT_WEEK = 3

#: Target attainment bands, as PERCENTAGES of the monthly unit target. These
#: are the brief's own thresholds and they are RAW ATTAINMENT, not
#: pace-normalised: at a day-20 checkpoint, 80% attainment means running ahead
#: of a flat month, which is what "on track" is meant to mean.
#:
#: Deliberately NOT `config.SEVERITY_BANDS`. Those are ROI bands for Command
#: Center risk alerts -- different units, a different question -- and nothing
#: here reads or changes them.
ON_TRACK_ATTAINMENT_PCT: float = 80.0
WATCH_ATTAINMENT_PCT: float = 70.0

#: The hard discount ceiling, as a PERCENTAGE. Not a rule of its own -- it is
#: the deepest APPROVED treatment depth, read from the approved rules rather
#: than written down again. Nothing in this module can recommend past it.
MAX_DISCOUNT_PCT: float = max(response.APPROVED_DISCOUNT_PCT)

#: Response statuses. Only `evaluated` carries an assessment.
STATUS_EVALUATED = "evaluated"
STATUS_NO_DATA = "no_data"

#: Target status code -> (label, colour intent, the explicit action sentence).
#: One table, so the label, the severity and the sentence cannot drift apart
#: between the API and the screen. The intents are the platform's existing
#: status vocabulary; no Command Center risk colour changes meaning.
TARGET_STATUS: dict[str, tuple[str, str, str]] = {
    "on_track": ("ON TRACK", "success", "Maintain current treatment."),
    "watch": ("WATCH", "warning", "Monitor pace; intervention may not be required."),
    "at_risk": ("TARGET AT RISK", "danger", "Recovery action recommended."),
    "achieved": ("TARGET ACHIEVED", "success", "No intervention required."),
    "missed": (
        "TARGET MISSED",
        "danger",
        "The month is closed. No intervention can change this result.",
    ),
}

#: Phases of the month, which decide how much weight the evidence carries.
PHASE_EARLY = "early_month"
PHASE_CHECKPOINT = "checkpoint"
PHASE_COMPLETE = "complete"

#: Said whenever fewer than `MONTHLY_CHECKPOINT_WEEK` business weeks have
#: completed. The brief is explicit that this must not block the user -- it
#: qualifies the evidence, it does not withhold it.
EARLY_MONTH_NOTE = (
    "Early-month signal. Fewer than {weeks} business weeks of the month have "
    "completed, so the run-rate rests on less trading than the mid-month "
    "checkpoint assumes. Target Rescue becomes more reliable from the third "
    "completed business week, which is approximately day 20."
).format(weeks=MONTHLY_CHECKPOINT_WEEK)

#: Carried on the run-rate projection. Deliberately not the word "forecast".
RUN_RATE_LABEL = "Run-rate projection"
RUN_RATE_NOTE = (
    "Month-to-date units divided by the days the COMPLETED business weeks cover, "
    "extended over the days all the month's business weeks cover. The elapsed "
    "coverage comes from the authoritative business-week calendar, never from raw "
    "calendar days. A straight-line projection of the pace measured so far -- not "
    "a forecast, and no model stands behind it."
)

CANNIBALIZATION_NOTE = (
    "Not modelled. The approved promotion rules define no cannibalization "
    "response to discount depth, so a rescue plan describes the treated "
    "products only and says nothing about their neighbours."
)

#: Why a recovery figure can be missing. Used verbatim rather than paraphrased,
#: because the brief forbids showing fake precision in its place.
NO_ESTIMATE_REASON = (
    "Recovery impact cannot be reliably estimated with the available promotion "
    "economics."
)


# --- the approved treatment ladder ------------------------------------------


#: A promotion master name that opens with a percentage is a PRICE DISCOUNT
#: ("5% Discount"); one that does not is a MECHANIC ("Buy3Get1").
_PERCENT_NAME = re.compile(r"^\s*\d+(?:\.\d+)?\s*%")


def approved_mechanic_names() -> dict[str, str]:
    """Approved treatment key -> the PROMOTION MASTER's own name for it.

    Read from `dim_promotion`, never written down here. The master calls PB001
    "Buy3Get1", and that is where the clearance mechanic's name comes from.
    """
    store = get_store()
    out: dict[str, str] = {}
    for treatment in config.TREATMENT_RULES:
        promotion = store.dims.promotions.get(treatment)
        if promotion is not None:
            out[treatment] = promotion.name
    return out


def clearance_treatments() -> tuple[str, ...]:
    """The approved treatments the promotion master records as a MECHANIC.

    THE BRIEF'S RULE, APPLIED RATHER THAN ASSUMED. It names Buy2Get1 and
    Buy3Get1 as examples and then forbids inventing economics for a mechanic
    the approved promotion strategy does not contain. So the master is
    inspected: it holds `PB001 = "Buy3Get1"`, and no Buy2Get1 at all. Buy3Get1
    is therefore offered on its own approved economics -- d = 25%, uplift
    60-72% -- and Buy2Get1 is never offered, because fabricating an uplift and
    a cost for it is the one thing this must not do.

    Empty is a legitimate answer: a master with no mechanic yields no clearance
    rung, and the ladder simply ends at the deepest approved discount.
    """
    return tuple(
        treatment
        for treatment, name in approved_mechanic_names().items()
        if not _PERCENT_NAME.match(name)
    )


def snap_to_approved(discount_pct: float) -> tuple[float, str | None]:
    """Resolve a slider position to the applicable approved treatment depth.

    Returns `(depth, treatment)`, where a depth of 0 means NO TREATMENT and
    carries a null key -- a legitimate current state, and the one the ladder
    starts from when nothing is running.

    The approved depths are 5/10/15/20/25 and `response.get_treatment_response`
    refuses to interpolate between them, so a position between two resolves to
    the nearer rather than being priced with an invented band. Ties resolve
    DOWN, to the shallower treatment: the conservative reading of an ambiguous
    position is the smaller intervention.
    """
    value = max(0.0, min(float(discount_pct), MAX_DISCOUNT_PCT))
    approved = sorted(response.APPROVED_DISCOUNT_PCT)
    # Below half the shallowest approved depth there is no treatment to speak
    # of; the user has chosen "no discount", which is a real state.
    if value < approved[0] / 2:
        return 0.0, None
    best = min(approved, key=lambda d: (abs(d - value), d))
    return best, response.get_treatment_response(best).treatment


def ladder(current_discount_pct: float) -> list[response.TreatmentResponse]:
    """Approved treatments STRICTLY DEEPER than the current one, shallowest
    first.

    The order is the whole point. The brief is explicit that the engine must
    not jump to 25% and must not jump to clearance: it tests interventions in
    increasing aggressiveness and stops at the first that meets the target. An
    ascending list is what makes "the first that reaches the target" and "the
    least aggressive that reaches the target" the same sentence.

    Empty when the current treatment is already the deepest approved one. That
    is not a failure -- it is the answer to "what is stronger than 25%?", and
    `no_stronger_reason` says so in words.
    """
    return [
        rule
        for rule in sorted(response.all_treatments(), key=lambda r: r.discount_pct)
        if rule.discount_pct > current_discount_pct
    ]


def no_stronger_reason(current_discount_pct: float) -> str:
    """Why the ladder is empty, in the terms the promotion master supports."""
    mechanics = clearance_treatments()
    if not mechanics:
        return (
            f"{current_discount_pct:g}% is the deepest approved promotion treatment, and "
            "the promotion master holds no clearance mechanic beyond it. There is no "
            "stronger approved intervention to recommend."
        )
    names = ", ".join(sorted(approved_mechanic_names()[t] for t in mechanics))
    deepest = max(response.get_treatment(t).discount_pct for t in mechanics)
    if current_discount_pct >= deepest:
        return (
            f"{current_discount_pct:g}% is already the deepest approved treatment, and it is "
            f"the approved clearance mechanic ({names}) -- the master records no separate, "
            "stronger mechanic above it. There is no further approved step, and this mode "
            "will not invent one."
        )
    return (
        f"No approved treatment is deeper than {current_discount_pct:g}%. The approved "
        f"clearance mechanic ({names}) sits at {deepest:g}%."
    )


def _ladder_label(index: int, total: int, kind: str, mechanic: str | None) -> str:
    """What to call one rung, in the brief's own ladder vocabulary.

    LEVEL 3 AND LEVEL 4 COINCIDE IN THIS PROJECT, and the label says so rather
    than pretending to two rungs. The brief's Level 3 is the maximum approved
    discount and its Level 4 is an approved clearance mechanic; the promotion
    master's only mechanic is PB001 "Buy3Get1" AT 25%, which is also the deepest
    approved depth. There is no separate deeper mechanic to invent.
    """
    if kind == "maintain":
        return "Current treatment"
    if kind == "clearance":
        return f"Approved clearance mechanic ({mechanic})" if mechanic else "Approved clearance mechanic"
    if index == 1:
        return "Next approved discount level"
    if index == 2:
        return "Next stronger approved discount level"
    if index == total:
        return "Maximum approved discount"
    return "Stronger approved discount level"


# --- the month, in the grain the data actually has --------------------------


@dataclass(frozen=True)
class MonthCalendar:
    """The selected month's business weeks and the days they cover.

    `week_keys` is taken from THE ROWS, not from dim_date, so it can only ever
    contain a week the selection genuinely holds trading for. Each week's day
    count comes from `FactStore.week_span`, which reads dim_date -- the clean
    calendar -- so a short year-end week is 4 or 5 days rather than an assumed 7.
    """

    year: int
    month: int
    week_keys: tuple[str, ...]
    #: Cumulative days covered after each week: (7, 14, 21, 28) for a plain
    #: four-week month. These are the only days progress can be measured at.
    boundaries: tuple[int, ...]

    @property
    def days_in_month(self) -> int:
        return self.boundaries[-1] if self.boundaries else 0

    @property
    def weeks_in_month(self) -> int:
        return len(self.week_keys)

    @property
    def period_label(self) -> str:
        return F.period_label(self.year or None, self.month or None)

    @property
    def ordinals(self) -> dict[str, int]:
        """week key -> its 1-based position in the month. The checkpoint, the
        remaining-week report and every per-week figure address a week by this
        ordinal, so "Week 3" means the same thing everywhere."""
        return {key: index for index, key in enumerate(self.week_keys, start=1)}

    def days_through(self, ordinal: int) -> int:
        """Days the first `ordinal` business weeks cover. The run-rate's elapsed
        denominator -- from the authoritative calendar, never from raw days."""
        if ordinal <= 0 or not self.boundaries:
            return 0
        return self.boundaries[min(ordinal, len(self.boundaries)) - 1]


def month_calendar(state: FilterState, rows: Sequence[A.WeekRow]) -> MonthCalendar:
    """The business-week shape of the selected month."""
    store = get_store()
    keys = sorted({row.week_key for row in rows})
    boundaries: list[int] = []
    running = 0
    for key in keys:
        year, week = key.split("-W")
        running += store.week_span(int(year), int(week))
        boundaries.append(running)
    return MonthCalendar(
        year=state.year or 0,
        month=state.month or 0,
        week_keys=tuple(keys),
        boundaries=tuple(boundaries),
    )


@dataclass(frozen=True)
class Cadence:
    """The promotion cadence of the selected channel(s).

    READ FROM `promo_calendar.CADENCE`, never restated here. A channel the
    declaration does not cover falls back to MONTHLY, exactly as
    `promo_calendar.cell_detail` does, and is listed in `unknown` so the gap is
    visible rather than absorbed.
    """

    #: WEEKLY | MONTHLY | MIXED.
    code: str
    #: channel id -> its own cadence. Always populated, even when `code` is
    #: MIXED, so the screen can say which channel plans which way.
    per_channel: dict[str, str]
    channels: tuple[str, ...]
    #: Channels in scope that `promo_calendar.CADENCE` does not declare.
    unknown: tuple[str, ...]

    @property
    def weekly(self) -> bool:
        """True only when EVERY channel in scope plans weekly.

        A mixed scope is deliberately not weekly. Taking the weekly rule for a
        scope that contains a monthly channel would read that channel's month as
        a series of independent promotion slots, which is exactly what section 12
        of the brief forbids.
        """
        return self.code == CADENCE_WEEKLY

    @property
    def label(self) -> str:
        if self.code != CADENCE_MIXED:
            return self.code
        return "MIXED (" + ", ".join(
            f"{channel} {self.per_channel[channel]}" for channel in self.channels
        ) + ")"


def resolve_cadence(state: FilterState) -> Cadence:
    """The cadence of the scope's channel(s).

    An unconstrained channel selection covers every channel the store holds, and
    they do not all plan the same way -- so that scope is MIXED, and says so,
    rather than quietly adopting one cadence for all of them. The roster is read
    from the dimension, so a channel added to the data is covered here without
    this code changing; one the declaration does not name is reported through
    `unknown` rather than dropped.
    """
    store = get_store()
    codes = tuple(sorted(state.channel) if state.channel else sorted(store.dims.channels))
    per = {channel: CADENCE.get(channel, CADENCE_MONTHLY) for channel in codes}
    unknown = tuple(channel for channel in codes if channel not in CADENCE)
    distinct = set(per.values())
    code = distinct.pop() if len(distinct) == 1 else CADENCE_MIXED
    return Cadence(code=code, per_channel=per, channels=codes, unknown=unknown)


class ImpossibleCheckpoint(ValueError):
    """A checkpoint week the selected month does not contain.

    A distinct type so the router can answer 422 with the month's real week count
    rather than a generic validation message. The brief is explicit that an
    impossible future week must be REJECTED -- not clamped to the last one, which
    would answer a different question than the one asked.
    """

    def __init__(self, ordinal: int, total: int, period: str) -> None:
        super().__init__(
            f"Week {ordinal} is not a business week of {period}, which has {total}. "
            f"A checkpoint cannot be read from a week the month does not contain, and "
            f"this mode will not project one. Select a week from 1 to {total}, "
            f"'{CHECKPOINT_LATEST}' for the latest completed week, or "
            f"'{CHECKPOINT_AUTO}'."
        )
        self.ordinal = ordinal
        self.total = total


@dataclass(frozen=True)
class Checkpoint:
    """Which completed business week progress is read at, and how that was
    resolved.

    A WEEK, NOT A DAY. Progress is knowable at complete-business-week boundaries
    and nowhere finer -- `loader.Dimensions.week_start` documents the scrambled
    `Date` on three channels that makes a daily read untrustworthy -- so the
    checkpoint is an ORDINAL over the month's business weeks. `days_elapsed` is
    derived from that ordinal through the authoritative calendar and exists only
    as the run-rate's denominator; it is never an input.
    """

    #: auto | latest | week -- how the ordinal was arrived at.
    kind: str
    #: What the caller asked for, verbatim, so the screen can distinguish "Auto
    #: chose week 3" from "the user chose week 3".
    requested: int | str | None
    #: 1-based position in the month's business weeks.
    ordinal: int
    #: The week the checkpoint sits at the end of.
    week_key: str | None
    #: Days the completed weeks cover, from the calendar.
    days_elapsed: int
    elapsed_weeks: tuple[str, ...]
    remaining_weeks: tuple[str, ...]

    @property
    def weeks_completed(self) -> int:
        return self.ordinal

    @property
    def weeks_remaining(self) -> int:
        return len(self.remaining_weeks)


def resolve_checkpoint(
    calendar: MonthCalendar,
    cadence: Cadence,
    checkpoint: int | str | None = None,
) -> Checkpoint:
    """Resolve a checkpoint selection to one of the month's business weeks.

    THE AUTO RULE IS CADENCE-AWARE, which is the point of this resolution:

      * A WEEKLY-cadence channel plans a separate promotion each week, so its
        natural read is the LATEST COMPLETED WEEK -- the most evidence available.
      * A MONTHLY-cadence channel runs one treatment across the month's weeks, so
        its natural read is the MID-MONTH checkpoint: the third completed business
        week, which is approximately the brief's day 20. Where the month holds
        fewer than three, the latest completed week is used instead -- there is no
        third week to wait for.

    An explicit ordinal outside the month raises `ImpossibleCheckpoint`. It is
    not clamped: a request for week 6 of a four-week month is a question about a
    week that does not exist, and answering it with week 4 would report a
    different checkpoint than the one asked for.
    """
    total = calendar.weeks_in_month
    if not total:
        return Checkpoint(CHECKPOINT_AUTO, checkpoint, 0, None, 0, (), ())

    if checkpoint is None or checkpoint == CHECKPOINT_AUTO:
        kind = CHECKPOINT_AUTO
        ordinal = total if cadence.weekly else min(MONTHLY_CHECKPOINT_WEEK, total)
    elif checkpoint == CHECKPOINT_LATEST:
        kind, ordinal = CHECKPOINT_LATEST, total
    else:
        try:
            ordinal = int(checkpoint)
        except (TypeError, ValueError):
            raise ImpossibleCheckpoint(0, total, calendar.period_label) from None
        if ordinal < 1 or ordinal > total:
            raise ImpossibleCheckpoint(ordinal, total, calendar.period_label)
        kind = CHECKPOINT_WEEK

    return Checkpoint(
        kind=kind,
        requested=checkpoint,
        ordinal=ordinal,
        week_key=calendar.week_keys[ordinal - 1],
        days_elapsed=calendar.days_through(ordinal),
        elapsed_weeks=calendar.week_keys[:ordinal],
        remaining_weeks=calendar.week_keys[ordinal:],
    )


def checkpoint_options(calendar: MonthCalendar, cadence: Cadence) -> list[dict[str, Any]]:
    """Every checkpoint the selected month and channel actually allow.

    ONLY WEEKS THE MONTH CONTAINS. The brief forbids offering an impossible
    future week, so the list is generated from the calendar rather than fixed at
    four or five entries. Each week carries the remaining-week count it would
    leave, because that is what decides whether an intervention can be evaluated
    at all.
    """
    total = calendar.weeks_in_month
    auto = resolve_checkpoint(calendar, cadence, CHECKPOINT_AUTO)
    options: list[dict[str, Any]] = [{
        "value": CHECKPOINT_AUTO,
        "label": "Auto",
        "ordinal": auto.ordinal,
        "week_key": auto.week_key,
        "weeks_remaining": auto.weeks_remaining,
        "note": (
            "Latest completed business week -- a weekly-cadence channel plans a "
            "separate promotion each week."
            if cadence.weekly else
            f"Week {auto.ordinal} of {total} -- the mid-month checkpoint for a "
            f"monthly-cadence channel, approximately day {auto.days_elapsed}."
        ),
    }]
    for ordinal, week_key in enumerate(calendar.week_keys, start=1):
        options.append({
            "value": ordinal,
            "label": f"Week {ordinal}",
            "ordinal": ordinal,
            "week_key": week_key,
            "days_covered": calendar.days_through(ordinal),
            "weeks_remaining": total - ordinal,
            "note": (
                f"After week {ordinal} · {calendar.days_through(ordinal)} of "
                f"{calendar.days_in_month} days covered"
            ),
        })
    options.append({
        "value": CHECKPOINT_LATEST,
        "label": "Latest Completed Week",
        "ordinal": total,
        "week_key": calendar.week_keys[-1] if calendar.week_keys else None,
        "weeks_remaining": 0,
        "note": (
            "The month's last business week. Every week is complete in the recorded "
            "data, so this leaves no remaining week for an intervention to act on."
        ),
    })
    return options


# --- candidates for an intervention ----------------------------------------


@dataclass(frozen=True)
class Candidate:
    """ONE MEASURED ROW of one remaining business week that a treatment could
    replace, at the KPI grain: (product, channel, week, promotion).

    THE GRAIN IS THE ROW'S, NOT THE MONTH'S. A weekly-cadence channel runs
    several SEPARATE promotions inside one month, each with its own
    Promotion_Id, and collapsing the remaining weeks into a single synthetic row
    would invent one monthly promotion the plan does not contain -- which section
    11 of the brief forbids by name. Keeping the row grain preserves each event's
    identity, lets the expected recovery be reported and aggregated week by week,
    and leaves the totals untouched: `b . (Sum n) . (1 + u)` and
    `Sum b . n . (1 + u)` are the same number.

    For a MONTHLY-cadence channel the same treatment repeats across the month's
    weeks. Those repeats are still carried as separate rows here -- that is where
    the volume lives -- but they are REPORTED as one monthly treatment observed at
    weekly grain, never as several promotions. See `_remaining_scope`.

    THE BASELINE RATE IS STILL MEASURED OVER THE WHOLE MONTH. It is a
    per-transaction mean and carries no week inside it, whereas a single week
    frequently holds no non-promoted row at all for a product promoted every week
    of the month. Deriving it per week would drop exactly the products most in
    need of a deeper treatment.
    """

    product_id: str
    channel_id: str
    brand_form: str
    week_key: str
    #: This row's own Promotion_Id -- "-1" when the week was not promoted. Never
    #: rewritten, and never merged with another week's.
    promotion_id: str
    is_promoted: bool
    #: Per-transaction non-promoted baseline, over the whole month.
    baseline_rate: float
    list_price: float
    unit_cost: float
    #: Transactions in THIS week -- the volume the rate multiplies.
    transactions: int
    #: The measured row, kept so the maintain rung and the treated rungs are
    #: read off the same observation.
    row: A.WeekRow

    @property
    def baseline_units(self) -> float:
        """What this row would do UNPROMOTED."""
        return self.baseline_rate * self.transactions


@dataclass(frozen=True)
class Population:
    """Everything the remaining business weeks contain, split by what a treatment
    can reach."""

    treatable: tuple[Candidate, ...]
    #: Rows of the remaining weeks whose (product, channel) has no non-promoted
    #: week anywhere in the month, so there is no ordinary demand level to apply
    #: a treatment to. They are CARRIED at their measured level in every rung's
    #: projection -- identically, so they cannot tilt the comparison -- and they
    #: are counted and explained rather than silently dropped.
    carried_rows: tuple[A.WeekRow, ...]
    carried_products: int
    #: The remaining business weeks, in calendar order.
    remaining_weeks: tuple[str, ...]
    #: week key -> its 1-based position in the month.
    ordinals: dict[str, int]

    @property
    def carried_units(self) -> float:
        return sum(row.actual_quantity for row in self.carried_rows)

    @property
    def treatable_products(self) -> int:
        return len({(c.product_id, c.channel_id) for c in self.treatable})


def population(
    rows: Sequence[A.WeekRow], checkpoint: Checkpoint, calendar: MonthCalendar
) -> Population:
    """Split the remaining business weeks into what a treatment can reach and
    what it cannot.

    COMPLETED WEEKS ARE NEVER TOUCHED. Only rows whose `week_key` is in
    `checkpoint.remaining_weeks` become candidates, so no rung of the ladder can
    rewrite a week that has already been observed -- section 12 of the brief, and
    `tests/test_target_rescue.py` asserts it directly against the measured rows.

    The baseline rule is `optimization._price_and_baseline`'s, CALLED rather than
    restated -- that function already carries the test keeping it in step with
    `aggregate._volume.baseline_average`, and a second copy here would need its
    own.
    """
    remaining = set(checkpoint.remaining_weeks)
    by_key: dict[tuple[str, str], list[A.WeekRow]] = defaultdict(list)
    for row in rows:
        by_key[(row.product_id, row.channel_id)].append(row)

    treatable: list[Candidate] = []
    carried: list[A.WeekRow] = []
    carried_products = 0

    for key in sorted(by_key):
        month_rows = by_key[key]
        rest = [row for row in month_rows if row.week_key in remaining]
        if not rest:
            continue  # nothing left of the month for this (product, channel)

        price, baseline, _ = optimization._price_and_baseline(month_rows)
        quantity = sum(row.actual_quantity for row in month_rows)
        cost = sum(row.total_cost for row in month_rows)

        if baseline is None or not price or not quantity:
            carried.extend(rest)
            carried_products += 1
            continue

        unit_cost = cost / quantity
        emitted = 0
        for row in sorted(rest, key=lambda r: (r.week_key, r.promotion_id)):
            if not row.transaction_count:
                # No transactions to re-base. Carried at its measured level.
                carried.append(row)
                continue
            treatable.append(Candidate(
                product_id=key[0],
                channel_id=key[1],
                brand_form=row.brand_form,
                week_key=row.week_key,
                promotion_id=row.promotion_id,
                is_promoted=row.is_promoted,
                baseline_rate=baseline,
                list_price=price,
                unit_cost=unit_cost,
                transactions=row.transaction_count,
                row=row,
            ))
            emitted += 1
        if not emitted:
            carried_products += 1

    return Population(
        treatable=tuple(treatable),
        carried_rows=tuple(carried),
        carried_products=carried_products,
        remaining_weeks=tuple(checkpoint.remaining_weeks),
        ordinals=calendar.ordinals,
    )


# --- one rung of the ladder -------------------------------------------------


def _counterfactual(
    pop: Population, discount: float, uplift: float
) -> tuple[tuple[A.WeekRow, ...], float, float]:
    """The remaining business weeks as they would read under one approved
    treatment.

    `execution.synthesize`'s arithmetic, term for term, applied ROW BY ROW as
    that function does -- so the two cannot disagree about what a treatment does
    to an observation. Real `WeekRow`s come out, carrying their own week and their
    own Promotion_Id, because the engine functions that read them next take rows
    and because a weekly channel's separate events must stay separate.

    The rows are returned ALIGNED TO `pop.treatable`, one for one and in order,
    so a caller can attribute each synthesized row back to the week it belongs
    to without re-deriving anything.

    Returns the rows plus Incremental Units and Incremental Sales, which are
    `aggregate._volume`'s definitions with the baseline SUPPLIED. See the module
    docstring for why that is the one figure the engine cannot be handed a row
    set for.
    """
    cost_rate = config.PROMOTION_COST_RATE
    out: list[A.WeekRow] = []
    incremental_units = 0.0
    incremental_sales = 0.0

    for candidate in pop.treatable:
        baseline_units = candidate.baseline_units
        units = baseline_units * (1 + uplift)
        gross = units * candidate.list_price
        revenue = gross * (1 - discount)
        price = candidate.list_price * (1 - discount)
        out.append(dataclasses.replace(
            candidate.row,
            is_promoted=True,
            base_quantity=units,
            actual_quantity=units,
            actual_revenue=revenue,
            actual_price_sum=price * candidate.transactions,
            discount_value=gross - revenue,
            promotion_cost=cost_rate * gross,
            total_cost=candidate.unit_cost * units,
        ))
        incremental_units += units - baseline_units
        incremental_sales += (units - baseline_units) * price

    return tuple(out), incremental_units, incremental_sales


def _measured(pop: Population) -> tuple[tuple[A.WeekRow, ...], float, float]:
    """The remaining business weeks AS RECORDED, on the same measurement basis.

    The "maintain current treatment" rung. Incremental Units and Incremental
    Sales are computed against the SAME supplied baselines the treated rungs use,
    so the comparison is like for like -- and each row is valued at its OWN
    realised price, which is `aggregate._volume`'s rule rather than a pooled one.
    """
    out: list[A.WeekRow] = []
    incremental_units = 0.0
    incremental_sales = 0.0

    for candidate in pop.treatable:
        row = candidate.row
        out.append(row)
        if not row.actual_quantity:
            continue
        price = row.actual_revenue / row.actual_quantity
        incremental_units += row.actual_quantity - candidate.baseline_units
        incremental_sales += (row.actual_quantity - candidate.baseline_units) * price

    return tuple(out), incremental_units, incremental_sales


@dataclass(frozen=True)
class WeekImpact:
    """One remaining business week's share of one rung.

    Section 11 of the brief: a weekly channel's remaining promotion
    opportunities are evaluated individually and the expected recovery is
    aggregated across them. This is the individual figure; the rung's totals are
    the aggregate.
    """

    week_key: str
    ordinal: int
    #: The PROMOTION EVENTS this week carries, as their own Promotion_Ids,
    #: preserved distinctly. The non-promoted marker "-1" is excluded: it is the
    #: absence of a promotion, not one of them, and listing it beside real ids
    #: would make an unpromoted week look like it carried an event. The same rule
    #: applies in `_remaining_scope`, so the two blocks always agree.
    promotion_ids: tuple[str, ...]
    measured_units: float
    units_low: float
    units_high: float
    trade_spend: float | None


def _week_impacts(
    pop: Population,
    low_rows: Sequence[A.WeekRow],
    high_rows: Sequence[A.WeekRow],
) -> tuple[WeekImpact, ...]:
    """One rung, broken out by remaining business week.

    Reads the ALIGNMENT `_counterfactual` guarantees: `low_rows[i]` and
    `high_rows[i]` are candidate `i` under the two ends of the approved band. No
    week is re-derived and no row is matched by search.
    """
    measured: dict[str, float] = defaultdict(float)
    low: dict[str, float] = defaultdict(float)
    high: dict[str, float] = defaultdict(float)
    promotions: dict[str, set[str]] = defaultdict(set)
    spend_rows: dict[str, list[A.WeekRow]] = defaultdict(list)

    for index, candidate in enumerate(pop.treatable):
        week = candidate.week_key
        measured[week] += candidate.row.actual_quantity
        if candidate.is_promoted:
            promotions[week].add(candidate.promotion_id)
        if index < len(low_rows):
            low[week] += low_rows[index].actual_quantity
            spend_rows[week].append(low_rows[index])
        if index < len(high_rows):
            high[week] += high_rows[index].actual_quantity

    for row in pop.carried_rows:
        measured[row.week_key] += row.actual_quantity
        if row.is_promoted:
            promotions[row.week_key].add(row.promotion_id)

    return tuple(
        WeekImpact(
            week_key=week,
            ordinal=pop.ordinals.get(week, 0),
            promotion_ids=tuple(sorted(promotions[week])),
            measured_units=measured[week],
            units_low=low.get(week, 0.0),
            units_high=high.get(week, 0.0),
            trade_spend=A.calculate_trade_spend(tuple(spend_rows[week])),
        )
        for week in sorted(measured, key=lambda w: pop.ordinals.get(w, 0))
    )


@dataclass(frozen=True)
class Level:
    """One rung of the intervention ladder, priced at BOTH ends of its approved
    uplift band.

    `reaches_target` is decided at the LOW end and only there. An intervention
    that clears the target at the top of its approved band and misses at the
    bottom has not been shown to recover the target, and recommending it would
    be reading the band as a forecast.
    """

    level: int
    kind: str  # maintain | discount | clearance
    treatment: str | None
    discount_pct: float
    mechanic: str | None
    ladder_label: str

    uplift_low: float
    uplift_high: float

    units_low: float
    units_high: float
    projected_low: float
    projected_high: float
    achievement_low: float | None
    achievement_high: float | None
    reaches_target: bool

    trade_spend: float | None
    additional_trade_spend: float | None
    incremental_units: float | None
    incremental_sales: float | None
    roi_multiple: float | None
    margin_pct: float | None
    recovery_units_low: float | None
    recovery_units_high: float | None

    estimable: bool
    unavailable_reason: str | None
    within_budget: bool
    budget_reason: str | None
    #: The depth the rung actually ran at, for the maintain rung only. Measured,
    #: not chosen -- see `measured_depth_pct`.
    measured_depth_pct: float | None
    #: Units of the remaining weeks that no treatment could be applied to, added
    #: to every rung identically so they cannot tilt the comparison.
    carried_units: float
    #: Anything about this rung a number cannot say. Carries the fact that the
    #: brief's Level 3 and Level 4 coincide in this project, on the rung where
    #: they do.
    level_note: str | None
    #: This rung, broken out by remaining business week. The rung's totals are
    #: the aggregate of these -- which is what "evaluate the remaining weekly
    #: promotion events individually, then aggregate" means in arithmetic.
    by_week: tuple[WeekImpact, ...]


def _achievement(projected: float, target: float) -> float | None:
    """Percentage of target a projection reaches, or None against no target.
    A share of zero is undefined, not zero and not infinite."""
    return None if target <= 0 else round(projected / target * 100, 1)


def _level(
    *,
    level: int,
    kind: str,
    rule: response.TreatmentResponse | None,
    ladder_label: str,
    pop: Population,
    units_sold: float,
    target_units: float,
    baseline_spend: float | None,
    budget: float | None,
    currency: str,
) -> Level:
    """Price one rung and judge it against the target and the budget.

    Every KPI is produced by an `aggregate` function. Nothing is computed twice,
    and nothing is computed here that the engine already defines.
    """
    if rule is None:
        rows, incremental_units, incremental_sales = _measured(pop)
        low_rows = high_rows = rows
        uplift_low = uplift_high = 0.0
        units_low = units_high = sum(row.actual_quantity for row in rows)
        discount_pct = 0.0
        treatment: str | None = None
        mechanic: str | None = None
    else:
        discount = rule.discount_pct / 100
        low_rows, incremental_units, incremental_sales = _counterfactual(
            pop, discount, rule.uplift_low
        )
        high_rows, _, _ = _counterfactual(pop, discount, rule.uplift_high)
        rows = low_rows
        uplift_low, uplift_high = rule.uplift_low, rule.uplift_high
        units_low = sum(row.actual_quantity for row in low_rows)
        units_high = sum(row.actual_quantity for row in high_rows)
        discount_pct = rule.discount_pct
        treatment = rule.treatment
        mechanic = approved_mechanic_names().get(rule.treatment)
        if _PERCENT_NAME.match(mechanic or ""):
            mechanic = None

    # THE ENGINE'S OWN FUNCTIONS. Trade Spend is
    # Sum(Base_Revenue - Actual_Revenue + Promotion_Cost); Margin is
    # Sum(Actual_Revenue - Total_Cost) / Sum(Actual_Revenue); ROI is
    # (Incremental Sales - Trade Spend) / Trade Spend. None of the three is
    # restated in this module.
    trade_spend = A.calculate_trade_spend(rows)
    margin_pct = A.calculate_margin(rows)
    sales = None if not rows else round(incremental_sales, 1)
    roi_multiple = A.roi_multiple(sales, trade_spend)

    carried = pop.carried_units
    projected_low = units_sold + units_low + carried
    projected_high = units_sold + units_high + carried

    estimable = bool(pop.treatable)
    additional = (
        None
        if trade_spend is None or baseline_spend is None
        else round(trade_spend - baseline_spend, 1)
    )

    within_budget = True
    budget_reason = None
    if budget is not None and additional is not None and additional > budget:
        within_budget = False
        budget_reason = (
            f"Additional trade spend of {F.money(additional, currency)} exceeds the "
            f"{F.money(budget, currency)} ceiling set for this evaluation."
        )

    return Level(
        level=level,
        kind=kind,
        treatment=treatment,
        discount_pct=discount_pct,
        mechanic=mechanic,
        ladder_label=ladder_label,
        uplift_low=uplift_low,
        uplift_high=uplift_high,
        units_low=units_low,
        units_high=units_high,
        projected_low=projected_low,
        projected_high=projected_high,
        achievement_low=_achievement(projected_low, target_units),
        achievement_high=_achievement(projected_high, target_units),
        # The LOW end, and only the low end. See the class docstring.
        reaches_target=estimable and projected_low >= target_units,
        trade_spend=trade_spend,
        additional_trade_spend=additional,
        incremental_units=None if not rows else round(incremental_units, 0),
        incremental_sales=sales,
        roi_multiple=roi_multiple,
        margin_pct=margin_pct,
        recovery_units_low=None,  # filled once the maintain rung is known
        recovery_units_high=None,
        estimable=estimable,
        unavailable_reason=None if estimable else NO_ESTIMATE_REASON,
        within_budget=within_budget,
        budget_reason=budget_reason,
        measured_depth_pct=measured_depth_pct(rows) if rule is None else None,
        carried_units=carried,
        level_note=(
            (
                f"The deepest approved depth ({MAX_DISCOUNT_PCT:g}%) and the promotion "
                f"master's only clearance mechanic ({mechanic}) are the same approved "
                "treatment, so the ladder has one rung here rather than two. No deeper "
                "mechanic exists to offer."
            )
            if kind == "clearance" and discount_pct >= MAX_DISCOUNT_PCT
            else None
        ),
        by_week=_week_impacts(pop, low_rows, high_rows),
    )


def _with_recovery(levels: Sequence[Level]) -> list[Level]:
    """Expected recovery, measured against the maintain rung.

    The first rung is always `maintain`, so every other rung's recovery is its
    projection minus that one's. A NEGATIVE value is reported as it stands: a
    shallow treatment replacing a deeper one that is already running does lose
    volume, and rounding that up to zero would hide the reason the ladder starts
    where it does.
    """
    if not levels:
        return []
    base_low, base_high = levels[0].projected_low, levels[0].projected_high
    out = [dataclasses.replace(levels[0], recovery_units_low=0.0, recovery_units_high=0.0)]
    for level in levels[1:]:
        out.append(dataclasses.replace(
            level,
            recovery_units_low=None if not level.estimable else round(level.projected_low - base_low, 0),
            recovery_units_high=None if not level.estimable else round(level.projected_high - base_high, 0),
        ))
    return out


def _build_ladder(
    *,
    pop: Population,
    units_sold: float,
    target_units: float,
    current_depth: float,
    budget: float | None,
    currency: str,
) -> list[Level]:
    """The maintain rung, then every approved treatment deeper than the current
    one, shallowest first.

    THE MAINTAIN RUNG IS BUILT FIRST AND THAT IS NOT INCIDENTAL: every other
    rung's additional trade spend and expected recovery are differences against
    it, so it has to exist before they can be priced. Its own additional spend is
    zero by construction rather than by subtraction.
    """
    maintain = _level(
        level=0,
        kind="maintain",
        rule=None,
        ladder_label=_ladder_label(0, 0, "maintain", None),
        pop=pop,
        units_sold=units_sold,
        target_units=target_units,
        baseline_spend=None,
        budget=None,
        currency=currency,
    )
    rungs = ladder(current_depth)
    mechanics = clearance_treatments()
    levels = [dataclasses.replace(maintain, additional_trade_spend=0.0)]
    for index, rule in enumerate(rungs, start=1):
        kind = "clearance" if rule.treatment in mechanics else "discount"
        levels.append(_level(
            level=index,
            kind=kind,
            rule=rule,
            ladder_label=_ladder_label(
                index, len(rungs), kind, approved_mechanic_names().get(rule.treatment)
            ),
            pop=pop,
            units_sold=units_sold,
            target_units=target_units,
            baseline_spend=maintain.trade_spend,
            budget=budget,
            currency=currency,
        ))
    return _with_recovery(levels)


# --- the recommendation policy ---------------------------------------------


#: The preference order, stated once. Lower sorts first.
RANKING_BASIS = (
    "Among the interventions that reach the target at the BOTTOM of their approved "
    "uplift band and stay inside the trade-spend ceiling: least aggressive first "
    "(shallowest approved depth), then lowest additional trade spend, then better "
    "ROI, then better margin impact. Units alone never decide it."
)


def _rank_key(level: Level) -> tuple[float, float, float, float]:
    """§14's preference order as a sort key.

    Depths are distinct, so in practice the first term decides and the rest are
    tie-breakers that never fire. They are implemented anyway, because a policy
    that exists only in a comment is a policy nobody can test.
    """
    return (
        level.discount_pct,
        level.additional_trade_spend if level.additional_trade_spend is not None else 0.0,
        -(level.roi_multiple if level.roi_multiple is not None else -1e9),
        -(level.margin_pct if level.margin_pct is not None else -1e9),
    )


def _recommend(
    levels: Sequence[Level],
    *,
    target_units: float,
    projected_run_rate: float,
    phase: str,
    current_discount_pct: float,
    currency: str,
) -> dict[str, Any]:
    """Choose the least aggressive validated action, or say why there is none.

    THE CONSERVATIVE CHECK COMES FIRST, exactly as the brief orders it. If the
    measured pace already lands the month at or above target, the answer is to
    maintain the current treatment -- no discount is recommended to solve a
    problem the trajectory does not have.

    Only then is the ladder walked, and it is walked from the bottom. The first
    rung that reaches the target at the LOW end of its approved band wins; a
    deeper rung is never selected when a shallower approved one already gets
    there.
    """
    if phase == PHASE_COMPLETE:
        return {
            "action": None,
            "level": None,
            "reason": (
                "The month is complete. Target Rescue reports the final result and "
                "recommends no intervention -- there is no remaining period for one to act on."
            ),
            "reaches_target": None,
            "ranking_basis": None,
            "candidates_considered": 0,
        }

    usable = [level for level in levels if level.estimable]
    if not usable:
        return {
            "action": None,
            "level": None,
            "reason": NO_ESTIMATE_REASON,
            "reaches_target": None,
            "ranking_basis": None,
            "candidates_considered": 0,
        }

    maintain = usable[0]

    if projected_run_rate >= target_units:
        return {
            "action": "maintain",
            "level": maintain.level,
            "reason": (
                f"The measured run-rate projects {F.quantity(projected_run_rate)} units against a "
                f"{F.quantity(target_units)} unit target, so the current trajectory reaches it. "
                "No additional discount is recommended."
            ),
            "reaches_target": True,
            "ranking_basis": RANKING_BASIS,
            "candidates_considered": len(usable),
        }

    eligible = [level for level in usable if level.reaches_target and level.within_budget]
    if eligible:
        chosen = min(eligible, key=_rank_key)
        return {
            "action": "maintain" if chosen.kind == "maintain" else chosen.kind,
            "level": chosen.level,
            "reason": _chosen_reason(chosen, target_units, current_discount_pct, currency),
            "reaches_target": True,
            "ranking_basis": RANKING_BASIS,
            "candidates_considered": len(usable),
        }

    blocked = [level for level in usable if level.reaches_target and not level.within_budget]
    if blocked:
        cheapest = min(blocked, key=_rank_key)
        return {
            "action": None,
            "level": None,
            "reason": (
                "Every intervention that reaches the target exceeds the trade-spend ceiling. "
                f"The least aggressive of them ({_depth_label(cheapest)}) would need "
                f"{F.money(cheapest.additional_trade_spend, currency)} of additional trade spend. "
                "Raise the ceiling or accept the shortfall -- the recommendation will not "
                "silently spend past a stated budget."
            ),
            "reaches_target": False,
            "ranking_basis": RANKING_BASIS,
            "candidates_considered": len(usable),
        }

    best = max(usable, key=lambda level: level.projected_low)
    shortfall = target_units - best.projected_low
    return {
        "action": None,
        "level": None,
        "reason": (
            "No approved intervention recovers the target over the month's remaining "
            f"business weeks. The strongest approved option ({_depth_label(best)}) still "
            f"projects {F.quantity(best.projected_low)} units against a "
            f"{F.quantity(target_units)} unit target -- a shortfall of "
            f"{F.quantity(shortfall)} units at the bottom of its approved band. "
            f"{no_stronger_reason(MAX_DISCOUNT_PCT) if current_discount_pct >= MAX_DISCOUNT_PCT else ''}"
        ).strip(),
        "reaches_target": False,
        "ranking_basis": RANKING_BASIS,
        "candidates_considered": len(usable),
    }


def _depth_label(level: Level) -> str:
    if level.kind == "maintain":
        return "the current treatment"
    if level.mechanic:
        return f"the approved clearance mechanic {level.mechanic} at {level.discount_pct:g}%"
    return f"{level.discount_pct:g}%"


def _chosen_reason(
    level: Level, target_units: float, current_discount_pct: float, currency: str
) -> str:
    if level.kind == "maintain":
        return (
            "The month's remaining business weeks already carry the target at the current "
            "treatment, so no additional discount is recommended."
        )
    recovery = (
        F.quantity(level.recovery_units_low)
        if level.recovery_units_low is not None
        else "an amount that cannot be estimated"
    )
    return (
        f"Moving from {current_discount_pct:g}% to {_depth_label(level)} is the least aggressive "
        f"approved intervention that reaches the {F.quantity(target_units)} unit target at the "
        f"bottom of its approved uplift band. It recovers {recovery} units for "
        f"{F.money(level.additional_trade_spend, currency)} of additional trade spend."
    )


# --- status, pace and gap ---------------------------------------------------


def target_status(attainment_pct: float | None, phase: str, achieved: bool) -> dict[str, Any]:
    """The brief's status bands, applied to RAW target attainment.

    A COMPLETE MONTH IS NOT A RESCUE. Once the month's last business week is in,
    the question stops being "will we get there" and becomes "did we", so the
    bands are not consulted at all -- the result is `achieved` or `missed` and no
    future intervention is offered.

    The thresholds are `ON_TRACK_ATTAINMENT_PCT` and `WATCH_ATTAINMENT_PCT`, and
    the boundaries are INCLUSIVE at the bottom exactly as stated: 80% is on
    track, 70% is watch, 69.9% is at risk.
    """
    if phase == PHASE_COMPLETE:
        code = "achieved" if achieved else "missed"
    elif attainment_pct is None:
        code = "at_risk"
    elif attainment_pct >= ON_TRACK_ATTAINMENT_PCT:
        code = "on_track"
    elif attainment_pct >= WATCH_ATTAINMENT_PCT:
        code = "watch"
    else:
        code = "at_risk"

    label, intent, action = TARGET_STATUS[code]
    return {
        "code": code,
        "label": label,
        "intent": intent,
        "action": action,
        "final": phase == PHASE_COMPLETE,
        "thresholds": {
            "on_track_pct": ON_TRACK_ATTAINMENT_PCT,
            "watch_pct": WATCH_ATTAINMENT_PCT,
            "basis": (
                f"Target attainment at or above {ON_TRACK_ATTAINMENT_PCT:g}% is on track; "
                f"at or above {WATCH_ATTAINMENT_PCT:g}% is watch; below that is at risk. "
                "Raw attainment against the monthly target, not pace-normalised."
            ),
        },
    }


def pace_block(
    units_sold: float, days_elapsed: int, days_in_month: int, target_units: float, currency: str
) -> dict[str, Any]:
    """The run-rate projection, labelled for what it is.

    `daily_pace` is division and nothing else. `projected_month_end` extends it
    over the days the month's business weeks cover -- the same denominator
    `days_in_month` uses everywhere on this response, so the projection and the
    progress bar describe one month rather than two.
    """
    if not days_elapsed:
        return {
            "daily_pace": None,
            "daily_pace_display": F.quantity(None),
            "projected_month_end": None,
            "projected_month_end_display": F.quantity(None),
            "projected_achievement_pct": None,
            "days_remaining": days_in_month,
            "label": RUN_RATE_LABEL,
            "note": RUN_RATE_NOTE,
            "unavailable_reason": "No complete business week has elapsed, so there is no pace to measure.",
        }

    pace = units_sold / days_elapsed
    projected = pace * days_in_month
    return {
        "daily_pace": round(pace, 1),
        "daily_pace_display": F.quantity(round(pace, 1)),
        "projected_month_end": round(projected, 0),
        "projected_month_end_display": F.quantity(round(projected, 0)),
        "projected_achievement_pct": _achievement(projected, target_units),
        "days_remaining": days_in_month - days_elapsed,
        "label": RUN_RATE_LABEL,
        "note": RUN_RATE_NOTE,
        "unavailable_reason": None,
    }


def gap_block(target_units: float, units_sold: float) -> dict[str, Any]:
    """Units still to sell. NEVER NEGATIVE.

    A target already passed has no gap, and `on_track` says so instead of
    reporting a negative number that reads as a deficit.
    """
    raw = target_units - units_sold
    gap = max(0.0, raw)
    return {
        "units": round(gap, 0),
        "units_display": F.quantity(round(gap, 0)),
        "on_track": raw <= 0,
        "label": "On track" if raw <= 0 else f"{F.quantity(round(gap, 0))} units behind target",
        "surplus_units": round(-raw, 0) if raw < 0 else None,
    }


def measured_depth_pct(rows: Sequence[A.WeekRow]) -> float | None:
    """The discount depth the elapsed weeks ACTUALLY ran at, as a percentage.

    Given-away revenue over gross revenue -- `optimization._historical`'s own
    ratio, read from prices rather than from a promotion's name. Shown beside the
    current-discount control so a user setting it can see what the data says,
    rather than guessing and then being told a shallower treatment loses volume.
    """
    gross = sum(row.actual_revenue + row.discount_value for row in rows)
    given = sum(row.discount_value for row in rows)
    return None if not gross else round(given / gross * 100, 1)


# --- scope, provenance, presentation ---------------------------------------


def resolve_year(year: int | None) -> int:
    """The year the evaluation runs over.

    A YEAR IS REQUIRED HERE, unlike in General Optimization, and the difference
    is not an inconsistency. That mode averages an AMOUNT of trade spend across
    the reference years and says so; this one counts DAYS, and January 2024
    covers 37 of them where January 2025 covers 36. Averaging two calendars
    would put "day 20 of 36.5" on screen, which is not a day in any month.

    An unrecognised or absent year resolves to the most recent year the data
    holds, which is the month a user asking about pace means.
    """
    years = get_store().years()
    if year is not None and year in years:
        return year
    return max(years)


class InvalidSelection(ValueError):
    """A scope that names a dimension value the data does not contain.

    Distinct from an empty result. A category or product id that is not in the
    dimension tables, or a product that does not belong to the selected
    category, is a MALFORMED REQUEST -- the caller has a stale or mismatched
    selection -- and it should be told which, not handed a no-data assessment
    that reads as "this scope traded nothing".
    """


def validate_selection(state: FilterState) -> None:
    """Reject a selection the dimensions cannot honour.

    Four things are checked, one per level of the hierarchy plus the cascade
    itself, and nothing else. Everything beyond them -- a combination that is
    well-formed but happens to hold no rows -- is a real answer and goes down the
    honest no-data path instead.
    """
    store = get_store()

    if state.channel:
        unknown = sorted(set(state.channel) - set(store.dims.channels))
        if unknown:
            raise InvalidSelection(
                f"Unknown channel{'' if len(unknown) == 1 else 's'}: {', '.join(unknown)}. "
                f"The channels in this dataset are {', '.join(sorted(store.dims.channels))}."
            )

    if state.category:
        known = {p.category for p in store.dims.products.values() if p.category}
        unknown = sorted(set(state.category) - known)
        if unknown:
            raise InvalidSelection(
                f"Unknown categor{'y' if len(unknown) == 1 else 'ies'}: {', '.join(unknown)}. "
                f"The categories in this dataset are {', '.join(sorted(known))}."
            )

    if state.product:
        unknown = sorted(set(state.product) - set(store.dims.products))
        if unknown:
            raise InvalidSelection(
                f"Unknown product id{'' if len(unknown) == 1 else 's'}: {', '.join(unknown)}."
            )
        if state.category:
            # THE CASCADE, ENFORCED AT THE CONTRACT. A product from another
            # category is not a narrow scope, it is a contradiction: the two
            # constraints select nothing and no calculation can mean anything.
            mismatched = sorted(
                pid for pid in state.product
                if store.dims.products[pid].category not in state.category
            )
            if mismatched:
                names = ", ".join(
                    f"{pid} ({store.dims.products[pid].category})" for pid in mismatched
                )
                raise InvalidSelection(
                    f"Product {names} is not in the selected categor"
                    f"{'y' if len(state.category) == 1 else 'ies'} "
                    f"{', '.join(sorted(state.category))}. Select the product's own category, "
                    "or clear the category filter."
                )


def cascade_options(state: FilterState) -> dict[str, Any]:
    """Channel -> Category -> Product, strictly top-down.

    THE PROJECT'S OWN OPTION ENGINE, called three times over three narrowings.
    `filters.options_for` already guarantees the properties this cascade needs --
    an option appears if and only if picking it returns at least one row, and a
    dimension's own constraint is lifted so the active selection stays in its own
    list -- so nothing here re-derives a reachable value. There is no second
    filter architecture.

    WHY THE DOWNSTREAM CONSTRAINTS ARE CLEARED for each list. `options_for` on
    one state makes every list narrow together, which is right for the Command
    Center's flat filter bar but wrong for a HIERARCHY: with a product selected,
    the category list would collapse to that product's own category and the user
    could never climb back up. So each level is computed with the levels BELOW it
    lifted:

        channels, categories   <- year + month           (category, product cleared)
        products               <- year + month + channel + category

    Month and year stay in force throughout: a category with no trading in the
    selected month is not a choice, it is a dead end.
    """
    upstream = state.replace(category=None, product=None)
    midstream = state.replace(product=None)
    above = FL.options_for(upstream)
    within = FL.options_for(midstream)
    return {
        "channels": above["channels"],
        "categories": above["categories"],
        "products": within["products"],
        "basis": (
            "Each list is generated from the rows the levels above it admit, by the "
            "same app/tpo/filters.options_for the Command Center uses. An option "
            "appears only if selecting it returns at least one row, so no dead choice "
            "is ever offered."
        ),
        "hierarchy": ["channel", "category", "product"],
    }


def _band(low: float | None, high: float | None, unit: str, currency: str) -> dict[str, Any]:
    """One figure at both ends of its approved band, never as a midpoint.

    `optimization._band`'s shape, restated for this module rather than imported,
    so a change to one mode's presentation cannot silently reshape the other's
    payload.
    """
    fmt = F.money if unit == "currency" else F.quantity
    kwargs = {"currency": currency} if unit == "currency" else {}
    return {
        "low": low,
        "high": high,
        "display_low": fmt(low, **kwargs),  # type: ignore[arg-type]
        "display_high": fmt(high, **kwargs),  # type: ignore[arg-type]
        "display": (
            fmt(low, **kwargs)  # type: ignore[arg-type]
            if low is not None and high is not None and abs(high - low) < 0.5
            else f"{fmt(low, **kwargs)} - {fmt(high, **kwargs)}"  # type: ignore[arg-type]
        ),
    }


def _cadence_block(cadence: Cadence) -> dict[str, Any]:
    """The cadence, per channel, with its source named.

    Section 6 of the brief: the screen has to show the cadence so the user
    understands why the checkpoint behaves differently for E-commerce than for
    Modern Trade.
    """
    store = get_store()
    return {
        "code": cadence.code,
        "label": cadence.label,
        "weekly": cadence.weekly,
        "channels": [
            {
                "channel_id": channel,
                "name": (
                    store.dims.channels[channel].name
                    if channel in store.dims.channels
                    else channel
                ),
                "cadence": cadence.per_channel[channel],
                "declared": channel in CADENCE,
            }
            for channel in cadence.channels
        ],
        "mixed": cadence.code == CADENCE_MIXED,
        "undeclared_channels": list(cadence.unknown),
        "basis": (
            "The project's stated channel planning structure, read from "
            "app/tpo/promo_calendar.CADENCE -- the same declaration the Promotion "
            "Calendar reads. It is not inferred from the transaction pattern, and it "
            "is not written down a second time here."
        ),
        "checkpoint_rule": (
            "A weekly-cadence channel plans a separate promotion each week, so its "
            "checkpoint defaults to the latest completed business week. A "
            "monthly-cadence channel runs one treatment across the month's weeks, so "
            f"its checkpoint defaults to the mid-month read -- completed business week "
            f"{MONTHLY_CHECKPOINT_WEEK}, or the latest completed week where the month "
            "holds fewer than that."
        ),
    }


def _scope_block(
    state: FilterState, calendar: MonthCalendar, checkpoint: Checkpoint, cadence: Cadence
) -> dict[str, Any]:
    store = get_store()
    channels = sorted(state.channel) if state.channel else None
    names = [store.dims.channels[c].name for c in (channels or []) if c in store.dims.channels]
    return {
        "cadence": _cadence_block(cadence),
        "year": state.year,
        "month": state.month,
        # The calendar month's own name. Deliberately NOT
        # `F.period_label(None, month)`, which answers "All Time" for a yearless
        # period -- true of a period, wrong as a label for October.
        "month_label": MONTHS[state.month - 1] if state.month else None,
        "period_label": F.period_label(state.year, state.month),
        "channel": channels,
        "channel_label": ", ".join(names) if names else "All channels",
        "category": sorted(state.category) if state.category else None,
        "category_label": ", ".join(sorted(state.category)) if state.category else "All categories",
        "product": sorted(state.product) if state.product else None,
        "product_label": _product_label(state),
        "weeks_in_month": calendar.weeks_in_month,
        "days_in_month": calendar.days_in_month,
        "week_boundaries": list(calendar.boundaries),
        "week_keys": list(calendar.week_keys),
        "week_ordinals": calendar.ordinals,
        "elapsed_weeks": list(checkpoint.elapsed_weeks),
        "remaining_weeks": list(checkpoint.remaining_weeks),
        "weeks_completed": checkpoint.weeks_completed,
        "weeks_total": calendar.weeks_in_month,
        "weeks_remaining": checkpoint.weeks_remaining,
        "filters_applied": state.applied(),
        "available_years": store.years(),
        # THE CASCADE'S OWN LIST, not every category in the catalogue. A category
        # that does not trade in this channel and month is not a choice here.
        "available_categories": cascade_options(state)["categories"],
        # SECTION 6's summary line, assembled once on the server so the screen and
        # the API cannot describe the same scope differently.
        "scope_summary": _scope_summary(state, calendar, checkpoint),
    }


def _product_label(state: FilterState) -> str:
    """The selected product's business name, or how many were selected.

    From `dim_product`, never written down here. An id with no dimension row
    keeps its id rather than being given an invented name.
    """
    if not state.product:
        return "All products"
    store = get_store()
    names = [
        (store.dims.products[pid].name.strip() if pid in store.dims.products else pid)
        for pid in sorted(state.product)
    ]
    return names[0] if len(names) == 1 else f"{len(names)} products"


def _scope_summary(
    state: FilterState, calendar: MonthCalendar, checkpoint: Checkpoint
) -> str:
    """Year, month, channel, category, product and checkpoint, in one line.

    Every level is named even when unconstrained -- "All categories" rather than
    silence -- because a summary that omits a level leaves the reader guessing
    whether it was filtered or forgotten.
    """
    store = get_store()
    channels = sorted(state.channel) if state.channel else None
    channel = (
        ", ".join(
            store.dims.channels[c].name if c in store.dims.channels else c for c in channels
        )
        if channels else "All channels"
    )
    category = ", ".join(sorted(state.category)) if state.category else "All categories"
    parts = [
        F.period_label(state.year, state.month),
        channel,
        category,
        _product_label(state),
    ]
    if checkpoint.ordinal:
        parts.append(f"Week {checkpoint.ordinal} checkpoint")
    elif calendar.weeks_in_month == 0:
        parts.append("no business week")
    return " · ".join(parts)


def _provenance() -> dict[str, Any]:
    return {
        "response_rule": response.PROVENANCE,
        "promotion_cost_rate": config.PROMOTION_COST_RATE,
        "approved_discount_pct": sorted(response.APPROVED_DISCOUNT_PCT),
        "clearance_mechanics": [
            {
                "treatment": treatment,
                "name": approved_mechanic_names()[treatment],
                "discount_pct": response.get_treatment(treatment).discount_pct,
                "uplift_low": response.get_treatment(treatment).uplift_low,
                "uplift_high": response.get_treatment(treatment).uplift_high,
            }
            for treatment in clearance_treatments()
        ],
        "clearance_basis": (
            "Read from the promotion master (dim_promotion). The master records PB001 as "
            "Buy3Get1 at the 25% approved depth and holds no Buy2Get1, so Buy3Get1 is "
            "offered on its own approved economics and Buy2Get1 is never offered. No "
            "mechanic outside the master is priced."
        ),
        "economics": (
            "units = baseline x (1 + u); gross = units x list price; revenue = gross x "
            "(1 - d); trade spend = gross x (d + c); total cost = unit cost x units. The "
            "same algebra app/tpo/execution.synthesize applies row by row."
        ),
        "kpi_engine": (
            "Trade Spend, Margin Impact and ROI come from aggregate.calculate_trade_spend, "
            "aggregate.calculate_margin and aggregate.roi_multiple. Incremental Units and "
            "Incremental Sales are aggregate._volume's definitions with the baseline "
            "supplied, because a row set carrying the treatment on every row holds no "
            "non-promoted row to derive one from."
        ),
        "day_grain": (
            "Progress is measured in COMPLETED BUSINESS WEEKS, never in raw days. "
            "fact_sales carries a scrambled Date on three channels, so the project "
            "derives the analytical month from the week and there is no trustworthy "
            "daily grain to read a mid-week checkpoint at. No day-level figure is "
            "fabricated and no partial week is prorated."
        ),
        "cadence_basis": (
            "Checkpoint behaviour follows the channel's promotion cadence, read from "
            "app/tpo/promo_calendar.CADENCE. A weekly-cadence channel is read at its "
            "latest completed business week; a monthly-cadence channel at the mid-month "
            f"checkpoint, completed business week {MONTHLY_CHECKPOINT_WEEK}."
        ),
        "promotion_identity": (
            "A weekly channel's promotions stay separate: every remaining week is "
            "evaluated as its own event, carrying its own Promotion_Id, and the expected "
            "recovery is aggregated across them. A monthly channel's repeated weeks are "
            "one monthly treatment observed at weekly grain, not several promotions."
        ),
        "intervention_scope": (
            "An intervention applies only to the month's REMAINING business weeks. "
            "Completed weeks are read as recorded and are never re-priced."
        ),
        "selection_scope": (
            "Year, month, channel, category and product are ONE FilterState, applied "
            "once before any measurement. Every figure on this response -- month-to-date "
            "units, attainment, the gap, the run-rate, the projection, the status, the "
            "remaining weeks, the ladder, trade spend, incremental sales, ROI, margin and "
            "the recommendation -- is computed over exactly those rows. No level of the "
            "hierarchy is applied for display only."
        ),
        "option_cascade": (
            "Channel, then category, then product. Each list is generated from the rows "
            "the levels above it admit, by the same app/tpo/filters.options_for the "
            "Command Center uses, so an option appears only if selecting it returns a row."
        ),
        "days_in_month_basis": (
            "The days the analytical month's business weeks cover, from dim_date -- not the "
            "calendar length of the month, whose first days belong to a business week filed "
            "under the previous month."
        ),
        "decision_rule": (
            "An intervention counts as reaching the target only at the BOTTOM of its "
            "approved uplift band. The top of the band is reported beside it and is never "
            "what the recommendation rests on."
        ),
        "ranking_basis": RANKING_BASIS,
        "discount_ceiling": (
            f"{MAX_DISCOUNT_PCT:g}%, the deepest approved treatment depth. No deeper "
            "discount has an approved uplift band, so none can be recommended."
        ),
        "cannibalization": CANNIBALIZATION_NOTE,
        "run_rate": RUN_RATE_NOTE,
        "execution": (
            "Target Rescue recommends and simulates only. It creates no promotion, changes "
            "no calendar, writes no fact row and activates no discount. Execution remains a "
            "Decision Center action."
        ),
    }


def _meta(currency: str) -> dict[str, Any]:
    return {
        "mode": MODE,
        "currency": currency,
        "base_currency": config.BASE_CURRENCY,
        "exchange_rate": F._rate(currency),
        "max_discount_pct": MAX_DISCOUNT_PCT,
        "monthly_checkpoint_week": MONTHLY_CHECKPOINT_WEEK,
        "on_track_attainment_pct": ON_TRACK_ATTAINMENT_PCT,
        "watch_attainment_pct": WATCH_ATTAINMENT_PCT,
    }


def _discount_block() -> dict[str, Any]:
    """The approved points the control may land on, and why it may not land
    between them."""
    mechanics = clearance_treatments()
    return {
        "min_pct": 0.0,
        "max_pct": MAX_DISCOUNT_PCT,
        "approved_points": [
            {
                "discount_pct": rule.discount_pct,
                "treatment": rule.treatment,
                "name": approved_mechanic_names().get(rule.treatment, rule.treatment),
                "uplift_low": rule.uplift_low,
                "uplift_high": rule.uplift_high,
                "breakeven_uplift": rule.breakeven_uplift,
                "clearance": rule.treatment in mechanics,
            }
            for rule in sorted(response.all_treatments(), key=lambda r: r.discount_pct)
        ],
        "note": (
            "Only the approved treatment depths can be priced. A position between two of "
            "them resolves to the applicable approved treatment; it does not create a depth "
            "with an invented uplift band."
        ),
    }


def _level_payload(level: Level, currency: str) -> dict[str, Any]:
    return {
        "level": level.level,
        "kind": level.kind,
        "ladder_label": level.ladder_label,
        "treatment": level.treatment,
        # NULL, not zero, on the maintain rung. That rung is the remaining weeks
        # AS RECORDED -- it did not run at a 0% depth, it ran at whatever depth
        # the data holds, which travels beside it as `measured_depth_pct`.
        "discount_pct": None if level.kind == "maintain" else level.discount_pct,
        "discount_display": "Current" if level.kind == "maintain" else F.percent(level.discount_pct),
        "measured_depth_pct": level.measured_depth_pct,
        "measured_depth_display": F.percent(level.measured_depth_pct),
        "mechanic": level.mechanic,
        "level_note": level.level_note,
        "uplift": {"low": level.uplift_low, "high": level.uplift_high},
        # `units` is the TREATABLE population only, so the rungs are comparable
        # with each other. `remaining_units` adds the carried products back, so
        # the figure is comparable with the month's own measured remainder.
        "units": _band(level.units_low, level.units_high, "quantity", currency),
        "remaining_units": _band(
            level.units_low + level.carried_units,
            level.units_high + level.carried_units,
            "quantity",
            currency,
        ),
        "projected_month_end": _band(level.projected_low, level.projected_high, "quantity", currency),
        "achievement_pct": {"low": level.achievement_low, "high": level.achievement_high},
        "reaches_target": level.reaches_target,
        "recovery_units": _band(level.recovery_units_low, level.recovery_units_high, "quantity", currency),
        "trade_spend": level.trade_spend,
        "trade_spend_display": F.money(level.trade_spend, currency),
        "additional_trade_spend": level.additional_trade_spend,
        "additional_trade_spend_display": F.money(level.additional_trade_spend, currency),
        "incremental_units": level.incremental_units,
        "incremental_units_display": F.quantity(level.incremental_units),
        "incremental_sales": level.incremental_sales,
        "incremental_sales_display": F.money(level.incremental_sales, currency),
        "roi_multiple": level.roi_multiple,
        "roi_display": F.multiple(level.roi_multiple),
        "margin_pct": level.margin_pct,
        "margin_display": F.percent(level.margin_pct),
        "estimable": level.estimable,
        "unavailable_reason": level.unavailable_reason,
        "within_budget": level.within_budget,
        "budget_reason": level.budget_reason,
        # SECTION 11's aggregation, shown rather than only summed: each remaining
        # business week's own contribution, with the Promotion_Ids it carries.
        "by_week": [
            {
                "week_key": week.week_key,
                "week_number": int(week.week_key.split("-W")[1]),
                "ordinal": week.ordinal,
                "label": f"Week {week.ordinal}",
                "promotion_ids": list(week.promotion_ids),
                "promoted": bool(week.promotion_ids),
                "measured_units": round(week.measured_units, 0),
                "measured_units_display": F.quantity(round(week.measured_units, 0)),
                "units": _band(week.units_low, week.units_high, "quantity", currency),
                "trade_spend": week.trade_spend,
                "trade_spend_display": F.money(week.trade_spend, currency),
            }
            for week in level.by_week
        ],
    }


# --- the historical reference target ---------------------------------------


def reference_target(state: FilterState, currency: str = "INR") -> dict[str, Any]:
    """A MEASURED figure to seed the target input from, or nothing.

    The same month, channel and category in the PREVIOUS year, measured by the
    engine over the whole month. It is offered as a reference and never as a
    default the user did not choose: a target is a business commitment, and this
    module has no standing to invent one.

    Null with the reason when the previous year holds no rows for the scope --
    the first year in the data has no predecessor, and a zero there would read
    as a target of nothing.
    """
    if state.year is None:
        return {
            "units": None,
            "units_display": F.quantity(None),
            "year": None,
            "available": False,
            "basis": None,
            "unavailable_reason": "No year is resolved for this scope.",
        }
    previous = state.year - 1
    if previous not in get_store().years():
        return {
            "units": None,
            "units_display": F.quantity(None),
            "year": previous,
            "available": False,
            "basis": None,
            "unavailable_reason": (
                f"{previous} is not in the dataset, so there is no prior-year actual for "
                "this month to reference."
            ),
        }
    rows = rows_for(state.replace(year=previous))
    if not rows:
        return {
            "units": None,
            "units_display": F.quantity(None),
            "year": previous,
            "available": False,
            "basis": None,
            "unavailable_reason": (
                f"{previous} holds no rows for this month, channel and category."
            ),
        }
    units = round(sum(row.actual_quantity for row in rows), 0)
    return {
        "units": units,
        "units_display": F.quantity(units),
        "year": previous,
        "available": True,
        "basis": (
            f"Measured units for the same month, channel and category in {previous}. A "
            "reference, not a target -- the target is the user's to set."
        ),
        "unavailable_reason": None,
    }


def budget_reference(state: FilterState, currency: str = "INR") -> dict[str, Any]:
    """What bounds the optional additional-trade-spend ceiling.

    `optimization.historical_reference` MEASURES it: the mean Trade Spend across
    the reference years for this month, channel and category, on the project's
    own Trade Spend definition. Reused rather than re-derived, so the two modes
    cannot disagree about what an ordinary month costs.

    The control is offered ONLY when that measurement exists. The brief forbids
    inventing a ceiling, and an unmeasurable scope gets no slider rather than a
    round number nobody chose.
    """
    reference = optimization.historical_reference(state)
    return {
        **reference,
        "display_average": F.money(reference["average_trade_spend"], currency),
        "note": (
            "An optional cap on ADDITIONAL trade spend, over and above what the month's "
            "remaining weeks already carry. A recommendation never silently exceeds it: an "
            "intervention past the cap is reported as blocked, with the amount it needed."
        ),
    }


# --- the endpoint payloads --------------------------------------------------


def _checkpoint_block(
    calendar: MonthCalendar, checkpoint: Checkpoint, cadence: Cadence
) -> dict[str, Any]:
    """Where progress was read, how that was chosen, and what else was available.

    `checkpoint_type` distinguishes "Auto chose week 3" from "the user chose week
    3" -- the same ordinal arrived at two different ways, and a screen explaining
    the default needs to know which.
    """
    return {
        "checkpoint_type": checkpoint.kind,
        "checkpoint_week": checkpoint.ordinal,
        "checkpoint_label": (
            f"Week {checkpoint.ordinal}" if checkpoint.ordinal else "No completed week"
        ),
        "week_key": checkpoint.week_key,
        "requested": checkpoint.requested,
        "weeks_completed": checkpoint.weeks_completed,
        "weeks_total": calendar.weeks_in_month,
        "weeks_remaining": checkpoint.weeks_remaining,
        # Days are DERIVED from the completed weeks and exist only as the
        # run-rate's denominator. They are never an input, and no day-level
        # sales figure is read.
        "days_elapsed": checkpoint.days_elapsed,
        "days_in_month": calendar.days_in_month,
        "auto_rule": (
            "Latest completed business week"
            if cadence.weekly
            else f"Completed business week {MONTHLY_CHECKPOINT_WEEK} (mid-month)"
        ),
        "options": checkpoint_options(calendar, cadence),
        "note": (
            "Progress is read at complete business-week boundaries only. The day count "
            "beside it is what those weeks cover in the authoritative calendar -- it is "
            "not a daily sales read."
        ),
    }


def scope(
    state: FilterState,
    checkpoint: int | str | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """What the controls need before a target has been entered.

    Four of these the client genuinely cannot work out for itself, which is why
    this endpoint exists at all:

      * the CADENCE of the selected channel(s), and therefore which checkpoint
        rule applies;
      * which business weeks the month holds, so the checkpoint selector can
        offer those and only those -- the brief forbids offering an impossible
        future week;
      * the prior-year actual, so the target input has a measured figure to start
        from rather than a made-up one;
      * the measured discount depth the elapsed weeks actually ran at.

    It evaluates nothing and recommends nothing.
    """
    currency = F.normalise_currency(currency)
    state = state.replace(year=resolve_year(state.year))
    validate_selection(state)
    cadence = resolve_cadence(state)
    rows = rows_for(state)
    calendar = month_calendar(state, rows)
    resolved = resolve_checkpoint(calendar, cadence, checkpoint)

    if not rows:
        return {
            "mode": MODE,
            "status": STATUS_NO_DATA,
            "message": (
                f"{_scope_summary(state, calendar, resolved)} selects no sales rows, so "
                "there is no progress to measure and no target to assess."
            ),
            "scope": _scope_block(state, calendar, resolved, cadence),
            "cadence": _cadence_block(cadence),
            "checkpoint": None,
            # THE CASCADE IS STILL RETURNED. An empty scope is exactly when the
            # user needs the option lists to climb back out of it.
            "options": cascade_options(state),
            "reference_target": None,
            "measured": None,
            "discount": _discount_block(),
            "budget": None,
            "ready": False,
            "provenance": _provenance(),
            "meta": _meta(currency),
        }

    elapsed = [row for row in rows if row.week_key in set(resolved.elapsed_weeks)]
    return {
        "mode": MODE,
        "status": STATUS_EVALUATED,
        "message": None,
        "scope": _scope_block(state, calendar, resolved, cadence),
        "cadence": _cadence_block(cadence),
        "checkpoint": _checkpoint_block(calendar, resolved, cadence),
        "options": cascade_options(state),
        "reference_target": reference_target(state, currency),
        "measured": {
            "month_units": round(sum(row.actual_quantity for row in rows), 0),
            "month_units_display": F.quantity(round(sum(row.actual_quantity for row in rows), 0)),
            # MONTH-TO-DATE: the sum over the COMPLETED business weeks, which is
            # the same figure the evaluation measures attainment from.
            "units_mtd": round(sum(row.actual_quantity for row in elapsed), 0),
            "units_mtd_display": F.quantity(round(sum(row.actual_quantity for row in elapsed), 0)),
            "elapsed_depth_pct": measured_depth_pct(elapsed),
            "elapsed_depth_display": F.percent(measured_depth_pct(elapsed)),
            "month_depth_pct": measured_depth_pct(rows),
            "depth_basis": (
                "Given-away revenue over gross revenue for the completed business weeks -- "
                "the depth the month actually ran at, read from prices rather than from a "
                "promotion's name. Shown so the current-discount control can be set from "
                "evidence."
            ),
            "mtd_basis": (
                "Sum of actual units across the completed business weeks of the selected "
                "year, month and channel. The weeks come from the authoritative "
                "(Year, Week) to month mapping, never from fact_sales.Date."
            ),
        },
        "discount": _discount_block(),
        "budget": budget_reference(state, currency),
        "ready": True,
        "provenance": _provenance(),
        "meta": _meta(currency),
    }


def _remaining_scope(
    pop: Population, cadence: Cadence, remaining_rows: Sequence[A.WeekRow]
) -> dict[str, Any]:
    """What an intervention would actually act on, and how it is counted.

    SECTIONS 11 AND 12, side by side. The same remaining weeks are counted two
    different ways depending on the channel's cadence, and the difference is not
    cosmetic:

      * WEEKLY -- every remaining business week is its OWN promotion opportunity,
        with its own Promotion_Id. Two remaining weeks are two opportunities.
      * MONTHLY -- the remaining weeks are the tail of ONE monthly treatment.
        Three remaining weeks are one opportunity observed over three weeks, not
        three promotions.
      * MIXED -- counted the monthly way, because a monthly channel is present
        and reading its month as independent weekly slots is precisely what
        section 12 forbids.
    """
    weeks: list[dict[str, Any]] = []
    by_week: dict[str, list[A.WeekRow]] = defaultdict(list)
    for row in remaining_rows:
        by_week[row.week_key].append(row)

    treatable_by_week: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for candidate in pop.treatable:
        treatable_by_week[candidate.week_key].add((candidate.product_id, candidate.channel_id))

    for week_key in sorted(by_week, key=lambda w: pop.ordinals.get(w, 0)):
        week_rows = by_week[week_key]
        promoted = sorted({r.promotion_id for r in week_rows if r.is_promoted})
        weeks.append({
            "week_key": week_key,
            "week_number": int(week_key.split("-W")[1]),
            "ordinal": pop.ordinals.get(week_key, 0),
            "label": f"Week {pop.ordinals.get(week_key, 0)}",
            "promotion_ids": promoted,
            "promoted": bool(promoted),
            "measured_units": round(sum(r.actual_quantity for r in week_rows), 0),
            "treatable_products": len(treatable_by_week.get(week_key, ())),
        })

    if cadence.weekly:
        opportunities = len(weeks)
        opportunity_label = (
            f"{opportunities} weekly promotion opportunit{'y' if opportunities == 1 else 'ies'}"
        )
        basis = (
            "A weekly-cadence channel plans a separate promotion each business week, so "
            "each remaining week is its own opportunity and keeps its own Promotion_Id. "
            "The expected recovery is evaluated per week and aggregated."
        )
    else:
        opportunities = 1 if weeks else 0
        opportunity_label = (
            f"1 monthly promotion treatment across {len(weeks)} remaining business "
            f"week{'' if len(weeks) == 1 else 's'}"
            if weeks else "no remaining monthly promotion period"
        )
        basis = (
            "A monthly-cadence channel runs ONE treatment across the month's business "
            "weeks. The repeated weeks are the same promotion observed at weekly grain, "
            "not several promotions, so they count as a single opportunity."
        )

    return {
        "weeks": weeks,
        "weeks_remaining": len(weeks),
        "promotion_opportunities": opportunities,
        "opportunity_label": opportunity_label,
        "distinct_promotion_ids": sorted({
            pid for week in weeks for pid in week["promotion_ids"]
        }),
        "treatable_products": pop.treatable_products,
        "carried_products": pop.carried_products,
        "basis": basis,
        "completed_weeks_untouched": (
            "Completed business weeks are read as recorded. No rung of the ladder "
            "re-prices one."
        ),
    }


def _evidence(
    *,
    checkpoint: Checkpoint,
    calendar: MonthCalendar,
    cadence: Cadence,
    units_sold: float,
    target_units: float,
    attainment_pct: float | None,
    pace: dict[str, Any],
    phase: str,
    pop: Population,
    remaining: dict[str, Any],
    total_products: int,
) -> list[str]:
    """The "why this recommendation?" trail, in sentences the numbers support.

    Every line is derived from a figure elsewhere on the same response. Nothing
    here characterises a result the calculation did not produce.
    """
    lines: list[str] = []
    share = (
        "an undefined share of" if attainment_pct is None else f"{attainment_pct:g}% of"
    )
    lines.append(
        f"At completed business week {checkpoint.weeks_completed} of "
        f"{calendar.weeks_in_month}, month-to-date units are {F.quantity(units_sold)} -- "
        f"{share} the {F.quantity(target_units)} unit target. Progress is the sum of the "
        f"completed business weeks, not a daily read."
    )
    lines.append(
        f"{cadence.label} cadence: the checkpoint "
        + (
            f"defaults to the latest completed business week."
            if cadence.weekly
            else f"defaults to completed business week {MONTHLY_CHECKPOINT_WEEK}, the "
            f"mid-month read."
        )
        + (
            f" It was chosen automatically."
            if checkpoint.kind == CHECKPOINT_AUTO
            else f" Week {checkpoint.ordinal} was selected explicitly."
        )
    )
    if pace["projected_month_end"] is not None:
        verdict = (
            "at or above the target"
            if pace["projected_month_end"] >= target_units
            else "below the target"
        )
        lines.append(
            f"The measured pace of {pace['daily_pace_display']} units/day across the "
            f"{checkpoint.days_elapsed} days those weeks cover projects "
            f"{pace['projected_month_end_display']} units by month end -- {verdict}. This is "
            f"a run-rate projection, not a forecast."
        )
    if phase == PHASE_EARLY:
        lines.append(EARLY_MONTH_NOTE)
    if phase == PHASE_COMPLETE:
        lines.append(
            "No business week of the month remains, so this is a final result rather than a "
            "rescue. No intervention can act on a period that has closed."
            + (
                " The checkpoint resolved automatically to the latest completed business "
                "week, which is the month's last; select an earlier week to evaluate a "
                "mid-month rescue."
                if checkpoint.kind in (CHECKPOINT_AUTO, CHECKPOINT_LATEST)
                else ""
            )
        )
    else:
        lines.append(
            f"An intervention would act on {remaining['opportunity_label']}. "
            f"{remaining['completed_weeks_untouched']}"
        )
    if pop.carried_products:
        lines.append(
            f"{pop.carried_products} of {total_products} products in scope have no "
            f"non-promoted week this month, so no approved treatment can be re-based on them. "
            f"Their {F.quantity(pop.carried_units)} remaining units are carried at their "
            f"measured level in every option, identically, so they cannot tilt the comparison."
        )
    return lines


def rescue(
    state: FilterState,
    target_units: float,
    current_discount_pct: float,
    checkpoint: int | str | None = None,
    max_additional_trade_spend: float | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """Evaluate one month's target and recommend the least aggressive recovery.

    The order is the brief's: resolve the channel's cadence, read progress at the
    checkpoint that cadence implies, judge the status, project the pace, size the
    gap, then -- and only if the trajectory does not already reach the target --
    walk the approved ladder from the bottom over the REMAINING business weeks and
    stop at the first rung that gets there.

    Raises `ImpossibleCheckpoint` for a week the month does not contain. A scope
    with no rows returns a status and a reason and NO NUMBERS: a zeroed assessment
    would read as "the target was missed" rather than "nothing was measured".
    """
    currency = F.normalise_currency(currency)
    state = state.replace(year=resolve_year(state.year))
    validate_selection(state)
    cadence = resolve_cadence(state)
    rows = rows_for(state)
    calendar = month_calendar(state, rows)
    mark = resolve_checkpoint(calendar, cadence, checkpoint)

    if not rows:
        return {
            "mode": MODE,
            "status": STATUS_NO_DATA,
            "message": (
                f"{_scope_summary(state, calendar, mark)} selects no sales rows. There is no "
                "progress to measure against the target, and no intervention to evaluate."
            ),
            "scope": _scope_block(state, calendar, mark, cadence),
            "cadence": _cadence_block(cadence),
            "checkpoint": None,
            # THE CASCADE IS STILL RETURNED. An empty scope is exactly when the
            # user needs the option lists to climb back out of it.
            "options": cascade_options(state),
            "progress": None,
            "target_status": None,
            "pace": None,
            "gap": None,
            "current_treatment": None,
            "interventions": [],
            "recommendation": None,
            "evidence": [],
            # Every block the evaluated response carries is present and NULL, so
            # a client reads one shape either way and cannot mistake an absent
            # key for a zero.
            "budget": None,
            "population": None,
            "remaining_scope": None,
            "discount": _discount_block(),
            "provenance": _provenance(),
            "meta": _meta(currency),
        }

    # MONTH-TO-DATE. The sum of ACTUAL UNITS over the COMPLETED BUSINESS WEEKS of
    # the selected year, month and channel -- section 4 of the brief, verbatim.
    # The weeks come from `WeekRow.week_key` and `WeekRow.month`, which the loader
    # derives from the authoritative (Year, Week) to dim_date join; nothing here
    # reads `fact_sales.Date`.
    elapsed_keys = set(mark.elapsed_weeks)
    remaining_keys = set(mark.remaining_weeks)
    elapsed_rows = [row for row in rows if row.week_key in elapsed_keys]
    remaining_rows = [row for row in rows if row.week_key in remaining_keys]
    units_mtd = sum(row.actual_quantity for row in elapsed_rows)
    attainment_pct = _achievement(units_mtd, target_units)

    # THE PHASE IS COUNTED IN WEEKS, not days. "Early" is fewer completed
    # business weeks than the mid-month checkpoint needs -- the same threshold the
    # monthly auto rule uses, so the two cannot disagree about when the evidence
    # becomes reliable.
    phase = (
        PHASE_COMPLETE
        if not mark.remaining_weeks
        else PHASE_EARLY
        if mark.weeks_completed < MONTHLY_CHECKPOINT_WEEK
        else PHASE_CHECKPOINT
    )

    # THE RUN-RATE'S ELAPSED DENOMINATOR IS THE DAYS THE COMPLETED WEEKS COVER,
    # from the authoritative calendar. It is derived from the weeks, never read as
    # a raw calendar day count that might contradict them.
    pace = pace_block(units_mtd, mark.days_elapsed, calendar.days_in_month, target_units, currency)
    gap = gap_block(target_units, units_mtd)
    status = target_status(attainment_pct, phase, achieved=units_mtd >= target_units)

    # THE CURRENT TREATMENT, resolved to an approved depth. A slider position
    # between two approved points is not a treatment; `snap_to_approved` says
    # which one it is, and `snapped` keeps the movement visible.
    current_depth, current_treatment = snap_to_approved(current_discount_pct)

    pop = population(rows, mark, calendar)
    remaining = _remaining_scope(pop, cadence, remaining_rows)
    total_products = len({(row.product_id, row.channel_id) for row in remaining_rows})

    if phase == PHASE_COMPLETE:
        # No ladder. A closed month has no remaining business week for a treatment
        # to act on -- section 17 -- and an empty list says that better than four
        # rungs each carrying "cannot be estimated".
        levels: list[Level] = []
    else:
        levels = _build_ladder(
            pop=pop,
            units_sold=units_mtd,
            target_units=target_units,
            current_depth=current_depth,
            budget=max_additional_trade_spend,
            currency=currency,
        )

    recommendation = _recommend(
        levels,
        target_units=target_units,
        projected_run_rate=pace["projected_month_end"] or 0.0,
        phase=phase,
        current_discount_pct=current_depth,
        currency=currency,
    )
    recommended = next(
        (
            level for level in levels
            if recommendation["level"] is not None and level.level == recommendation["level"]
        ),
        None,
    )
    recommendation["intervention"] = (
        _level_payload(recommended, currency) if recommended is not None else None
    )

    evidence = _evidence(
        checkpoint=mark,
        calendar=calendar,
        cadence=cadence,
        units_sold=units_mtd,
        target_units=target_units,
        attainment_pct=attainment_pct,
        pace=pace,
        phase=phase,
        pop=pop,
        remaining=remaining,
        total_products=total_products,
    )
    if recommendation["reason"]:
        evidence.append(recommendation["reason"])

    return {
        "mode": MODE,
        "status": STATUS_EVALUATED,
        "message": None,
        "scope": _scope_block(state, calendar, mark, cadence),
        "cadence": _cadence_block(cadence),
        "checkpoint": _checkpoint_block(calendar, mark, cadence),
        "options": cascade_options(state),
        "progress": {
            "checkpoint_type": mark.kind,
            "checkpoint_week": mark.ordinal,
            "checkpoint_label": f"Week {mark.ordinal}" if mark.ordinal else "No completed week",
            "week_key": mark.week_key,
            "weeks_completed": mark.weeks_completed,
            "weeks_total": calendar.weeks_in_month,
            "weeks_remaining": mark.weeks_remaining,
            # Derived from the completed weeks, for the run-rate. Not a daily read.
            "days_elapsed": mark.days_elapsed,
            "days_in_month": calendar.days_in_month,
            "days_remaining": calendar.days_in_month - mark.days_elapsed,
            "boundaries": list(calendar.boundaries),
            "units_mtd": round(units_mtd, 0),
            "units_mtd_display": F.quantity(round(units_mtd, 0)),
            # Kept under its original name too: it is the same figure, and a
            # client reading `units_sold` should not silently get nothing.
            "units_sold": round(units_mtd, 0),
            "units_sold_display": F.quantity(round(units_mtd, 0)),
            "target_units": target_units,
            "target_units_display": F.quantity(target_units),
            "attainment_pct": attainment_pct,
            "target_attainment": attainment_pct,
            "attainment_display": F.percent(attainment_pct),
            "phase": phase,
            "phase_note": (
                EARLY_MONTH_NOTE
                if phase == PHASE_EARLY
                else (
                    "No business week of the month remains. This is a final target result, "
                    "not a rescue."
                    if phase == PHASE_COMPLETE
                    else (
                        f"Completed business week {mark.weeks_completed} of "
                        f"{calendar.weeks_in_month}: the normal Target Rescue interpretation "
                        f"applies."
                    )
                )
            ),
            "mtd_basis": (
                "Sum of actual units across the completed business weeks of the selected "
                "year, month and channel. The month of each week comes from the "
                "authoritative (Year, Week) to dim_date mapping, never from "
                "fact_sales.Date."
            ),
        },
        "target_status": status,
        "pace": pace,
        "gap": gap,
        "current_treatment": {
            "discount_pct": current_depth,
            "discount_display": F.percent(current_depth),
            "treatment": current_treatment,
            "name": approved_mechanic_names().get(current_treatment or "", None),
            "requested_pct": float(current_discount_pct),
            "snapped": current_depth != float(current_discount_pct),
            "measured_depth_pct": measured_depth_pct(elapsed_rows),
            "measured_depth_display": F.percent(measured_depth_pct(elapsed_rows)),
            "at_ceiling": current_depth >= MAX_DISCOUNT_PCT,
            "ceiling_pct": MAX_DISCOUNT_PCT,
            "no_stronger_reason": (
                None if ladder(current_depth) else no_stronger_reason(current_depth)
            ),
        },
        "interventions": [_level_payload(level, currency) for level in levels],
        "recommendation": recommendation,
        "evidence": evidence,
        "remaining_scope": remaining,
        "budget": {
            "max_additional_trade_spend": max_additional_trade_spend,
            "max_additional_trade_spend_display": F.money(max_additional_trade_spend, currency),
            "applied": max_additional_trade_spend is not None,
            **budget_reference(state, currency),
        },
        "population": {
            "treatable_products": pop.treatable_products,
            "treatable_rows": len(pop.treatable),
            "carried_products": pop.carried_products,
            "carried_units": round(pop.carried_units, 0),
            "carried_units_display": F.quantity(round(pop.carried_units, 0)),
            "carried_reason": (
                "No non-promoted week anywhere in this month, so there is no ordinary demand "
                "level for an approved treatment to be applied to. Carried at the measured "
                "level in every option."
                if pop.carried_products
                else None
            ),
            "remaining_products": total_products,
        },
        "discount": _discount_block(),
        "provenance": _provenance(),
        "meta": _meta(currency),
    }
