"""Match identity hash — a stable, opaque digest of the *played* match.

The hash answers "are these two files the same match?" It is derived only from what
was played — the move and cube decisions, the dice, and the score progression —
**never** from analysis output (equities, candidates, luck, errors, comments,
flags). That separation is what keeps the id stable when a match is re-analysed at
a different ply, mirroring how XGIDs stay stable across re-analysis.

**The canonical form below is part of the public contract.** Field order,
normalization, the play-vs-analysis boundary, and the algorithm are frozen and
versioned: changing them re-keys every stored match id, so bump ``IDENTITY_VERSION``
and treat it as a breaking change. Consumers must treat the result as an opaque
black box.

Per-game match score is included deliberately: the same move sequence played at a
different score is a different match and must not collide.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import Match

IDENTITY_VERSION = 1


def match_identity(match: "Match") -> str:
    """Return the versioned identity hash for *match* (e.g. ``"xgmid1-<hex>"``)."""
    from .models import CubeAction, Move

    lines: list[str] = [
        f"v{IDENTITY_VERSION}",
        f"variation={match.header.variation}",
        f"match_length={match.header.match_length}",
    ]

    for game in match.games:
        # Per-game match score is part of the identity (see module docstring).
        lines.append(f"G:{game.header.score1}:{game.header.score2}")
        for event in game.events:
            if isinstance(event, Move):
                moves = ",".join(f"{md.from_point}/{md.die}" for md in event.moves)
                lines.append(
                    f"M:{event.player}:{event.dice[0]}:{event.dice[1]}:{moves}"
                )
            elif isinstance(event, CubeAction):
                lines.append(
                    "C:{p}:{d}:{t}:{b}:{c}".format(
                        p=event.player,
                        d=int(event.doubled),
                        t="-" if event.took is None else int(event.took),
                        b=int(event.beavered),
                        c=event.cube_value,
                    )
                )

    canonical = "\n".join(lines).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    return f"xgmid{IDENTITY_VERSION}-{digest}"
