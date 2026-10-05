"""THE MMM COLUMN CONTRACT — one daily table, matched on its column headers.

Taken from the reference dataset the module was specified against
(MMM_Final_Daily_Dataset.csv: one row per day, 33 columns). Mirrored for the
upload guide in frontend/src/mmm/schema.ts; the two must list the same columns.

WHAT IS REQUIRED. Only what MMM cannot work without:
    Date, Revenue, and at least one media-spend column (`*_Spend`).
Everything else is OPTIONAL and matched by name when present:
    - the 22 reference spend channels (any extra `*_Spend` column is accepted
      as a further channel, so a client with a channel we have not listed is
      not turned away);
    - the promotion and event fields;
    - the calendar fields, which are DERIVED from Date when missing, since
      they carry nothing Date does not.

Column names are matched case-insensitively, as TPO's star schema matches them:
Excel round-trips rarely preserve casing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Group = Literal["core", "media", "promo", "calendar"]
ColumnType = Literal["date", "currency", "flag", "percent", "text", "integer"]


@dataclass(frozen=True)
class ColumnSpec:
    name: str
    group: Group
    type: ColumnType
    required: bool
    description: str
    example: str


GROUP_LABELS: dict[Group, str] = {
    "core": "Date & revenue",
    "media": "Media spend",
    "promo": "Promotions & events",
    "calendar": "Calendar fields",
}

#: Media channels in the reference file, in its column order, with the family
#: the Insights Hub rolls them up into. The family is presentation only — it
#: is never asserted as a modelled grouping.
MEDIA_CHANNELS: tuple[tuple[str, str], ...] = (
    ("TV_Spend", "Broadcast & Video"),
    ("OTT_Spend", "Broadcast & Video"),
    ("Streaming_Audio_Spend", "Broadcast & Video"),
    ("Cinema_Advertising_Spend", "Broadcast & Video"),
    ("Meta_Ads_Spend", "Social & Video Platforms"),
    ("YouTube_Ads_Spend", "Social & Video Platforms"),
    ("Google_Ads_Spend", "Search & Programmatic"),
    ("TikTok_Ads_Spend", "Social & Video Platforms"),
    ("Billboard_Spend", "Out of Home"),
    ("Transit_Advertising_Spend", "Out of Home"),
    ("Airport_Advertising_Spend", "Out of Home"),
    ("Newspaper_Spend", "Print"),
    ("Magazine_Spend", "Print"),
    ("Google_Search_Spend", "Search & Programmatic"),
    ("Programmatic_Display_Spend", "Search & Programmatic"),
    ("Native_Advertising_Spend", "Search & Programmatic"),
    ("Ecommerce_Ads_Spend", "Commerce & Retail Media"),
    ("Quick_Commerce_Ads_Spend", "Commerce & Retail Media"),
    ("In_Store_Digital_Ads_Spend", "Commerce & Retail Media"),
    ("Influencer_Marketing_Spend", "Influencer & Content"),
    ("Creator_Content_Spend", "Influencer & Content"),
    ("Sponsored_Content_Spend", "Influencer & Content"),
)

#: A `*_Spend` column we did not list still counts as a channel.
SPEND_SUFFIX = "_spend"
OTHER_FAMILY = "Other Media"

_SPEND_EXAMPLES = {
    "TV_Spend": "2981128", "OTT_Spend": "691790", "Meta_Ads_Spend": "1494598",
    "Google_Ads_Spend": "0", "YouTube_Ads_Spend": "406139",
}


def channel_label(column: str) -> str:
    """"In_Store_Digital_Ads_Spend" -> "In-Store Digital Ads"."""
    base = column[: -len("_Spend")] if column.lower().endswith(SPEND_SUFFIX) else column
    label = base.replace("_", " ").strip()
    return label.replace("In Store", "In-Store").replace("Ecommerce", "E-commerce")


COLUMNS: tuple[ColumnSpec, ...] = (
    ColumnSpec("Date", "core", "date", True,
               "The day the row describes. One row per day, no repeats. DD-MM-YYYY "
               "(YYYY-MM-DD and DD/MM/YYYY are also read).", "02-01-2015"),
    ColumnSpec("Revenue", "core", "currency", True,
               "Total sales revenue for the day, in rupees, as a plain number.", "17364174"),
    *(
        ColumnSpec(col, "media", "currency", False,
                   f"{channel_label(col)} spend for the day, in rupees. 0 on days "
                   "the channel did not run. At least one spend column is required.",
                   _SPEND_EXAMPLES.get(col, "0"))
        for col, _family in MEDIA_CHANNELS
    ),
    ColumnSpec("Holiday_Flag", "promo", "flag", False,
               "1 if the day is a holiday, otherwise 0.", "1"),
    ColumnSpec("Trending_Flag", "promo", "flag", False,
               "1 if the brand or category was trending that day, otherwise 0.", "0"),
    ColumnSpec("Promotion_Flag", "promo", "flag", False,
               "1 if a consumer promotion was live that day, otherwise 0.", "1"),
    ColumnSpec("Discount_Percentage", "promo", "percent", False,
               "Headline discount on the day, as a number (10 means 10%). 0 when no offer.", "10"),
    ColumnSpec("Promotion_Type", "promo", "text", False,
               "The offer that ran, e.g. 10% Discount or Buy3Get1. \"No Offer\" when none.",
               "10% Discount"),
    ColumnSpec("Month", "calendar", "integer", False,
               "Month number 1-12. Derived from Date when missing.", "1"),
    ColumnSpec("Quarter", "calendar", "text", False,
               "Q1-Q4. Derived from Date when missing.", "Q1"),
    ColumnSpec("Week_of_Year", "calendar", "integer", False,
               "Week number of the year. Derived from Date when missing.", "1"),
    ColumnSpec("Year", "calendar", "integer", False,
               "Calendar year. Derived from Date when missing.", "2015"),
)

BY_NAME: dict[str, ColumnSpec] = {c.name.lower(): c for c in COLUMNS}
REQUIRED: tuple[str, ...] = tuple(c.name for c in COLUMNS if c.required)
FAMILY: dict[str, str] = dict(MEDIA_CHANNELS)
FLAGS: tuple[str, ...] = ("Holiday_Flag", "Trending_Flag", "Promotion_Flag")
CALENDAR: tuple[str, ...] = ("Month", "Quarter", "Week_of_Year", "Year")


@dataclass(frozen=True)
class HeaderMatch:
    """What one uploaded header row means to MMM."""

    #: Upload column name -> canonical name, for every column MMM reads.
    rename: dict[str, str]
    #: Canonical names of the spend columns, reference channels first.
    media: tuple[str, ...]
    missing_required: tuple[str, ...]
    #: Optional reference columns that were not found.
    missing_optional: tuple[str, ...]
    #: Columns MMM does not read. Kept out of the installed file.
    ignored: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return not self.missing_required and bool(self.media)

    def problems(self) -> list[str]:
        out = [f"Missing required column: {c}" for c in self.missing_required]
        if not self.media:
            out.append("No media-spend column found — at least one column ending in _Spend "
                       "(e.g. TV_Spend) is required.")
        return out


def match_header(header: list[str]) -> HeaderMatch:
    rename: dict[str, str] = {}
    media: list[str] = []
    extra_media: list[str] = []
    ignored: list[str] = []
    for raw in header:
        name = str(raw).strip()
        if not name:
            continue
        spec = BY_NAME.get(name.lower())
        if spec is not None:
            if spec.name in rename.values():
                ignored.append(name)  # a duplicate header: first one wins
                continue
            rename[name] = spec.name
            if spec.group == "media":
                media.append(spec.name)
        elif name.lower().endswith(SPEND_SUFFIX) and len(name) > len(SPEND_SUFFIX):
            rename[name] = name
            extra_media.append(name)
        else:
            ignored.append(name)

    found = set(rename.values())
    order = [c for c, _ in MEDIA_CHANNELS]
    media.sort(key=order.index)
    return HeaderMatch(
        rename=rename,
        media=tuple(media + extra_media),
        missing_required=tuple(c for c in REQUIRED if c not in found),
        missing_optional=tuple(c.name for c in COLUMNS if not c.required and c.name not in found),
        ignored=tuple(ignored),
    )


def family_of(column: str) -> str:
    return FAMILY.get(column, OTHER_FAMILY)
