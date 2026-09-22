"""Payloads of the RETIRED Simulation Studio, for the Decision Center tests.

Decision Center, the decision briefing and the durable store were built on the
payloads the earlier Simulation Studio produced -- `/api/simulation/context`,
`/run`, `/simulate`, `/compare`, `/recommend`, `/risk` and `/weekly`. That
studio was replaced by the three-lever studio in app/tpo/studio.py, which
produces none of them, and the endpoints are gone. Stored decision records
and their exports still hold payloads in the old shape, and the assembler
(app/tpo/decision.py) still reads them.

`fixtures/legacy_journey.json` is one full journey captured from those
endpoints before they were removed: scope {year 2025, channel CH002},
scenario-a at 10% and scenario-b at 15%, the comparison and recommendation
over both, the risk assessment of scenario-b (with and without the weekly
decomposition) and the weekly decomposition itself. The tests that used to
walk the journey live now load this instead.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

FIXTURE = Path(__file__).parent / "fixtures" / "legacy_journey.json"

SCOPE = {"year": 2025, "channel": ["CH002"]}
QUESTION = "Which approved treatment recovers the most incremental sales in Modern Trade?"


def load() -> dict[str, Any]:
    """A fresh deep copy every time, so one test's edits never reach another."""
    return copy.deepcopy(json.loads(FIXTURE.read_text(encoding="utf-8")))


def record_request(snapshot: dict[str, Any] | None = None, *, weekly: bool = True) -> dict[str, Any]:
    """The `/api/decision/record` body the old page posted for scenario-b."""
    snap = snapshot or load()
    body = {
        "context": snap["context"],
        "simulation": snap["scenario_b"],
        "recommendation": snap["recommendation"],
        "risk": snap["risk"] if weekly else snap["risk_no_weekly"],
    }
    if weekly:
        body["weekly"] = snap["weekly"]
    return body
