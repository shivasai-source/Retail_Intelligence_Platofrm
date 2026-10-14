"""Which page answers a question typed into Investigations.

A plain figure lookup goes to the Insights Hub Analyst; anything causal,
diagnostic or unsure stays an investigation.
"""

import pytest

from app.agents.analyst import route_question


@pytest.mark.parametrize(
    "question",
    [
        "What is ROI by channel in 2025?",
        "How much trade spend did we have in March 2025",
        "Which region had the lowest ROI?",
        "Show top 5 promotions by incremental sales",
        "how many promotions ran in Modern Trade",
    ],
)
def test_lookups_go_to_the_analyst(question):
    assert route_question(question) == "analyst"


@pytest.mark.parametrize(
    "question",
    [
        "Why did South MT Push underperform despite higher trade spend?",
        "What drove the decline in Q3?",
        "Which channel underperformed in 2025",
        "Investigate the Diwali offer in Modern Trade",
        "ROI for D Mart",
        "",
    ],
)
def test_causal_or_unsure_stays_an_investigation(question):
    assert route_question(question) == "investigation"
