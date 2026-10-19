"""A client's own column names, mapped onto ours.

WHAT IS BEING PINNED. No source system exports `Actual_Quantity`; it exports
`UnitsSold`, `Qty` or `SalesUnits`. Before `app/column_mapping.py` every such
file was refused as "not one of the standard tables" — a message about the
wrong problem, since the data was right and only the names were not. These
tests pin that a renamed dataset installs, that it produces the SAME NUMBERS as
the identically-sourced canonical one, and that the two things which must never
be guessed — an ambiguous name, and a column the user corrected by hand — are
not.

Throwaway folders only; the live Data/ folder is never written to.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import column_mapping as cm
from app import source_sync, star_dataset
from app.deps import current_user
from app.main import app
from app.tpo import config, loader

#: The reference dataset, materialised from git HEAD by tests/conftest.py.
#: NOT the working Data/ folder — see that file.
REPO_DATA = config.DATA_DIR

#: Every reference file, restated under the names a real extract would use.
#: One concept per rename, all of them reachable through COLUMN_ALIASES, so
#: this is the "client sends us their own export" case end to end.
CLIENT_NAMES: dict[str, dict[str, str]] = {
    config.FACT_FILE: {
        "Date": "TxnDate", "Product_id": "SKU", "Store_Id": "Outlet",
        "Promotion_Id": "PromoCode", "Base_Quantity": "BaseUnits",
        "Actual_Quantity": "UnitsSold", "Base_Price": "MRP",
        "Actual_Price": "NetPrice", "Total_Cost": "TotalCOGS",
        "Promotion_Cost": "PromoSpend",
    },
    config.DIM_FILES["product"]: {
        "Product_id": "SKU", "Product_Name": "Description", "Size": "PackSize",
    },
    config.DIM_FILES["geo_store"]: {
        "Store_Id": "Outlet", "Channel_Id": "ChannelCode",
        "Retailer": "RetailerName", "Region": "Zone", "State": "StateName",
        "City": "Town", "Tier": "StoreGrade",
    },
    config.DIM_FILES["channel"]: {
        "Channel_Id": "ChannelCode", "Channel_Name": "ChannelDesc",
        "Channel_Type": "ChannelFormat",
    },
    config.DIM_FILES["promotion"]: {
        "Promotion_Id": "PromoCode", "Promotion_Name": "PromoName",
        "Promotion_Type": "PromoType", "Promotion_Description": "PromoDetails",
    },
    config.DIM_FILES["date"]: {
        "Date": "CalendarDay", "Year": "CalendarYear", "Month": "MonthNumber",
        "Week": "WeekNumber",
    },
}

#: Columns a load-bearing export carries that mean nothing to us. Added to the
#: fact table so the "extra columns are ignored" half of the contract is
#: exercised by the same end-to-end test.
JUNK_COLUMNS = ("RegionMgr", "LoadTS", "BatchId")


def _rename_file(source: Path, target: Path, renames: dict[str, str], junk=()) -> None:
    """Copy a CSV with its header rewritten to the client's names."""
    with source.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    header = [renames.get(c, c) for c in rows[0]] + list(junk)
    with target.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for row in rows[1:]:
            writer.writerow(row + ["ignored"] * len(junk))


@pytest.fixture(scope="module")
def client_named_dataset(tmp_path_factory) -> Path:
    """The six reference files, every column renamed as a client would."""
    folder = tmp_path_factory.mktemp("client_named")
    for name, renames in CLIENT_NAMES.items():
        _rename_file(
            REPO_DATA / name, folder / name, renames,
            JUNK_COLUMNS if name == config.FACT_FILE else (),
        )
    return folder


# --- the alias table itself ------------------------------------------------


def test_no_alias_is_claimed_by_two_canonical_columns():
    """The module's whole safety claim is that an alias can mean ONE column.
    A name two canonicals both list would silently resolve to whichever was
    declared first, which is exactly the quiet wrong answer this forbids."""
    claims: dict[str, list[str]] = {}
    for canonical, aliases in cm.COLUMN_ALIASES.items():
        for alias in aliases:
            claims.setdefault(cm.normalise(alias), []).append(canonical)
    clashes = {alias: owners for alias, owners in claims.items() if len(owners) > 1}
    assert not clashes, f"ambiguous aliases: {clashes}"


