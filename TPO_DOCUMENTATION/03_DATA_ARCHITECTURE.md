# 03 — Data Architecture

All figures below were counted from the files in `Data/` on 2026-08-24.

## 1. Storage model

There is **no analytical database**. Five CSV files are parsed once per
process by `backend/app/tpo/loader.py` into a columnar in-memory store
(`FactStore`), cached with `lru_cache(maxsize=1)` for the process lifetime.

- Measures are held as `array('d')` (float64) columns.
- Dimension references are held as `array('i')` integer **codes** into small
  lookup tables (55 stores / 36 products / 16 promotions actually referenced).
- `year`/`month`/`week`/`promoted` are `array('h'/'b')`.

A filter pass is therefore a tight loop over integers, not a walk over 205,920
Python dicts.

SQLite (`backend/.store/tiq.db`) exists **only for application writes** —
scenarios, decisions and report artifacts. No analytical figure is ever read
from it.

## 2. Star schema

```
                       dim_date2425_corrected.csv
                        (Date, Year, Month, Quarter, Week, Day)
                                     ▲
                                     │  joined on (Year, Week)
                                     │  ← THE AUTHORITATIVE MONTH
                                     │
 dim_product_reordered.csv           │            dim_promotion_final.csv
 (Product_id PK)                     │            (Promotion_Id PK)
        ▲                            │                    ▲
        │ Product_id                 │                    │ Promotion_Id
        │                            │                    │
   ┌────┴────────────────────────────┴────────────────────┴────┐
   │  fact_sales_2024_2025_all_channels.csv                    │
   │  PK: Transaction_Id                                       │
   │  205,920 rows · grain: one Store × Product × Promotion    │
   │                        × business-week/month booking      │
   └────┬───────────────────────────────────┬──────────────────┘
        │ Store_Id                          │ Channel_Id
        ▼                                   ▼
 dim_geo_store_final.csv            dim_channel.csv
 (Store_Id PK, Channel_Id FK)       (Channel_Id PK)
```

`Channel_Id` is carried on **both** the fact and `dim_geo_store`. The loader
reads the channel from the **store** dimension (`Store.channel_id`), so the
store dimension is authoritative for channel attribution.

## 3. `fact_sales_2024_2025_all_channels.csv`

**205,920 rows.** Columns, in file order:

| Column | Type | Notes |
|---|---|---|
| `Transaction_Id` | text | PK. Composite, e.g. `CH001-2024-W01-S211-P11-100ml`. **Not loaded** |
| `Date` | DD-MM-YYYY | **Only the YEAR is used.** See §7 |
| `Week` | int | Business week ordinal. **Intact in every row — the join key** |
| `Month` | text | **NOT USED.** 22.6% of rows disagree with their business week |
| `Product_id` | FK → dim_product | |
| `Store_Id` | FK → dim_geo_store | |
| `Channel_Id` | FK → dim_channel | Loader reads channel from the store instead |
| `Promotion_Id` | FK → dim_promotion | `-1` = not promoted (`loader.NO_PROMOTION`) |
| `Base_Quantity` | float | Ordinary demand level. **Equals `Actual_Quantity` on every row** |
| `Actual_Quantity` | float | |
| `Base_Price` | float | List price. Not loaded directly; recovered as `(Actual_Revenue + discount) / Base_Quantity` where needed |
| `Actual_Price` | float | Realised price for this row |
| `Base_Revenue` | float | |
| `Actual_Revenue` | float | |
| `Total_Cost` | float | COGS |
| `Promotion_Cost` | float | The promotion-cost ledger |
| `Schedule` | `WEEKLY`/`MONTHLY` | One value per channel; agrees with `promo_calendar.CADENCE` |

### The property everything rests on

> On every row, promoted or not, `Base_Quantity == Actual_Quantity`.

