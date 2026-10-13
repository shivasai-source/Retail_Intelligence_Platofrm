"""Promotion Calendar read model.

  * Counts are the fact table's own: products and stores per channel-month.
  * Booking grain is read from the data: General Trade runs single weeks.
  * A month the data does not reach is "No data", never "No Promo".
  * The Upcoming feed holds only promotions from the data.

Run with:  ../venv/Scripts/python.exe -m pytest tests/test_promotion_calendar.py -q
"""

from __future__ import annotations

from app.tpo import promo_calendar as PC
from app.tpo.loader import get_store


def test_booking_is_read_from_the_data():
    booking = PC.booking()
    assert booking["CH002"] == "month" and booking["CH005"] == "month"
    assert booking["CH003"] == "week", "General Trade books one week a month per store"


def test_months_past_the_data_are_no_data():
    store = get_store()
    last_year = max(store.years())
    months = {int(store.month[i]) for i in range(store.row_count) if store.year[i] == last_year}
    cells = PC.matrix(last_year)["channels"][0]["cells"]
    for cell in cells:
        if cell["month"] not in months:
            assert cell["kind"] == "no_data"


def test_cell_counts_match_the_fact_rows():
    store = get_store()
    year, month, channel = 2025, 10, "CH001"
    products, stores = set(), set()
    for i in range(store.row_count):
        st = store.stores[store.store_code[i]]
        if store.year[i] == year and store.month[i] == month and st.channel_id == channel and store.promoted[i]:
            products.add(store.products[store.product_code[i]].product_id)
            stores.add(st.store_id)
    cell = next(c for c in PC.matrix(year, [channel])["channels"][0]["cells"] if c["month"] == month)
    assert cell["product_count"] == len(products)
    assert cell["store_count"] == len(stores)
    detail = PC.cell_detail(year, month, channel)
    assert all(p["start"] and p["end"] and p["store_count"] > 0 for p in detail["promotions"])
    assert detail["weeks"], "a weekly channel shows its weeks"


def test_upcoming_is_promotions_only():
    feed = PC.upcoming(2025, 0)
    assert feed["events"] and {e["source"] for e in feed["events"]} == {"promotion"}