def test_no_alias_shadows_a_different_canonical_name():
    """`Size` must never be an alias of something else, or a file using our own
    name for a column would be mapped away from it."""
    canonical_norms = {cm.normalise(c): c for c in cm.COLUMN_ALIASES}
    for canonical, aliases in cm.COLUMN_ALIASES.items():
        for alias in aliases:
            owner = canonical_norms.get(cm.normalise(alias))
            assert owner in (None, canonical), (
                f"'{alias}' is an alias of {canonical} but is also the real name of {owner}"
            )


def test_normalise_folds_spelling_but_not_meaning():
    for spelling in ("Units Sold", "units_sold", "UNITS-SOLD", "UnitsSold", " unitssold "):
        assert cm.normalise(spelling) == "unitssold"
    # A plural is NOT folded: Unit and Units are worth asking about.
    assert cm.normalise("Unit") != cm.normalise("Units")


def test_ambiguous_names_are_left_unmapped():
    """`Price` could be base or actual, `Cost` any of three. Guessing either
    inverts discounts or corrupts ROI with no error anywhere, so the table
    must not contain them and the user must be asked."""
    for ambiguous in ("Price", "Cost", "Amount", "Value", "Id", "Name", "Type"):
        assert cm.normalise(ambiguous) not in cm._ALIAS_INDEX or \
            cm._ALIAS_INDEX[cm.normalise(ambiguous)] == ambiguous.title(), ambiguous

    proposal = cm.propose(
        ["Date", "Product_id", "Store_Id", "Promotion_Id", "Qty", "Price", "Cost"],
        star_dataset.ROLE_COLUMNS["fact"],
        star_dataset.EITHER_COLUMNS["fact"],
    )
    assert "Base_Price" in proposal.unmapped
    assert "Actual_Price" in proposal.unmapped
    assert "Price" in proposal.spare and "Cost" in proposal.spare


# --- proposing -------------------------------------------------------------


def test_a_client_fact_header_maps_completely():
    header = [
        "TxnDate", "SKU", "Outlet", "PromoCode", "PromoDesc", "OfferType",
        "UnitsSold", "MRP", "NetPrice", "UnitCost", "PromoSpend",
        "RegionMgr", "LoadTS", "BatchId",
    ]
    proposal = star_dataset.propose_for("fact", header)
    assert proposal.unmapped == ()
    assert proposal.mapping["Actual_Quantity"] == "UnitsSold"
    assert proposal.mapping["Base_Price"] == "MRP"
    assert proposal.mapping["Actual_Price"] == "NetPrice"
    assert proposal.mapping["CP"] == "UnitCost"
    # Cost arrives per unit, so the interchangeable group is satisfied by CP
    # and Total_Cost is simply absent rather than missing.
    assert "Total_Cost" not in proposal.mapping
    # Columns that mean nothing to us are ignored, not rejected.
    assert set(proposal.spare) == set(JUNK_COLUMNS)


def test_one_column_is_never_claimed_twice():
    """A file with both `Qty` and `Units` must not have them both read as
    Actual_Quantity, or one measure would be counted under two names."""
    proposal = star_dataset.propose_for(
        "fact",
        ["Date", "Product_id", "Store_Id", "Promotion_Id", "Qty", "Units",
         "MRP", "NetPrice", "UnitCost"],
    )
    claimed = list(proposal.mapping.values())
    assert len(claimed) == len(set(claimed))


# --- identification --------------------------------------------------------


def test_role_is_reached_through_aliases():
    """The file that used to be refused outright."""
    found = star_dataset.identify(
        ["TxnDate", "SKU", "Outlet", "PromoCode", "UnitsSold", "MRP", "NetPrice",
         "UnitCost", "PromoSpend"]
    )
    assert found is not None
    assert found.role == "fact"
    assert found.matched_by == "recognised column names"


def test_a_fact_table_without_promotion_cost_needs_a_declared_role():
    """A PRE-EXISTING SHARP EDGE, pinned rather than fixed here.

    `Promotion_Cost` is optional to the loader but IS one of the fact table's
    two discriminators, so a fact file without it has never been identifiable
    — not even under our own column names. Aliases do not change that, because
    identification is about which columns exist, not what they are called.

    What is new is the way out: the user says which table it is, and the file
    is accepted. Fixing the discriminator itself would change what every other
    source is allowed to upload, which is not this feature's business.
    """
    canonical = ["Date", "Product_id", "Store_Id", "Promotion_Id",
                 "Actual_Quantity", "Base_Price", "Actual_Price", "Total_Cost"]
    assert star_dataset.identify(canonical) is None

    found = star_dataset.identify(canonical, role="fact")
    assert found is not None and found.proposal.unmapped == ()


