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


def _collapse_unambiguous_hops(
    rendered: list[tuple[int, int, bool]],
) -> list[tuple[int, int, bool]]:
    """Collapse consecutive hops that unambiguously belong to one checker.

    XG-style notation joins through an intermediate point only when exactly one
    stored hop enters that point and exactly one stored hop leaves it.  This
    collapses ``12/10 10/6`` to ``12/6`` and, inside a larger doubles move,
    ``21/15 15/9`` to ``21/9``.

    Ambiguous traffic is not joined.  For example, ``6/4(2) 4/2(2)`` stays as
    two grouped moves because two checkers enter and two leave point 4.

    A hit also ends the displayed segment so the hit point remains explicit.
    """
    if len(rendered) < 2:
        return rendered[:]

    incoming: dict[int, list[int]] = {}
    outgoing: dict[int, list[int]] = {}

    for index, (from_0, to_0, _) in enumerate(rendered):
        outgoing.setdefault(from_0, []).append(index)
        if to_0 >= 0:
            incoming.setdefault(to_0, []).append(index)

    predecessor: dict[int, int] = {}
    successor: dict[int, int] = {}

    for point_0, incoming_edges in incoming.items():
        outgoing_edges = outgoing.get(point_0, [])
        if len(incoming_edges) != 1 or len(outgoing_edges) != 1:
            continue

        before = incoming_edges[0]
        after = outgoing_edges[0]

        # Preserve an intermediate hit marker instead of hiding it inside a
        # longer source/destination pair.
        if rendered[before][2]:
            continue

        successor[before] = after
        predecessor[after] = before

    collapsed: list[tuple[int, int, bool]] = []
    visited: set[int] = set()

    # Start with edges that are not continuations of another collapsible edge.
    starts = [index for index in range(len(rendered)) if index not in predecessor]

    for start in starts:
        if start in visited:
            continue

        from_0 = rendered[start][0]
        current = start
        final_to = rendered[current][1]
        final_hit = rendered[current][2]
        visited.add(current)

        while current in successor:
            next_edge = successor[current]
            if next_edge in visited:
                break
            current = next_edge
            final_to = rendered[current][1]
            final_hit = rendered[current][2]
            visited.add(current)

        collapsed.append((from_0, final_to, final_hit))

    # Defensive fallback for any cycle/malformed edge set.
    for index, edge in enumerate(rendered):
        if index not in visited:
            collapsed.append(edge)

    return collapsed


def format_moves(moves: tuple[MoveDetail, ...], position: Position) -> str:
    """Render *moves* using XG-style checker notation.

    Consecutive hops made by one checker are collapsed whenever the intermediate
    point has one incoming and one outgoing hop.  The final display is ordered
    by source point descending.  Identical displayed segments are compacted by
    the consumer as ``(2)``, ``(3)``, etc.

    Returns ``"Cannot Move"`` for a dance.
    """
    if not moves:
        return "Cannot Move"

    _, rendered = _apply_moves(moves, position)
    display_segments = _collapse_unambiguous_hops(rendered)

    # XG display order: source point descending; for the same source, higher
    # destination first.  Point 24 represents Bar.
    display_segments.sort(key=lambda item: (-item[0], -item[1]))

    return " ".join(
        f"{_point_name(from_0)}/{_point_name(to_0)}{'*' if hit else ''}"
        for from_0, to_0, hit in display_segments
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
