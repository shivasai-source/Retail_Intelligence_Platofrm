# Module 06 — Promotion Calendar

**Route:** `#/calendar` · **Page:** `frontend/src/pages/Calendar.tsx` (232 lines)
**Status:** Implemented against real data · **First-class module**

The Calendar is **not** a step in the Command Center → RCA → Simulation →
Decision chain. It is a standalone promotion-plan view with its own routes, its
own service and its own read model.

## 1. Business purpose

A **trade-promotion plan**, not a diary:

```
YEAR → 12 MONTHS → 5 CHANNELS → PROMOTION → PROMOTED PRODUCTS
```

The primary view is a **Channel × Month matrix for one year**, never a grid of
days. The year is the top-level control, so *"which plan am I looking at?"* is
answered before anything else on the page.

## 2. Architecture

`backend/app/tpo/promo_calendar.py` (449 lines) is a **presentation read
model, not a second analytics engine.** It reads the same `WeekRow` stream every
KPI reads, through the same `filters.rows_for`, and does **no arithmetic beyond
counting distinct products**. No ROI, Trade Spend, Incremental Sales or baseline
logic is touched or duplicated.

One pass per year, cached (`_aggregate`, `lru_cache(maxsize=4)`), indexed three
ways:

```
products      (channel, month, promotion)            → {product_id}
weeks         (channel, month, promotion)            → {week_key}
week_products (channel, month, week_key, promotion)  → {product_id}
```

## 3. The authoritative date mapping

**The month comes from the week, never from `fact_sales.Month`.**

```
fact row (Year, Week) → dim_date days for that week → min(days) → its Month
```

`WeekRow.month` is already derived that way by the loader, so this module
**re-derives nothing**. `fact_sales.Month` disagrees with the business week on
22.6% of rows, and `fact_sales.Date` is scrambled on CH002/CH004/CH005 — see
[03_DATA_ARCHITECTURE.md](../03_DATA_ARCHITECTURE.md) §8.

**Year filtering** uses `_year_of(week_key)` — the year the loader stamped on
the business week, parsed from the week key, not from a date column.

`available_years()` reads the years from the **fact** stream, not from dim_date:
dim_date also describes 2026 (151 days), which holds no transactions, and
offering it as a tab would put an empty twelve-month grid in front of the user.
**Verified: `[2024, 2025]`.**

## 4. The 5-channel model and cadence

`promo_calendar.CADENCE` — declared **once, here**, so the frontend never
carries its own copy. Not present in `dim_channel.csv` (which carries
`Channel_Type`: Retail/B2B) and deliberately **not inferred from the
transaction pattern**, which would make a business rule depend on a data
accident.

| Channel | Name | Cadence |
|---|---|---|
| CH001 | E-commerce | **WEEKLY** |
| CH002 | Modern Trade | MONTHLY |
| CH003 | General Trade | MONTHLY |
| CH004 | Travel & Hospitality | **WEEKLY** |
| CH005 | B2B | MONTHLY |

It agrees with `fact_sales.Schedule`, and `tests/test_month_semantics.py` asserts
that agreement so the declared structure and the recorded one cannot drift.
Callers import this table rather than restating it.

### Weekly vs monthly behaviour

| | WEEKLY (CH001, CH004) | MONTHLY (CH002, CH003, CH005) |
|---|---|---|
| Promotions per month | Several distinct events | One or two, running the whole month |
| `cell_detail.weeks[]` | **Populated** — week-by-week breakdown | **Empty** |
| Cell reading | A summary of several events | The month's plan |

A month on a weekly channel genuinely holds several separate promotion events,
and collapsing them would misreport the plan.

## 5. The matrix cell

`GET /api/promotion-calendar/matrix?year=&channel=`

```json
{ "month": 10, "kind": "festival",
  "label": "Dussehra Deal 25 + Diwali Special 25",
  "promotion_ids": ["PBDU25", "PBDI25"],
  "product_count": 18, "promotion_count": 2, "extra_regular": 0 }
```

