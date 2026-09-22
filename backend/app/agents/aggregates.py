"""
Python-side aggregation.

The division of labour in this pipeline: **Python computes, the model
reasons.** Every number an agent sees is calculated here with pandas; the
model never receives raw rows and never does arithmetic. That keeps the
analysis grounded (a model asked to "compute ROI" from 2,000 rows will
approximate and drift), keeps token cost flat regardless of dataset size,
and makes the numbers reproducible.

`ColumnRoles` is the bridge between an arbitrary uploaded spreadsheet and
these generic analyses — the planning agent maps this dataset's actual
column names onto semantic roles, and everything here works off that.
"""
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

TOP_N = 12


@dataclass
class ColumnRoles:
    """Semantic roles resolved onto this dataset's real column names."""

    time: str | None = None
    spend: str | None = None
    revenue: str | None = None
    discount: str | None = None
    baseline: str | None = None
    actual: str | None = None
    dimensions: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], valid: set[str]) -> "ColumnRoles":
        """Build from the planner's output, dropping any column the model
        hallucinated — it can only name columns that actually exist."""

        def pick(key: str) -> str | None:
            value = raw.get(key)
            return value if isinstance(value, str) and value in valid else None

        dims = [d for d in (raw.get("dimensions") or []) if isinstance(d, str) and d in valid]
        return cls(
            time=pick("time"),
            spend=pick("spend"),
            revenue=pick("revenue"),
            discount=pick("discount"),
            baseline=pick("baseline"),
            actual=pick("actual"),
            dimensions=dims,
        )


