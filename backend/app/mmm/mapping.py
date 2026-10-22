"""Making a client's column names into MMM's — the mapping half of the upload.

WHY THIS EXISTS. `app/mmm/schema.py` identifies a file by its column headers,
which works only while those headers are already canonical. A real marketing
extract calls the day `TxnDate`, revenue `NetSales` and television spend `TV`
or `TV_Cost`, so the file was refused as "Missing required column: Revenue" —
a message about the wrong problem, since the file holds exactly the right data
under different names.

THE SAME SHAPE AS TPO'S `app/column_mapping.py`, over MMM's own contract.
`propose` suggests which actual column stands for each canonical one;
`apply_to_header` (TPO's, reused unchanged — it is pure) rewrites the header
once a mapping is settled. Nothing here decides anything on its own: a
proposal is shown to the reader, who confirms or corrects it, and only the
confirmed mapping is applied.

FOUR PASSES, WEAKEST LAST.
  exact   already MMM's name, in any spelling or casing.
  alias   a synonym that can only mean that column (`netsales` -> Revenue).
  channel a reference channel named without `_Spend`, or with a different
          spend word: `TV`, `TV Cost`, `Meta Ads Investment` -> TV_Spend,
          Meta_Ads_Spend. Matched on the channel's base name, so all 22
          reference channels are covered by one rule rather than 22 lists.
  new     any other column whose name ENDS in a spend word becomes a channel
          of its own: `Radio_Cost` -> `Radio_Spend`. MMM already accepts an
          unlisted `*_Spend` column as a further channel, so this only gives
          the same column the name the contract expects.
Each match records which pass found it, so the mapping screen can show a weak
guess as something to confirm rather than as a settled fact.

AMBIGUITY IS LEFT TO THE READER, ON PURPOSE. A column called `Print` could be
Newspaper_Spend or Magazine_Spend; `OOH` could be any of three channels;
`Social` could be any of four. Guessing would be quietly catastrophic — spend
attributed to the wrong channel moves its whole response curve and therefore
every recommendation the Budget Optimizer makes — so a name that names a
FAMILY rather than a channel is not aliased at all. It comes back spare, and
the mapping screen asks.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from app.column_mapping import apply_to_header, normalise
from app.mmm import schema

__all__ = ["MMM_ALIASES", "Proposal", "apply_to_header", "normalise", "propose", "spend_base"]


#: canonical column -> names that can only mean that column, for everything
#: that is not a media channel. Conservative by construction: anything that
#: could plausibly mean two canonical columns is absent.
MMM_ALIASES: dict[str, tuple[str, ...]] = {
    "Date": ("day", "days", "txndate", "transactiondate", "calendarday", "calendardate",
             "businessdate", "reportdate", "reportingdate", "activitydate", "datekey",
             "dateday", "salesdate", "spenddate", "periodday"),
    "Revenue": ("sales", "netsales", "grosssales", "totalsales", "salesvalue", "salesamount",
                "salesrevenue", "netrevenue", "grossrevenue", "totalrevenue", "revenueamount",
                "revenuevalue", "revenueinr", "turnover", "gmv", "netsalesvalue",
                "dailysales", "dailyrevenue"),
    "Festival_Flag": ("holidayflag", "festival", "isfestival", "festivalday", "festivalperiod",
                      "holiday", "isholiday", "holidayperiod", "festiveflag"),
    "Seasonal_Flag": ("trendingflag", "seasonal", "isseasonal", "seasonflag", "seasonalityflag",
                      "seasonalperiod", "peakseason"),
    "Promotion_Flag": ("promoflag", "ispromo", "ispromotion", "onpromo", "onpromotion",
                       "promoactive", "haspromotion", "promotionactive", "dealflag",
                       "offerflag"),
    "Discount_Percentage": ("discount", "discountpct", "discountpercent", "discountpercentage",
                            "discpercent", "discpct", "promodiscount", "discountrate",
                            "offerdiscount"),
    "Promotion_Type": ("promotype", "promotiontype", "offertype", "promomechanic",
                       "promotionmechanic", "mechanic", "offername", "promotionname",
                       "promoname", "dealtype", "offer"),
    "Month": ("monthnumber", "monthno", "monthnum", "calendarmonth"),
    "Quarter": ("qtr", "quarternumber", "calendarquarter", "quarterno"),
    "Week_of_Year": ("week", "weekno", "weeknumber", "weeknum", "weekofyear", "isoweek",
                     "calendarweek"),
    "Year": ("yearnumber", "calendaryear", "yearno"),
}

#: Words a client puts where MMM writes `_Spend`. Stripped from the END of a
#: column name before it is matched against a channel, so `TV Cost`,
#: `TV Investment` and `TV Budget` all reach TV_Spend.
SPEND_WORDS: tuple[str, ...] = (
    "spend", "spends", "spending", "cost", "costs", "investment", "investments",
    "inv", "expense", "expenses", "expenditure", "budget", "budgets", "outlay",
    "adspend", "adcost", "mediaspend", "mediacost", "amount", "amt", "value",
)

#: Names that name a FAMILY or a medium in general rather than one channel, so
#: they are never resolved automatically however close they score. Each of
#: these is genuinely ambiguous under MMM's channel list.
_FAMILY_WORDS: frozenset[str] = frozenset({
    "print", "ooh", "outofhome", "social", "socialmedia", "digital", "video",
    "search", "programmatic", "audio", "broadcast", "commerce", "retailmedia",
    "influencer", "content", "media", "marketing", "advertising", "ads", "ad",
    "total", "grandtotal", "overall", "others", "other", "misc",
})

#: How alike two names must be before a misspelling is suggested, and how far
#: ahead of the runner-up the winner has to be. Same values TPO's module
#: settled on, for the same reasons.
_CLOSE_RATIO = 0.86
_CLOSE_MARGIN = 0.06
_CLOSE_MIN_LENGTH = 5


def _index() -> dict[str, str]:
    out: dict[str, str] = {}
    for canonical, aliases in MMM_ALIASES.items():
        out.setdefault(normalise(canonical), canonical)
        for alias in aliases:
            # An alias two canonical columns both claim would be ambiguous,
            # which this module refuses to be: the first wins, and the clash is
            # a bug in the table above that the tests catch.
            out.setdefault(normalise(alias), canonical)
    return out


_ALIAS_INDEX: dict[str, str] = _index()

#: Reference channel -> the spellings of its base name. `TV_Spend` is reached
#: by `tv` and `tvspend`; `In_Store_Digital_Ads_Spend` by `instoredigitalads`.
_CHANNEL_BASES: dict[str, tuple[str, ...]] = {
    column: tuple({normalise(schema.channel_label(column)), normalise(column)[: -len("spend")]})
    for column, _family in schema.MEDIA_CHANNELS
}

#: Channel -> further names that can only mean that channel. Platform names a
#: client is likelier to use than ours.
_CHANNEL_ALIASES: dict[str, tuple[str, ...]] = {
    "TV_Spend": ("television", "lineartv", "tvc"),
    "OTT_Spend": ("connectedtv", "ctv", "ottvideo"),
    "Meta_Ads_Spend": ("facebook", "facebookads", "fbads", "meta", "instagramads", "fb"),
    "YouTube_Ads_Spend": ("youtube", "yt", "ytads"),
    "Google_Ads_Spend": ("adwords", "googleadwords", "gads"),
    "Google_Search_Spend": ("paidsearch", "sem", "searchengine", "googlesem"),
    "TikTok_Ads_Spend": ("tiktok",),
    "Newspaper_Spend": ("press", "newspapers", "dailies"),
    "Magazine_Spend": ("magazines", "periodicals"),
    "Billboard_Spend": ("billboards", "hoarding", "hoardings"),
    "Streaming_Audio_Spend": ("spotify", "streamingaudio", "digitalaudio"),
    "Cinema_Advertising_Spend": ("cinema", "theatre", "theater"),
    "Programmatic_Display_Spend": ("display", "displayads", "programmaticdisplay"),
    "Ecommerce_Ads_Spend": ("ecommerce", "ecomads", "marketplaceads", "amazonads"),
    "Quick_Commerce_Ads_Spend": ("quickcommerce", "qcommerce", "blinkit", "zepto"),
    "Influencer_Marketing_Spend": ("influencer", "influencers", "influencermarketing"),
    "Creator_Content_Spend": ("creator", "creators", "creatorcontent"),
    "Sponsored_Content_Spend": ("sponsoredcontent", "advertorial", "advertorials"),
    "Native_Advertising_Spend": ("native", "nativeads"),
    "Transit_Advertising_Spend": ("transit", "metroads", "busads"),
    "Airport_Advertising_Spend": ("airport", "airportads"),
    "In_Store_Digital_Ads_Spend": ("instore", "instoredigital", "instoreads", "shopperads"),
}

_CHANNEL_INDEX: dict[str, str] = {}
for _channel, _bases in _CHANNEL_BASES.items():
    for _base in _bases:
        if _base and _base not in _FAMILY_WORDS:
            _CHANNEL_INDEX.setdefault(_base, _channel)
for _channel, _names in _CHANNEL_ALIASES.items():
    for _name in _names:
        if _name not in _FAMILY_WORDS:
            _CHANNEL_INDEX.setdefault(normalise(_name), _channel)


def spend_base(name: str) -> str | None:
    """`TV Cost` -> `tv`; `Radio_Investment` -> `radio`; `Revenue` -> None.

    The normalised name with a trailing spend word removed, or None when it
    carries none. Used both to reach a reference channel under a different
    spend word and to turn any other spend column into a channel of its own.
    """
    norm = normalise(name)
    for word in sorted(SPEND_WORDS, key=len, reverse=True):
        if norm.endswith(word) and len(norm) > len(word):
            return norm[: -len(word)]
    return None


def _channel_for(name: str) -> str | None:
    """The reference channel a column names, under any spend word, or None."""
    norm = normalise(name)
    if norm in _FAMILY_WORDS:
        return None
    if norm in _CHANNEL_INDEX:
        return _CHANNEL_INDEX[norm]
    base = spend_base(name)
    if base and base not in _FAMILY_WORDS:
        return _CHANNEL_INDEX.get(base)
    return None


def _close(name: str, candidates: dict[str, tuple[str, ...]]) -> tuple[str, float] | None:
    """The canonical column a misspelled name almost certainly means.

    None whenever the answer is not obvious: too short, a family word, or
    within `_CLOSE_MARGIN` of a second canonical column. A caller that gets
    None must ask the reader.
    """
    norm = normalise(name)
    if len(norm) < _CLOSE_MIN_LENGTH or norm in _FAMILY_WORDS:
        return None
    scored = sorted(
        (
            (max(difflib.SequenceMatcher(None, norm, s).ratio() for s in spellings), canonical)
            for canonical, spellings in candidates.items()
        ),
        reverse=True,
    )
    if not scored:
        return None
    top, canonical = scored[0]
    if top < _CLOSE_RATIO:
        return None
    if len(scored) > 1 and top - scored[1][0] < _CLOSE_MARGIN:
        return None
    return canonical, round(top, 3)


_CLOSE_CANDIDATES: dict[str, tuple[str, ...]] = {
    canonical: tuple({normalise(canonical), *(normalise(a) for a in aliases)})
    for canonical, aliases in MMM_ALIASES.items()
}


@dataclass(frozen=True)
class Proposal:
    """What this module suggests for ONE file, for a reader to confirm."""

    #: canonical column -> the file's own column standing for it.
    mapping: dict[str, str] = field(default_factory=dict)
    #: canonical column -> which pass found it: exact | alias | typo | channel | new.
    sources: dict[str, str] = field(default_factory=dict)
    #: Required columns nothing in the file matched. What the reader is asked about.
    unmapped: tuple[str, ...] = ()
    #: The file's columns nothing claimed. Harmless — MMM has always ignored
    #: extra columns — and listed so the mapping screen has something to offer.
    spare: tuple[str, ...] = ()

    @property
    def is_complete(self) -> bool:
        return not self.unmapped

    @property
    def renames(self) -> dict[str, str]:
        """actual -> canonical, for the columns that actually change name."""
        return {
            actual: canonical
            for canonical, actual in self.mapping.items()
            if normalise(actual) != normalise(canonical)
        }


def propose(header: list[str]) -> Proposal:
    """Suggest a canonical column for each of a file's columns.

    `unmapped` names only what MMM cannot work without: Date, Revenue, and at
    least one media-spend column. Everything else is optional — a file without
    the flags is perfectly usable — so an optional column is proposed but
    never reported as missing.
    """
    by_norm: dict[str, str] = {}
    for column in header:
        if column and str(column).strip():
            by_norm.setdefault(normalise(column), str(column).strip())

    mapping: dict[str, str] = {}
    sources: dict[str, str] = {}
    claimed: set[str] = set()

    def take(canonical: str, actual: str, source: str) -> None:
        mapping[canonical] = actual
        sources[canonical] = source
        claimed.add(actual)

    # PASS 1 — already MMM's own name, however spelled or cased. Includes the
    # schema's own aliases (Holiday_Flag) and every reference channel.
    for canonical in (c.name for c in schema.COLUMNS):
        norm = normalise(canonical)
        if norm in by_norm and by_norm[norm] not in claimed:
            take(canonical, by_norm[norm], "exact")
    for actual_norm, actual in by_norm.items():
        if actual in claimed:
            continue
        schema_alias = schema.ALIASES.get(actual_norm)
        if schema_alias and schema_alias not in mapping:
            take(schema_alias, actual, "exact")

    # PASS 2 — a synonym that can only mean one canonical column.
    for actual_norm, actual in by_norm.items():
        if actual in claimed:
            continue
        canonical = _ALIAS_INDEX.get(actual_norm)
        if canonical and canonical not in mapping:
            take(canonical, actual, "alias")

    # PASS 3 — a reference channel named without `_Spend`, or with another
    # spend word: `TV`, `TV Cost`, `Facebook Ads`.
    for actual_norm, actual in by_norm.items():
        if actual in claimed or schema.is_rollup(actual):
            continue
        channel = _channel_for(actual)
        if channel and channel not in mapping:
            take(channel, actual, "channel")

    # PASS 4 — misspellings of the non-channel columns, for fields nothing
    # else claimed. Channels are left out on purpose: `Magazine` and
    # `Newspaper` are close enough to each other under Print that a typo guess
    # would be a coin toss on which channel a spend belongs to.
    for actual_norm, actual in by_norm.items():
        if actual in claimed or actual_norm in _ALIAS_INDEX:
            continue
        found = _close(actual, _CLOSE_CANDIDATES)
        if found and found[0] not in mapping:
            take(found[0], actual, "typo")

    # PASS 5 — any remaining column whose name ends in a spend word becomes a
    # channel of its own. MMM already reads an unlisted `*_Spend` column as a
    # further channel, so this only gives it the name the contract expects.
    for actual_norm, actual in by_norm.items():
        if actual in claimed or schema.is_rollup(actual):
            continue
        base = spend_base(actual)
        if not base or base in _FAMILY_WORDS or actual_norm.endswith("spend"):
            continue
        canonical = "_".join(p.capitalize() for p in _words(actual, base)) + "_Spend"
        if canonical not in mapping:
            take(canonical, actual, "new")

    unmapped: list[str] = []
    for required in schema.REQUIRED:
        if required not in mapping:
            unmapped.append(required)
    # A media column is required as a GROUP, not by name, so it is named as
    # the choice it is rather than as one arbitrary channel.
    if not any(_is_spend(c) for c in mapping):
        unmapped.append("a media spend column")

    return Proposal(
        mapping=mapping,
        sources=sources,
        unmapped=tuple(unmapped),
        spare=tuple(
            str(c).strip() for c in header
            if c and str(c).strip() and str(c).strip() not in claimed
        ),
    )


def _is_spend(canonical: str) -> bool:
    return canonical.lower().endswith(schema.SPEND_SUFFIX) and not schema.is_rollup(canonical)


def _words(actual: str, base: str) -> list[str]:
    """The client's own words for a new channel, so `radio ad cost` keeps its
    spelling as `Radio_Ad_Spend` rather than becoming `Radioad_Spend`."""
    parts = [p for p in re.split(r"[^A-Za-z0-9]+", str(actual)) if p]
    out: list[str] = []
    for part in parts:
        if normalise(part) in SPEND_WORDS:
            continue
        out.append(part)
        if normalise("".join(out)) == base:
            break
    return out or [base]
