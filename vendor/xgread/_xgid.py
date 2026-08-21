"""XGID encoding — the canonical string form of a position/decision.

An XGID is the standard eXtremeGammon position identifier: a 26-character board
string followed by nine colon-separated fields describing cube, turn, dice, score,
and match settings. It is a pure function of the position and the match context.

**Canonical form is part of the public contract.** The field order, the
on-roll-player perspective, the score ordering, and the dice rendering below are
frozen: changing any of them silently re-keys every XGID a consumer has stored, so
treat such a change as a breaking, versioned API change.

Reference: the format follows ``docs/xgid.md`` from ``gtback/backgammon-js`` and
agrees with GNU Backgammon's ``SetXGID`` parser (``set.c``).

Layout::

    XGID=<position>:<cube>:<cubePos>:<turn>:<dice>:<playerScore>:<oppScore>:<rules>:<matchLen>:<maxCube>

The board is always written from the on-roll player's perspective (uppercase =
player on roll, lowercase = opponent), which matches ``Position.points`` exactly,
so no side-swapping is needed.
"""

from __future__ import annotations


def encode_position(points: tuple[int, ...]) -> str:
    """Encode a 26-slot board (on-roll player's POV) as the XGID position string.

    Each slot maps to one character: ``-`` for empty, ``A``–``O`` for 1–15 checkers
    of the player on roll, ``a``–``o`` for 1–15 of the opponent. Slot 0 is the
    opponent's bar, 1–24 the points (1 = on-roll ace point), 25 the on-roll bar.
    """
    if len(points) != 26:
        raise ValueError(f"Position must have 26 slots, got {len(points)}")
    chars = []
    for v in points:
        if v == 0:
            chars.append("-")
        elif v > 0:
            chars.append(chr(ord("A") + min(v, 15) - 1))
        else:
            chars.append(chr(ord("a") + min(-v, 15) - 1))
    return "".join(chars)


def build_xgid(
    *,
    points: tuple[int, ...],
    cube_value: int,
    dice: tuple[int, int] | None,
    player_score: int,
    opp_score: int,
    match_length: int,
    crawford_game: bool,
    jacoby: bool,
    beaver: bool,
    cube_limit: int,
    turn: int = 1,
) -> str:
    """Build the canonical XGID string for one position/decision.

    *points* is the board from the on-roll player's perspective. *cube_value* uses
    the log-encoded convention (0 = centred, +n = on-roll player owns 2^n, -n =
    opponent owns 2^n). *dice* is the rolled pair for a checker decision, or
    ``None`` for a cube decision (rendered ``"00"``). *player_score*/*opp_score* are
    the match scores of the on-roll player and the opponent. *match_length* is 0 for
    money play. *turn* is +1 when the on-roll player is to move (the perspective this
    library always emits) and -1 otherwise.
    """
    position = encode_position(points)

    cube = abs(cube_value)
    cube_pos = (cube_value > 0) - (cube_value < 0)  # sign: +1 / 0 / -1

    if dice is None:
        dice_str = "00"
    else:
        hi, lo = (dice[0], dice[1]) if dice[0] >= dice[1] else (dice[1], dice[0])
        dice_str = f"{hi}{lo}"

    if match_length > 0:
        rules = 1 if crawford_game else 0
    else:
        rules = (1 if jacoby else 0) + (2 if beaver else 0)

    fields = [
        position,
        str(cube),
        str(cube_pos),
        str(turn),
        dice_str,
        str(player_score),
        str(opp_score),
        str(rules),
        str(match_length),
        str(cube_limit),
    ]
    return "XGID=" + ":".join(fields)
