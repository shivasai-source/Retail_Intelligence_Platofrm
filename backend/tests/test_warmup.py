"""The startup warm-up, and the one way it can silently stop working.

WHY THIS MATTERS. The KPI engine memoises per scope, so the first visit to a
period pays for the whole computation and every later visit is free. Measured
on the reference dataset, one cold year costs about six seconds spread across
the Insights Hub's panels — 3.5s for the KPI cards, 2.0s for the region
breakdown, 0.6s for channel. That is what "changing the period is slow" was.

`app.main._warm_insights_hub` pays it on a background thread at startup
instead, which turns a six-second period change into a twenty-millisecond one.
It can only do that for the panels it actually knows about: a chart that starts
asking for a dimension the warm-up does not list goes back to paying its own
cost, and nothing fails — the page is simply slow again, which is exactly the
kind of regression that is never noticed until someone complains.

So the dimensions are read out of the frontend and compared.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app import main

REPO = Path(__file__).resolve().parents[2]
COMMAND_DIR = REPO / "frontend" / "src" / "components" / "command"
HUB_PAGE = REPO / "frontend" / "src" / "pages" / "CommandCenter.tsx"


def _dimensions_the_page_asks_for() -> set[str]:
    """Every literal dimension passed to `useBreakdown` by the Insights Hub.

    A dimension chosen at runtime — the Analyst's pinned charts pass a
    variable — cannot be known here and is not warmed; those are one reader's
    ad-hoc chart rather than part of the page everyone lands on.
    """
    found: set[str] = set()
    sources = [HUB_PAGE, *COMMAND_DIR.glob("*.tsx")]
    for path in sources:
        if not path.is_file():
            continue
        for match in re.finditer(r"useBreakdown\(\s*'([a-z_]+)'", path.read_text(encoding="utf-8")):
            found.add(match.group(1))
    return found


def _warmed_dimensions() -> set[str]:
    """The dimensions `_warm_insights_hub` precomputes, read from its source —
    they are a local in that function rather than a module constant, because
    they describe one page and belong beside the code that warms it."""
    source = Path(main.__file__).read_text(encoding="utf-8")
    body = source[source.index("def _warm_insights_hub"):]
    block = body[body.index("panels:"): body.index("years =")]
    return set(re.findall(r'\("([a-z_]+)",\s*\d+\)', block))


def test_the_warm_up_covers_every_chart_the_hub_draws():
    page = _dimensions_the_page_asks_for()
    warmed = _warmed_dimensions()
    assert page, "found no useBreakdown calls — the reader below has drifted, not the page"
    missing = page - warmed
    assert not missing, (
        f"The Insights Hub draws {sorted(missing)} but the startup warm-up does not "
        "precompute them, so the first visit to each period pays for them again "
        "(seconds, not milliseconds). Add them to `panels` in app/main.py."
    )


def test_the_warm_up_does_not_precompute_charts_nobody_draws():
    """The startup budget is real: warming a dimension the page never requests
    spends twenty seconds of a thread on nothing."""
    extra = _warmed_dimensions() - _dimensions_the_page_asks_for()
    assert not extra, f"{sorted(extra)} is warmed but no panel asks for it."


def test_the_reader_actually_reads_something():
    """A parser that silently found nothing would make both tests above pass
    while the lists drifted — the only way a mirror test is worse than none."""
    assert len(_dimensions_the_page_asks_for()) >= 5
    assert len(_warmed_dimensions()) >= 5


@pytest.mark.parametrize("name", ["kpis", "trend", "promotion_mix", "top_promotions", "breakdown"])
def test_the_warm_up_calls_the_services_the_page_calls(name):
    source = Path(main.__file__).read_text(encoding="utf-8")
    body = source[source.index("def _warm_insights_hub"):]
    assert f"service.{name}(" in body


def test_a_failed_warm_up_never_stops_the_server():
    """It is an optimisation. A period that cannot be precomputed must still be
    reachable — it simply pays its own cost on first use, as it always did."""
    body = Path(main.__file__).read_text(encoding="utf-8")
    body = body[body.index("def _warm_insights_hub"):]
    assert "except Exception:" in body
    assert "log.exception" in body