Verified across all 205,920 rows. Therefore `Actual_Quantity − Base_Quantity`
is identically zero and measures nothing. Uplift is instead measured against a
**non-promotional baseline** derived per `(product, channel)` inside the current
selection — see [08_KPI_AND_BUSINESS_LOGIC.md](08_KPI_AND_BUSINESS_LOGIC.md).

### Row distribution

| Channel | Rows | Schedule |
|---|---:|---|
| CH001 E-commerce | 37,440 | WEEKLY |
| CH002 Modern Trade | 37,440 | MONTHLY |
| CH003 General Trade | 37,440 | MONTHLY |
| CH004 Travel & Hospitality | 56,160 | WEEKLY |
| CH005 B2B | 37,440 | MONTHLY |

| Year | Rows |
|---|---:|
| 2024 | 102,960 |
| 2025 | 102,960 |

**Promotion_Id usage in the fact table:**

| Promotion_Id | Rows | |
|---|---:|---|
| `-1` | 146,070 | not promoted (70.9%) |
| `PR001` | 15,840 | 5% Discount, Regular |
| `PR002` | 14,760 | 10% Discount, Regular |
| `PR003` | 15,930 | 15% Discount, Regular |
| `PBNY24` / `PBNY25` | 1,305 / 1,305 | New Year Savings |
| `PBHO24` / `PBHO25` | 1,125 / 1,305 | Holi Special Deal |
| `PBSU24` / `PBSU25` | 1,125 / 1,125 | Summer Special |
| `PBIN24` / `PBIN25` | 1,125 / 1,125 | Independence Offer |
| `PBDU24` / `PBDU25` | 1,125 / 805 | Dussehra Deal |
| `PBDI24` / `PBDI25` | 1,125 / 725 | Diwali Special |

> **Important:** `PS001` and `PB001` **do not appear in the fact table.** They
> exist in `dim_promotion_final.csv` as the generic seasonal mechanics, and in
> `config.TREATMENT_RULES` as the approved 20% and 25% treatments. The dated
> seasonal ids (`PB**24`/`PB**25`) are what actually ran, and
> `scripts/audit_roi_realism.treatment_of` maps them onto the two treatments.

## 4. `dim_product_reordered.csv` — 36 rows

| Column | Notes |
|---|---|
| `Product_id` | PK, e.g. `P11-250ml` |
| `Product_Name` | Several cells carry **stray leading spaces**; `loader._clean` trims them |
| `Brand` | The **Brand Form** — 4 pack sizes share one. Also carries stray spaces |
| `Category` | 3 values |
| `Size` | e.g. `250 mL`, `64 ct`, `17 oz` |
| `Cost` | Unit cost |

**Derived at load time, not stored in the file:** `Product.rank` — the SKU's
1-4 position inside its Brand Form, ordered by the leading number in `Size`.
This is what makes cannibalization possible: neighbours are ranks ±1.

| Category | Brand Forms |
|---|---|
| Fabric & Home Care | Laundry Detergent, Fabric Conditioner, Fabric Softener Dryer Sheets |
| Baby Care | Taped Diapers, Baby Wipes, L_Diapers |
| Health Care | Toothpaste, Toothbrushes, Cough & Cold |

9 Brand Forms × 4 pack sizes = 36 SKUs.

**Rank 1 (the smallest pack) is never promoted** in this data — 0 promoted rows
at rank 1, against 24,210 / 24,660 / 11,430 at ranks 2 / 3 / 4. It appears as a
cannibalization *victim* and never as a *promoter*.

## 5. `dim_geo_store_final.csv` — 509 rows

| Column | Values |
|---|---|
| `Store_Id` | PK, `S001`… |
| `Channel_Id` | FK → dim_channel |
| `Retailer` | **Blank on every CH005 (B2B) store** |
| `Distributor_Name` | `Distributor_01`…`Distributor_05`; blank outside General Trade |
| `Region` | Central, East, North, South, West |
| `Country` | India (single value — **not exposed as a filter**) |
| `State` | Chandigarh, Delhi, Gujarat, Karnataka, Madhya Pradesh, Maharashtra, Punjab, Rajasthan, Tamil Nadu, Telangana, West Bengal |
| `City` | |
| `Tier` | Tier 1, Tier 2, Tier 3 |

