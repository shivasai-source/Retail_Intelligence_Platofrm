"""The No-U-Turn Sampler (NUTS), in numpy.

Hamiltonian Monte Carlo that picks its own trajectory length: Hoffman &
Gelman (2014), "The No-U-Turn Sampler", Algorithm 6 (slice NUTS with dual
averaging), with Stan's windowed adaptation of a diagonal mass matrix.

WHY IT IS WRITTEN HERE. TPO_Algorithm_Workflow.pdf names PyMC or numpyro.
Both need native code this deployment cannot load: Windows Smart App Control
blocks jaxlib's unsigned DLLs, and PyMC compiles its own C at run time. The
sampler is the same algorithm; only the host language differs. The model it
samples lives in `planner_model`.

USE.
    run_nuts(logp_grad, init, chains=4, warmup=1000, draws=1000, seed=...)
`logp_grad(q) -> (log density, gradient)` on an unconstrained vector.
Returns the draws (chains x draws x dim) and the sampler's diagnostics;
`diagnostics()` adds split R-hat and effective sample size per coordinate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

LogpGrad = Callable[[np.ndarray], tuple[float, np.ndarray]]

#: A trajectory whose energy error passes this is divergent (Stan's value).
DELTA_MAX = 1000.0
#: Dual-averaging constants from the paper.
_GAMMA, _T0, _KAPPA = 0.05, 10.0, 0.75


def _safe(logp_grad: LogpGrad, q: np.ndarray) -> tuple[float, np.ndarray]:
    """A point the density cannot evaluate (an overflow far out in the tails)
    has zero probability: the trajectory there is simply rejected."""
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            lp, g = logp_grad(q)
    except (OverflowError, FloatingPointError, ValueError, ZeroDivisionError):
        return -math.inf, np.zeros_like(q)
    if not math.isfinite(lp) or not np.all(np.isfinite(g)):
        return -math.inf, np.zeros_like(q)
    return float(lp), g


@dataclass
class ChainResult:
    draws: np.ndarray            # draws x dim
    step_size: float
    divergences: int
    mean_tree_depth: float
    mean_accept: float
    inv_mass: np.ndarray


@dataclass
class _DualAveraging:
    mu: float
    h_bar: float = 0.0
    log_eps_bar: float = 0.0
    m: int = 0

    def update(self, accept: float, target: float) -> float:
        self.m += 1
        w = 1.0 / (self.m + _T0)
        self.h_bar = (1 - w) * self.h_bar + w * (target - accept)
        log_eps = self.mu - math.sqrt(self.m) / _GAMMA * self.h_bar
        eta = self.m ** -_KAPPA
        self.log_eps_bar = eta * log_eps + (1 - eta) * self.log_eps_bar
        return math.exp(log_eps)


@dataclass
class _Sampler:
    logp_grad: LogpGrad
    inv_mass: np.ndarray
    rng: np.random.Generator
    max_depth: int = 10
    leapfrogs: int = field(default=0)

    # --- one leapfrog step ---------------------------------------------------
    def _leapfrog(self, q, p, g, eps):
        self.leapfrogs += 1
        p = p + 0.5 * eps * g
        q = q + eps * self.inv_mass * p
        lp, g = _safe(self.logp_grad, q)
        p = p + 0.5 * eps * g
        return q, p, g, lp

    def _joint(self, lp: float, p: np.ndarray) -> float:
        with np.errstate(over="ignore", invalid="ignore"):
            j = lp - 0.5 * float(np.dot(p * p, self.inv_mass))
        return j if math.isfinite(j) else -math.inf

    def _no_u_turn(self, q_minus, q_plus, p_minus, p_plus) -> bool:
        dq = q_plus - q_minus
        return float(np.dot(dq, self.inv_mass * p_minus)) >= 0 and float(np.dot(dq, self.inv_mass * p_plus)) >= 0

    # --- the recursive tree (Algorithm 6, BuildTree) -------------------------
    def _build(self, q, p, g, log_u, v, j, eps, joint0):
        if j == 0:
            q1, p1, g1, lp1 = self._leapfrog(q, p, g, v * eps)
            joint = self._joint(lp1, p1)
            n1 = 1 if log_u <= joint else 0
            s1 = log_u < DELTA_MAX + joint
            accept = math.exp(min(0.0, joint - joint0)) if joint > -math.inf else 0.0
            return q1, p1, g1, q1, p1, g1, q1, g1, lp1, n1, s1, accept, 1, not s1
        (qm, pm, gm, qp, pp, gp, q1, g1, lp1, n1, s1, a1, na1, div) = self._build(q, p, g, log_u, v, j - 1, eps, joint0)
        if s1:
            if v == -1:
                (qm, pm, gm, _, _, _, q2, g2, lp2, n2, s2, a2, na2, div2) = self._build(qm, pm, gm, log_u, v, j - 1, eps, joint0)
            else:
                (_, _, _, qp, pp, gp, q2, g2, lp2, n2, s2, a2, na2, div2) = self._build(qp, pp, gp, log_u, v, j - 1, eps, joint0)
            if n1 + n2 > 0 and self.rng.random() < n2 / (n1 + n2):
                q1, g1, lp1 = q2, g2, lp2
            a1 += a2
            na1 += na2
            div = div or div2
            s1 = s2 and self._no_u_turn(qm, qp, pm, pp)
            n1 += n2
        return qm, pm, gm, qp, pp, gp, q1, g1, lp1, n1, s1, a1, na1, div

    # --- one NUTS transition ---------------------------------------------------
    def transition(self, q, lp, g, eps):
        p0 = self.rng.standard_normal(len(q)) / np.sqrt(self.inv_mass)
        joint0 = self._joint(lp, p0)
        log_u = joint0 - self.rng.exponential()
        qm = qp = q
        pm = pp = p0
        gm = gp = g
        q_new, lp_new, g_new = q, lp, g
        n, s, depth = 1, True, 0
        accept_sum, accept_n, divergent = 0.0, 0, False
        while s and depth < self.max_depth:
            v = -1 if self.rng.random() < 0.5 else 1
            if v == -1:
                (qm, pm, gm, _, _, _, q1, g1, lp1, n1, s1, a, na, div) = self._build(qm, pm, gm, log_u, v, depth, eps, joint0)
            else:
                (_, _, _, qp, pp, gp, q1, g1, lp1, n1, s1, a, na, div) = self._build(qp, pp, gp, log_u, v, depth, eps, joint0)
            if s1 and self.rng.random() < min(1.0, n1 / n):
                q_new, lp_new, g_new = q1, lp1, g1
            n += n1
            accept_sum += a
            accept_n += na
            divergent = divergent or div
            s = s1 and self._no_u_turn(qm, qp, pm, pp)
            depth += 1
        return q_new, lp_new, g_new, accept_sum / max(accept_n, 1), depth, divergent

    def reasonable_step(self, q, lp, g) -> float:
        """The paper's heuristic: double or halve until one leapfrog step's
        acceptance crosses one half."""
        eps = 0.1
        p = self.rng.standard_normal(len(q)) / np.sqrt(self.inv_mass)
        joint0 = self._joint(lp, p)
        _, p1, _, lp1 = self._leapfrog(q, p, g, eps)
        ratio = self._joint(lp1, p1) - joint0
        a = 1.0 if ratio > math.log(0.5) else -1.0
        for _ in range(50):
            if not (a * ratio > -a * math.log(2)):
                break
            eps *= 2.0 ** a
            _, p1, _, lp1 = self._leapfrog(q, p, g, eps)
            ratio = self._joint(lp1, p1) - joint0
        return eps


def _windows(warmup: int) -> list[int]:
    """Stan's adaptation schedule: the iterations at which a slow window ends
    (the mass matrix is re-estimated there). A fast buffer of 75 opens, one of
    50 closes, and the windows between start at 25 and double."""
    init, term, base = 75, 50, 25
    if warmup < init + term + base:
        return [warmup]
    ends: list[int] = []
    start, size = init, base
    last = warmup - term
    while start < last:
        end = start + size
        if end + 2 * size > last:
            end = last
        ends.append(end)
        start, size = end, size * 2
    return ends


def run_chain(logp_grad: LogpGrad, init: np.ndarray, *, warmup: int, draws: int, seed: int,
              target_accept: float = 0.85, max_depth: int = 10) -> ChainResult:
    rng = np.random.default_rng(seed)
    dim = len(init)
    sampler = _Sampler(logp_grad, np.ones(dim), rng, max_depth=max_depth)
    q = init.astype(float).copy()
    lp, g = _safe(logp_grad, q)
    if not math.isfinite(lp):
        raise ValueError("The starting point has no probability.")
    eps = sampler.reasonable_step(q, lp, g)
    da = _DualAveraging(mu=math.log(10 * eps))
    window_ends = set(_windows(warmup))
    window: list[np.ndarray] = []
    in_slow = False

    out = np.empty((draws, dim))
    divergences = 0
    depths: list[int] = []
    accepts: list[float] = []
    for it in range(warmup + draws):
        q, lp, g, accept, depth, divergent = sampler.transition(q, lp, g, eps)
        if it < warmup:
            eps = da.update(accept, target_accept)
            if it >= 75:
                in_slow = True
            if in_slow:
                window.append(q.copy())
            if it + 1 in window_ends and len(window) > 10:
                # Regularised variance of the window's draws (Stan's rule).
                w = np.array(window)
                n = len(w)
                var = w.var(axis=0, ddof=1)
                sampler.inv_mass = (n / (n + 5.0)) * var + 1e-3 * (5.0 / (n + 5.0))
                window = []
                eps = sampler.reasonable_step(q, lp, g)
                da = _DualAveraging(mu=math.log(10 * eps))
            if it == warmup - 1:
                eps = math.exp(da.log_eps_bar)
        else:
            out[it - warmup] = q
            divergences += int(divergent)
            depths.append(depth)
            accepts.append(accept)
    return ChainResult(draws=out, step_size=eps, divergences=divergences,
                       mean_tree_depth=float(np.mean(depths)) if depths else 0.0,
                       mean_accept=float(np.mean(accepts)) if accepts else 0.0,
                       inv_mass=sampler.inv_mass)


def run_nuts(logp_grad: LogpGrad, init: np.ndarray, *, chains: int = 4, warmup: int = 1000, draws: int = 1000,
             seed: int = 0, jitter: float = 0.5, target_accept: float = 0.85) -> tuple[np.ndarray, list[ChainResult]]:
    """Run `chains` independent chains from jittered starts. Returns the draws
    as chains x draws x dim and each chain's sampler report."""
    results = []
    for c in range(chains):
        rng = np.random.default_rng(seed + 7919 * (c + 1))
        start = init + rng.uniform(-jitter, jitter, size=len(init))
        results.append(run_chain(logp_grad, start, warmup=warmup, draws=draws, seed=seed + 104729 * (c + 1),
                                 target_accept=target_accept))
    return np.stack([r.draws for r in results]), results