def test_canonical_files_are_still_matched_on_their_own_names(client_named_dataset):
    """Aliases are a fallback, never a reinterpretation: the shipped files must
    identify exactly as they did before this module existed."""
    for role, name in star_dataset.ROLE_FILES.items():
        item = star_dataset.classify(name, (REPO_DATA / name).read_bytes())
        assert item is not None, name
        assert item.role == role
        assert item.matched_by == "column headers"
        assert item.missing_columns == ()
        # Nothing to rename, so nothing is renamed.
        assert item.mapping_renames_nothing if hasattr(item, "mapping_renames_nothing") else True
        assert all(
            cm.normalise(actual) == cm.normalise(canonical)
            for canonical, actual in item.mapping.items()
        )


def test_an_unknown_header_is_still_unrecognised():
    """Mapping widens what can be recognised; it does not make everything
    acceptable. A file of nothing we understand is still a wrong-file slip."""
    assert star_dataset.classify("notes.csv", b"Foo,Bar,Baz\n1,2,3\n") is None


def test_a_declared_role_overrides_the_discriminators():
    """The user's answer to "which table is this?" is never second-guessed."""
    content = b"Col1,Col2,Col3\n1,2,3\n"
    assert star_dataset.classify("mystery.csv", content) is None
    item = star_dataset.classify("mystery.csv", content, role="product")
    assert item is not None
    assert item.role == "product"
    assert item.matched_by == "chosen by you"
    # Declaring the role does not invent the columns.
    assert set(item.missing_columns) == set(star_dataset.ROLE_COLUMNS["product"])


def test_a_confirmed_mapping_beats_the_proposal():
    """Once the user has chosen, the proposal must not quietly re-guess —
    the difference between a suggestion and a decision made for them."""
    header = b"TxnDate,SKU,Outlet,PromoCode,UnitsSold,MRP,NetPrice,UnitCost,PromoSpend,ShelfPrice\n"
    proposed = star_dataset.classify("sales.csv", header)
    assert proposed is not None and proposed.mapping["Base_Price"] == "MRP"

    corrected = star_dataset.classify(
        "sales.csv", header, mapping={"Base_Price": "ShelfPrice"}
    )
    assert corrected is not None
    assert corrected.mapping["Base_Price"] == "ShelfPrice"
    # And the fields the user did not touch still stand.
    assert corrected.mapping["Actual_Quantity"] == "UnitsSold"


def test_a_mapping_naming_a_column_the_file_lacks_is_ignored():
    """The browser may have been looking at a different file by the time the
    mapping was sent, so a choice that cannot be honoured is dropped rather
    than written into the header."""
    item = star_dataset.classify(
        "sales.csv",
        b"TxnDate,SKU,Outlet,PromoCode,UnitsSold,MRP,NetPrice,UnitCost,PromoSpend\n",
        mapping={"Base_Price": "NoSuchColumn"},
    )
    assert item is not None
    assert item.mapping["Base_Price"] == "MRP"


# --- applying the rename ---------------------------------------------------


def test_rename_rewrites_the_header_and_leaves_rows_untouched():
    """The loader indexes by column NAME, so rewriting row data would be work
    that can only introduce errors. The data bytes must come through
    identically."""
    original = (
        b"TxnDate,SKU,UnitsSold\n"
        b'2024-01-01,P1,"1,234"\n'
        b"2024-01-02,P2,7\n"
    )
    out = star_dataset._rename_csv_header(
        original, {"TxnDate": "Date", "SKU": "Product_id", "UnitsSold": "Actual_Quantity"}
    )
    assert out.split(b"\n", 1)[0] == b"Date,Product_id,Actual_Quantity"
    assert out.split(b"\n", 1)[1] == original.split(b"\n", 1)[1]


