"""Standard backgammon move notation (e.g. ``13/7*``).

A move is a set of individual checker hops (``MoveDetail``); standard notation
collapses hops of the same checker into a chain (``24/18/13``) and marks hits
with ``*``. This is a pure, objective function of the move plus the board it is
played from (needed to detect hits and to order chains canonically), so it lives
in the library rather than in any one consumer.

Coordinates in ``MoveDetail`` are 0-based from the on-roll player's point of view:
point 0 is the ace point, 24 is that player's bar, and a negative destination
means bearing off.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .models import MoveDetail, Position

if TYPE_CHECKING:
    from .models import MoveCandidate


def _point_name(point: int) -> str:
    """Human name for a 0-based point: ``off`` / ``bar`` / ``1``..``24``."""
    if point < 0:
        return "off"
    if point == 24:  # player's bar in 0-based coordinates
        return "bar"
    return str(point + 1)


def format_moves(moves: tuple[MoveDetail, ...], position: Position) -> str:
    """Render *moves* played from *position* as standard notation.

    ``position`` is the board *before* the move (on-roll player's POV), used to
    detect hits and to chain hops of the same checker. Returns ``"(no moves)"``
    for a dance (empty move set).
    """
    if not moves:
        return "(no moves)"

    # Working copy of the board (index 0=opp bar, 1-24=points, 25=player bar).
    board = list(position.points)

    def board_at(point_0: int) -> int:
        """Board value at a 0-based point index (0 outside the 1-24 range)."""
        if point_0 < 0 or point_0 >= 24:
            return 0
        return board[point_0 + 1]

    def apply_move(from_0: int, to_0: int) -> bool:
        """Move one checker; return True if it hit an opponent blot."""
        src = from_0 + 1  # player bar (from_0=24) -> board[25]; regular -> from_0+1
        if 1 <= src <= 25:
            board[src] -= 1
        if to_0 < 0:
            return False  # bearing off — no destination slot to update
        dst = to_0 + 1
        if not (1 <= dst <= 24):
            return False
        hit = board[dst] == -1
        if hit:
            board[dst] = 1
            board[0] -= 1  # send the opponent checker to their bar
        else:
            board[dst] += 1
        return hit

    # (from_point, destination) pairs, high point first.
    move_list = sorted(((md.from_point, md.die) for md in moves), key=lambda x: -x[0])
    n = len(move_list)
    parts: list[tuple[int, str]] = []
    i = 0

    while i < n:
        chain_from = move_list[i][0]
        cur_to = move_list[i][1]

        # Extend the chain: follow the same checker through further hops. Moves may
        # be stored out of order (XG records physical play order), so scan ahead for
        # the continuation and swap it into place. Stop at an intermediate hit.
        while cur_to >= 0 and board_at(cur_to) != -1:
            j = next((k for k in range(i + 1, n) if move_list[k][0] == cur_to), None)
            if j is None:
                break
            move_list[i + 1], move_list[j] = move_list[j], move_list[i + 1]
            apply_move(move_list[i][0], cur_to)
            i += 1
            cur_to = move_list[i][1]

        # Apply the final (or only) segment; detect a hit at the destination.
        hit = cur_to >= 0 and board_at(cur_to) == -1
        apply_move(move_list[i][0], cur_to)

        parts.append(
            (chain_from, f"{_point_name(chain_from)}/{_point_name(cur_to)}{'*' if hit else ''}")
        )
        i += 1

    # Canonical ordering: by from-point descending, so equivalent move sets
    # (same checkers, different storage order) render identically.
    parts.sort(key=lambda x: (-x[0], x[1]))
    return " ".join(segment for _, segment in parts)


def played_candidate_index(
    played: tuple[MoveDetail, ...],
    candidates: tuple[MoveCandidate, ...],
    position: Position,
) -> int | None:
    """Index of the candidate matching the *played* move, or ``None``.

    The XG file records the played move (as raw checker hops) separately from the
    engine's ranked candidate list, so identifying which candidate was played means
    matching by canonical notation from *position* (this normalises equivalent hop
    orderings and transpositions). Returns ``None`` when the played move is not
    among the candidates (unanalysed, or a transposition XG did not list — always a
    near-zero-error case in practice).
    """
    if not candidates:
        return None
    target = format_moves(played, position)
    for i, candidate in enumerate(candidates):
        if format_moves(candidate.moves, position) == target:
            return i
    return None
