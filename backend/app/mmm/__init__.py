"""MMM — Market Mix & Marketing Intelligence.

Everything the MMM module owns on the backend lives in this package, the way
everything TPO owns lives in `app/tpo/`:

    config.py    where the MMM dataset lives on disk, and the file name
    schema.py    THE column contract: which columns MMM reads, their groups,
                 types and docs. The frontend mirror is frontend/src/mmm/schema.ts
    dataset.py   upload -> validate -> install, status, reset, preview
    loader.py    the installed dataset as a cached DataFrame
    service.py   Insights Hub payload (KPIs, trend, channels, promotions)
    calendar.py  Calendar payload (channel x month spend, month day detail)
    report.py    the Report Center adapter (`mmm-insights`)
    router.py    every /api/mmm/* route

MMM NEVER TOUCHES TPO's DATA. TPO's six star-schema CSVs live in `Data/` and are
installed by `app/star_dataset.py`; MMM's one daily table lives in its own
folder (see config.py) and is installed by `dataset.py`. Neither installer can
reach the other's files.
"""
