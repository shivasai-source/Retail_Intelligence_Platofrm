"""THE MMM RESPONSE MODEL behind the Budget Optimizer.

What a day's revenue is made of:

    revenue_t = baseline_t + sum over channels c of  beta_c * hill(adstock_c,t)

    baseline_t  = trend + yearly seasonality (Fourier) + day of week
                  + festival / seasonal / promotion flags + discount depth
                  + promotion type                      -- the non-ad factors
    adstock_c,t = spend_c,t + decay_c * adstock_c,t-1   -- carryover
    hill(x)     = x^alpha_c / (x^alpha_c + kappa_c^alpha_c)
                                                        -- diminishing returns

HOW IT IS FITTED.

1. JOINT FIT. Baseline and media fitted together on every day. Ad days and
   no-ad days alternate in runs of about two days, so most no-ad days still
   carry the previous days' advertising; fitting both together attributes
   that carryover to the spend that caused it, while the no-ad days still pin
   the baseline down. The media curves (decay, kappa,
   alpha per channel) are found by coordinate search over a grid; each
   candidate is scored by projecting it against every other column, which is
   exact and needs no re-fit.

   POOLED CHANNEL EFFECTS. Seven digital channels switch on and off on the
   same days with spend ~0.95 correlated, so the data fixes their combined
   effect but not how it splits between them. Each channel's ROAS therefore
   has a hierarchical prior: ROAS_c ~ N(mean ROAS, PRIOR_SD^2), the mean
   itself estimated, and the effects are kept non-negative. A channel moves
   away from the shared mean only as far as its own data supports, instead of
   swinging to 0 or 10. PRIOR_SD is set in advance, not tuned to a result.

2. UNCERTAINTY: A BLOCK BOOTSTRAP. The whole fit -- curves included -- is
   repeated on BOOTSTRAPS resamples of the calendar months (with
   replacement). Each refit is one draw; every plan is scored on every draw,
   which is where the P10 - P90 ranges and "chance profit rises" come from.
   Months, not days, are resampled so carryover and seasonality stay intact.

Validated on the last 365 days after refitting on the days before them.
Only numpy, pandas and scipy: the deployment cannot load native ML packages.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.optimize import lsq_linear
from scipy.signal import lfilter

from app.mmm import loader

#: Grids for the coordinate search over each channel's media curve.
DECAYS = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7)
KAPPA_MULTIPLES = (0.5, 0.75, 1.0, 1.5, 2.0)
ALPHAS = (0.8, 0.9, 1.0)
SWEEPS = 3
#: Ridge penalty on the (standardised) baseline coefficients.
RIDGE = 1.0
#: Prior spread of a channel's ROAS around the shared mean.
PRIOR_SD = 0.75
#: The most recent days held out to validate the fit.
HOLDOUT_DAYS = 365
#: Block-bootstrap refits behind every range, and the sweeps each one makes
#: (it starts from the central fit's curves, so fewer are needed).
BOOTSTRAPS = 40
BOOT_SWEEPS = 2
#: Bumped whenever the model changes, so a cached fit is never reused across
#: versions.
VERSION = 2


def adstock(spend: np.ndarray, decay: float) -> np.ndarray:
    """Geometric carryover along axis 0 (days)."""
    return lfilter([1.0], [1.0, -decay], spend, axis=0) if decay else np.asarray(spend, float)


def hill(x: np.ndarray, kappa: float, alpha: float) -> np.ndarray:
    xa = np.power(np.maximum(x, 0.0), alpha)
    return xa / (xa + kappa**alpha)


def hill_slope(x: np.ndarray, kappa: float, alpha: float) -> np.ndarray:
    """d hill / d x."""
    x = np.maximum(x, 1e-9)
    ka = kappa**alpha
    xa = np.power(x, alpha)
    return alpha * ka * xa / (x * (xa + ka) ** 2)


@dataclass
class Curve:
    decay: float
    kappa: float
    alpha: float


@dataclass
class Fit:
    """One fitted set of parameters: the central fit or one bootstrap draw."""

    curves: list[Curve]
    w: np.ndarray       # baseline coefficients, rupees per standardised unit
    beta: np.ndarray    # media coefficients, rupees per day at full saturation
    roas: np.ndarray    # each channel's ROAS over the whole file

    def shapes(self, spend: np.ndarray) -> np.ndarray:
        """hill(adstock) per channel for a days x channels spend matrix."""
        out = np.empty(spend.shape, float)
        for j, c in enumerate(self.curves):
            out[:, j] = hill(adstock(spend[:, j], c.decay), c.kappa, c.alpha)
        return out

    def media(self, spend: np.ndarray) -> np.ndarray:
        """Revenue each channel drives, per day (days x channels)."""
        return self.shapes(spend) * self.beta


@dataclass
class Model:
    dates: pd.DatetimeIndex
    channels: list[str]
    spend: np.ndarray            # days x channels, in date order
    revenue: np.ndarray
    baseline_X: np.ndarray       # days x baseline features
    central: Fit
    draws: list[Fit]
    checks: dict[str, Any] = field(default_factory=dict)

    def baseline(self, fit: Fit | None = None) -> np.ndarray:
        return self.baseline_X @ (fit or self.central).w


# --------------------------------------------------------------- features


def _raw_features(frame: pd.DataFrame, history: pd.DataFrame, t_end: float | None = None) -> np.ndarray:
    """The baseline's columns before standardising, laid out as `history`
    lays them out (its start date, flags and promotion types). Past `t_end`
    the trend continues along its tangent at t_end -- straight on at its
    latest rate -- instead of bending with the quadratic."""
    dates = frame["Date"]
    t = (dates - history["Date"].min()).dt.days.to_numpy() / 3652.5
    t2 = t**2
    if t_end is not None:
        t2 = np.where(t > t_end, t_end**2 + 2 * t_end * (t - t_end), t2)
    doy = dates.dt.dayofyear.to_numpy()
    cols: list[np.ndarray] = [t, t2]
    for k in (1, 2, 3, 4):
        cols += [np.sin(2 * np.pi * k * doy / 365.25), np.cos(2 * np.pi * k * doy / 365.25)]
    for d in range(6):
        cols.append((dates.dt.dayofweek == d).to_numpy(float))
    for flag in ("Festival_Flag", "Seasonal_Flag", "Promotion_Flag", "Discount_Percentage"):
        if flag in history:
            cols.append(frame[flag].to_numpy(float) if flag in frame else np.zeros(len(frame)))
    if "Promotion_Type" in history:
        types = frame["Promotion_Type"].astype(str) if "Promotion_Type" in frame else pd.Series([""] * len(frame))
        for p in sorted(history["Promotion_Type"].astype(str).unique())[1:]:
            cols.append((types == p).to_numpy(float))
    return np.column_stack(cols)


def baseline_features(frame: pd.DataFrame, history: pd.DataFrame | None = None) -> np.ndarray:
    """The baseline's design matrix for `frame`, standardised by `history`
    (the fitted data; `frame` itself when omitted). Days after the history
    take the trend straight on from its last day."""
    history = frame if history is None else history
    H = _raw_features(history, history)
    sd = H.std(axis=0)
    sd[sd == 0] = 1.0
    t_end = None if history is frame else float((history["Date"].max() - history["Date"].min()).days / 3652.5)
    X = (_raw_features(frame, history, t_end) - H.mean(axis=0)) / sd
    return np.column_stack([np.ones(len(frame)), X])


def _accuracy(pred: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    mape = float(np.mean(np.abs(pred - actual) / actual) * 100)
    r2 = float(1 - np.sum((pred - actual) ** 2) / np.sum((actual - actual.mean()) ** 2))
    return {"mape_pct": round(mape, 2), "r2": round(r2, 3), "days": int(len(actual))}


# --------------------------------------------------------------- one fit


def _fit_once(B: np.ndarray, spend: np.ndarray, y: np.ndarray, weights: np.ndarray,
              start: list[Curve] | None, sweeps: int, progress=lambda f: None) -> Fit:
    """Curves by coordinate search, then the pooled linear fit -- on the rows
    weighted by `weights` (all ones for the central fit, resample counts for
    a bootstrap draw)."""
    rw = np.sqrt(weights)
    keep = weights > 0
    ys = (y - y.mean()) / y.std()
    k = spend.shape[1]
    curves = list(start) if start else []
    if not curves:
        for j in range(k):
            stock = adstock(spend[:, j], 0.3)
            active = stock[spend[:, j] > 0]
            curves.append(Curve(0.3, float(active.mean()) if len(active) else 1.0, 0.9))
    shapes = np.column_stack([hill(adstock(spend[:, j], c.decay), c.kappa, c.alpha) for j, c in enumerate(curves)])

    Bw = (B * rw[:, None])[keep]
    yw = (ys * rw)[keep]
    total = sweeps * k
    step = 0
    for _ in range(sweeps):
        for j in range(k):
            step += 1
            progress(step / total)
            # Everything but channel j projected out once: each candidate is
            # then scored exactly, without re-solving the regression.
            others = (np.delete(shapes, j, axis=1) * rw[:, None])[keep]
            Q, _ = np.linalg.qr(np.column_stack([Bw, others]))
            r = yw - Q @ (Q.T @ yw)
            best = (-np.inf, curves[j], shapes[:, j])
            for decay in DECAYS:
                stock = adstock(spend[:, j], decay)
                active = stock[spend[:, j] > 0]
                base_kappa = float(active.mean()) if len(active) else 1.0
                for km in KAPPA_MULTIPLES:
                    for alpha in ALPHAS:
                        col = hill(stock, base_kappa * km, alpha)
                        v = (col * rw)[keep]
                        v = v - Q @ (Q.T @ v)
                        vv = v @ v
                        gain = (v @ r) ** 2 / vv if vv > 1e-12 else 0.0
                        if gain > best[0]:
                            best = (gain, Curve(decay, base_kappa * km, alpha), col)
            curves[j] = best[1]
            shapes[:, j] = best[2]

    # The pooled linear fit. Media columns are scaled so each coefficient IS
    # the channel's ROAS over the file.
    p = B.shape[1]
    unit = np.where(shapes.sum(axis=0) > 0, spend.sum(axis=0) / np.maximum(shapes.sum(axis=0), 1e-12), 0.0)
    Z = shapes * unit
    X = np.column_stack([B, Z])[keep] * rw[keep, None]
    yk = y[keep] * rw[keep]
    sigma = float(np.std(yk - X @ np.linalg.lstsq(X, yk, rcond=None)[0]))
    ridge = np.zeros((p - 1, p + k + 1))
    ridge[:, 1:p] = np.sqrt(RIDGE) * np.eye(p - 1)
    pool = np.zeros((k, p + k + 1))
    pool[:, p:p + k] = np.eye(k) * sigma / PRIOR_SD
    pool[:, -1] = -sigma / PRIOR_SD
    A = np.vstack([np.column_stack([X, np.zeros(len(X))]), ridge, pool])
    b = np.concatenate([yk, np.zeros(p - 1 + k)])
    lo = np.full(A.shape[1], -np.inf)
    lo[p:p + k] = 0.0
    theta = lsq_linear(A, b, bounds=(lo, np.full(A.shape[1], np.inf)), lsmr_tol="auto").x
    roas = theta[p:p + k]
    return Fit(curves=curves, w=theta[:p], beta=roas * unit, roas=roas)


def _month_weights(dates: pd.DatetimeIndex, rng: np.random.Generator) -> np.ndarray:
    """A block-bootstrap resample: whole calendar months drawn with
    replacement, as a weight per day."""
    month = dates.year * 12 + dates.month
    ids, inverse = np.unique(month, return_inverse=True)
    counts = np.bincount(rng.integers(0, len(ids), len(ids)), minlength=len(ids))
    return counts[inverse].astype(float)


def fit(frame: pd.DataFrame, progress=lambda stage, pct: None) -> Model:
    frame = frame.sort_values("Date").reset_index(drop=True)
    channels = loader.media_columns(frame)
    spend = frame[channels].to_numpy(float)
    y = frame["Revenue"].to_numpy(float)
    B = baseline_features(frame)
    dates = pd.DatetimeIndex(frame["Date"])
    n = len(frame)
    holdout = np.arange(n) >= n - HOLDOUT_DAYS

    # 1. The central fit, and its holdout validation.
    central = _fit_once(B, spend, y, np.ones(n), None, SWEEPS,
                        lambda f: progress("Fitting channel response curves", 5 + int(25 * f)))
    held = _fit_once(B, spend, y, (~holdout).astype(float), central.curves, 1,
                     lambda f: progress("Validating on the last year", 30 + int(5 * f)))
    holdout_check = _accuracy(B[holdout] @ held.w + held.shapes(spend)[holdout] @ held.beta, y[holdout])

    # 2. Block-bootstrap draws.
    rng = np.random.default_rng(7)
    draws: list[Fit] = []
    for i in range(BOOTSTRAPS):
        weights = _month_weights(dates, rng)
        draws.append(_fit_once(B, spend, y, weights, central.curves, BOOT_SWEEPS,
                               lambda f, i=i: progress("Measuring uncertainty", 35 + int(63 * (i + f) / BOOTSTRAPS))))
    progress("Ready", 100)

    return Model(
        dates=dates, channels=channels, spend=spend, revenue=y, baseline_X=B,
        central=central, draws=draws,
        checks={
            "holdout_last_year": holdout_check,
            "media_share_pct": round(float((central.shapes(spend) @ central.beta).sum() / y.sum() * 100), 2),
            "bootstraps": BOOTSTRAPS,
        },
    )


# --------------------------------------------------------------- training state

_lock = threading.Lock()
_state: dict[str, Any] = {"status": "idle", "stage": "", "progress": 0, "error": None, "key": None}
_model: Model | None = None


def _key() -> tuple:
    from app.mmm import config

    path = config.data_dir() / config.DATASET_FILE
    st = path.stat()
    return (VERSION, str(path), st.st_mtime_ns, st.st_size)


def _cache_path() -> Path:
    return Path(__file__).resolve().parents[2] / ".store" / "mmm_budget_model.npz"


# THE CACHE IS PLAIN ARRAYS AND JSON, never pickle: loading it can only ever
# produce numbers and strings, whatever is in the file.

def _fit_arrays(prefix: str, f: Fit) -> dict[str, np.ndarray]:
    return {
        f"{prefix}curves": np.array([[c.decay, c.kappa, c.alpha] for c in f.curves]),
        f"{prefix}w": f.w, f"{prefix}beta": f.beta, f"{prefix}roas": f.roas,
    }


def _fit_from(arrays, prefix: str) -> Fit:
    return Fit(
        curves=[Curve(float(d), float(k), float(a)) for d, k, a in arrays[f"{prefix}curves"]],
        w=arrays[f"{prefix}w"], beta=arrays[f"{prefix}beta"], roas=arrays[f"{prefix}roas"],
    )


def _save_cached(key: tuple, model: Model) -> None:
    try:
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        arrays: dict[str, np.ndarray] = {
            "meta": np.array(json.dumps({"key": list(key), "channels": model.channels,
                                         "draws": len(model.draws), "checks": model.checks})),
            "dates": model.dates.values.astype("datetime64[ns]").astype(np.int64),
            "spend": model.spend, "revenue": model.revenue, "baseline_X": model.baseline_X,
            **_fit_arrays("central_", model.central),
        }
        for i, d in enumerate(model.draws):
            arrays.update(_fit_arrays(f"draw{i}_", d))
        with open(path, "wb") as fh:
            np.savez_compressed(fh, **arrays)
    except Exception:
        pass  # a cache that cannot be written only costs a refit


def _load_cached(key: tuple) -> Model | None:
    try:
        with np.load(_cache_path(), allow_pickle=False) as arrays:
            meta = json.loads(str(arrays["meta"]))
            if tuple(meta["key"]) != key:
                return None
            return Model(
                dates=pd.DatetimeIndex(arrays["dates"].astype("datetime64[ns]")),
                channels=list(meta["channels"]),
                spend=arrays["spend"], revenue=arrays["revenue"], baseline_X=arrays["baseline_X"],
                central=_fit_from(arrays, "central_"),
                draws=[_fit_from(arrays, f"draw{i}_") for i in range(meta["draws"])],
                checks=meta["checks"],
            )
    except Exception:
        return None


def status() -> dict[str, Any]:
    """The model's training state, starting a fit when none is current."""
    global _model
    loader.get_frame()  # raises MmmDatasetMissing when nothing is installed
    key = _key()
    with _lock:
        if _state["key"] != key and _state["status"] != "training":
            cached = _load_cached(key)
            if cached is not None:
                _model = cached
                _state.update(status="ready", stage="Ready", progress=100, error=None, key=key)
            else:
                _start(key)
        return {k: _state[k] for k in ("status", "stage", "progress", "error")}


def _start(key: tuple) -> None:
    _state.update(status="training", stage="Starting", progress=0, error=None, key=key)

    def run() -> None:
        global _model
        started = time.time()
        try:
            def progress(stage: str, pct: int) -> None:
                _state.update(stage=stage, progress=pct)

            model = fit(loader.get_frame(), progress)
            model.checks["fit_seconds"] = round(time.time() - started, 1)
            _save_cached(key, model)
            with _lock:
                _model = model
                _state.update(status="ready", stage="Ready", progress=100)
        except Exception as exc:  # surfaced to the page, not swallowed
            with _lock:
                _state.update(status="error", error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=run, name="mmm-budget-fit", daemon=True).start()


def get_model() -> Model | None:
    """The fitted model for the installed dataset, or None while it trains."""
    status()
    with _lock:
        return _model if _state["status"] == "ready" else None


def reset() -> None:
    """Forget the model (a new dataset was installed or removed)."""
    global _model
    with _lock:
        _model = None
        _state.update(status="idle", stage="", progress=0, error=None, key=None)