def _num(value: Any) -> float | None:
    """Aggregates feed straight into JSON — NaN/inf must not survive."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return round(f, 2) if np.isfinite(f) else None


def _metric_frame(df: pd.DataFrame, roles: ColumnRoles, group: pd.Series | str) -> pd.DataFrame:
    """Shared spend/revenue/ROI/uplift rollup for one grouping."""
    agg: dict[str, Any] = {}
    if roles.spend:
        agg[roles.spend] = "sum"
    if roles.revenue:
        agg[roles.revenue] = "sum"
    if roles.discount:
        agg[roles.discount] = "mean"
    if roles.baseline:
        agg[roles.baseline] = "sum"
    if roles.actual:
        agg[roles.actual] = "sum"

    grouped = df.groupby(group, dropna=False)
    out = grouped.agg(agg) if agg else pd.DataFrame(index=grouped.size().index)
    out["rows"] = grouped.size()

    rename = {}
    if roles.spend:
        rename[roles.spend] = "spend"
    if roles.revenue:
        rename[roles.revenue] = "revenue"
    if roles.discount:
        rename[roles.discount] = "avg_discount"
    if roles.baseline:
        rename[roles.baseline] = "baseline"
    if roles.actual:
        rename[roles.actual] = "actual"
    out = out.rename(columns=rename)

    # ROI and uplift are the two numbers every promotion question comes back
    # to, so derive them once here rather than in each specialist's prompt.
    if "revenue" in out and "spend" in out:
        out["roi"] = np.where(out["spend"].abs() > 1e-9, out["revenue"] / out["spend"], np.nan)
    if "actual" in out and "baseline" in out:
        out["uplift_pct"] = np.where(
            out["baseline"].abs() > 1e-9, (out["actual"] - out["baseline"]) / out["baseline"] * 100, np.nan
        )
    return out


def _records(frame: pd.DataFrame, label_name: str, limit: int = TOP_N) -> list[dict[str, Any]]:
    rows = []
    for label, row in frame.head(limit).iterrows():
        rec: dict[str, Any] = {label_name: str(label)}
        for col, val in row.items():
            rec[str(col)] = int(val) if col == "rows" else _num(val)
        rows.append(rec)
    return rows


def by_dimension(df: pd.DataFrame, roles: ColumnRoles, dimension: str) -> dict[str, Any]:
    """Performance broken out by one categorical dimension (channel, region…)."""
    if dimension not in df.columns:
        return {"dimension": dimension, "error": "column not present"}
    frame = _metric_frame(df, roles, dimension)
    sort_col = "roi" if "roi" in frame else ("revenue" if "revenue" in frame else "rows")
    frame = frame.sort_values(by=sort_col, ascending=False, na_position="last")
    return {
        "dimension": dimension,
        "distinct_values": int(df[dimension].nunique(dropna=False)),
        "rows": _records(frame, dimension),
    }


def by_segment(df: pd.DataFrame, roles: ColumnRoles, dimensions: list[str]) -> dict[str, Any]:
    """Cross-dimension segments (channel × region, …) ranked by how far each
    deviates from the overall ROI.

    This exists because single-dimension breakdowns cannot see interactions.
    If one channel underperforms only in one region, the channel average and
    the region average both look unremarkable — the effect only appears at the
    intersection. Promotion problems are very often exactly this shape, so the
    `roi_index` (segment ROI vs overall, 100 = on par) is the column that
    actually answers "where is this going wrong".
    """
    dims = [d for d in dimensions if d in df.columns]
    if len(dims) < 2:
        return {"error": "need at least two valid dimension columns for a segment analysis"}
    if not (roles.spend and roles.revenue):
        return {"error": "segment analysis needs both spend and revenue columns"}

    frame = _metric_frame(df, roles, dims if len(dims) > 1 else dims[0])
    total_spend = df[roles.spend].sum()
    total_revenue = df[roles.revenue].sum()
    overall_roi = total_revenue / total_spend if abs(total_spend) > 1e-9 else np.nan

    if "roi" in frame and np.isfinite(overall_roi) and abs(overall_roi) > 1e-9:
        frame["roi_index"] = frame["roi"] / overall_roi * 100
    frame = frame[frame["rows"] >= 5]  # ignore segments too small to mean anything
    if frame.empty:
        return {"error": "no segment had enough rows to analyse"}

    sort_col = "roi_index" if "roi_index" in frame else "roi"
    ranked = frame.sort_values(by=sort_col, na_position="last")

    def rows_of(sub: pd.DataFrame) -> list[dict[str, Any]]:
        out = []
        for label, row in sub.iterrows():
            parts = label if isinstance(label, tuple) else (label,)
            rec: dict[str, Any] = {d: str(p) for d, p in zip(dims, parts)}
            for col, val in row.items():
                rec[str(col)] = int(val) if col == "rows" else _num(val)
            out.append(rec)
        return out

    return {
        "dimensions": dims,
        "overall_roi": _num(overall_roi),
        "roi_index_note": "roi_index = segment ROI as % of overall ROI; 100 = on par, below 100 = underperforming",
        "segment_count": int(len(frame)),
        "worst_segments": rows_of(ranked.head(8)),
        "best_segments": rows_of(ranked.tail(5).iloc[::-1]),
    }


def segment_by_discount(df: pd.DataFrame, roles: ColumnRoles, dimensions: list[str]) -> dict[str, Any]:
    """Segment performance split by discount depth — surfaces the common case
    where a segment is fine at shallow discounts and collapses at deep ones,
    which neither a segment view nor a discount view alone would reveal."""
    dims = [d for d in dimensions if d in df.columns]
    if not dims:
        return {"error": "no valid dimension columns"}
    if not roles.discount or roles.discount not in df.columns:
        return {"error": "no discount column identified"}
    if not (roles.spend and roles.revenue):
        return {"error": "needs both spend and revenue columns"}

    work = df.copy()
    try:
        work["_band"] = pd.qcut(work[roles.discount], q=3, labels=["shallow", "mid", "deep"], duplicates="drop")
    except (ValueError, TypeError):
        return {"error": "discount column could not be banded"}

    group_cols = dims[:2] + ["_band"]
    frame = _metric_frame(work, roles, group_cols)
    frame = frame[frame["rows"] >= 4]
    if frame.empty or "roi" not in frame:
        return {"error": "not enough data per segment/discount band"}

    total_spend = df[roles.spend].sum()
    overall_roi = df[roles.revenue].sum() / total_spend if abs(total_spend) > 1e-9 else np.nan
    if np.isfinite(overall_roi) and abs(overall_roi) > 1e-9:
        frame["roi_index"] = frame["roi"] / overall_roi * 100

    ranked = frame.sort_values(by="roi_index" if "roi_index" in frame else "roi", na_position="last")
    rows = []
    for label, row in ranked.head(12).iterrows():
        parts = label if isinstance(label, tuple) else (label,)
        rec: dict[str, Any] = {c.lstrip("_"): str(p) for c, p in zip(group_cols, parts)}
        for col, val in row.items():
            rec[str(col)] = int(val) if col == "rows" else _num(val)
        rows.append(rec)
    return {
        "dimensions": group_cols,
        "overall_roi": _num(overall_roi),
        "roi_index_note": "roi_index = ROI as % of overall; below 100 = underperforming",
        "worst_segment_bands": rows,
    }


def by_discount_band(df: pd.DataFrame, roles: ColumnRoles) -> dict[str, Any]:
    """ROI against discount depth — the core price-elasticity question:
    where does deeper discounting stop paying for itself?"""
    if not roles.discount or roles.discount not in df.columns:
        return {"error": "no discount column identified"}
    work = df.copy()
    try:
        work["_band"] = pd.qcut(work[roles.discount], q=5, duplicates="drop")
    except (ValueError, TypeError):
        return {"error": "discount column could not be banded"}
    frame = _metric_frame(work, roles, "_band")
    frame = frame.sort_index()
    rows = []
    for band, row in frame.iterrows():
        rec: dict[str, Any] = {"discount_band": str(band)}
        for col, val in row.items():
            rec[str(col)] = int(val) if col == "rows" else _num(val)
        rows.append(rec)
    return {"discount_column": roles.discount, "bands": rows}


def over_time(df: pd.DataFrame, roles: ColumnRoles) -> dict[str, Any]:
    """Period-by-period trend — catches decay, front-loading and spikes."""
    if not roles.time or roles.time not in df.columns:
        return {"error": "no time column identified"}
    work = df.copy()
    if not pd.api.types.is_datetime64_any_dtype(work[roles.time]):
        work[roles.time] = pd.to_datetime(work[roles.time], errors="coerce")
    work = work.dropna(subset=[roles.time])
    if work.empty:
        return {"error": "time column had no parseable values"}
    frame = _metric_frame(work, roles, work[roles.time].dt.to_period("W").astype(str)).sort_index()
    return {"time_column": roles.time, "periods": _records(frame, "period", limit=30)}


def numeric_correlations(df: pd.DataFrame, roles: ColumnRoles) -> dict[str, Any]:
    """What actually moves the outcome, ranked. A cheap but effective way to
    stop a specialist theorising about a driver the data doesn't support."""
    target = roles.revenue or roles.actual
    if not target or target not in df.columns:
        return {"error": "no outcome column identified"}
    numeric = df.select_dtypes(include="number")
    if target not in numeric.columns or numeric.shape[1] < 2:
        return {"error": "not enough numeric columns"}
    corr = numeric.corr(numeric_only=True)[target].drop(labels=[target], errors="ignore")
    corr = corr.reindex(corr.abs().sort_values(ascending=False).index)
    return {
        "target": target,
        "correlations": [{"column": str(k), "r": _num(v)} for k, v in corr.head(TOP_N).items() if _num(v) is not None],
    }


