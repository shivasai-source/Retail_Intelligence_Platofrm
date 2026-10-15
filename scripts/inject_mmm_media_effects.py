"""Give the MMM reference dataset a real, known advertising effect.

WHY. In the reference file (Data/mmm/mmm_daily.csv) revenue does not respond
to ad spend: days with spend average Rs 2.720 Cr against Rs 2.719 Cr on days
without, while spending Rs 1.23 Cr. A budget optimizer over that file can only
rank noise. This script rebuilds Revenue as

    Revenue = original Revenue + sum over channels of the channel's effect

where a channel's effect on a day is the standard media-mix shape:

    adstock_t  = spend_t + decay * adstock_{t-1}          (carryover)
    effect_t   = beta * adstock_t^alpha / (adstock_t^alpha + kappa^alpha)
                                                          (diminishing returns)

Every channel gets its own decay, alpha and kappa, and beta is set so that the
channel returns a chosen ROAS (incremental revenue / spend) over the file's
whole history. Days without spend keep their original revenue except for the
carryover from earlier spend, so the baseline is unchanged.

KNOWN TRUTH. The parameters are written to scripts/mmm_media_truth.json, so
the platform's model can be tested against effects that are known to be there.

REPRODUCIBLE. The original revenue is always read from git (the commit named
by --source-rev), never from the file being rewritten, so running this twice
gives the same file.

    python scripts/inject_mmm_media_effects.py
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "Data" / "mmm" / "mmm_daily.csv"
TRUTH = ROOT / "scripts" / "mmm_media_truth.json"
#: The last commit holding the original, effect-free revenue.
SOURCE_REV = "e58596a"

#: channel: (daily decay, alpha, ROAS over the whole history). Alpha <= 1
#: keeps every response curve concave (diminishing returns from the first
#: rupee), which is what real channels show at these spend levels and what
#: makes the budget problem have one best answer. The spread of ROAS --
#: search and commerce well above 1, print and out-of-home below it -- is the
#: usual shape of Indian media mixes and gives the optimizer a real choice.
CHANNELS: dict[str, tuple[float, float, float]] = {
    "TV_Spend": (0.50, 0.90, 1.40),
    "OTT_Spend": (0.40, 0.90, 1.60),
    "Streaming_Audio_Spend": (0.30, 0.85, 0.90),
    "Cinema_Advertising_Spend": (0.45, 0.85, 0.70),
    "Meta_Ads_Spend": (0.20, 0.85, 1.90),
    "YouTube_Ads_Spend": (0.30, 0.85, 1.70),
    "Google_Ads_Spend": (0.10, 0.80, 2.20),
    "TikTok_Ads_Spend": (0.20, 0.85, 1.10),
    "Billboard_Spend": (0.50, 0.90, 0.80),
    "Transit_Advertising_Spend": (0.45, 0.90, 0.60),
    "Airport_Advertising_Spend": (0.45, 0.90, 0.50),
    "Newspaper_Spend": (0.25, 0.90, 0.70),
    "Magazine_Spend": (0.45, 0.90, 0.50),
    "Google_Search_Spend": (0.05, 0.80, 2.80),
    "Programmatic_Display_Spend": (0.15, 0.85, 1.00),
    "Native_Advertising_Spend": (0.20, 0.85, 1.20),
    "Ecommerce_Ads_Spend": (0.10, 0.80, 3.00),
    "Quick_Commerce_Ads_Spend": (0.05, 0.80, 2.40),
    "In_Store_Digital_Ads_Spend": (0.10, 0.85, 2.00),
    "Influencer_Marketing_Spend": (0.30, 0.85, 1.30),
    "Creator_Content_Spend": (0.30, 0.85, 1.10),
    "Sponsored_Content_Spend": (0.30, 0.85, 0.90),
}
#: Half-saturation point, as a multiple of the channel's mean adstock on the
#: days it is active: at today's spend levels each channel is about half way
#: up its curve, so moving money visibly changes what each rupee returns.
KAPPA_MULTIPLE = 1.0


def adstock(spend: np.ndarray, decay: float) -> np.ndarray:
    out = np.empty_like(spend)
    carry = 0.0
    for i, s in enumerate(spend):
        carry = s + decay * carry
        out[i] = carry
    return out


def hill(x: np.ndarray, kappa: float, alpha: float) -> np.ndarray:
    xa = np.power(np.maximum(x, 0.0), alpha)
    return xa / (xa + kappa**alpha)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source-rev", default=SOURCE_REV)
    args = ap.parse_args()

    raw = subprocess.run(
        ["git", "show", f"{args.source_rev}:Data/mmm/mmm_daily.csv"],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout.decode("utf-8-sig")
    # Every column read as text, so everything but Revenue is written back
    # byte for byte.
    frame = pd.read_csv(io.StringIO(raw), dtype=str, keep_default_na=False)
    order = pd.to_datetime(frame["Date"], format="%d-%m-%Y").argsort(kind="stable").to_numpy()
    revenue = frame["Revenue"].astype(float).to_numpy()

    effect = np.zeros(len(frame))
    truth: dict[str, dict[str, float]] = {}
    for channel, (decay, alpha, roas) in CHANNELS.items():
        spend = np.zeros(len(frame))
        spend[order] = frame[channel].astype(float).to_numpy()[order]
        # Carryover runs in date order.
        stock = np.zeros(len(frame))
        stock[order] = adstock(spend[order], decay)
        active = stock[spend > 0]
        kappa = float(active.mean()) * KAPPA_MULTIPLE
        shape = hill(stock, kappa, alpha)
        beta = roas * spend.sum() / shape.sum()
        effect += beta * shape
        truth[channel] = {
            "decay": decay, "alpha": alpha, "kappa": round(kappa, 2),
            "beta": round(float(beta), 2), "roas": roas,
            "spend": round(float(spend.sum()), 2),
            "incremental_revenue": round(float((beta * shape).sum()), 2),
        }

    frame["Revenue"] = np.rint(revenue + effect).astype(np.int64).astype(str)
    DATA.write_text(frame.to_csv(index=False, lineterminator="\n"), encoding="utf-8")

    spend_total = sum(t["spend"] for t in truth.values())
    inc_total = sum(t["incremental_revenue"] for t in truth.values())
    TRUTH.write_text(json.dumps({
        "source_rev": args.source_rev,
        "kappa_multiple": KAPPA_MULTIPLE,
        "overall_roas": round(inc_total / spend_total, 4),
        "media_share_of_revenue": round(inc_total / float(frame["Revenue"].astype(float).sum()), 4),
        "channels": truth,
    }, indent=2), encoding="utf-8")
    print(f"Rewrote {DATA.relative_to(ROOT)}: overall ROAS {inc_total / spend_total:.2f}, "
          f"media share of revenue {inc_total / frame['Revenue'].astype(float).sum():.1%}")


if __name__ == "__main__":
    main()