| Channel | Stores |
|---|---:|
| CH001 E-commerce | 10 |
| CH002 Modern Trade | 210 |
| CH003 General Trade | 210 |
| CH004 Travel & Hospitality | 15 |
| CH005 B2B | 64 |

Because B2B carries no Retailer, `filters.options_for` returns
`retailer_available: false` for a B2B-only scope and the UI **hides** the
Retailer control rather than showing an empty dropdown.

## 6. `dim_channel.csv` — 5 rows (the finalized channel model)

| Channel_Id | Channel_Name | Channel_Type | Promotion cadence |
|---|---|---|---|
| CH001 | E-commerce | Retail | **WEEKLY** |
| CH002 | Modern Trade | Retail | MONTHLY |
| CH003 | General Trade | Retail | MONTHLY |
| CH004 | Travel & Hospitality | Retail | **WEEKLY** |
| CH005 | B2B | B2B | MONTHLY |

**Cadence is not in this file.** `Channel_Type` is Retail/B2B. The planning
cadence is declared once in `backend/app/tpo/promo_calendar.CADENCE` — as the
project's stated channel structure, deliberately *not* inferred from the
transaction pattern. Callers import it rather than restating it,
and `tests/test_month_semantics.py` asserts it agrees with `fact_sales.Schedule`.

## 7. `dim_promotion_final.csv` — 18 rows

The file carries a **UTF-8 BOM**; `loader._read_csv` opens it `utf-8-sig`.

| Promotion_Id | Promotion_Name (MECHANIC) | Type | Promotion_Description (EVENT) |
|---|---|---|---|
| `-1` | No Discount | Normal | No Discount |
| PR001 | 5% Discount | Regular | 5% Discount |
| PR002 | 10% Discount | Regular | 10% Discount |
| PR003 | 15% Discount | Regular | 15% Discount |
| PS001 | 20% Discount | Seasonal | 20% Discount |
| PB001 | Buy3Get1 | Seasonal | Buy3Get1 |
| PBNY24 | 20% Discount | Seasonal | New Year Savings 24 |
| PBNY25 | Buy3Get1 | Seasonal | New Year Savings 25 |
| PBHO24 | 20% Discount | Seasonal | Holi Special Deal 24 |
| PBHO25 | Buy3Get1 | Seasonal | Holi Special Deal 25 |
| PBSU24 | 20% Discount | Seasonal | Summer Special 24 |
| PBSU25 | Buy3Get1 | Seasonal | Summer Special 25 |
| PBIN24 | 20% Discount | Seasonal | Independence Offer 24 |
| PBIN25 | Buy3Get1 | Seasonal | Independence Offer 25 |
| PBDU24 | 20% Discount | Seasonal | Dussehra Deal 24 |
| PBDU25 | Buy3Get1 | Seasonal | Dussehra Deal 25 |
| PBDI24 | 20% Discount | Seasonal | Diwali Special 24 |
| PBDI25 | Buy3Get1 | Seasonal | Diwali Special 25 |

**Name vs description matters, and the code depends on it:**

- `Promotion_Name` is the **MECHANIC** and is **not unique** — seven rows are
  called "20% Discount" and seven "Buy3Get1".
- `Promotion_Description` is the **EVENT** and **is unique** across all 18 rows.

`loader.Promotion.label` therefore returns the *description*, and both the
filter options and the promotion-mix legend read that property. Rendering the
name instead produced six identical "Buy3Get1" entries in the Offer dropdown.
The Command Center exposes the mechanic separately as the
`promotion_mechanic` breakdown dimension, which carries the member
`Promotion_Id`s so a mechanic made of six offers can be selected as one thing.

**The 2024/2025 seasonal split is a mechanic change**: every 2024 seasonal
event is a 20% price discount (PS001 economics); every 2025 seasonal event is
Buy3Get1 (PB001 economics, carried as a 25% effective price discount — see
`scripts/represent_pb001_as_price_discount.py`).