| Field | Meaning |
|---|---|
| `kind` | `none` · `regular` · `seasonal` · `festival` |
| `label` | The seasonal event names joined by `" + "`, or `"Regular"`, or `"No Promo"` |
| `promotion_ids` | The **named** promotions — the seasonal ones when there are any |
| `product_count` | **Distinct** products promoted in the cell — a product carried by both a regular and a seasonal offer counts once |
| `promotion_count` | Promotions in the cell |
| `extra_regular` | Count of concurrent regular promotions when a seasonal one owns the headline |

**Headline rule:** the season wins when there is one — that is the event a
planner scans for. Regular activity alongside it is reported as `extra_regular`,
and the detail panel still lists every promotion in the cell.

Promotions are ordered by the **first week they ran** (`_first_week`), not
alphabetically.

`all_channels` is returned **independently of the `channel` filter**, so once
narrowed to CH001 the picker still offers a way back to the others.

## 6. Seasonal events and the festival kind

`kind: "festival"` exists purely so a cell carrying **two or more seasonal
events in one month** can be tinted differently. It is a **presentation bucket,
not a business category**, and nothing downstream branches on it.

### The 2025 October case — verified

October is the month that motivates the bucket: **Dussehra and Diwali both fall
in it**. Verified against the live data (2025):

| Channel | Cadence | Oct kind | Promotions in cell |
|---|---|---|---|
| CH001 E-commerce | WEEKLY | `festival` | 5 |
| CH002 Modern Trade | MONTHLY | `festival` | 2 |
| CH003 General Trade | MONTHLY | `festival` | 3 |
| CH004 Travel & Hospitality | WEEKLY | `festival` | 4 |
| CH005 B2B | MONTHLY | `festival` | 3 |

**CH002 · October 2025** (monthly cadence):

```
label          "Dussehra Deal 25 + Diwali Special 25"
promotion_ids  ["PBDU25", "PBDI25"]
product_count  18      promotion_count 2      extra_regular 0
weeks[]        empty (monthly channel)
PBDU25         10 products, weeks [41, 42, 43, 44]
PBDI25          8 products, weeks [41, 42, 43, 44]
```

Both events run across all four business weeks — the monthly booking pattern.

**CH001 · October 2025** (weekly cadence) — the same month, resolved to weeks:

| Week | Starts | Promotions |
|---|---|---|
| 2025-W41 | 2025-10-06 | PBDU25 (Dussehra Deal 25), PR002 (10% Discount) |
| 2025-W42 | 2025-10-13 | PR003 (15% Discount) |
| 2025-W43 | 2025-10-20 | PR001 (5% Discount) |
| 2025-W44 | 2025-10-27 | PBDI25 (Diwali Special 25), PR002 (10% Discount) |

Dussehra opens the month, Diwali closes it, and three regular mechanics run
between them. That is the weekly-event behaviour the cell summary compresses.

### The full seasonal calendar

Six festivals × two years, each appearing in every channel:

| Event | 2024 (20% Discount) | 2025 (Buy3Get1) |
|---|---|---|
| New Year | PBNY24 | PBNY25 |
| Holi | PBHO24 | PBHO25 |
| Summer | PBSU24 | PBSU25 |
| Independence | PBIN24 | PBIN25 |
| Dussehra | PBDU24 | PBDU25 |
| Diwali | PBDI24 | PBDI25 |

Verified 2025 pattern across every channel: seasonal months are **1, 3, 5, 8,
10**, with October carrying two events; every other month is `regular`.

## 7. Promotion metadata

Resolved through `dim_promotion_final.csv` only, via `Dimensions.promotions`:

| Field | Source | Example |
|---|---|---|
| `mechanic` | `Promotion_Name` | `"Buy3Get1"` |
| `type` | `Promotion_Type` | `"Seasonal"` |
| `description` | `Promotion_Description` | `"Diwali Special 25"` |