def test_a_rename_collision_drops_the_column_it_displaced():
    """A file carrying both `MRP` and a junk `Base_Price`, with MRP mapped onto
    Base_Price, would otherwise end up with the name twice and DictReader would
    silently keep whichever came last."""
    header = ["MRP", "Base_Price", "NetPrice"]
    renamed, dropped = cm.apply_to_header(header, {"MRP": "Base_Price"})
    assert renamed == ["Base_Price", "NetPrice"]
    assert dropped == ["Base_Price"]

    out = star_dataset._rename_csv_header(
        b"MRP,Base_Price,NetPrice\n100,999,90\n", {"MRP": "Base_Price"}
    )
    rows = list(csv.reader(out.decode().splitlines()))
    assert rows[0] == ["Base_Price", "NetPrice"]
    # The human's choice survived; the displaced column is gone entirely.
    assert rows[1] == ["100", "90"]


# --- samples, the price-swap guard ----------------------------------------


def test_samples_skip_blanks():
    """A blank in row 1 must not teach the user that the column is empty."""
    samples = star_dataset.read_samples(
        "sales.csv", b"MRP,NetPrice,Note\n,90.00,x\n249.00,90.00,y\n"
    )
    assert samples["MRP"] == ["249.00"]
    assert samples["NetPrice"] == ["90.00"]


def test_samples_show_that_a_price_column_varies():
    """THE REASON SAMPLES ARE A LIST. On an unpromoted row the base and actual
    price are equal, so one example showed `80` against both and taught the
    user nothing about the one pair that must not be swapped. Distinct values
    over many rows make a selling price look like a selling price."""
    rows = b"MRP,NetPrice\n" + b"".join(
        # The first three rows are unpromoted: both prices identical.
        [b"80,80\n"] * 3 + [b"80,64\n", b"100,72\n", b"80,64\n"]
    )
    samples = star_dataset.read_samples("sales.csv", rows)
    assert samples["MRP"] == ["80", "100"]
    assert samples["NetPrice"] == ["80", "64", "72"]
    # Capped, so a wide file cannot turn the mapping screen into a data dump.
    assert all(len(v) <= 3 for v in samples.values())


# --- misspelled column names ----------------------------------------------


def test_a_misspelled_name_is_matched_to_what_it_meant():
    assert cm.close_match("UnitsSld") == ("Actual_Quantity", pytest.approx(0.941, abs=0.01))
    assert cm.close_match("NetPrce")[0] == "Actual_Price"
    assert cm.close_match("BasePrce")[0] == "Base_Price"
    assert cm.close_match("Retailr")[0] == "Retailer"
    assert cm.close_match("Produkt_Name")[0] == "Product_Name"


def test_closeness_refuses_what_it_cannot_be_sure_of():
    """The typo pass must not undo the module's one safety property. A name
    that is ambiguous, or merely short, is left for the user."""
    for refused in (
        "Price", "Cost", "Amount", "Value", "Qty", "Total",   # ambiguous
        "Prce", "Blob", "Thing",                               # too short/unlike
        "SellPrice",                                           # base or actual?
    ):
        assert cm.close_match(refused) is None, refused

    # An exact alias is not a typo — that is the alias pass's job, and it
    # records a different, stronger source.
    assert cm.close_match("NetPrice") is None


def test_a_typo_is_proposed_but_marked_as_a_guess():
    """It still has to be visibly weaker than a name we actually know, or the
    user has no idea which rows deserve a second look."""
    proposal = star_dataset.propose_for(
        "fact",
        ["TxnDate", "SKU", "Outlet", "PromoCode", "UnitsSld", "MRP", "NetPrce",
         "UnitCost", "PromoSpend"],
    )
    assert proposal.unmapped == ()
    assert proposal.mapping["Actual_Quantity"] == "UnitsSld"
    assert proposal.sources["Actual_Quantity"] == "typo"
    assert proposal.sources["Actual_Price"] == "typo"
    # A name we genuinely know is not downgraded to a guess.
    assert proposal.sources["Base_Price"] == "alias"


def test_a_typo_does_not_change_what_a_file_is():
    """THE BUG THIS PINS. The fact table is told apart by Actual_Quantity and
    Promotion_Cost. With the quantity spelled `UnitsSld` neither was reachable
    by alias, so the file fell through to the next discriminator that did
    match — Promotion_Id and Promotion_Name — and four months of sales were
    identified as the promotion dimension."""
    header = ["TxnDate", "SKU", "Outlet", "PromoCode", "PromoDesc", "OfferType",
              "UnitsSld", "MRP", "NetPrce", "UnitCost", "PromoSpend"]
    found = star_dataset.identify(header)
    assert found is not None
    assert found.role == "fact"


