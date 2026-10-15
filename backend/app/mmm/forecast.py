"""THE MMM REVENUE FORECAST: revenue for a future ad plan.

The reader uploads a daily plan for dates after the installed data -- the
data's columns without Revenue: every channel's spend (zero on dark days),
the festival / seasonal / promotion flags, discount and promotion type. Each
day's revenue is predicted with the Budget Optimizer's fitted response
(budget_model), on the central fit and every bootstrap draw:

    revenue_t = baseline_t + media_t

    baseline_t  the fitted baseline on the day's calendar and flags; the trend
                goes straight on from the data's last day at its latest rate
    media_t     every channel's carryover and diminishing returns, run over
                the history AND the plan, so the plan's first days still carry
                the last ads in the data

    Net profit = revenue - ad spend, Profit % = net profit / ad spend,
    ROAS = media-driven revenue / ad spend -- the optimizer's definitions.

THE EXTENDED MODEL. The history with the plan's days appended (spend, and the
baseline's columns standardised as the history's were) is an ordinary
budget_model.Model, so the Budget Optimizer and the Budget Allocator plan
the forecast weeks with the same code they plan the past with
(`source="forecast"`).

One plan is kept at a time, in the MMM data folder's `forecast/` beside the
dataset. Sample plans of 1 to 5 years are in Data/mmm/future/
(scripts/make_mmm_future.py).
"""

from __future__ import annotations

import io
import json
import shutil
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.mmm import budget as B
from app.mmm import budget_model, config, loader
from app.tpo import formatting as F

#: The sample plans, by years.
SAMPLES = Path(__file__).resolve().parents[3] / "Data" / "mmm" / "future"
#: The longest plan accepted.
MAX_DAYS = 6 * 366
FLAGS = ("Festival_Flag", "Seasonal_Flag", "Promotion_Flag", "Discount_Percentage")
NO_OFFER = "No Offer"

_extended: dict[tuple, tuple[budget_model.Model, pd.DataFrame]] = {}


class ForecastError(ValueError):
    """The uploaded plan cannot be used; the message says why."""


class NoForecast(RuntimeError):
    """No plan is uploaded."""


def _folder() -> Path:
    return config.data_dir() / "forecast"


def _plan_path() -> Path:
    return _folder() / "plan.csv"


def _meta_path() -> Path:
    return _folder() / "plan.json"


def sample_path(years: int) -> Path:
    path = SAMPLES / f"mmm_future_{years}y.csv"
    if not path.is_file():
        raise FileNotFoundError(f"No {years}-year sample plan.")
    return path


# --------------------------------------------------------------- reading a plan


def _dates(col: pd.Series) -> pd.Series:
    text = col.astype(str).str.strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        parsed = pd.to_datetime(text, format=fmt, errors="coerce")
        if parsed.notna().all():
            return parsed
    raise ForecastError("The Date column could not be read. Use DD-MM-YYYY (as the data does) or YYYY-MM-DD.")