## 8. `dim_date2425_corrected.csv` — 882 rows — the authoritative calendar

| Column | Notes |
|---|---|
| `Date` | DD-MM-YYYY, PK |
| `Year` | 2024, 2025, **2026** |
| `Month` | Month name. **Strictly calendar — 0 mismatches** |
| `Quarter` | `Q1`…`Q4`, **calendar** quarters (Q1 = Jan–Mar), not fiscal |
| `Week` | Business week ordinal within the year |
| `Day` | Weekday name |

| Year | Days present |
|---|---:|
| 2024 | 366 |
| 2025 | 365 |
| 2026 | 151 |

2026 carries **no transactions**. `promo_calendar.available_years()`
deliberately reads the years from the *fact* stream rather than dim_date, so
the Calendar never offers an empty 2026 tab.

### Why the month comes from the week

`loader.Dimensions.week_start` documents the defect and the fix:

- The CH002 and CH004 generators set `Date = Week_Start` but never re-derived
  `Month` from it (CH004 literally writes `fact_sales["Month"] = fact_sales["Month"]`).
- CH002 / CH004 / CH005 also carry a **scrambled `Date`** — 51.9% of their rows
  disagree with the `Week_Start` that dim_date gives for their own `(Year, Week)`.
- Together those put **46,440 of 205,920 rows (22.6%) in the wrong month**.

`Week` is intact in every row and dim_date is clean, so:

```
analytical month = dim_date.Month of  min(days of (fact.Year, fact.Week))
```

This reproduces the two known-good channels exactly and gives all five the same
monthly shape. The loader **raises** if any `(Year, Week)` pair in the fact
table has no match in dim_date — an unresolved pair must fail loudly rather
than silently misfile a row.

Pinned by `tests/test_month_semantics.py` (14 tests).

## 9. The KPI grain — `WeekRow`

Filtered fact rows are collapsed by `filters._to_week_rows` into the grain the
KPI engine reads:

```
(product_id, channel_id, week_key, promotion_id)
```

- **Stores are POOLED** inside that group — one product's week in one channel is
  one observation however many outlets carried it.
- **Offers are NOT pooled** — a week running both a 5% and a 10% promotion is
  two promotion events, and merging them would report a promotion that never ran.

`WeekRow` fields: `product_id`, `channel_id`, `brand_form`, `product_rank`,
`week_key` (`"YYYY-Www"`), `month`, `is_promoted`, `promotion_id`,
`base_quantity`, `actual_quantity`, `actual_revenue`, `total_cost`,
`promotion_cost`, `discount_value` (`Base_Revenue − Actual_Revenue`),
`actual_price_sum` (Σ of per-transaction `Actual_Price`), `transaction_count`.

`actual_price_sum` and `transaction_count` are what make the row-level
incremental-sales formula exact at the aggregate grain, via the identity
`Actual_Revenue == Actual_Quantity × Actual_Price`:

```
Σ((Aq − b)·Ap) = Σ(Actual_Revenue) − b·Σ(Actual_Price)
```

## 10. Persistent application storage — `backend/.store/tiq.db`

SQLite, WAL mode, created and migrated on first use by `app/store/db.py`.

| Table | Written by | Mutability |
|---|---|---|
| `schema_meta` | `db.py` | version marker |
| `investigations` | `repository.py` | insert-only; found again by `natural_key` |
| `scenarios` | `repository.py` | `name` and `current_version` update |
| `scenario_results` | `repository.py` | **APPEND-ONLY** — PK `(scenario_id, version)` |
| `decisions` | `repository.py` | `current_version` updates |
| `decision_versions` | `repository.py` | **APPEND-ONLY** — PK `(decision_id, version)` |
| `reports` | `store/reports.py` | **deletable** — a report is a derived artifact |