# --- convergence diagnostics -----------------------------------------------------


def split_rhat(x: np.ndarray) -> np.ndarray:
    """Split R-hat per coordinate (Gelman et al., BDA3). x: chains x draws x dim."""
    c, n, d = x.shape
    half = n // 2
    s = np.concatenate([x[:, :half], x[:, half:2 * half]], axis=0)     # 2c x half x d
    m = s.shape[0]
    chain_mean = s.mean(axis=1)
    chain_var = s.var(axis=1, ddof=1)
    w = chain_var.mean(axis=0)
    b = half * chain_mean.var(axis=0, ddof=1)
    var_plus = (half - 1) / half * w + b / half
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.sqrt(var_plus / w)
    return np.where(w > 0, r, 1.0)


def ess(x: np.ndarray) -> np.ndarray:
    """Effective sample size per coordinate: the multi-chain autocorrelation
    estimate with Geyer's initial monotone sequence (as in Stan)."""
    c, n, d = x.shape
    out = np.empty(d)
    for k in range(d):
        y = x[:, :, k]
        y = y - y.mean(axis=1, keepdims=True)
        size = 1 << (2 * n - 1).bit_length()
        f = np.fft.rfft(y, n=size, axis=1)
        acov = np.fft.irfft(f * np.conj(f), n=size, axis=1)[:, :n] / n
        chain_var = acov[:, 0] * n / (n - 1)
        mean_var = chain_var.mean()
        means = x[:, :, k].mean(axis=1)
        var_plus = mean_var * (n - 1) / n + (means.var(ddof=1) if c > 1 else 0.0)
        if var_plus <= 0:
            out[k] = c * n
            continue
        rho = 1.0 - (mean_var - acov.mean(axis=0)) / var_plus
        rho[0] = 1.0
        # Sum pairs while positive, enforcing monotone decrease.
        total, prev = 0.0, math.inf
        t = 0
        while t + 1 < n:
            pair = rho[t] + rho[t + 1]
            if pair < 0:
                break
            pair = min(pair, prev)
            total += pair
            prev = pair
            t += 2
        tau = -1.0 + 2.0 * total
        out[k] = c * n / max(tau, 1e-9)
    return out


def diagnostics(x: np.ndarray, results: list[ChainResult]) -> dict[str, float | int]:
    r = split_rhat(x)
    e = ess(x)
    return {
        "chains": int(x.shape[0]),
        "draws_per_chain": int(x.shape[1]),
        "rhat_max": round(float(np.max(r)), 4),
        "ess_min": round(float(np.min(e)), 1),
        "ess_median": round(float(np.median(e)), 1),
        "divergences": int(sum(res.divergences for res in results)),
        "mean_tree_depth": round(float(np.mean([res.mean_tree_depth for res in results])), 2),
        "mean_accept": round(float(np.mean([res.mean_accept for res in results])), 3),
        "step_size": round(float(np.mean([res.step_size for res in results])), 5),
    }


__all__ = ["ChainResult", "diagnostics", "ess", "run_chain", "run_nuts", "split_rhat"]