def read_plan(content: bytes, model: budget_model.Model, history: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """The plan as one row per day from its first to its last date, with
    every channel's spend and the baseline's columns, plus what was assumed
    or ignored on the way."""
    try:
        frame = pd.read_csv(io.BytesIO(content), encoding="utf-8-sig")
    except Exception as exc:
        raise ForecastError(f"The file could not be read as CSV: {exc}") from exc
    frame.columns = [str(c).strip() for c in frame.columns]
    if "Date" not in frame.columns:
        raise ForecastError("The file has no Date column.")
    if frame.empty:
        raise ForecastError("The file has no rows.")
    notes: list[str] = []
    frame["Date"] = _dates(frame["Date"])
    if frame["Date"].duplicated().any():
        first = frame.loc[frame["Date"].duplicated(), "Date"].iloc[0]
        raise ForecastError(f"{first:%d %b %Y} appears more than once; give one row per day.")
    frame = frame.sort_values("Date").reset_index(drop=True)
    last = model.dates.max()
    if frame["Date"].min() <= last:
        raise ForecastError(f"The plan must start after {last:%d %b %Y}, the last day of the installed data "
                            f"(it starts {frame['Date'].min():%d %b %Y}).")
    span = (frame["Date"].max() - last).days
    if span > MAX_DAYS:
        raise ForecastError(f"The plan runs {span:,} days past the data; at most {MAX_DAYS:,} (about six years) can be forecast.")
    if "Revenue" in frame.columns:
        frame = frame.drop(columns="Revenue")
        notes.append("The Revenue column was ignored: revenue is what this page predicts.")

    channels = model.channels
    missing = [c for c in channels if c not in frame.columns]
    extra = [c for c in loader.media_columns(frame) if c not in channels]
    if len(missing) == len(channels):
        raise ForecastError("No channel spend columns found. Use the data's names, such as TV_Spend and Meta_Ads_Spend.")
    if missing:
        notes.append(f"No spend given for {len(missing)} channel(s), taken as zero: "
                     + ", ".join(B.channel_label(c) for c in missing) + ".")
    if extra:
        notes.append(f"Not in the model, ignored: {', '.join(extra)}.")
    for c in channels:
        if c in frame.columns:
            values = pd.to_numeric(frame[c], errors="coerce")
            if values.isna().sum() > frame[c].isna().sum():
                raise ForecastError(f"{c} holds values that are not numbers.")
            if (values < 0).any():
                raise ForecastError(f"{c} has negative spend.")
            blanks = int(values.isna().sum())
            if blanks:
                notes.append(f"{c}: {blanks} blank day(s) taken as zero spend.")
            frame[c] = values.fillna(0.0)
        else:
            frame[c] = 0.0

    known = set(history["Promotion_Type"].astype(str)) if "Promotion_Type" in history else set()
    absent = [f for f in (*FLAGS, "Promotion_Type") if f in history and f not in frame.columns]
    if absent:
        notes.append(f"Not in the file, taken as none: {', '.join(absent)}.")
    for f in FLAGS:
        if f in history:
            frame[f] = pd.to_numeric(frame[f], errors="coerce").fillna(0.0) if f in frame.columns else 0.0
    if "Promotion_Type" in history:
        types = frame["Promotion_Type"].astype(str).str.strip() if "Promotion_Type" in frame.columns else pd.Series(NO_OFFER, index=frame.index)
        unknown = sorted(set(types) - known)
        if unknown:
            notes.append(f"Promotion types the data never had, read as {NO_OFFER}: {', '.join(unknown)}.")
            types = types.where(types.isin(known), NO_OFFER)
        frame["Promotion_Type"] = types

    # Every day from the data's end to the plan's: a missing day is a day
    # without ads or offers.
    days = pd.date_range(last + pd.Timedelta(days=1), frame["Date"].max(), freq="D")
    holes = len(pd.date_range(frame["Date"].min(), frame["Date"].max(), freq="D")) - len(frame)
    if holes:
        notes.append(f"{holes} day(s) missing inside the plan, taken as days without ads or offers.")
    keep = ["Date", *channels, *[f for f in FLAGS if f in history], *(["Promotion_Type"] if "Promotion_Type" in history else [])]
    full = frame[keep].set_index("Date").reindex(days)
    full["in_plan"] = full.index >= frame["Date"].min()
    full[channels] = full[channels].fillna(0.0)
    for f in FLAGS:
        if f in full:
            full[f] = full[f].fillna(0.0)
    if "Promotion_Type" in full:
        full["Promotion_Type"] = full["Promotion_Type"].fillna(NO_OFFER)
    return full.rename_axis("Date").reset_index(), notes


# --------------------------------------------------------------- the stored plan


def install(name: str, content: bytes) -> dict[str, Any]:
    model = B._model()
    history = loader.get_frame()
    plan, notes = read_plan(content, model, history)
    folder = _folder()
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "plan.csv.tmp"
    tmp.write_bytes(content)
    shutil.move(str(tmp), str(_plan_path()))
    _meta_path().write_text(json.dumps({
        "name": Path(name).name, "uploaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "notes": notes,
    }), encoding="utf-8")
    _extended.clear()
    return status()


def reset() -> dict[str, Any]:
    shutil.rmtree(_folder(), ignore_errors=True)
    _extended.clear()
    return status()


def _meta() -> dict[str, Any] | None:
    if not _plan_path().is_file() or not _meta_path().is_file():
        return None
    try:
        return json.loads(_meta_path().read_text(encoding="utf-8"))
    except Exception:
        return None


def status() -> dict[str, Any]:
    meta = _meta()
    return {"loaded": meta is not None, **({"name": meta["name"], "uploaded_at": meta["uploaded_at"]} if meta else {})}


def _token() -> tuple:
    st = _plan_path().stat()
    return (st.st_mtime_ns, st.st_size)


def extended_model() -> tuple[budget_model.Model, int, pd.DataFrame]:
    """The fitted model over the history plus the plan's days, the index of
    the first day after the history, and the plan as read."""
    if _meta() is None:
        raise NoForecast("No future plan is uploaded. Upload one on Revenue Forecast.")
    model = B._model()
    key = (id(model), _token())
    if key not in _extended:
        _extended.clear()
        history = loader.get_frame().sort_values("Date").reset_index(drop=True)
        plan, _ = read_plan(_plan_path().read_bytes(), model, history)
        X = budget_model.baseline_features(plan, history)
        ext = replace(
            model,
            dates=model.dates.append(pd.DatetimeIndex(plan["Date"])),
            spend=np.vstack([model.spend, plan[model.channels].to_numpy(float)]),
            revenue=np.concatenate([model.revenue, np.full(len(plan), np.nan)]),
            baseline_X=np.vstack([model.baseline_X, X]),
            checks={**model.checks, "source": ["forecast", *key[1]]},
        )
        _extended[key] = (ext, plan)
    ext, plan = _extended[key]
    return ext, len(model.dates), plan


# --------------------------------------------------------------- the forecast


def _band(values: np.ndarray, axis: int = 0) -> tuple[np.ndarray, np.ndarray]:
    lo, hi = np.percentile(values, [10, 90], axis=axis)
    return lo, hi


def _series(dates: pd.DatetimeIndex, groups: np.ndarray, labels: list[str], starts: list[str],
            base: np.ndarray, media: np.ndarray, spend: np.ndarray) -> list[dict[str, Any]]:
    """One point per group: base / media are fits x days (row 0 central)."""
    n = len(labels)
    agg = lambda a: np.stack([np.bincount(groups, weights=row, minlength=n) for row in a])  # noqa: E731
    b, m = agg(base), agg(media)
    s = np.bincount(groups, weights=spend, minlength=n)
    days = np.bincount(groups, minlength=n)
    rev = b + m
    r_lo, r_hi = _band(rev[1:])
    p_lo, p_hi = _band(rev[1:] - s)
    m_lo, m_hi = _band(m[1:])
    out = []
    for i in range(n):
        out.append({
            "label": labels[i], "start": starts[i], "days": int(days[i]),
            "spend": round(float(s[i]), 2),
            "baseline": round(float(b[0, i]), 2), "media": round(float(m[0, i]), 2),
            "media_range": [round(float(m_lo[i]), 2), round(float(m_hi[i]), 2)],
            "revenue": round(float(rev[0, i]), 2), "revenue_range": [round(float(r_lo[i]), 2), round(float(r_hi[i]), 2)],
            "profit": round(float(rev[0, i] - s[i]), 2), "profit_range": [round(float(p_lo[i]), 2), round(float(p_hi[i]), 2)],
            "roas": round(float(m[0, i] / s[i]), 4) if s[i] > 0 else None,
        })
    return out


def _grouping(dates: pd.DatetimeIndex, by: str) -> tuple[np.ndarray, list[str], list[str]]:
    if by == "day":
        return np.arange(len(dates)), [d.strftime("%d %b %Y") for d in dates], [d.strftime("%Y-%m-%d") for d in dates]
    if by == "week":
        iso = dates.isocalendar()
        keys = (iso["year"].to_numpy() * 100 + iso["week"].to_numpy())
    elif by == "month":
        keys = dates.year * 100 + dates.month
    else:
        keys = dates.year
    uniq, groups = np.unique(np.asarray(keys), return_inverse=True)
    starts = [dates[groups == g][0] for g in range(len(uniq))]
    if by == "week":
        labels = [f"W{k % 100:02d} {k // 100}" for k in uniq]
    elif by == "month":
        labels = [s.strftime("%b %Y") for s in starts]
    else:
        labels = [str(k) for k in uniq]
    return groups, labels, [s.strftime("%Y-%m-%d") for s in starts]


def _first_weeks(ext: budget_model.Model, first: int, n: int = B.DEFAULT_WEEKS) -> dict[str, int] | None:
    whole = [w for w in B.weeks(ext) if w.first >= first and w.last - w.first == 6]
    if not whole:
        return None
    pick = whole[:n]
    return {"start": pick[0].key, "end": pick[-1].key}


def summary(currency: str = "INR") -> dict[str, Any]:
    currency = F.normalise_currency(currency)
    ext, first, plan = extended_model()
    meta = _meta() or {}
    days = plan["in_plan"].to_numpy()
    idx = first + np.nonzero(days)[0]
    dates = ext.dates[idx]
    spend_days = ext.spend[idx]
    fits = [ext.central, *ext.draws]
    base = np.stack([ext.baseline_X[idx] @ f.w for f in fits])                     # fits x days
    by_ch = np.stack([f.media(ext.spend)[idx] for f in fits])                      # fits x days x channels
    media = by_ch.sum(axis=2)
    spend = spend_days.sum(axis=1)

    totals = [B._totals(float(spend.sum()), float(b.sum()), float(m.sum())) for b, m in zip(base, media)]
    scored = B.Scored(plan=None, central=totals[0], draws=totals[1:], by_channel=None, weekly=None, weekly_draws=None)  # type: ignore[arg-type]
    figures = B._figures_out(scored, currency)

    ch_media = by_ch.sum(axis=1)                                                   # fits x channels
    ch_spend = spend_days.sum(axis=0)
    total_spend = float(ch_spend.sum())
    lo, hi = _band(ch_media[1:])
    channels = []
    for j, c in enumerate(ext.channels):
        s, m = float(ch_spend[j]), float(ch_media[0, j])
        channels.append({
            "key": c, "label": B.channel_label(c),
            "spend": round(s, 2), "spend_display": F.money(s, currency),
            "share_pct": round(s / total_spend * 100, 2) if total_spend else 0.0,
            "media": round(m, 2), "media_display": F.money(m, currency),
            "media_range": {"p10": round(float(lo[j]), 2), "p90": round(float(hi[j]), 2),
                            "display": f"{F.money(float(lo[j]), currency)} – {F.money(float(hi[j]), currency)}"},
            "roas": round(m / s, 4) if s > 0 else None, "roas_display": F.multiple(m / s) if s > 0 else "—",
            "active_days": int((spend_days[:, j] > 0).sum()),
        })
    channels.sort(key=lambda r: -r["spend"])

    # Plan years: twelve months at a time from the plan's first day.
    start = dates[0]
    year_of = np.array([(d.year - start.year) * 12 + d.month - start.month - (1 if d.day < start.day else 0) for d in dates]) // 12
    years = []
    for y in range(int(year_of.max()) + 1):
        sel = year_of == y
        b, m, s = base[:, sel].sum(axis=1), media[:, sel].sum(axis=1), float(spend[sel].sum())
        rev = b + m
        r_lo, r_hi = _band(rev[1:])
        years.append({
            "label": f"Year {y + 1}", "from": dates[sel][0].strftime("%d %b %Y"), "to": dates[sel][-1].strftime("%d %b %Y"),
            "days": int(sel.sum()),
            "spend_display": F.money(s, currency),
            "baseline_display": F.money(float(b[0]), currency),
            "media_display": F.money(float(m[0]), currency),
            "revenue_display": F.money(float(rev[0]), currency),
            "revenue_range_display": f"{F.money(float(r_lo), currency)} – {F.money(float(r_hi), currency)}",
            "profit_display": F.money(float(rev[0] - s), currency),
            "roas_display": F.multiple(float(m[0]) / s) if s > 0 else "—",
        })

    series = {}
    for by in ("day", "week", "month"):
        groups, labels, starts = _grouping(dates, by)
        series[by] = _series(dates, groups, labels, starts, base, media, spend)

    return {
        "currency": currency,
        "exchange_rate": F.convert(1.0, currency),
        "draws": len(ext.draws),
        "plan": {
            "name": meta.get("name"), "uploaded_at": meta.get("uploaded_at"), "notes": meta.get("notes", []),
            "start": dates[0].strftime("%Y-%m-%d"), "end": dates[-1].strftime("%Y-%m-%d"),
            "days": int(len(dates)), "ad_days": int((spend > 0).sum()),
            "history_end": ext.dates[first - 1].strftime("%Y-%m-%d"),
            "channels": len(ext.channels),
        },
        "figures": figures,
        "series": series,
        "channels": channels,
        "years": years,
        "optimize_default": _first_weeks(ext, first),
        "model": B.model_card(ext),
    }


def predictions_csv() -> str:
    """The plan with its predicted revenue (central and P10 - P90), in rupees."""
    ext, first, plan = extended_model()
    idx = first + np.nonzero(plan["in_plan"].to_numpy())[0]
    fits = [ext.central, *ext.draws]
    base = np.stack([ext.baseline_X[idx] @ f.w for f in fits])
    media = np.stack([f.media(ext.spend)[idx].sum(axis=1) for f in fits])
    rev = base + media
    lo, hi = _band(rev[1:])
    out = plan[plan["in_plan"]].drop(columns="in_plan").copy()
    out["Date"] = out["Date"].dt.strftime("%d-%m-%Y")
    spend = ext.spend[idx].sum(axis=1)
    out["Ad_Spend_Total"] = spend.round(2)
    out["Predicted_Revenue"] = rev[0].round(0)
    out["Revenue_P10"] = lo.round(0)
    out["Revenue_P90"] = hi.round(0)
    out["Baseline_Revenue"] = base[0].round(0)
    out["Media_Revenue"] = media[0].round(0)
    out["Net_Profit"] = (rev[0] - spend).round(0)
    return out.to_csv(index=False, lineterminator="\n")
