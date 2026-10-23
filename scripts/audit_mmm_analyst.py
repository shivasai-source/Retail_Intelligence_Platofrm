"""Audit the MMM Insights Hub's Analyst against the real model and real data.

    cd backend && ../venv/Scripts/python.exe ../scripts/audit_mmm_analyst.py

WHY THIS IS NOT A UNIT TEST. Every scenario here spends a model call, and the
model is not deterministic — a suite that costs money and can fail for reasons
that are nobody's fault does not belong in `pytest -q`. The LOGIC each
scenario exercises is unit-tested in backend/tests/test_mmm_analyst.py; what
this adds is the only question those tests cannot answer: does the whole thing,
with a real model in the middle, give the reader the right figure.

WHAT MAKES IT AN AUDIT RATHER THAN A DEMO. Nothing is judged by reading the
answers. The expected figures are computed HERE, from the engine, before any
question is asked — so a scenario passes only when the answer carries the
figure the page would show, verbatim, and does NOT carry the one it must not:
a different period's total, or a better channel's name when the question asked
for the worst. Both of those have been shipped by this Analyst and found by
exactly this check.

Exit code is the number of failures, so CI can run it when someone wants to.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Run from anywhere: the agent lives under backend/.
BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from app.agents import mmm_analyst as A  # noqa: E402
from app.agents import mmm_tools as M  # noqa: E402

DASH = {"pinned": [], "hidden_charts": [], "cards": [], "granularity": "month"}
PINNED = {
    "pinned": [{"id": "pinned:1", "title": "ROAS by Channel", "chart_type": "bar",
                "by": "channel", "metric": "roas"}],
    "hidden_charts": [], "cards": [], "granularity": "month",
}


def main() -> int:
    # --- GROUND TRUTH, computed before a single question is asked ------------
    k25 = {k["label"]: k["display"] for k in M.kpis({"year": 2025})["kpis"]}
    k24 = {k["label"]: k["display"] for k in M.kpis({"year": 2024})["kpis"]}
    q3 = {k["label"]: k["display"] for k in M.kpis({"year": 2025, "quarter": 3})["kpis"]}
    may = {k["label"]: k["display"] for k in M.kpis({"year": 2025, "month": 5})["kpis"]}
    best = M.breakdown({"year": 2025}, "channel", "roas", 3, order="best")["groups"]
    worst = M.breakdown({"year": 2025}, "channel", "roas", 3, order="worst")["groups"]
    spend = M.breakdown({"year": 2025}, "channel", "spend", 3)["groups"]
    promo = M.breakdown({"year": 2025}, "promotion", "revenue", 3)["groups"]

    #: (question, must appear, must NOT appear, tools that must be called)
    answers: list[tuple[str, list[str], list[str], list[str]]] = [
        # The figures a reader checks against the cards beside the chat.
        ("what was the revenue in 2025?", [k25["Total Revenue"]], ["15,236"], ["get_kpis"]),
        ("total ad spend in 2025?", [k25["Total Ad Spend"]], [], ["get_kpis"]),
        ("what was roas in 2025?", [k25["ROAS"]], [], ["get_kpis"]),
        ("baseline and incremental revenue for 2025",
         [k25["Baseline Revenue"], k25["Incremental Revenue"]], [], ["get_kpis"]),
        ("how many days had ad spend in 2025?", ["180"], [], ["get_kpis"]),
        ("what was revenue in 2024?", [k24["Total Revenue"]], [], ["get_kpis"]),
        # A part of a year is NOT the year: the baseline is re-estimated for it.
        ("what was revenue in q3 2025?",
         [q3["Total Revenue"]], [k25["Total Revenue"]], ["get_kpis"]),
        ("what was roas in may 2025?", [may["ROAS"]], [], ["get_kpis"]),
        ("revenue for 11 mar 2025 to 11 aug 2025", [], [], ["get_kpis"]),
        # Both ends of a ranking. The "worst" question named the sixth-best
        # channel until `compare` learned to rank upwards.
        ("which channel had the best roas in 2025?",
         [best[0]["group"], best[0]["roas_display"]], [], ["compare"]),
        ("which channel had the WORST roas in 2025?",
         [worst[0]["group"], worst[0]["roas_display"]], [best[0]["group"]], ["compare"]),
        ("which channel spent the most in 2025?",
         [spend[0]["group"], spend[0]["spend_display"]], [], ["compare"]),
        ("which promotion type earned the most in 2025?",
         [promo[0]["group"], promo[0]["revenue_display"]], [], ["compare"]),
        # A definition describes THIS hub, not the textbook.
        ("what does ROAS mean here?",
         ["incremental revenue", "total ad spend"], [], ["define_kpi"]),
        ("what is the baseline?", ["baseline"], [], ["define_kpi"]),
        ("how does 2025 compare with a year ago?", [k25["ROAS"]], [], ["compare_periods"]),
        # "Did X lift revenue" is a measurement, not a share of attributed
        # revenue — 3.69% was the decomposition's share, read as a lift.
        ("did festivals lift revenue in 2025?", [], ["3.69%"], ["compare"]),
        # Ordinary questions are answered, not refused as off-topic.
        ("what is 2+2?", ["4"], [], []),
        ("hi", [], [], []),
        # And what the data cannot answer is said plainly, with no figure.
        ("what was revenue in 1990?", [], ["₹"], []),
        ("which store sold the most?", [], [], []),
    ]

    #: (question, page state, action kinds, summary must, summary must not)
    changes: list[tuple[str, dict, list[str], list[str], list[str]]] = [
        ("show me q3 2025", DASH, ["period"], ["Q3 2025"], []),
        ("go to 2024", DASH, ["period"], ["2024"], []),
        ("show me all years", DASH, ["period"], ["all years"], []),
        ("show me 11 mar 2025 to 11 aug 2025", DASH, ["period"], ["Mar 2025"], []),
        ("show the trend weekly", DASH, ["granularity"], ["weekly"], []),
        ("just show TV and OTT", DASH, ["filter"], ["TV", "OTT"], ["removed"]),
        ("clear the filters", DASH, ["filter"], ["cleared"], []),
        ("remove the event impact chart", DASH, ["layout"], ["removed Event Impact"], []),
        ("add the incremental revenue card", DASH, ["layout"], ["Incremental Revenue"], []),
        ("add a chart of ad spend by channel to the hub", DASH, ["pin_chart"],
         ["Ad Spend", "Channel"], []),
        # Changing a chart is never removing one, and never removing another.
        ("make the roas by channel chart a column chart", PINNED, ["update_chart"],
         ["column"], ["removed"]),
        ("group the roas by channel chart by family instead", PINNED, ["update_chart"],
         ["Family"], ["removed"]),
        # A reset is one change, not one change plus six.
        ("put everything back", DASH, ["layout"], ["default"], ["added Ad Spend"]),
        ("undo", DASH, ["undo"], [], []),
    ]

    failures: list[str] = []

    async def run() -> None:
        print("=" * 78)
        print("ANSWERS")
        print("=" * 78)
        for question, must, must_not, tools in answers:
            try:
                result = await A.answer(question, dashboard=DASH)
            except Exception as exc:
                failures.append(f"{question!r} raised {type(exc).__name__}: {exc}")
                print(f"\n  [ERROR] {question}\n          {type(exc).__name__}: {exc}")
                continue
            answer = " ".join(result["answer"].split())
            # CASE-INSENSITIVE: the answer writes a metric the way the page
            # writes it ("Baseline Revenue"), and the scenario above names it
            # the way a reader would. Matching on case made this script report
            # a failure that was its own.
            folded = answer.casefold()
            called = [s["tool"] for s in result["steps"]]
            missing = [m for m in must if m.casefold() not in folded]
            present = [m for m in must_not if m.casefold() in folded]
            uncalled = [t for t in tools if t not in called]
            ok = not (missing or present or uncalled)
            print(f"\n  [{'PASS' if ok else 'FAIL'}] {question}")
            print(f"         {answer[:180]}")
            if called:
                print(f"         tools: {called}")
            for label, items, note in (
                ("MISSING", missing, "missing"),
                ("SHOULD NOT CONTAIN", present, "contains"),
                ("DID NOT CALL", uncalled, "did not call"),
            ):
                if items:
                    failures.append(f"{question!r} {note} {items}")
                    print(f"         {label}: {items}")

        print()
        print("=" * 78)
        print("PAGE CHANGES")
        print("=" * 78)
        for question, page, kinds, must, must_not in changes:
            try:
                result = await A.answer(question, dashboard=page)
            except Exception as exc:
                failures.append(f"{question!r} raised {type(exc).__name__}: {exc}")
                print(f"\n  [ERROR] {question}\n          {type(exc).__name__}: {exc}")
                continue
            got = [a["kind"] for a in result["actions"]]
            summary = "; ".join(a["summary"] for a in result["actions"])
            folded = summary.casefold()
            wrong_kind = [k for k in kinds if k not in got]
            missing = [m for m in must if m.casefold() not in folded]
            present = [m for m in must_not if m.casefold() in folded]
            ok = not (wrong_kind or missing or present)
            print(f"\n  [{'PASS' if ok else 'FAIL'}] {question}")
            print(f"         actions: {summary or 'NONE'}")
            if wrong_kind:
                failures.append(f"{question!r} gave {got}, wanted {kinds}")
                print(f"         WRONG KIND: got {got}, wanted {kinds}")
            if missing:
                failures.append(f"{question!r} summary missing {missing}")
                print(f"         MISSING: {missing}")
            if present:
                failures.append(f"{question!r} summary contains {present}")
                print(f"         SHOULD NOT CONTAIN: {present}")

    asyncio.run(run())

    total = len(answers) + len(changes)
    print()
    print("=" * 78)
    print(f"{total} scenarios, {len(failures)} failures")
    for failure in failures:
        print(f"  - {failure}")
    return len(failures)


if __name__ == "__main__":
    sys.exit(main())
