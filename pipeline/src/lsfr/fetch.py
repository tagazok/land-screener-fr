"""Resumable, provenance-logged downloads.

Large data.gouv.fr transfers get cut mid-stream on some networks (HTTP/2
CANCEL), so we shell out to curl with --http1.1 and -C - (resume) in a retry
loop, then verify the size against the server's Content-Length.
"""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "land-screener-fr/0.1 (open-data research prototype)"


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            n = r.headers.get("Content-Length")
            return int(n) if n else None
    except Exception:
        return None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _zip_ok(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as z:
            return bool(z.namelist())
    except Exception:
        return False


def fetch(url: str, dest: Path, *, retries: int = 20, provenance: Path | None = None) -> Path:
    """Download url to dest unless an already-complete copy exists."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    expected = remote_size(url)
    if dest.exists() and expected is not None and dest.stat().st_size == expected:
        return dest
    if dest.exists() and expected is None and dest.stat().st_size > 0:
        return dest  # server gives no size (dynamic export): trust the cached copy

    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        # -C - only works when the server reports a size; dynamic exports restart.
        resume = ["-C", "-"] if expected is not None else []
        if expected is None and part.exists():
            part.unlink()
        cmd = ["curl", "-sS", "-f", "-L", "--http1.1", "-A", USER_AGENT, *resume, "-o", str(part), url]
        res = subprocess.run(cmd, capture_output=True, text=True)
        size = part.stat().st_size if part.exists() else 0
        # Servers that send no size can silently truncate: a zip must at least open.
        ok_zip = expected is not None or not dest.name.endswith(".zip") or _zip_ok(part)
        if res.returncode == 0 and (expected is None or size == expected) and ok_zip:
            break
        if res.returncode == 22 and "404" in res.stderr:
            raise RuntimeError(f"not found (404): {url}")
        if attempt == retries:
            raise RuntimeError(f"download failed after {retries} attempts: {url}\n{res.stderr}")
        time.sleep(min(2 * attempt, 15))
    part.rename(dest)

    if provenance is not None:
        provenance.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "url": url,
            "path": str(dest),
            "bytes": dest.stat().st_size,
            "sha256": sha256(dest),
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with provenance.open("a") as f:
            f.write(json.dumps(rec) + "\n")
    return dest


class _HttpRangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file using HTTP Range requests.

    Lets zipfile read one member of a huge remote archive (e.g. one
    département inside a 300 MB national zip) without downloading the rest.
    """

    def __init__(self, url: str):
        self.url, self.pos = url, 0
        size = remote_size(url)
        if size is None:
            raise RuntimeError(f"server gives no size for {url}")
        self.size = size

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.pos + n, self.size) - 1
        for attempt in range(8):
            try:
                req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}", "User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                if len(data) == end - self.pos + 1:
                    break
            except Exception:
                if attempt == 7:
                    raise
            time.sleep(2 + attempt)
        self.pos += len(data)
        return data

    def readinto(self, b):
        d = self.read(len(b))
        b[: len(d)] = d
        return len(d)


def remote_zip_members(url: str) -> list[tuple[str, int]]:
    with zipfile.ZipFile(_HttpRangeFile(url)) as z:
        return [(i.filename, i.file_size) for i in z.infolist()]


def fetch_zip_member(url: str, member: str, dest: Path) -> Path:
    """Extract one member of a remote zip to dest (skip if already present)."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with zipfile.ZipFile(_HttpRangeFile(url)) as z, z.open(member) as src, tmp.open("wb") as out:
        while chunk := src.read(1 << 20):
            out.write(chunk)
    tmp.rename(dest)
    return dest