**No promotion name, description or id is written down in this module or in the
frontend.** An id with no dimension row keeps its id and is reported with
`metadata_missing: true` — the gap travels to the UI rather than being papered
over with an invented name.

## 8. Cell detail panel

`GET /api/promotion-calendar/cell?year=&month=&channel=`

Returns the cell summary, `promotions[]`, and — for WEEKLY channels only —
`weeks[]` with `week_key`, `week_number`, `week_start` (ISO) and that week's
promotions.

Each promotion carries `product_count` and `products[]`. **The count IS the
length of the list**, so the panel can never claim nine products and then list
eight.

`products[]` are ordered in the project's own hierarchy — **Brand Form, then SKU
rank smallest → largest** — never alphabetically, which would interleave the
pack sizes of different brand forms. Each carries `product_id`, `name`,
`brand_form`, `category`, `size`, `rank`.

Rendered by `components/calendar/PromotionDetailPanel.tsx` (237 lines).

## 9. Upcoming events

`GET /api/promotion-calendar/upcoming?year=&after_month=&channel=&limit=`

**Two real sources merged into one chronological feed. Nothing is synthesised.**

1. **Promotion starts** — from this module's own aggregate. In a trade-promotion
   calendar "what is coming next" is first of all the next promotions, and this
   is the only source with data for every year, month and channel.
   `source: "promotion"`, `type` = the real `Promotion_Type`.
2. **Business events** — from `app/data/calendar.json`. Six authored rows,
   types `review` / `launch` / `extension` / `data` / `closure`. They are kept
   so the existing event types still appear, but **that file holds June–July
   2025 only**, which is exactly why it cannot be the sole source of an
   "upcoming" panel.

Business-event channel tokens are resolved **against `dim_channel`**, not a
hand-written map: `"GT"` → "General Trade" → CH003, `"MT"` → CH002,
`"Ecom"` → CH001. Unknown tokens map to nothing rather than being guessed at.

An `"All"` event is **one event that applies to every channel**, not five copies
of itself; it narrows to a channel id only when the user has filtered to a
single channel.

Sorted by `(date, channel_id, name)`. **The feed never crosses years** — the
calendar is a one-year plan and mixing years would misreport it.

### Contextual behaviour

`after_month` is **the month the user is looking at**; `0` means the whole year
is still ahead. The page passes `selected?.month ?? 0`, so selecting a cell
re-scopes the feed to what comes after it, and the panel's context label reads
`"After October 2025 · CH002 · Modern Trade"` or `"2025 · All channels"`.

Verified: `upcoming(2025, after_month=9)` returns **33 events**, opening on
2025-10-06 with Dussehra across four channels and the regular mechanics beside
them.

## 10. Frontend implementation

```
Calendar.tsx
├── Channel dropdown          from matrix.all_channels; "All Channels" clears
├── Year radio group          from matrix.years — the real years only
├── Legend                    Regular · Seasonal · Multi-event Month · No Promotion
├── PromotionMatrix           12 × N grid, click a cell to select/deselect
├── Footnote                  weekly channels may run several promotions a month
└── Right column (336 px)
    ├── PromotionDetailPanel  shown only when a cell is selected
    └── UpcomingEventsPanel   contextual, expandable
```

- **Year and channel changes clear the selection** (`setSelected(null)`), so the
  detail panel can never describe a cell from a different plan.
- **Clicking the selected cell again deselects it.**
- Colours: `components/calendar/statusColors.ts` — one bucket per `kind`.

### Right-column layout and internal scrolling

The **matrix sets the row height**; the right column stretches to it and absorbs
overflow with internal scrolling, so the page never grows taller than the
calendar itself.

The mechanism is documented in the page: a grid item is sized by its own content
even with `min-h-0`, so the right column's long lists would otherwise stretch
the row — and the calendar with it. Taking the content out of flow with
`absolute` positioning makes the item contribute **nothing** to the row height,
then fill exactly what the calendar sets.

Below **1180 px** the two columns stack and each panel falls back to its own
height.

Weighting between the two right-hand panels:

| State | Details | Upcoming |
|---|---|---|
| Cell selected, Upcoming collapsed | `flex-[1.35]` | `flex-[1]` |
| Cell selected, Upcoming expanded | `flex-[1]` | `flex-[1.6]` |
| Nothing selected | hidden | `flex-[1.6]` (fills the column) |

## 11. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/promotion-calendar/matrix` | The 12 × N grid for one year |
| GET | `/api/promotion-calendar/cell` | One Channel × Month, with weeks for weekly channels |
| GET | `/api/promotion-calendar/upcoming` | Promotion starts + business events, chronological |

Mounted at `/api/promotion-calendar`, **not** `/api/calendar` — that path
already serves the business-event feed from `misc.py` and its contract is
unchanged.

**Validation:** an unknown channel code → **422** naming it. `month` is bounded
1–12; `after_month` 0–12; `limit` 1–200 (default 60).

> **Implementation note.** `ChannelParam` deliberately carries no `pattern=`:
> in Pydantic v2 a string pattern on a `list[str]` query parameter is applied to
> the **list**, not to its items, which fails validation for every non-empty
> value. The codes are checked explicitly in the route instead.

## 12. Data sources

| Source | Used for |
|---|---|
| `fact_sales_2024_2025_all_channels.csv` | Which promotions ran, where, in which weeks, on which products |
| `dim_date2425_corrected.csv` | The authoritative month and every week-start date |
| `dim_promotion_final.csv` | Mechanic, type, event name |
| `dim_product_reordered.csv` | Product name, Brand Form, category, size, rank |
| `dim_channel.csv` | Channel names, and business-event token resolution |
| `promo_calendar.CADENCE` | Weekly vs monthly behaviour |
| `backend/app/data/calendar.json` | 6 business events, **June–July 2025 only** |

## 13. Validation

| What | Where |
|---|---|
| The `(Year, Week) → dim_date` month | `tests/test_month_semantics.py` (14 tests) |
| `CADENCE` agrees with `fact_sales.Schedule` | `tests/test_month_semantics.py` |
| Promotion sits in its assigned business month | `scripts/validate_promotion_schedule.py` (read-only) |
| Matrix / cell / upcoming payloads | **No dedicated test module** |

## 14. Known limitations

| # | Limitation |
|---|---|
| 1 | **No dedicated test module** for the Calendar's own routes. Its date semantics are covered indirectly by `test_month_semantics.py` |
| 2 | The business-event source holds **6 events, June–July 2025 only**. Every other month's "upcoming" is promotion starts alone |
| 3 | The feed **never crosses years** — in December, "upcoming" is empty rather than showing January |
| 4 | The Calendar is **not connected to the global filter state**. Its only filters are year and channel; category, brand, product, region and offer do not reach it |
| 5 | **No export.** The Calendar is absent from `reports.service.MODULES` |
| 6 | The page **defaults to `year = 2025`** as a literal `useState(2025)`, before the matrix reports which years exist. It corrects itself once the payload arrives |
| 7 | `kind: "festival"` is a tint bucket only; two seasonal events in a month are otherwise handled exactly like one |

## 15. File map

| Concern | File |
|---|---|
| Page | `frontend/src/pages/Calendar.tsx` |
| Matrix + legend | `frontend/src/components/calendar/PromotionMatrix.tsx` |
| Detail panel | `frontend/src/components/calendar/PromotionDetailPanel.tsx` |
| Upcoming panel | `frontend/src/components/calendar/UpcomingEventsPanel.tsx` |
| Colours | `frontend/src/components/calendar/statusColors.ts` |
| Hook | `frontend/src/hooks/usePromotionCalendar.ts` |
| Types | `frontend/src/types/promotionCalendar.ts`, `calendar.ts` |
| Router | `backend/app/routers/promotion_calendar.py` |
| Read model | `backend/app/tpo/promo_calendar.py` |
| Business events | `backend/app/data/calendar.json` (via `routers/misc.py`) |
