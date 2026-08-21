"""xgread — read eXtremeGammon .xg and .xgp match files."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path

try:
    __version__ = _pkg_version("xgread")
except PackageNotFoundError:  # not installed (e.g. running from a source checkout)
    __version__ = "0.0.0+unknown"

from ._archive import open_archive
from ._notation import format_moves
from ._parser import RICH_HDR_SIZE, parse_rich_header, parse_xg_stream
from .models import (
    NOT_ANALYSED,
    CubeAction,
    Decision,
    Evaluation,
    Game,
    GameFooter,
    GameHeader,
    Match,
    MatchFooter,
    MatchHeader,
    Move,
    MoveCandidate,
    MoveDetail,
    Position,
)

__all__ = [
    "__version__",
    "read",
    "read_xgp",
    "read_xg",
    "format_moves",
    "NOT_ANALYSED",
    # models
    "Match",
    "MatchHeader",
    "MatchFooter",
    "Game",
    "GameHeader",
    "GameFooter",
    "Move",
    "MoveCandidate",
    "CubeAction",
    "MoveDetail",
    "Position",
    "Evaluation",
    "Decision",
]


_RICH_MAGIC = b"RGMH"


def read(path: str | Path) -> Match:
    """Read an eXtremeGammon match file (.xg or .xgp).

    Both extensions use the same rich-header + ZLB archive format.
    Format is detected from the first 4 bytes, not the extension.
    """
    return _read_bytes(Path(path).read_bytes())


def read_xgp(path: str | Path) -> Match:
    """Read a ``.xgp`` eXtremeGammon package file."""
    return _read_bytes(Path(path).read_bytes())


def read_xg(path: str | Path) -> Match:
    """Read a ``.xg`` eXtremeGammon game file."""
    return _read_bytes(Path(path).read_bytes())


def _read_bytes(data: bytes) -> Match:
    if data[:4] == _RICH_MAGIC:
        hdr, thumb_size = parse_rich_header(data)
        thumbnail = data[RICH_HDR_SIZE : RICH_HDR_SIZE + thumb_size]
        archive_data = data[RICH_HDR_SIZE + thumb_size :]
        files = open_archive(archive_data)
        xg_data = files.get("temp.xg")
        if xg_data is None:
            raise ValueError("Archive does not contain 'temp.xg'")
        return parse_xg_stream(xg_data, thumbnail=thumbnail)
    return parse_xg_stream(data)
