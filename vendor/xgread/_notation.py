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


def _single_checker_chain(
    rendered: list[tuple[int, int, bool]],
) -> list[tuple[int, int, bool]] | None:
    """Return the ordered path when every stored hop belongs to one checker.

    XG collapses a move such as ``12/10 10/6`` to ``12/6``.  We only do this
    when the *entire* move is one continuous checker path.  This is important
    for doubles: if several checkers move, segments such as ``6/4 4/2`` must
    remain separate so that XG-style multiplicities can be shown correctly.

    A hit ends one display segment because the hit point itself must remain
    visible (e.g. ``13/12* 12/7`` rather than hiding the intermediate hit).
    """
    if len(rendered) < 2:
        return None

    # XG stores physical play order.  A one-checker move is therefore a single
    # continuous path: each destination is the next segment's source.
    if any(
        rendered[index][1] < 0 or rendered[index][1] != rendered[index + 1][0]
        for index in range(len(rendered) - 1)
    ):
        return None

    return rendered


def _format_single_checker_chain(
    chain: list[tuple[int, int, bool]],
) -> str:
    """Collapse a one-checker path, preserving intermediate hit points."""
    parts: list[str] = []
    segment_from = chain[0][0]

    for index, (_, to_0, hit) in enumerate(chain):
        is_last = index == len(chain) - 1
        if hit or is_last:
            parts.append(
                f"{_point_name(segment_from)}/{_point_name(to_0)}{'*' if hit else ''}"
            )
            if not is_last:
                segment_from = to_0

    return " ".join(parts)


def format_moves(moves: tuple[MoveDetail, ...], position: Position) -> str:
    """Render *moves* using XG-style checker notation.

    Rules used here:
    * a move made by one checker only is collapsed (``12/10 10/6`` -> ``12/6``);
    * an intermediate hit remains visible;
    * when multiple checkers move, stored segments stay separate;
    * multi-checker segments are displayed by source point descending;
    * identical segments are compacted later by the consumer as ``(2)``,
      ``(3)``, etc.

    Returns ``"Cannot Move"`` for a dance.
    """
    if not moves:
        return "Cannot Move"

    _, rendered = _apply_moves(moves, position)

    single_chain = _single_checker_chain(rendered)
    if single_chain is not None:
        return _format_single_checker_chain(single_chain)

    # XG display order for multi-checker moves: source point descending; for the
    # same source, the higher destination first.  Point 24 represents Bar.
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
