"""
Making a client's column names into ours — the mapping half of the connector.

WHY THIS EXISTS. `star_dataset` identifies an uploaded file by its column
headers, which works only while those headers are already canonical. A real
client extract calls the quantity `UnitsSold`, the date `TxnDate` and the unit
cost `UnitCost`, so every one of its files matched no table at all and the whole
upload was refused as "not one of the standard tables" — a message about the
wrong problem, since the file holds exactly the right data under different
names.

TWO STEPS, DELIBERATELY SEPARATE. `propose` suggests which actual column stands
for each canonical one; `apply_to_header` rewrites a header once a mapping is
settled. Nothing here decides anything on its own: a proposal is shown to the
user, who confirms or corrects it, and only the confirmed mapping is applied.
That split is the whole safety property of this module — see AMBIGUITY below.

NORMALISATION DOES MOST OF THE WORK. Comparison strips case and every
non-alphanumeric character, so one alias covers a family of spellings:
`units_sold`, `Units Sold`, `UNITS-SOLD` and `UnitsSold` all normalise to
`unitssold`. The alias lists below therefore name a concept once rather than
enumerating punctuation.

THREE PASSES, WEAKEST LAST. A field is matched by our own name (`exact`), then
by a synonym (`alias`), then — only if nothing else claimed it — by closeness,
which catches a misspelling like `UnitsSld` or `NetPrce` (`typo`). Each match
records WHICH pass found it, so the upload screen can show a typo guess as
something to confirm rather than as a settled fact.

AMBIGUITY IS LEFT TO THE USER, ON PURPOSE. A column called `Price` could be
`Base_Price` or `Actual_Price`, and `Cost` could be any of three. Guessing
either would be catastrophically quiet: swap base and actual price and every
discount inverts, turning promotions into price rises across every KPI with no
error anywhere. So genuinely ambiguous names are NOT aliased — they come back
unmapped, and the upload screen asks. An alias earns its place only when it can
mean one canonical column and nothing else, and the typo pass refuses the same
names for the same reason (`_NEVER_GUESS`) rather than quietly undoing it.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

#: canonical column -> names that can only mean that column.
#:
#: Conservative by construction. Anything that could plausibly mean two
#: canonical columns is absent, so the user is asked instead of guessed at:
#: no bare `price` (base or actual?), no bare `cost` (line cost, unit cost or
#: promotion spend?), no bare `id`, `name` or `type`.
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    # ---- fact: keys
    "Date": ("txndate", "transactiondate", "saledate", "salesdate",
             "invoicedate", "billdate", "calendarday", "businessdate",
             "orderdate"),
    "Product_id": ("sku", "skucode", "skuid", "productcode", "productkey",
                   "itemcode", "itemid", "itemnumber", "materialcode",
                   "materialnumber", "ean", "upc", "articlecode", "articleid"),
    "Store_Id": ("outlet", "outletcode", "outletid", "storecode", "storekey",
                 "storenumber", "shopcode", "shopid", "siteid", "sitecode",
                 "locationcode", "locationid", "branchcode", "customercode",
                 "shipto"),
    "Promotion_Id": ("promocode", "promoid", "promotioncode", "promokey",
                     "offercode", "offerid", "dealid", "dealcode",
                     "campaignid", "campaigncode", "mechanicid"),
    # ---- fact: measures
    "Actual_Quantity": ("unitssold", "units", "qty", "quantity", "quantitysold",
                        "salesunits", "salesqty", "soldqty", "volume",
                        "actualunits", "actualqty", "pieces", "eaches"),
    "Base_Quantity": ("baseunits", "baselinequantity", "baselineunits",
                      "baselinevolume", "expectedunits", "expectedquantity",
                      "nonpromoquantity", "nonpromounits", "baseqty"),
    "Base_Price": ("mrp", "listprice", "regularprice", "rrp", "shelfprice",
                   "normalprice", "grossprice", "ticketprice",
                   "undiscountedprice", "msrp"),
    "Actual_Price": ("netprice", "sellingprice", "promoprice", "promotedprice",
                     "actualsellingprice", "realisedprice", "realizedprice",
                     "paidprice", "finalprice", "discountedprice",
                     "transactionprice"),
    # Cost of goods: per unit (CP) or for the whole line (Total_Cost). Both are
    # aliased because the loader accepts either, but only names that say WHICH.
    "CP": ("unitcost", "costperunit", "cogsperunit", "cpu", "standardcost",
           "costprice", "purchaseprice", "landedcostperunit", "unitcogs"),
    "Total_Cost": ("totalcogs", "linecost", "costofgoodssold", "cogs",
                   "extendedcost", "totalcostofgoods", "linecogs"),
    "Promotion_Cost": ("promospend", "promotionspend", "promospendamount",
                       "tradespend", "promoinvestment", "offercost",
                       "promotioninvestment", "dealspend", "discountspend",
                       "tradeinvestment"),
    # ---- promotion descriptors (ride on the fact row in the 3-file shape)
    "Promotion_Name": ("promodesc", "promodescription", "promoname",
                       "promotiondesc", "offername", "offerdesc", "dealname",
                       "campaignname", "mechanicname", "promolabel"),
    "Promotion_Type": ("offertype", "promotype", "promomechanic", "mechanic",
                       "mechanism", "dealtype", "promotionmechanic",
                       "offermechanic", "promocategory", "discounttype"),
    "Promotion_Description": ("promotionlongdesc", "offerdetails",
                              "promodetails", "promotionnotes", "offernotes"),
    # ---- product
    "Product_Name": ("description", "productdesc", "productdescription",
                     "itemname", "itemdesc", "itemdescription", "materialdesc",
                     "materialdescription", "articlename", "articledesc",
                     "skuname", "skudescription", "longdescription"),
    "Brand": ("brandname", "branddesc", "brandlabel", "manufacturerbrand"),
    "Category": ("categoryname", "productcategory", "majorcategory",
                 "department", "producthierarchy", "merchandisecategory",
                 "productgroup", "segment"),
    "Size": ("packsize", "pack", "packagesize", "unitsize", "grammage",
             "volumesize", "netweight", "netcontent", "fillsize"),
    # ---- store / geography
    "Retailer": ("retailername", "accountname", "customername", "banner",
                 "bannername", "chain", "chainname", "keyaccount", "account"),
    "Region": ("zone", "zonename", "regionname", "area", "areaname",
               "territory", "territoryname", "salesregion", "geography"),
    "State": ("statename", "province", "provincename", "statecode",
              "stateprovince"),
    "City": ("cityname", "town", "townname", "citytown", "municipality"),
    "Tier": ("storegrade", "grade", "storetier", "classification", "storeclass",
             "citytier", "tiername"),
    "Country": ("countryname", "countrycode", "nation"),
    "Distributor_Name": ("distributor", "distributorname", "wholesaler",
                         "wholesalername", "supplier", "suppliername"),
    "Channel_Id": ("channelcode", "channelkey", "tradechannel",
                   "tradechannelcode", "channelnumber"),
    "Channel_Name": ("channeldesc", "channeldescription",
                     "tradechannelname", "channellabel"),
    "Channel_Type": ("channelformat", "format", "formatname",
                     "outlettype", "storetype", "channelsegment",
                     "storeformat"),
    "Schedule": ("deliveryschedule", "visitschedule", "servicefrequency",
                 "callfrequency"),
    # ---- calendar
    "Year": ("yr", "calendaryear", "fiscalyear", "yearnumber"),
    "Month": ("mth", "monthnumber", "calendarmonth", "monthno"),
    "Week": ("wk", "weeknumber", "calendarweek", "weekno", "weekofyear",
             "fiscalweek"),
    "Quarter": ("qtr", "calendarquarter", "fiscalquarter", "quarternumber"),
    "Day": ("dayofmonth", "daynumber", "dayno"),
}


def normalise(name: str) -> str:
    """A column name reduced to what two spellings of it have in common.

    Case and every non-alphanumeric character go, so `Units Sold`,
    `units_sold`, `UNITS-SOLD` and `UnitsSold` all come out as `unitssold`.
    A trailing plural `s` is NOT stripped: `Unit` and `Units` are different
    enough in this domain to be worth asking about.
    """
    return re.sub(r"[^a-z0-9]+", "", name.strip().lower())


#: normalised alias -> canonical column, built once. Inverted so a header is
#: resolved by lookup per column rather than by scanning every alias list.
_ALIAS_INDEX: dict[str, str] = {}
for _canonical, _aliases in COLUMN_ALIASES.items():
    _ALIAS_INDEX.setdefault(normalise(_canonical), _canonical)
    for _alias in _aliases:
        # An alias two canonical columns both claim would be ambiguous, which
        # this module refuses to be: the first wins, and the clash is a bug in
        # the table above that test_column_mapping catches.
        _ALIAS_INDEX.setdefault(normalise(_alias), _canonical)


#: How alike two names must be before a misspelling is suggested, and how far
#: ahead of the runner-up the winner has to be.
#:
#: 0.86 accepts `UnitsSld` for `UnitsSold` (0.94) and `NetPrce` for `NetPrice`
#: (0.93) while rejecting `SellPrice` for `SellingPrice` (0.78) — which is the
#: right call, because "sell price" could as easily be the base price, and a
#: name that could mean two columns is exactly what this module refuses to
#: guess at. The margin is the second guard: a column that is nearly as close
#: to a second canonical column is ambiguous, however high its best score, and
#: is left for the user instead.
_CLOSE_RATIO = 0.86
_CLOSE_MARGIN = 0.06

#: Shortest name a misspelling is looked for in. Below this, edit distance
#: stops meaning anything: three-letter columns are close to everything.
_CLOSE_MIN_LENGTH = 5

#: Names never resolved by closeness, however high they score. These are the
#: genuinely ambiguous ones -- `Price` is as near `Base_Price` as it is to
#: `Actual_Price` -- and the whole point of leaving them unmapped is that the
#: user is asked. A typo pass that quietly undid that would be worse than no
#: typo pass at all.
_NEVER_GUESS: frozenset[str] = frozenset({
    "price", "prices", "cost", "costs", "amount", "amounts", "value", "values",
    "id", "ids", "key", "keys", "name", "names", "type", "types", "code",
    "codes", "qty", "total", "totals", "date", "number", "desc", "sales",
})

#: canonical column -> every normalised spelling that means it, for the
#: closeness pass. Built once from the table above.
_CLOSE_CANDIDATES: dict[str, tuple[str, ...]] = {
    canonical: tuple(
        {normalise(canonical), *(normalise(alias) for alias in aliases)}
    )
    for canonical, aliases in COLUMN_ALIASES.items()
}


def close_match(column: str) -> tuple[str, float] | None:
    """The canonical column a misspelled name almost certainly means.

    Returns (canonical, score) or None. Scored against every known spelling of
    every canonical column, so `UnitsSld` is compared with `unitssold` rather
    than only with `actualquantity` — a typo is a typo of whatever the client
    actually wrote, not of our name for it.

    None is returned whenever the answer is not obvious: too short, in
    `_NEVER_GUESS`, below `_CLOSE_RATIO`, or within `_CLOSE_MARGIN` of a second
    canonical column. A caller that gets None must ask the user.
    """
    norm = normalise(column)
    if len(norm) < _CLOSE_MIN_LENGTH or norm in _NEVER_GUESS:
        return None
    # An exact alias is not a typo; that is the alias pass's job.
    if norm in _ALIAS_INDEX:
        return None

    scored: list[tuple[float, str]] = []
    for canonical, spellings in _CLOSE_CANDIDATES.items():
        best = max(
            difflib.SequenceMatcher(None, norm, spelling).ratio() for spelling in spellings
        )
        scored.append((best, canonical))
    scored.sort(reverse=True)

    top, canonical = scored[0]
    if top < _CLOSE_RATIO:
        return None
    if len(scored) > 1 and top - scored[1][0] < _CLOSE_MARGIN:
        return None
    return canonical, round(top, 3)


@dataclass(frozen=True)
class Proposal:
    """What this module suggests for ONE file, for a user to confirm."""

    #: canonical column -> the file's own column standing for it.
    mapping: dict[str, str] = field(default_factory=dict)
    #: canonical column -> "exact" (already our name) or "alias" (a synonym).
    #: Carried so the upload screen can show a weak guess differently from a
    #: name that needed no guessing at all.
    sources: dict[str, str] = field(default_factory=dict)
    #: Canonical columns this role needs that nothing in the file matched.
    #: These are what the user is asked about.
    unmapped: tuple[str, ...] = ()
    #: The file's columns no canonical column claimed. Harmless — extra columns
    #: have always been ignored — and listed only so the mapping screen has
    #: something to offer in its dropdowns.
    spare: tuple[str, ...] = ()

    @property
    def is_complete(self) -> bool:
        return not self.unmapped

    @property
    def renames(self) -> dict[str, str]:
        """actual -> canonical, for the columns that actually change name."""
        return {
            actual: canonical
            for canonical, actual in self.mapping.items()
            if normalise(actual) != normalise(canonical)
        }


def propose(
    header: list[str],
    wanted: tuple[str, ...],
    either: tuple[tuple[str, ...], ...] = (),
    optional: tuple[str, ...] = (),
) -> Proposal:
    """Suggest a column for each canonical name a role needs.

    `wanted` is the role's required columns, `either` its interchangeable
    groups (satisfied by any one member) and `optional` the columns the loader
    reads when present. Optional columns are proposed but never reported as
    unmapped — a file without them is perfectly usable.

    Each of the file's columns is claimed at most once. Ties are broken by the
    order of `wanted`, which is the order the loader reads them in.
    """
    by_norm: dict[str, str] = {}
    for column in header:
        if column and column.strip():
            by_norm.setdefault(normalise(column), column.strip())

    mapping: dict[str, str] = {}
    sources: dict[str, str] = {}
    claimed: set[str] = set()

    either_members = tuple(m for group in either for m in group)
    for canonical in (*wanted, *either_members, *optional):
        if canonical in mapping:
            continue
        norm = normalise(canonical)
        # Our own name, however it was spelled or cased.
        if norm in by_norm and by_norm[norm] not in claimed:
            mapping[canonical] = by_norm[norm]
            sources[canonical] = "exact"
            claimed.add(by_norm[norm])
            continue
        # A synonym that can only mean this column.
        for actual_norm, actual in by_norm.items():
            if actual in claimed:
                continue
            if _ALIAS_INDEX.get(actual_norm) == canonical:
                mapping[canonical] = actual
                sources[canonical] = "alias"
                claimed.add(actual)
                break

    # THIRD PASS: misspellings, and only for fields nothing else claimed.
    #
    # Column-centric rather than field-centric on purpose. `close_match` can
    # only apply its "clearly closer to one column than any other" rule by
    # scoring one name against every canonical at once, which means asking
    # "what is this column?" rather than "what might this field be called?".
    # A typo guess is also marked as one, so the upload screen can show it as
    # something to confirm rather than as a settled fact.
    needed = {*wanted, *either_members, *optional}
    for actual_norm, actual in by_norm.items():
        if actual in claimed:
            continue
        found = close_match(actual)
        if found is None:
            continue
        canonical, _score = found
        if canonical not in needed or canonical in mapping:
            continue
        mapping[canonical] = actual
        sources[canonical] = "typo"
        claimed.add(actual)

    unmapped = [c for c in wanted if c not in mapping]
    # An interchangeable group is unmet only when NONE of its members mapped,
    # and is then named as the choice it is rather than as one arbitrary member.
    for group in either:
        if not any(m in mapping for m in group):
            unmapped.append(" or ".join(group))

    return Proposal(
        mapping=mapping,
        sources=sources,
        unmapped=tuple(unmapped),
        spare=tuple(c.strip() for c in header if c and c.strip() and c.strip() not in claimed),
    )


def canonical_names(header: list[str]) -> set[str]:
    """Every canonical column this header could supply, under any name.

    Used to decide WHICH TABLE a file is when its own names are not ours:
    `star_dataset` tests its role discriminators against this set instead of
    the raw header, so a file whose quantity is called `UnitsSold` is still
    recognisable as the sales fact.

    MISSPELLINGS COUNT HERE TOO, and leaving them out was a real bug. The
    fact table is told apart by `Actual_Quantity` and `Promotion_Cost`; a
    client file spelling the first `UnitsSld` reached neither, so the file
    fell through to the next discriminator that DID match on alias alone —
    `Promotion_Id` and `Promotion_Name` — and four months of sales were
    identified as the promotion dimension. A typo must not change what a file
    IS, only how confidently its columns are matched.
    """
    out: set[str] = set()
    for column in header:
        if not column or not column.strip():
            continue
        canonical = _ALIAS_INDEX.get(normalise(column))
        if canonical:
            out.add(canonical)
            continue
        found = close_match(column)
        if found:
            out.add(found[0])
    return out


def apply_to_header(header: list[str], renames: dict[str, str]) -> tuple[list[str], list[str]]:
    """Rename a header row, and say which columns had to be dropped.

    `renames` is actual -> canonical, as a confirmed mapping gives it.

    A rename can collide: a file carrying both `MRP` and a junk `Base_Price`
    column, with MRP mapped to `Base_Price`, would end up with the name twice
    and `csv.DictReader` would silently keep whichever came last. The mapped
    column wins — it is the one a human chose — and the colliding original is
    dropped and returned, so the upload screen can say so rather than leaving
    the user to find out from a wrong number.
    """
    wanted = {normalise(src): dst for src, dst in renames.items()}
    targets = {normalise(dst) for dst in renames.values()}

    out: list[str] = []
    dropped: list[str] = []
    for column in header:
        norm = normalise(column)
        if norm in wanted:
            out.append(wanted[norm])
        elif norm in targets:
            # Already carries the canonical name, but something else was mapped
            # onto it. Two columns cannot share a name.
            dropped.append(column)
        else:
            out.append(column)
    return out, dropped