`reports` columns: `id`, `name`, `module`, `module_label`, `title`,
`scope_label`, `scope_json`, `options_json`, `filters_json`, `currency`,
`status` (`generating` / `ready` / `failed`), `error`, `preview_json`,
`xlsx_name`, `xlsx_blob`, `pdf_name`, `pdf_blob`, `owner`, `created_at`.
Indexed on `created_at DESC` and `module`.

**Every row in every table carries `owner = NULL`**, with
`db.NO_OWNER_NOTE` returned beside it. There is no authentication in this
project, so there is no actor to attribute a row to and none has been invented.

Report artifacts are stored as **BLOBs in the row**, not as loose files: a
delete is then atomic and cannot orphan a file, and no filesystem path is ever
exposed to the browser.

## 11. Static content data — `backend/app/data/*.json`

Served by `app/data_loader.py`, `lru_cache`d at first read. These are **authored
display content**, not computed.

| File | Size | Served at | Status |
|---|---:|---|---|
| `nav.json` | 1.2 KB | `/api/nav` | Sidebar structure |
| `user.json` | 86 B | `/api/user` | **Static persona** ("Sanjay Kumar") |
| `focus.json` | 174 B | `/api/focus` | **Static context chips — figures contradict the engine** |
| `investigation-types.json` | 2.6 KB | `/api/investigation-types` | 4 archetypes + example questions |
| `investigations.json` | 37 KB | `/api/investigations/{type}`, `/legacy` | **Static causal graph** |
| `intelligence.json` | 15 KB | `/api/intelligence-default` | **Static** |
| `intelligence-answers.json` | 3.9 KB | `/api/intelligence-answers/{type}` | **Static AI narrative** |
| `pages-by-type.json` | 45 KB | `/api/{intelligence,simulation,decision}/{type}` | **Static** |
| `simulation.json` | 5.6 KB | `/api/simulation-default` | **Static, legacy** |
| `decision.json` | 4.8 KB | `/api/decision-default` | **Static, legacy** |
| `command.json` | 4.7 KB | `/api/command` | **Static, legacy** — the real Command Center does not read it |
| `calendar.json` | 853 B | `/api/calendar`, and merged into `/promotion-calendar/upcoming` | 6 business events, **June–July 2025 only** |
| `connections.json` | 1.4 KB | `/api/connections` | 8 connector rows, **status is authored** |
| `settings.json` | 333 B | `/api/settings` | Preferences + integration names |
| `ai-watch.json` | 1.4 KB | `/api/ai-watch` | **Static**; no frontend consumer found |
| `recommendations.json` | 990 B | `/api/recommendations` | **Static**; no frontend consumer found |
| `reports.json` | 990 B | **nothing** | **DEAD FILE.** Its endpoint was removed — see below |

### `reports.json` is dead on purpose

`backend/app/routers/misc.py` carries a comment where `GET /api/reports` used to
be. It served six authored rows ("Sanjay Kumar", "4.2 MB", "Just now") with no
artifact behind any of them. It was removed rather than left dead beside the
real Report Center because `misc` is registered before `reports`, so a
fake-data endpoint on that path would have **shadowed** the real listing. The
file is left on disk; nothing reads it.

## 12. Data-quality caveats carried in code

| Issue | Where handled |
|---|---|
| `fact_sales.Month` wrong on 22.6% of rows | `loader.Dimensions.week_start` — month recovered from `(Year, Week)` |
| `fact_sales.Date` scrambled on CH002/CH004/CH005 | Only the year is read; day-grain analysis is refused (`rescue.py`) |
| Stray leading spaces in dim_product / dim_promotion | `loader._clean` |
| BOM in `dim_promotion_final.csv` | `utf-8-sig` |
| `Promotion_Name` not unique | `Promotion.label` uses `Promotion_Description` |
| Blank Retailer on B2B stores | `options_for` → `retailer_available: false` |
| Fact row referencing an absent dimension id | Warned to stdout, row kept under a blank label — never silently dropped from Trade Spend |
| `(Year, Week)` with no dim_date match | **Raises** at load |
