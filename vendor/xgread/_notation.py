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
    """Human name for a 0-based point: ``Off`` / ``Bar`` / ``1``..``24``."""
    if point < 0:
        return "Off"
    if point == 24:  # player's bar in 0-based coordinates
        return "Bar"
    return str(point + 1)


def _apply_moves(
    moves: tuple[MoveDetail, ...],
    position: Position,
) -> tuple[tuple[int, ...], list[tuple[int, int, bool]]]:
    """Apply XG's stored move segments in their recorded order.

    Returns the resulting board plus ``(from, to, hit)`` metadata for each
    stored segment.  XG already stores the segmentation it wants to display;
    do not merge adjacent segments here.
    """
    board = list(position.points)
    rendered: list[tuple[int, int, bool]] = []

    for move in moves:
        from_0 = move.from_point
        to_0 = move.die

        src = from_0 + 1
        if 1 <= src <= 25:
            board[src] -= 1

        hit = False
        if to_0 >= 0:
            dst = to_0 + 1
            if 1 <= dst <= 24:
                hit = board[dst] == -1
                if hit:
                    board[dst] = 1
                    board[0] -= 1
                else:
                    board[dst] += 1

        rendered.append((from_0, to_0, hit))

    return tuple(board), rendered


def format_moves(moves: tuple[MoveDetail, ...], position: Position) -> str:
    """Render *moves* using XG's stored segmentation and ordering conventions.

    XG stores the checker-move segments themselves.  We preserve those segments,
    determine hits in the recorded play order, then display them in descending
    point order (Bar first, then higher points to lower points).  Identical
    segments are compacted later by the consumer as ``(2)``, ``(3)``, etc.

    Returns ``"Cannot Move"`` for a dance.
    """
    if not moves:
        return "Cannot Move"

    _, rendered = _apply_moves(moves, position)

    # XG display order: source point descending; for the same source, the higher
    # destination first.  Python's numeric point 24 represents Bar.
    rendered.sort(key=lambda item: (-item[0], -item[1]))

    return " ".join(
        f"{_point_name(from_0)}/{_point_name(to_0)}{'*' if hit else ''}"
        for from_0, to_0, hit in rendered
    )


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

    target_position, _ = _apply_moves(played, position)
    for i, candidate in enumerate(candidates):
        candidate_position, _ = _apply_moves(candidate.moves, position)
        if candidate_position == target_position:
            return i
    return None