def overall(df: pd.DataFrame, roles: ColumnRoles) -> dict[str, Any]:
    """Headline totals for the whole dataset — the denominator every
    specialist finding gets judged against."""
    out: dict[str, Any] = {"rows": int(len(df))}
    if roles.spend and roles.spend in df:
        out["total_spend"] = _num(df[roles.spend].sum())
    if roles.revenue and roles.revenue in df:
        out["total_revenue"] = _num(df[roles.revenue].sum())
    if out.get("total_spend") and out.get("total_revenue"):
        spend = out["total_spend"]
        out["overall_roi"] = _num(out["total_revenue"] / spend) if abs(spend) > 1e-9 else None
    if roles.discount and roles.discount in df:
        out["avg_discount"] = _num(df[roles.discount].mean())
    if roles.baseline and roles.actual and roles.baseline in df and roles.actual in df:
        base = df[roles.baseline].sum()
        out["total_uplift_pct"] = _num((df[roles.actual].sum() - base) / base * 100) if abs(base) > 1e-9 else None
    if roles.time and roles.time in df:
        times = pd.to_datetime(df[roles.time], errors="coerce").dropna()
        if not times.empty:
            out["period_start"] = str(times.min().date())
            out["period_end"] = str(times.max().date())
    return out


def build_analysis(
    df: pd.DataFrame,
    roles: ColumnRoles,
    kind: str,
    dimension: str | None,
    dimensions: list[str] | None = None,
) -> dict[str, Any]:
    """Dispatch one specialist's requested analysis."""
    dims = dimensions or ([dimension] if dimension else []) or roles.dimensions
    if kind == "dimension" and dimension:
        return by_dimension(df, roles, dimension)
    if kind == "segment":
        return by_segment(df, roles, dims)
    if kind == "segment_discount":
        return segment_by_discount(df, roles, dims)
    if kind == "discount_band":
        return by_discount_band(df, roles)
    if kind == "time":
        return over_time(df, roles)
    if kind == "correlation":
        return numeric_correlations(df, roles)
    return {"error": f"unknown analysis kind '{kind}'"}