# --- end to end ------------------------------------------------------------


def test_a_fully_renamed_dataset_installs_and_matches_the_canonical_one(
    client_named_dataset, tmp_path, monkeypatch
):
    """THE POINT OF THE FEATURE. The same data under a client's names must
    install, and every measure must come out identical to the canonical
    upload — mapping is a rename, not a transformation."""
    data = tmp_path / "Data"
    data.mkdir()
    monkeypatch.setenv("TPO_DATA_DIR", str(data))
    monkeypatch.setattr(source_sync, "CONN_PATH", tmp_path / "source-connection.json")
    app.dependency_overrides[current_user] = lambda: {
        "email_key": "qa", "email": "qa@example.test"
    }
    try:
        star_dataset.reset_caches()
        client = TestClient(app)
        files = [
            ("files", (name, (client_named_dataset / name).read_bytes(), "text/csv"))
            for name in CLIENT_NAMES
        ]
        response = client.post("/api/datasets", files=files)
        assert response.status_code == 200, response.text
        assert len(response.json()["star"]["installed"]) == len(CLIENT_NAMES)

        # What landed on disk is canonical: nothing downstream can tell.
        with (data / config.FACT_FILE).open(encoding="utf-8-sig", newline="") as fh:
            installed_header = next(csv.reader(fh))
        for canonical in star_dataset.ROLE_COLUMNS["fact"]:
            assert canonical in installed_header
        assert not any(client_name in installed_header
                       for client_name in CLIENT_NAMES[config.FACT_FILE].values())
        # Extra columns are carried through untouched, as they always were.
        assert all(junk in installed_header for junk in JUNK_COLUMNS)

        # And the numbers are the reference numbers, measure for measure.
        mapped = loader._build_store(data)
        reference = loader._build_store(REPO_DATA)
        assert mapped.row_count == reference.row_count
        assert mapped.years() == reference.years()
        for measure in ("actual_quantity", "base_quantity", "actual_revenue",
                        "base_revenue", "total_cost", "promotion_cost"):
            assert sum(getattr(mapped, measure)) == pytest.approx(
                sum(getattr(reference, measure))
            ), measure
        assert set(mapped.dims.channels) == set(reference.dims.channels)
        assert set(mapped.dims.products) == set(reference.dims.products)
    finally:
        app.dependency_overrides.pop(current_user, None)
        # No delenv: monkeypatch.setenv already restores the session-level
        # TPO_DATA_DIR (tests/conftest.py).
        star_dataset.reset_caches()


def test_inspect_reports_the_proposal_for_the_mapping_screen(client_named_dataset):
    """The screen is server-driven, so inspect must hand it everything it
    renders: the role, the proposed column per field, what is still unmapped,
    every column to choose from, and a sample value to check a guess against."""
    uploads = [
        (name, (client_named_dataset / name).read_bytes())
        for name in (config.FACT_FILE, config.DIM_FILES["product"])
    ]
    result = star_dataset.inspect(uploads)
    fact = next(f for f in result["files"] if f["filename"] == config.FACT_FILE)
    assert fact["role"] == "fact"
    assert fact["matched_by"] == "recognised column names"
    assert fact["mapping"]["Actual_Quantity"] == "UnitsSold"
    assert fact["missing_columns"] == []
    assert "RegionMgr" in fact["columns"]
    assert fact["samples"]["UnitsSold"]


def test_inspect_accepts_a_declared_role_and_says_what_is_still_needed():
    """What the mapping screen asks on its second call: the user has said which
    table an unrecognisable file is, and needs to know which fields remain."""
    uploads = [("mystery.csv", b"Thing,Widget,Blob\n1,2,3\n")]
    blind = star_dataset.inspect(uploads)
    assert blind["files"][0]["role"] is None
    assert blind["files"][0]["columns"] == ["Thing", "Widget", "Blob"]

    declared = star_dataset.inspect(
        uploads, {"mystery.csv": {"role": "product", "columns": {"Product_id": "Thing"}}}
    )
    file = declared["files"][0]
    assert file["role"] == "product"
    assert file["mapping"]["Product_id"] == "Thing"
    assert set(file["missing_columns"]) == {"Product_Name", "Brand", "Category", "Size"}
