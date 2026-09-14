"""ONE-OFF MIGRATION: restate every STORED Promotion ROI as a multiple.

On 2026-09-14 the Promotion ROI definition changed from

    ROI % = (Incremental Sales - Trade Spend) / Trade Spend x 100        (40.0%)
to
    ROI   =  Incremental Sales / Trade Spend                             (1.4)

The engine (app/tpo/aggregate.roi_multiple) now produces the multiple, so
every LIVE figure is already right. What this script converts is what was
computed and saved under the old definition:

  * backend/app/data/investigation-runs.json -- recorded agent runs, whose
    facts, tool tables and narrative prose quote ROI percentages;
  * backend/.store/tiq.db -- saved scenario results (scenario_results),
    decision records (decision_versions) and the JSON halves of saved reports
    (reports.options_json / preview_json).

THE ARITHMETIC IS EXACT: x = pct / 100 + 1, so a delta or a distance from
target in percentage points becomes pp / 100 in multiples. Growth rates of
ROI are re-derived from the pair they came from, since the growth of a
multiple is not the growth of a net percentage.

STRUCTURED FIELDS are renamed and converted by key. PROSE is converted by
VALUE: for each record, every ROI percentage its structured fields carry is
collected, and only those exact figures are rewritten where they appear with
a percent sign in the record's text ("returned 38.7% ROI" -> "returned 1.4
ROI"). A figure that is also some other percentage in the same record (a
spend share, a margin) is left alone and reported, because guessing which
one the sentence meant would be fabricating a number. The residual list at
the end is the set of sentences a reader should still treat as old-unit.

The rendered xlsx/pdf blobs of saved reports are NOT rewritten: they are
finished documents in the unit that was current when they were generated,
and re-rendering them from converted JSON would silently manufacture a
document nobody generated. Regenerate a report to get one in the new unit.

Usage:  venv/Scripts/python.exe scripts/migrate_roi_to_multiple.py [--dry-run]
        [--cutoff 2026-09-14T14:00]   (store rows created at/after it are
                                       assumed already in the new unit)

Idempotent by construction: a record that already carries `roi_multiple`, or
no old-unit key at all, is skipped and left byte-for-byte unchanged.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
RUNS_PATH = REPO / "backend" / "app" / "data" / "investigation-runs.json"
DB_PATH = REPO / "backend" / ".store" / "tiq.db"

NEW_FORMULA = "Incremental Sales ÷ Trade Spend"
OLD_FORMULAS = (
    "(Incremental Sales − Trade Spend) ÷ Trade Spend × 100",
    "(Incremental Sales - Trade Spend) / Trade Spend x 100",
)
NEW_PEI_FORMULA = "0.40 × (ROI − 1.00) + 0.30 × Incremental Qty % + 0.30 × Margin Impact"
OLD_PEI_FORMULA = "0.40 × ROI + 0.30 × Incremental Qty % + 0.30 × Margin Impact"


def x(pct: float | None) -> float | None:
    """40.0 (percent) -> 1.40 (a two-decimal multiple, exact from a 1 dp percent)."""
    return None if pct is None else round(pct / 100 + 1, 2)


def dx(pp: float | None) -> float | None:
    """+12.3 (percentage points) -> +0.12 (a difference in multiples)."""
    return None if pp is None else round(pp / 100, 2)


def fmt(v: float | None, signed: bool = False) -> str:
    if v is None:
        return "—"
    return f"{'+' if signed and v > 0 else ''}{v:,.2f}"


# --- structured conversion ---------------------------------------------------

#: key -> (new key, converter). Order matters only for readability.
RENAMES: dict[str, tuple[str, Any]] = {
    "roi_pct": ("roi_multiple", x),
    "target_roi_pct": ("target_roi", x),
    "weighted_roi_pct": ("weighted_roi", x),
    "vs_target_pp": ("vs_target", dx),
    "contribution_pp": ("contribution", dx),
    "gap_pp": ("gap", dx),
}
#: keys whose VALUE is an ROI percentage but whose name stays.
VALUE_ONLY = {"promotion_roi", "roi_low", "roi_high", "overall_roi"}
#: `*_display` twins of the above.
DISPLAY_ONLY = {"roi_low_display", "roi_high_display"}

_NUM = r"-?\d+(?:\.\d+)?"


class Record:
    """One top-level stored object: collects the ROI figures it carries so its
    prose can be converted by value, and counts what it changed."""

    def __init__(self, label: str):
        self.label = label
        self.roi_values: set[str] = set()      # "38.7", "-3.6"
        self.other_values: set[str] = set()    # every other numeric figure
        self.changed = 0
        self.residual: list[str] = []

    @property
    def roi_gaps(self) -> set[str]:
        """Every pairwise distance between the ROI figures, at 1 dp."""
        vals = sorted({float(v) for v in self.roi_values})
        return {f"{abs(a - b):.2f}" for a in vals for b in vals if a != b}

    def note_roi(self, v: Any) -> None:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            self.roi_values.add(f"{v:.1f}")
            self.roi_values.add(f"{v:g}")

    def note_other(self, v: Any) -> None:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            self.other_values.add(f"{v:.1f}")
            self.other_values.add(f"{v:g}")


#: Containers whose numbers an AGENT copied out of the tables -- chart bars,
#: comparison bases, the figure-provenance lists. They are neither ROI nor
#: not-ROI by key; they are whatever they were copied from, so they are
#: classified by VALUE against the tables (see `convert_copied`) and kept out
#: of the "other" set that would otherwise veto every ROI figure in prose.
COPIED = {"viz_items", "viz", "delta_basis", "delta_computed", "unverified_figures",
          "unverified_viz_items", "contextChips"}


def collect(o: Any, rec: Record, parent_key: str | None = None, in_roi: bool = False) -> None:
    """First pass: which numbers are ROI percentages, which are anything else.

    `in_roi` is carried down from a cell that names the ROI metric, so the
    nested `scenarios[].low.value` / `baseline.value` of a comparison row are
    read as ROI figures and not as anonymous "value"s.
    """
    if isinstance(o, dict):
        # A cell names its metric, or sits under it (`evidence.roi_percent.low`).
        is_roi_cell = in_roi or (
            o.get("key") == "roi_percent" or o.get("metric") == "roi_percent"
            or parent_key == "roi_percent"
        )
        for k, v in o.items():
            if k in COPIED:
                continue
            if isinstance(v, (dict, list)):
                collect(v, rec, k, is_roi_cell)
                continue
            if k in RENAMES and k not in ("vs_target_pp", "contribution_pp", "gap_pp"):
                rec.note_roi(v)
            elif k in VALUE_ONLY:
                rec.note_roi(v)
            elif k == "roi" and parent_key != "levers":
                rec.note_roi(v)
            elif is_roi_cell and k in ("value", "low", "high", "baseline"):
                rec.note_roi(v)
            elif is_roi_cell and k in ("absolute", "percent_change"):
                pass  # a delta between two ROIs, never quoted as one
            elif k in ("vs_target_pp", "contribution_pp", "gap_pp") or k.endswith("_delta_pct"):
                pass  # movements, not levels; never quoted as an ROI figure
            else:
                rec.note_other(v)
    elif isinstance(o, list):
        for item in o:
            if isinstance(item, (dict, list)):
                collect(item, rec, parent_key, in_roi)
            elif parent_key == "roi":
                rec.note_roi(item)
            else:
                rec.note_other(item)


def convert_roi_cell(cell: dict[str, Any], rec: Record) -> None:
    """A KPI cell {key: roi_percent, value, display_value, unit, formula}."""
    if cell.get("key") == "roi_percent":
        cell["key"] = "roi_multiple"
    if cell.get("metric") == "roi_percent":
        cell["metric"] = "roi_multiple"
    if cell.get("unit") == "percent":
        cell["unit"] = "multiple"
    for k in ("value", "low", "high"):
        if isinstance(cell.get(k), (int, float)):
            cell[k] = x(cell[k])
    for k in ("display_value", "display_low", "display_high"):
        if isinstance(cell.get(k), str) and cell[k].endswith("%"):
            base = k.replace("display_", "") if k != "display_value" else "value"
            cell[k] = fmt(cell.get(base))
    if cell.get("formula") in OLD_FORMULAS:
        cell["formula"] = NEW_FORMULA
    if cell.get("delta_type") == "percentage_point":
        cell["delta_type"] = "absolute"
        cell["delta_rationale"] = (
            "A multiple of trade spend. Two ROIs differ by a multiple (+0.3); a "
            "percent change of a rate reads as though the return itself had changed "
            "by that much."
        )
    # comparison: baseline + scenarios[].low/high/delta_low/delta_high
    base = cell.get("baseline")
    if isinstance(base, dict) and isinstance(base.get("value"), (int, float)):
        base["value"] = x(base["value"])
        base["display_value"] = fmt(base["value"])
    for sc in cell.get("scenarios") or []:
        for end in ("low", "high"):
            e = sc.get(end)
            if isinstance(e, dict) and isinstance(e.get("value"), (int, float)):
                e["value"] = x(e["value"])
                e["display_value"] = fmt(e["value"])
            d = sc.get(f"delta_{end}")
            if isinstance(d, dict) and isinstance(d.get("absolute"), (int, float)):
                d["absolute"] = dx(d["absolute"])
                d["display"] = fmt(d["absolute"], signed=True)
    rec.changed += 1


def _is_roi_figure(v: Any, rec: Record) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and f"{v:.1f}" in rec.roi_values


def convert_copied(o: Any, rec: Record) -> None:
    """Agent-copied figures: an ROI only if the tables say that number is one."""
    if isinstance(o, list):
        for item in o:
            convert_copied(item, rec)
        return
    if not isinstance(o, dict):
        return
    if "items" in o and isinstance(o["items"], list):          # viz: {type, unit, items}
        convert_copied(o["items"], rec)
        if o.get("unit") == "%" and all(_is_roi_figure(i.get("value"), rec) for i in o["items"] if isinstance(i, dict)):
            o["unit"] = ""  # a bare multiple carries no unit sign
        return
    if "kind" in o and "compared_to" in o:                     # delta_basis
        if _is_roi_figure(o.get("value"), rec) and _is_roi_figure(o.get("compared_to"), rec):
            o["value"], o["compared_to"] = x(o["value"]), x(o["compared_to"])
            if o.get("kind") == "percentage_point_gap":
                o["kind"] = "multiple_gap"  # the kind app/agents/figures.py prints without a unit sign
            rec.changed += 1
        return
    if "delta" in o and isinstance(o["delta"], str):            # delta_computed: "-42.3 pp"
        m = re.fullmatch(rf"({_NUM}) pp", o["delta"])
        if m:
            o["delta"] = fmt(dx(float(m.group(1))), signed=True)
            rec.changed += 1
        return
    if "label" in o and _is_roi_figure(o.get("value"), rec):    # one bar
        o["value"] = x(o["value"])
        rec.changed += 1


def convert(o: Any, rec: Record, parent_key: str | None = None) -> Any:
    """Second pass: rename and rescale the structured fields in place."""
    if isinstance(o, dict):
        if o.get("key") == "roi_percent" or o.get("metric") == "roi_percent":
            convert_roi_cell(o, rec)
        # kpis dicts keyed by metric name
        if "roi_percent" in o and isinstance(o["roi_percent"], dict):
            cell = o.pop("roi_percent")
            convert_roi_cell(cell, rec)
            o["roi_multiple"] = cell
        elif "roi_percent" in o and isinstance(o["roi_percent"], (int, float, type(None))):
            o["roi_multiple"] = x(o.pop("roi_percent"))
            rec.changed += 1
        for k in list(o.keys()):
            v = o[k]
            if k in ("viz_items", "delta_basis", "delta_computed") or (k == "viz" and isinstance(v, dict)):
                convert_copied(v, rec)
            elif k in RENAMES:
                new_key, conv = RENAMES[k]
                o[new_key] = conv(v) if isinstance(v, (int, float)) or v is None else v
                del o[k]
                rec.changed += 1
            elif k in VALUE_ONLY and isinstance(v, (int, float)):
                o[k] = x(v)
                rec.changed += 1
            elif k in DISPLAY_ONLY and isinstance(v, str) and v.endswith("%"):
                o[k] = fmt(o.get(k.replace("_display", "")))
                rec.changed += 1
            elif k == "roi" and parent_key != "levers":
                if isinstance(v, (int, float)):
                    o[k] = x(v)
                    rec.changed += 1
                elif isinstance(v, list):
                    o[k] = [x(i) if isinstance(i, (int, float)) else i for i in v]
                    rec.changed += 1
                elif isinstance(v, str) and v.endswith("%"):
                    try:
                        o[k] = fmt(x(float(v[:-1])))
                        rec.changed += 1
                    except ValueError:
                        pass
            elif k == "promotion_roi_delta_pct" and isinstance(v, (int, float)):
                # growth of a net percentage -> growth of the multiple, from the
                # same pair: prev = cur / (1 + g/100), both restated as multiples.
                cur = o.get("promotion_roi")
                if isinstance(cur, (int, float)) and v != -100:
                    prev_pct = cur / (1 + v / 100)
                    cur_x, prev_x = cur / 100 + 1, prev_pct / 100 + 1
                    o[k] = round((cur_x - prev_x) / abs(prev_x) * 100, 1) if prev_x else None
                    rec.changed += 1
            elif k == "must_be" and v == "strictly_positive":
                o[k] = "above_breakeven"
                rec.changed += 1
            elif k == "formula" and v == OLD_PEI_FORMULA:
                o[k] = NEW_PEI_FORMULA
                rec.changed += 1
            elif k in ("required_metrics", "hierarchy", "evidence_metrics") and isinstance(v, list):
                o[k] = [("roi_multiple" if i == "roi_percent" else i) for i in v]
            elif isinstance(v, (dict, list)):
                convert(v, rec, k)
        # `promotion_roi` was rescaled above; the cell-level ROI in
        # decision "expected_impact" rows is handled by convert_roi_cell.
        return o
    if isinstance(o, list):
        for i, item in enumerate(o):
            if isinstance(item, (dict, list)):
                convert(item, rec, parent_key)
            elif item == "roi_percent":
                o[i] = "roi_multiple"
        return o
    return o


# --- prose conversion --------------------------------------------------------


def convert_text(s: str, rec: Record) -> str:
    """Rewrite the ROI figures this record is known to carry, and the fixed
    phrases the engine and the prompts used to emit."""
    if "%" not in s and "ROI" not in s and "roi" not in s:
        return s
    before = s

    # Fixed engine/prompt phrases first -- these are unambiguous.
    s = s.replace("against a 50% target", "against a 1.50 target")
    s = s.replace("the 50% target", "the 1.50 target")
    s = s.replace("a 50% target", "a 1.50 target")
    s = s.replace("50% target", "1.50 target")
    s = s.replace("target of 50%", "target of 1.50")
    s = s.replace("50% ROI target", "1.50 ROI target")
    s = s.replace("target ROI of 50%", "target ROI of 1.50")
    s = s.replace("negative ROI", "below-break-even ROI")
    s = s.replace("ROI stays positive", "ROI stays above break-even")
    s = s.replace("ROI must stay positive", "ROI must stay above 1.00")
    s = s.replace("requires a positive ROI", "requires an ROI above 1.00")
    for old in OLD_FORMULAS:
        s = s.replace(old, NEW_FORMULA)
    s = s.replace("roi_pct is a PERCENTAGE", "roi_multiple is a MULTIPLE")
    s = s.replace("weighted_roi_pct", "weighted_roi").replace("contribution_pp", "contribution")
    s = s.replace("gap_pp", "gap").replace("target_roi_pct", "target_roi").replace("roi_pct", "roi_multiple")

    # "-53.6 pp against the 1.5 target" -> "-0.5 against the 1.5 target"
    s = re.sub(rf"({_NUM}) pp against", lambda m: f"{fmt(dx(float(m.group(1))), signed=True)} against", s)
    # "53.6 points below target" -> "0.5 below target"
    s = re.sub(rf"({_NUM}) points below target", lambda m: f"{fmt(abs(dx(float(m.group(1))) or 0))} below target", s)
    # "a gap of 42.3 percentage points" -- only when 42.3 is the distance
    # between two ROI figures this record carries, so a margin gap stays put.
    def gap(m: re.Match) -> str:
        if f"{abs(float(m.group(1))):.2f}" in rec.roi_gaps:
            return fmt(dx(float(m.group(1))))
        return m.group(0)
    s = re.sub(rf"({_NUM}) (?:percentage points|pp)(?![A-Za-z])", gap, s)
    # "ROI down 11.3% vs. overall" -- a movement of the ROI, so a difference.
    s = re.sub(
        rf"(ROI (?:down|up|fell|rose|dropped|declined|improved)(?: by)? )({_NUM})%",
        lambda m: f"{m.group(1)}{fmt(dx(abs(float(m.group(2)))))}",
        s,
    )

    # Known ROI figures by value, or any figure the sentence itself labels as
    # an ROI ("-3.6% ROI", "ROI: 38.7%", "ROI of 10.9%", "ROI at -2%").
    words = r"(?::|of|at|is|was|to|around|approximately|about|at least|-|–|—|=|\[[grn]\])"

    def labelled(m: re.Match) -> bool:
        after = s[m.end():m.end() + 8]
        before = s[max(0, m.start() - 40):m.start()]
        if re.match(r"\s*(?:\[/[grn]\])?\s*ROI\b", after):
            return True
        if re.search(rf"ROI(?:\s*{words})*\s*$", before):
            return True
        # "Whole Business ROI for Buy3Get1: 9.4%", "ROI vs 9.4%"
        if re.search(r"ROI(?: for [^:%]{0,30})?:\s*$", before) or re.search(r"ROI\s*(?:vs\.?|versus)\s*$", before):
            return True
        # "ROI -2% vs 9.4% in Whole Business": the figure after "vs" is the
        # same measure as the one before it.
        return bool(re.search(r"ROI\b[^%]{0,20}%\s*(?:vs\.?|versus|against|compared to)\s*$", before))

    def swap(m: re.Match) -> str:
        num = m.group(1)
        key = f"{float(num):.1f}"
        if labelled(m) or (key in rec.roi_values and key not in rec.other_values):
            return fmt(x(float(num)))
        # Only a figure that sits near the word is worth reporting; a discount
        # depth or a cannibalisation rate is not an unconverted ROI.
        window = s[max(0, m.start() - 25):m.end() + 12]
        if "ROI" in window:
            rec.residual.append(s[max(0, m.start() - 45):m.end() + 25].replace("\n", " "))
        return m.group(0)

    # Only a figure followed by "%" and NOT part of a mechanic name ("5% Discount").
    s = re.sub(rf"(?<![\d.])({_NUM})%(?! Discount)(?!\s*of )", swap, s)

    if s != before:
        rec.changed += 1
    return s


def convert_prose(o: Any, rec: Record) -> Any:
    if isinstance(o, dict):
        for k, v in o.items():
            o[k] = convert_prose(v, rec)
        return o
    if isinstance(o, list):
        return [convert_prose(i, rec) for i in o]
    if isinstance(o, str):
        return convert_text(o, rec)
    return o


def migrate_object(obj: Any, label: str) -> Record:
    rec = Record(label)
    collect(obj, rec)
    # A figure that is BOTH an ROI and something else is ambiguous in prose.
    convert(obj, rec)
    convert_prose(obj, rec)
    return rec


# --- the two stores ----------------------------------------------------------


def migrate_runs(dry_run: bool) -> list[Record]:
    if not RUNS_PATH.is_file():
        print(f"no recorded runs at {RUNS_PATH}; skipping")
        return []
    raw = RUNS_PATH.read_bytes()
    crlf = b"\r\n" in raw
    data = json.loads(raw.decode("utf-8"))
    if not dry_run:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = RUNS_PATH.with_name(f"investigation-runs.json.before-roi-multiple-{stamp}")
        backup.write_bytes(raw)
        print(f"backed up recorded runs to {backup.name}")
    records: list[Record] = []
    items = data.items() if isinstance(data, dict) else enumerate(data)
    for key, run in items:
        text = json.dumps(run)
        if "roi_multiple" in text:
            continue  # already in the new unit
        if not any(t in text for t in ("roi_pct", "roi_percent", "target_roi_pct", '"roi"', "ROI")):
            continue
        records.append(migrate_object(run, f"run {key}"))
    if not dry_run:
        out = json.dumps(data, ensure_ascii=False, indent=2)
        if crlf:
            out = out.replace("\n", "\r\n")
        RUNS_PATH.write_bytes(out.encode("utf-8"))
    return records


def _needs_migration(text: str) -> bool:
    return "roi_multiple" not in text and any(
        t in text for t in ("roi_pct", "roi_percent", "target_roi_pct", "vs_target_pp", "gap_pp")
    )


def migrate_db(dry_run: bool, cutoff: str) -> list[Record]:
    if not DB_PATH.is_file():
        print(f"no store at {DB_PATH}; skipping")
        return []
    if not dry_run:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = DB_PATH.with_name(f"tiq.db.before-roi-multiple-{stamp}")
        shutil.copy2(DB_PATH, backup)
        print(f"backed up store to {backup.name}")
    con = sqlite3.connect(DB_PATH)
    records: list[Record] = []
    plan = (
        ("scenario_results", ("scenario_id", "version"), ("payload_json",)),
        ("decision_versions", ("decision_id", "version"), ("record_json",)),
        ("reports", ("id",), ("options_json", "preview_json")),
    )
    for table, pk, cols in plan:
        rows = con.execute(
            f"SELECT {', '.join(pk)}, {', '.join(cols)}, created_at FROM {table}"
        ).fetchall()
        for row in rows:
            ids, payloads, created = row[: len(pk)], row[len(pk):-1], row[-1]
            if created >= cutoff:
                continue
            updates: dict[str, str] = {}
            for col, payload in zip(cols, payloads):
                if not payload or not _needs_migration(payload):
                    continue
                obj = json.loads(payload)
                rec = migrate_object(obj, f"{table} {'/'.join(str(i) for i in ids)} {col}")
                records.append(rec)
                updates[col] = json.dumps(obj, ensure_ascii=False)
            if updates and not dry_run:
                sets = ", ".join(f"{c} = ?" for c in updates)
                where = " AND ".join(f"{p} = ?" for p in pk)
                con.execute(f"UPDATE {table} SET {sets} WHERE {where}", [*updates.values(), *ids])
    if not dry_run:
        con.commit()
    con.close()
    return records


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--cutoff", default="2026-09-14T14:00",
                    help="store rows created at/after this ISO timestamp are left alone")
    args = ap.parse_args()

    records = migrate_runs(args.dry_run) + migrate_db(args.dry_run, args.cutoff)
    changed = sum(r.changed for r in records)
    residual = [(r.label, t) for r in records for t in r.residual]
    print(f"{'DRY RUN: ' if args.dry_run else ''}{len(records)} records, {changed} field/text changes")
    print(f"{len(residual)} percent figures near ROI left unconverted (ambiguous or unknown):")
    for label, t in residual[:40]:
        print(f"  [{label}] …{t}…")
    if len(residual) > 40:
        print(f"  … and {len(residual) - 40} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
