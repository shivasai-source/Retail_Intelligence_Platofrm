"""Reading the star-schema CSVs out of an Azure Blob Storage account.

WHY THIS IS SERVER-SIDE. The Excel connector's files arrive as a multipart
upload; these arrive as blob names, and the bytes have to be fetched from
somewhere. Doing that in the browser would mean pulling ~21 MB down from Azure
and immediately pushing the same 21 MB back up to this backend, and it would
only work at all with CORS configured on the storage account for this exact
origin — a setting most accounts do not have and many users cannot change.
Fetching server-to-server skips both problems: CORS does not apply outside a
browser, and the bytes travel Azure -> backend -> disk once.

The browse endpoints (containers, blobs) are also proxied here rather than left
to the browser's existing direct calls, so that a user who cannot enable CORS
still gets a working picker. `lib/portalConnectors.ts` keeps its direct-fetch
helpers for the standalone Azure browsing modal; this module is what the
dataset connector uses.

CREDENTIALS ARE NEVER PERSISTED. The account name and SAS token arrive on each
request, are used to build the URL for that request, and are dropped. Nothing
is written to disk or logged — a SAS token is a bearer credential, and the log
is the last place it should turn up. `_redact` scrubs it out of Azure's own
error bodies before they are shown to the user, since the failing URL that
Azure echoes back contains the signature.

INSTALLING IS THE EXCEL CONNECTOR'S INSTALL. Identification by column headers,
the all-six-or-nothing rule, the lock once complete, and the reset that clears
it are all `star_dataset`'s, unchanged. This module's only job is turning blob
names into (filename, bytes) pairs; every rule about what those bytes have to
be lives in one place, so the two connectors cannot drift apart.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, quote
from xml.etree import ElementTree

import httpx

#: Azure returns 5,000 blobs per page by default. The picker is for finding six
#: known files, not for browsing a data lake, so one page is plenty — the
#: response says whether more exist and the UI tells the user to use a prefix.
LIST_TIMEOUT = 30.0
#: The fact table is ~21 MB and a bigger replacement is legitimate. Generous,
#: because this is a server-to-server transfer with no browser in the middle.
DOWNLOAD_TIMEOUT = 300.0
# Larger CSVs are fetched in parallel byte ranges. This overlaps Azure's
# per-request latency while keeping the total number of in-flight requests low.
DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024
MAX_PARALLEL_DOWNLOADS = 8
#: Enough of a CSV to be sure of catching the header row, requested as an HTTP
#: Range so identifying six files does not download 21 MB of them.
HEADER_RANGE_BYTES = 256 * 1024


class AzureError(Exception):
    """Raised with a user-facing message when Azure cannot be reached or refuses."""


class ContainerScopedSas(AzureError):
    """The token is scoped to a single container, so the account cannot be listed.

    Not really an error: a container-scoped SAS (`sr=c`) is a perfectly normal
    thing to be given, and is often the ONLY thing a user can get when they do
    not own the storage account. It just means the picker has to start from a
    container name the user types rather than from a list it discovered.
    """

    def __init__(self) -> None:
        super().__init__(
            "This SAS token is scoped to a single container, so the list of "
            "containers can't be read. Enter the container name to continue."
        )


class BlobScopedSas(AzureError):
    """The token is scoped to ONE blob (`sr=b`), so nothing can be browsed.

    Distinct from `ContainerScopedSas` because the remedy is different, and
    telling these apart is the whole point: a container-scoped token still
    reaches the file picker once the user names the container, whereas a
    blob-scoped one cannot list anything at all. Prompting for a container name
    would ask for something that cannot help — the user needs a different token.
    """

    def __init__(self) -> None:
        super().__init__(
            "This SAS token is scoped to a single blob, so containers and files "
            "can't be browsed. Generate a token for the whole container "
            "(Read + List), or an account-level one, and try again."
        )


@dataclass(frozen=True)
class BlobRef:
    """One blob the user picked, addressed within the account."""

    container: str
    name: str


def _clean_sas(sas: str) -> str:
    """A SAS token, with or without its leading '?', as query-string text."""
    return sas.strip().lstrip("?")


def _redact(text: str, sas: str) -> str:
    """Remove the SAS signature from anything shown to the user or logged.

    Azure's error bodies quote the request URI, which carries the token. The
    `sig=` parameter is the secret part, so it is masked wherever it appears —
    including in a token the caller passed, which may be echoed verbatim.
    """
    out = re.sub(r"sig=[^&\s\"'<]+", "sig=***", text)
    token = _clean_sas(sas)
    if token:
        out = out.replace(token, "***")
    return out


def describe_sas(sas: str) -> dict[str, Any]:
    """What a SAS token says about itself, before any request is made.

    A SAS carries its own scope and permissions in plain query parameters, so
    the two failures that dominate real use can be diagnosed without asking
    Azure and without the user decoding the token by hand:

      * `sr=c` is a SERVICE SAS scoped to a single container, and `sr=b` to a
        single blob. Listing containers is an account-level operation, so it can
        never succeed with either — Azure answers AuthenticationFailed, whose
        wording ("make sure the Authorization header is formed correctly") sends
        people off checking for a copy-paste error that isn't there. The two are
        reported separately because the remedy differs: a container-scoped token
        still works once the user names its container, a blob-scoped one cannot
        browse at all and has to be replaced.
      * `sp=` without `l` cannot list. Azure calls this
        AuthorizationPermissionMismatch, which is accurate but does not say
        WHICH permission is absent.

    `srt` is the account-SAS equivalent: it must contain `c` (container) for
    listing to work, and `o` (object) to read blobs.
    """
    params = parse_qs(_clean_sas(sas), keep_blank_values=True)
    one = lambda k: (params.get(k) or [""])[0]
    perms = one("sp")
    srt = one("srt")
    resource = one("sr")
    return {
        # A service SAS names its resource; an account SAS uses srt instead.
        "scope": resource or ("account" if srt else ""),
        "container_scoped": resource == "c",
        "blob_scoped": resource == "b",
        "permissions": perms,
        "can_list": "l" in perms,
        "can_read": "r" in perms,
        "srt": srt,
        "expires": one("se"),
    }


def _account_host(account: str) -> str:
    name = account.strip().strip("/")
    if not name:
        raise AzureError("Storage account name is required.")
    # Accept either the bare name or a full endpoint pasted from the portal.
    if "." in name:
        return name.split("/")[0]
    return f"{name}.blob.core.windows.net"


def _url(account: str, sas: str, path: str = "", query: str = "") -> str:
    host = _account_host(account)
    token = _clean_sas(sas)
    if not token:
        raise AzureError("SAS token is required.")
    joined = f"{query}&{token}" if query else token
    return f"https://{host}/{path}?{joined}"


def _permission_advice(sas: str) -> str:
    """The concrete fix for a token that cannot do what was asked, or "".

    Read off the token rather than guessed, so the message names the actual
    missing letter instead of listing everything it could conceivably be.
    """
    info = describe_sas(sas)
    if info["permissions"] and not info["can_list"]:
        return (
            f" This token's permissions are '{info['permissions']}', which has no "
            f"'l' (List) — regenerate it with Read AND List ticked."
        )
    if info["srt"] and "c" not in info["srt"]:
        return (
            f" This token's resource types are '{info['srt']}', which omits 'c' "
            f"(Container) — regenerate it with Container and Object both ticked."
        )
    return ""


def _explain(status: int, body: str, sas: str) -> str:
    """Turn an Azure error response into something a user can act on.

    Azure's own <Message> is usually accurate but assumes you know the REST API,
    so the common causes get a plainer sentence. AuthenticationFailed in
    particular is almost always one of three fixable things.
    """
    code = ""
    try:
        root = ElementTree.fromstring(body)
        code = (root.findtext("Code") or "").strip()
        message = (root.findtext("Message") or "").strip().split("\n")[0]
    except ElementTree.ParseError:
        # Azure echoes the failing URI inside <Message>, and an unescaped '&'
        # from the SAS token makes the body invalid XML — exactly the case where
        # a useful <Code> is present. Recover it by hand rather than falling
        # through to the generic status-code text.
        match = re.search(r"<Code>([^<]+)</Code>", body)
        code = match.group(1).strip() if match else ""
        message = body.strip()[:300]

    hints = {
        "AuthenticationFailed": (
            "Azure rejected the SAS token. Check it has not expired, that it "
            "includes Read and List permission, and that it was copied whole "
            "(everything after the '?')."
        ),
        "AuthorizationPermissionMismatch": (
            "The SAS token is valid but lacks permission for this operation — "
            "it needs Read and List on blobs and containers."
        ),
        "ResourceNotFound": "No such container or blob in this storage account.",
        "ContainerNotFound": "That container does not exist in this storage account.",
        "BlobNotFound": "That file no longer exists in the container.",
        "InvalidQueryParameterValue": (
            "Azure did not accept part of the SAS token — it may be truncated, "
            "or built for a different service than Blob storage."
        ),
        "AccountIsDisabled": "This storage account is disabled.",
        "InsufficientAccountPermissions": (
            "The SAS token does not grant access at the level this needs — when "
            "creating it, tick both the Container and Object resource types."
        ),
    }
    if code in hints:
        if code in ("AuthenticationFailed", "AuthorizationPermissionMismatch", "InsufficientAccountPermissions"):
            return hints[code] + _permission_advice(sas)
        return hints[code]
    if status == 403:
        return (
            "Azure refused the request (403). The SAS token is usually expired, "
            "missing Read/List permission, or restricted to a different IP."
        )
    if status == 404:
        return "Not found (404) — check the storage account name and container."
    detail = _redact(message, sas) if message else f"HTTP {status}"
    return f"Azure refused the request: {detail}"


async def _get(
    client: httpx.AsyncClient, url: str, sas: str, *, headers: dict[str, str] | None = None
) -> httpx.Response:
    try:
        res = await client.get(url, headers=headers)
    except httpx.RequestError as e:
        raise AzureError(
            "Couldn't reach Azure — check the storage account name and this "
            f"machine's network access. Detail: {_redact(str(e), sas)}"
        ) from e
    if res.status_code >= 400:
        raise AzureError(_explain(res.status_code, res.text, sas))
    return res


# Azure's list APIs are unnamespaced XML, so plain tag names work.
def _text(node: Any, tag: str, default: str = "") -> str:
    found = node.findtext(tag)
    return found if found is not None else default


async def list_containers(account: str, sas: str) -> list[dict[str, Any]]:
    """Every container the token can see. The first step of the picker.

    Raises `ContainerScopedSas` for a token bound to one container: that is not
    a failure the user can fix by retrying, it just means the account-level
    listing is the wrong question to ask. The caller answers it by asking the
    user which container the token is for instead. `BlobScopedSas` is the
    dead-end case — a token for one blob can browse nothing.
    """
    scope = describe_sas(sas)
    if scope["blob_scoped"]:
        raise BlobScopedSas()
    if scope["container_scoped"]:
        raise ContainerScopedSas()
    url = _url(account, sas, "", "comp=list")
    async with httpx.AsyncClient(timeout=LIST_TIMEOUT, follow_redirects=True) as client:
        res = await _get(client, url, sas)
    try:
        root = ElementTree.fromstring(res.text)
    except ElementTree.ParseError as e:
        raise AzureError(
            "Azure returned something that isn't a container listing — check the "
            "storage account name is right."
        ) from e
    return [
        {"name": _text(el, "Name", "(unnamed)")}
        for el in root.findall("./Containers/Container")
    ]


async def list_blobs(
    account: str, sas: str, container: str, prefix: str = ""
) -> dict[str, Any]:
    """One level of a container: the CSV/Excel blobs in it, and its subfolders.

    Uses delimiter=/ so a container holding thousands of blobs comes back as a
    handful of folders rather than one enormous flat list — blob names contain
    '/' and Azure has no real directories, but this is what makes them navigable
    the way the user expects.

    Only files the star installer could actually accept are returned; a
    container full of parquet and JSON would otherwise bury the six CSVs.
    """
    query = "restype=container&comp=list&delimiter=%2F&maxresults=5000"
    if prefix:
        query += f"&prefix={quote(prefix, safe='')}"
    url = _url(account, sas, quote(container.strip("/"), safe=""), query)
    async with httpx.AsyncClient(timeout=LIST_TIMEOUT, follow_redirects=True) as client:
        res = await _get(client, url, sas)
    try:
        root = ElementTree.fromstring(res.text)
    except ElementTree.ParseError as e:
        raise AzureError("Azure returned an unreadable blob listing for this container.") from e

    folders = [
        _text(el, "Name")
        for el in root.findall("./Blobs/BlobPrefix")
        if _text(el, "Name")
    ]

    files: list[dict[str, Any]] = []
    for el in root.findall("./Blobs/Blob"):
        name = _text(el, "Name")
        if not name or not name.lower().endswith((".csv", ".xlsx", ".xls")):
            continue
        props = el.find("Properties")
        size = 0
        modified = ""
        if props is not None:
            try:
                size = int(_text(props, "Content-Length", "0") or 0)
            except ValueError:
                size = 0
            modified = _text(props, "Last-Modified")
        files.append(
            {
                "name": name,
                # What to show in the list — the part below the current folder.
                "display_name": name[len(prefix):] if prefix and name.startswith(prefix) else name,
                "size_bytes": size,
                "modified": modified,
            }
        )

    return {
        "container": container,
        "prefix": prefix,
        "folders": folders,
        "files": files,
        # NextMarker present means the listing was cut short; the picker says so
        # rather than pretending the container holds only what is shown.
        "truncated": bool(_text(root, "NextMarker")),
    }


def _blob_path(blob: BlobRef) -> str:
    """container/blob, percent-encoded but keeping '/' as the path separator —
    blob names routinely carry spaces, '#' and '+', which would otherwise be
    read as URL syntax rather than as part of the name."""
    return f"{quote(blob.container.strip('/'), safe='')}/{quote(blob.name, safe='/')}"


async def fetch_header(
    client: httpx.AsyncClient, account: str, sas: str, blob: BlobRef
) -> bytes:
    """The first chunk of a blob, for header identification.

    A ranged GET, so deciding which table a 21 MB fact table is costs 256 KB.
    Azure answers a Range request with 206 and the slice; a blob smaller than
    the range comes back whole, which is equally fine.

    An .xlsx is a zip whose central directory sits at the END of the file, so a
    prefix cannot be parsed — those are fetched whole, and are small enough in
    practice (a dimension table) for that to be reasonable.
    """
    url = _url(account, sas, _blob_path(blob))
    headers = None
    if not blob.name.lower().endswith((".xlsx", ".xls")):
        headers = {"Range": f"bytes=0-{HEADER_RANGE_BYTES - 1}"}
    res = await _get(client, url, sas, headers=headers)
    return res.content


async def fetch_blob(
    client: httpx.AsyncClient,
    account: str,
    sas: str,
    blob: BlobRef,
    request_slots: asyncio.Semaphore,
) -> bytes:
    """Fetch a blob, splitting larger files into parallel Azure byte ranges."""
    url = _url(account, sas, _blob_path(blob))

    async def ranged_get(start: int, end: int) -> httpx.Response:
        async with request_slots:
            return await _get(
                client,
                url,
                sas,
                headers={"Range": f"bytes={start}-{end}"},
            )

    first_end = DOWNLOAD_CHUNK_BYTES - 1
    first = await ranged_get(0, first_end)
    content_range = re.fullmatch(
        r"bytes\s+0-(\d+)/(\d+)", first.headers.get("Content-Range", ""), re.I
    )
    # A server that ignores Range returns the whole body (200); small blobs may
    # also fit in the first range and need no additional requests.
    if first.status_code != 206 or not content_range:
        return first.content

    first_last, total = map(int, content_range.groups())
    if first_last + 1 >= total:
        return first.content
    if first_last + 1 != len(first.content):
        raise AzureError(f"Azure returned an incomplete first range for '{blob.name}'.")

    ranges = [
        (start, min(start + DOWNLOAD_CHUNK_BYTES - 1, total - 1))
        for start in range(first_last + 1, total, DOWNLOAD_CHUNK_BYTES)
    ]
    parts = await asyncio.gather(*(ranged_get(start, end) for start, end in ranges))
    if any(len(part.content) != end - start + 1 for part, (start, end) in zip(parts, ranges)):
        raise AzureError(f"Azure returned an incomplete download for '{blob.name}'.")
    return first.content + b"".join(part.content for part in parts)


async def fetch_all(
    account: str, sas: str, blobs: list[BlobRef]
) -> list[tuple[str, bytes]]:
    """Download every selected blob, as (filename, bytes) for the installer.

    Download a small bounded batch concurrently. The six-table install is one
    blocking request, and sequential transfers leave Azure/network latency
    idle between blobs. Keeping the batch bounded avoids opening unbounded
    connections if this helper is ever given more than the standard six files.
    """
    request_slots = asyncio.Semaphore(MAX_PARALLEL_DOWNLOADS)

    async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
        async def download(blob: BlobRef) -> tuple[str, bytes]:
            content = await fetch_blob(client, account, sas, blob, request_slots)
            if not content:
                raise AzureError(f"'{blob.name}' is empty in Azure.")
            return blob.name.rsplit("/", 1)[-1], content

        out = await asyncio.gather(*(download(blob) for blob in blobs))
    # asyncio.gather preserves the selected order; the installer still receives
    # the same filename/content pairs as before.
    return out


async def inspect_blobs(
    account: str, sas: str, blobs: list[BlobRef]
) -> list[tuple[str, bytes]]:
    """Header-sized reads of the selected blobs, for the pre-flight check."""
    out: list[tuple[str, bytes]] = []
    async with httpx.AsyncClient(timeout=LIST_TIMEOUT, follow_redirects=True) as client:
        for blob in blobs:
            content = await fetch_header(client, account, sas, blob)
            out.append((blob.name.rsplit("/", 1)[-1], content))
    return out
