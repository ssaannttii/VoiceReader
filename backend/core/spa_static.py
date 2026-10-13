"""Static files for the web UI: precompressed variants and cache headers.

``bun run build:web`` writes ``.br`` / ``.gz`` siblings next to the text assets
(``electron/scripts/precompress-web.mjs``). Serving them cuts the first load of
the web UI from ~2 MB to ~0.5 MB, which matters on a phone reaching the PC over
Tailscale or a slow Wi-Fi link.

Cache policy: Vite's content-hashed ``assets/*`` never change under the same
name, so browsers may keep them for a year without asking again; everything else
(``index.html``, the service worker, the manifest, icons) is revalidated on every
load so a rebuilt UI shows up immediately.
"""
from __future__ import annotations

import os

from starlette.datastructures import Headers
from starlette.responses import FileResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"

#: (Accept-Encoding token, file suffix), best first.
_ENCODINGS = (("br", ".br"), ("gzip", ".gz"))


def _accepted(scope: Scope) -> set[str]:
    tokens = set()
    for part in Headers(scope=scope).get("accept-encoding", "").split(","):
        name, _, params = part.strip().partition(";")
        quality = params.strip().removeprefix("q=")
        try:
            refused = params.strip().startswith("q=") and float(quality) == 0
        except ValueError:
            refused = False
        if name and not refused:
            tokens.add(name.strip().lower())
    return tokens


def cache_control_for(path: str) -> str:
    """``path`` is relative to the dist root, with forward slashes."""
    return IMMUTABLE if path.startswith("assets/") else REVALIDATE


class SpaStaticFiles(StaticFiles):
    """``StaticFiles(html=True)`` plus precompressed variants and cache headers."""

    def file_response(self, full_path, stat_result, scope: Scope, status_code: int = 200) -> Response:
        rel = os.path.relpath(full_path, self.directory).replace(os.sep, "/") if self.directory else ""
        response = super().file_response(full_path, stat_result, scope, status_code)
        if response.status_code == 304:
            response.headers["cache-control"] = cache_control_for(rel)
            return response

        accepted = _accepted(scope)
        for token, suffix in _ENCODINGS:
            if token not in accepted:
                continue
            variant = f"{full_path}{suffix}"
            try:
                variant_stat = os.stat(variant)
            except OSError:
                continue
            compressed = FileResponse(
                variant,
                status_code=status_code,
                stat_result=variant_stat,
                media_type=response.media_type,
                headers={"content-encoding": token, "vary": "Accept-Encoding"},
            )
            compressed.headers["cache-control"] = cache_control_for(rel)
            if self.is_not_modified(compressed.headers, Headers(scope=scope)):
                return Response(status_code=304, headers={
                    key: value for key, value in compressed.headers.items()
                    if key in ("cache-control", "etag", "last-modified", "vary", "content-encoding")
                })
            return compressed

        response.headers["cache-control"] = cache_control_for(rel)
        if any(os.path.exists(full_path + suffix) for _, suffix in _ENCODINGS):
            response.headers["vary"] = "Accept-Encoding"
        return response
