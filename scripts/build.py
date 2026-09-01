#!/usr/bin/env python3
"""Build the static backgammon drill database from XG/XGP files anywhere under imports/."""

from __future__ import annotations

import hashlib
import html
import json
import re
import math
import shutil
import sys
import subprocess
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

import xgread  # noqa: E402
from xgread import CubeAction, Evaluation, Move  # noqa: E402
from xgread._notation import _apply_moves  # noqa: E402

IMPORTS_DIR = ROOT / "imports"
DIST_DIR = ROOT / "dist"
BOARD_DIR = DIST_DIR / "assets" / "boards"
DATA_DIR = DIST_DIR / "data"
CONFIG_PATH = ROOT / "config.json"


SUPPORTED_XG_SUFFIXES = {".xg", ".xgp"}


def imported_source_files() -> list[Path]:
    """Return XG/XGP sources recursively, case-insensitively.

    GitHub Actions runs on Linux, where pathlib glob patterns are case-sensitive.
    eXtreme Gammon files can arrive as .XG/.XGP as well as lowercase, so suffix
    comparison must not rely on rglob("*.xgp").
    """
    return sorted(
        (
            path
            for path in IMPORTS_DIR.rglob("*")
            if path.is_file() and path.suffix.casefold() in SUPPORTED_XG_SUFFIXES
        ),
        key=lambda path: path.as_posix().casefold(),
    )


def is_xgp_source(source: Path) -> bool:
    return source.suffix.casefold() == ".xgp"


def primary_decisions(source: Path, match: Any) -> list[Any]:
    """Return drill decisions for one source.

    XGP is a standalone-position export, not a played match.  When XG saves a
    checker-play position it may also attach a CubeAction record as context.
    In that case the Move is the actual drill question and the attached cube
    record must not create a second/spurious question.
    """
    decisions = list(match.decisions())
    if is_xgp_source(source) and any(isinstance(item.event, Move) for item in decisions):
        return [item for item in decisions if isinstance(item.event, Move)]
    return decisions


def xgp_identity(decisions: list[Any]) -> str:
    """Return a stable identity for a standalone XGP position export.

    Match.identity_hash intentionally hashes played history only.  Standalone
    XGP files often contain no played action, so many unrelated XGP positions
    otherwise collapse to the same match hash.  XGID + question kind describes
    the actual saved drill position and remains stable across re-analysis.
    """
    parts: list[str] = ["xgp-v1"]
    for decision in decisions:
        event = decision.event
        if isinstance(event, Move):
            kind = "checker"
        elif isinstance(event, CubeAction):
            kind = "take" if event.doubled and event.took is not None else "double"
        else:
            kind = type(event).__name__.casefold()
        parts.append(f"{kind}|{decision.xgid}")
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    return f"xgpid1-{digest}"


def source_uploaded_at(source: Path) -> str:
    """Return the latest Git commit time touching *source*.

    New is based on when the XG file was most recently uploaded/updated in this
    repository.  A simple ``git log -1`` is reliable for binary XG files and
    avoids rename/history reconstruction failures.

    If Git metadata is unexpectedly unavailable, use build time rather than
    silently excluding the file from New.
    """
    try:
        relative = source.relative_to(ROOT).as_posix()
    except ValueError:
        return datetime.now(UTC).isoformat()

    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(ROOT),
                "log",
                "-1",
                "--format=%cI",
                "--",
                relative,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        result = None

    if result is not None and result.returncode == 0:
        timestamps = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if timestamps:
            return timestamps[0]

    fallback = datetime.now(UTC).isoformat()
    print(
        f"WARNING: Git upload time unavailable for {source.name}; "
        f"using build time {fallback}"
    )
    return fallback


NEW_POSITION_WINDOW = timedelta(days=7)


def source_is_new(uploaded_at: str, now: datetime | None = None) -> bool:
    """Return whether an XG source belongs to New at build time.

    This is intentionally evaluated in Python during the Pages build so the
    browser does not have to parse Git timestamps or depend on the device clock.
    A small five-minute future tolerance covers clock skew.
    """
    try:
        uploaded = datetime.fromisoformat(uploaded_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False

    if uploaded.tzinfo is None:
        uploaded = uploaded.replace(tzinfo=UTC)
    else:
        uploaded = uploaded.astimezone(UTC)

    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    else:
        current = current.astimezone(UTC)

    age = current - uploaded
    return timedelta(minutes=-5) <= age <= NEW_POSITION_WINDOW


def load_config() -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "databaseTitle": "Position Drill",
        "errorThreshold": 0.02,
        "blunderThreshold": 0.08,
        "includeCheckerErrors": True,
        "includeCubeErrors": True,
        "includeTakeErrors": True,
        "anonymizeOpponents": False,
        "themeColor": "#B7924B",
    }
    if not CONFIG_PATH.exists():
        return defaults
    loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {**defaults, **loaded}


def player_name(match: Any, sign: int) -> str:
    return match.header.player1 if sign == 1 else match.header.player2


def bottom_player_sign(match: Any) -> int:
    """Return the player displayed on the bottom side in the source XG file.

    Extreme Gammon stores the board orientation in MatchHeader.invert.  In the
    source files used by Position Drill, a positive value means Player 1 is on
    the bottom; a negative value means Player 2 is on the bottom.  Position
    Drill treats that bottom player as the drill owner, independent of name.
    """
    invert = int(match.header.invert)
    if invert > 0:
        return 1
    if invert < 0:
        return -1
    raise ValueError("XG board orientation is missing: MatchHeader.invert is 0")


def is_drill_owner(match: Any, player_sign: int) -> bool:
    return int(player_sign) == bottom_player_sign(match)


def classification(loss: float, blunder_threshold: float) -> str:
    return "Blunder" if loss >= blunder_threshold else "Error"


def valid_probability_evaluation(evaluation: Evaluation | None) -> bool:
    """Return True only for a real XG probability vector.

    Some XG files keep unused candidate slots with the NOT_ANALYSED sentinel
    (-1000) and an all-zero probability vector.  Those records are placeholders,
    not genuine 0% positions, and must never be published or used as fallbacks.
    """
    if evaluation is None:
        return False

    values = (
        evaluation.win_single,
        evaluation.win_gammon,
        evaluation.win_bg,
        evaluation.lose_single,
        evaluation.lose_gammon,
        evaluation.lose_bg,
        evaluation.equity,
    )
    if not all(math.isfinite(float(value)) for value in values):
        return False
    if abs(float(evaluation.equity) - float(xgread.NOT_ANALYSED)) < 1e-6:
        return False

    win = float(evaluation.win_single)
    win_g = float(evaluation.win_gammon)
    win_bg = float(evaluation.win_bg)
    lose = float(evaluation.lose_single)
    lose_g = float(evaluation.lose_gammon)
    lose_bg = float(evaluation.lose_bg)

    if not (0.0 <= win <= 1.0 and 0.0 <= lose <= 1.0):
        return False
    if not (0.0 <= win_bg <= win_g <= win + 1e-6):
        return False
    if not (0.0 <= lose_bg <= lose_g <= lose + 1e-6):
        return False
    return abs((win + lose) - 1.0) <= 0.02


def probability_fields(evaluation: Evaluation | None, invert: bool = False) -> dict[str, float | None]:
    if not valid_probability_evaluation(evaluation):
        return {
            "winRate": None,
            "gammonWinRate": None,
            "backgammonWinRate": None,
            "loseRate": None,
            "gammonLoseRate": None,
            "backgammonLoseRate": None,
            "equity": None,
        }

    # XG stores these fields cumulatively: win_single is total wins, win_gammon
    # includes backgammons, and lose_single is total losses.
    if invert:
        return {
            "winRate": evaluation.lose_single,
            "gammonWinRate": evaluation.lose_gammon,
            "backgammonWinRate": evaluation.lose_bg,
            "loseRate": evaluation.win_single,
            "gammonLoseRate": evaluation.win_gammon,
            "backgammonLoseRate": evaluation.win_bg,
            "equity": -evaluation.equity,
        }

    return {
        "winRate": evaluation.win_single,
        "gammonWinRate": evaluation.win_gammon,
        "backgammonWinRate": evaluation.win_bg,
        "loseRate": evaluation.lose_single,
        "gammonLoseRate": evaluation.lose_gammon,
        "backgammonLoseRate": evaluation.lose_bg,
        "equity": evaluation.equity,
    }


def played_move_evaluation(move: Move) -> Evaluation | None:
    """Return the analysed evaluation for the move that was actually played.

    XG usually lets ``Move.played_index`` identify the played candidate directly.
    Some exports omit that match in two recoverable situations:

    * dances / no-move turns, where XG stores a dummy candidate move sequence;
    * rare records where the played checker sequence itself is absent from the
      ranked list, but ``ErrMove`` still identifies its evaluation equity.

    Recover both so every non-opening checker turn can reuse the preceding
    move's after-move evaluation as the next player's exact pre-roll baseline.
    """
    played_index = move.played_index
    if played_index is not None and 0 <= played_index < len(move.candidates):
        evaluation = move.candidates[played_index].evaluation
        if valid_probability_evaluation(evaluation):
            return evaluation

    valid_candidates = [
        candidate for candidate in move.candidates
        if valid_probability_evaluation(candidate.evaluation)
    ]
    if not valid_candidates:
        return None

    # XG dances are encoded with no played checker hops, while the sole engine
    # candidate may contain dummy 0/0 hops.  There is still only one analysed
    # result, so it is unambiguous.
    if not move.moves and len(valid_candidates) == 1:
        return valid_candidates[0].evaluation

    # In a handful of XG records the played sequence is missing from the
    # candidate list even though ErrMove is present.  ErrMove is the equity loss
    # from the engine's best candidate, so it pins down the played evaluation's
    # equity.  Match that inferred equity back to the stored probability vector.
    if move.is_analysed and math.isfinite(float(move.error)):
        best_equity = max(float(candidate.evaluation.equity) for candidate in valid_candidates)
        target_equity = best_equity - abs(float(move.error))
        closest = min(
            valid_candidates,
            key=lambda candidate: abs(float(candidate.evaluation.equity) - target_equity),
        )
        if abs(float(closest.evaluation.equity) - target_equity) <= 1e-5:
            return closest.evaluation

    return None


def checker_pre_roll_probability_fields(decisions: list[Any], index: int) -> dict[str, float | None]:
    """Return Checker Play probabilities for the position before the dice roll.

    XG normally stores a CubeAction record immediately before every checker
    move. Its No Double (or accepted Double/Take) analysis evaluates the same
    board before the dice are rolled, so prefer that vector. If that cube
    analysis is unavailable and no cube was turned, the previous played checker
    move ends at the same board; invert that mover's evaluation into the current
    player's perspective.

    Never substitute the current played move's after-move evaluation. When an
    exact pre-roll vector is unavailable, publish nulls so the UI displays an
    em dash rather than misleading post-move percentages.
    """
    empty = probability_fields(None)
    if index < 0 or index >= len(decisions):
        return empty

    decision = decisions[index]
    move = getattr(decision, "event", None)
    if not isinstance(move, Move):
        return empty

    if index > 0:
        previous = decisions[index - 1]
        if previous.game_number == decision.game_number and isinstance(previous.event, CubeAction):
            previous_cube = previous.event
            if previous_cube.player == move.player:
                evaluation = (
                    previous_cube.double_take_analysis
                    if previous_cube.doubled and previous_cube.took
                    else previous_cube.no_double_analysis
                )
                if valid_probability_evaluation(evaluation):
                    return probability_fields(evaluation)

            # Once the cube was actually turned, an earlier checker evaluation
            # belongs to the old cube state and is not a valid fallback.
            if previous_cube.doubled:
                return empty

    # Normal no-double turn with missing cube analysis: use the preceding
    # opponent move's analysed played result, which is the same board before
    # this roll. XG stores it from that opponent's perspective.
    for prior_index in range(index - 1, -1, -1):
        prior = decisions[prior_index]
        if prior.game_number != decision.game_number:
            break
        prior_event = prior.event
        if isinstance(prior_event, CubeAction):
            continue
        if not isinstance(prior_event, Move):
            continue
        if prior_event.player == move.player:
            break
        evaluation = played_move_evaluation(prior_event)
        if valid_probability_evaluation(evaluation):
            return probability_fields(evaluation, invert=True)
        break

    return empty


def terminal_probability_fields(*, win: bool) -> dict[str, float]:
    """Return a terminal single-game result for an accepted Pass/Drop.

    Once a player passes, the game is over: the winner's game win rate is
    100%, the loser's is 0%, and no gammon/backgammon continuation remains.
    """
    return {
        "winRate": 1.0 if win else 0.0,
        "gammonWinRate": 0.0,
        "backgammonWinRate": 0.0,
        "loseRate": 0.0 if win else 1.0,
        "gammonLoseRate": 0.0,
        "backgammonLoseRate": 0.0,
        "equity": None,
    }


RATE_FIELD_KEYS = (
    "winRate",
    "gammonWinRate",
    "loseRate",
    "gammonLoseRate",
)


def first_available_evaluation(*evaluations: Evaluation | None) -> Evaluation | None:
    """Return the first genuine probability vector available for this position."""
    return next((evaluation for evaluation in evaluations if valid_probability_evaluation(evaluation)), None)


def valid_probability_mapping(values: dict[str, Any]) -> bool:
    """Validate the four rates after they have been converted to JSON fields."""
    try:
        win = float(values["winRate"])
        win_g = float(values["gammonWinRate"])
        lose = float(values["loseRate"])
        lose_g = float(values["gammonLoseRate"])
    except (KeyError, TypeError, ValueError):
        return False
    if not all(math.isfinite(value) for value in (win, win_g, lose, lose_g)):
        return False
    if not (0.0 <= win_g <= win <= 1.0 and 0.0 <= lose_g <= lose <= 1.0):
        return False
    return abs((win + lose) - 1.0) <= 0.02


def ensure_row_probabilities(row: dict[str, Any]) -> None:
    """Guarantee that every published position has W/GW/L/GL values.

    XG does not attach a probability vector to the terminal Pass action itself.
    In that case the probability vector from another analysed action at the same
    pre-response position (normally Double/Take) is the correct display source.
    We never invent percentages: if no analysed vector exists anywhere in the
    row, the build fails instead of publishing blank rates.
    """
    if valid_probability_mapping(row):
        return

    candidates = row.get("candidates") or []
    fallback = next((candidate for candidate in candidates if valid_probability_mapping(candidate)), None)
    if fallback is not None:
        for key in (*RATE_FIELD_KEYS, "backgammonWinRate", "backgammonLoseRate", "equity"):
            if fallback.get(key) is not None:
                row[key] = fallback[key]

    if not valid_probability_mapping(row):
        raise RuntimeError(
            f"No valid probability vector for {row.get('id', 'unknown position')}. "
            "The XG record contains only unanalysed placeholder data."
        )


def event_id(match_hash: str, game_number: int, move_number: int, decision_type: str, actor: str) -> str:
    raw = f"{match_hash}|{game_number}|{move_number}|{decision_type}|{actor.casefold()}"
    return "POS-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12].upper()


def score_for_sign(decision: Any, sign: int) -> tuple[int, int]:
    if sign == 1:
        return decision.score1, decision.score2
    return decision.score2, decision.score1


def cube_value_number(cube_value: int) -> int:
    return 1 if cube_value == 0 else 2 ** abs(cube_value)


def invalid_match_cube_reason(match: Any, decision: Any, cube: CubeAction) -> str | None:
    """Return why this cube decision is not legal in match play.

    The important match-play rule is the dead-cube rule: a player may not
    redouble when the cube's *current* value is already sufficient for that
    player to win the match.  Therefore a 7-point match can legally contain a
    4 -> 8 redouble, but never an 8 -> 16 redouble.

    Money / Unlimited play is intentionally exempt from match-score checks.
    """
    match_length = int(match.header.match_length)
    if match_length <= 0 or match_length >= 99999:
        return None

    game = next(
        (item for item in match.games if item.header.game_number == decision.game_number),
        None,
    )
    if game is not None and game.header.crawford_apply:
        return "doubling cube is unavailable in the Crawford game"

    actor_score, _ = score_for_sign(decision, cube.player)
    actor_away = match_length - int(actor_score)
    current_cube = cube_value_number(cube.cube_value)

    if actor_away <= 0:
        return "match has already been won"
    if current_cube >= actor_away:
        return (
            f"dead cube: current cube {current_cube} is already sufficient "
            f"for the doubler at {actor_away}-away"
        )

    # A redouble is only available to the current cube owner.
    if cube.cube_value != 0:
        owner_sign = 1 if cube.cube_value > 0 else -1
        if owner_sign != int(cube.player):
            return "redouble attempted by the player who does not own the cube"

    return None


def position_for_view(points: tuple[int, ...] | list[int], black_sign: int) -> list[int]:
    """Return a board normalized so the selected player is black/on-roll.

    xgread stores point signs from player 1's perspective.  When player 2 is
    shown as black, reverse the point numbers, swap the bars, and invert signs.
    """
    source = [int(value) for value in points]
    if black_sign == 1:
        return source

    flipped = [0] * 26
    flipped[0] = -source[25]
    flipped[25] = -source[0]
    for point in range(1, 25):
        flipped[point] = -source[25 - point]
    return flipped


def cube_owner_for_view(cube_value: int, black_sign: int) -> str:
    """Map XG's player-relative cube sign to the displayed black/white view."""
    if cube_value == 0:
        return "center"
    owner_sign = 1 if cube_value > 0 else -1
    return "onRoll" if owner_sign == black_sign else "opponent"


def compact_move_notation(
    notation: str,
    dice: tuple[int, int] | list[int] | None = None,
) -> str:
    """Render checker notation compactly, matching XG2 doubles conventions.

    The base xgread formatter deliberately avoids joining through an
    intermediate point when several checkers enter or leave that point.  XG2
    is more aggressive for doubles: it prefers to continue one of the moved
    checkers through the shared point.  For example::

      13/11 8/6 6/4 6/4* -> 13/11 8/4* 6/4
      8/6 6/5 6/5*       -> 8/5* 6/5
      Bar/23* 6/4 4/2(2) -> Bar/23* 6/2 4/2
      Bar/24 24/23(2) 9/8 -> Bar/23 24/23 9/8

    Non-doubles keep the previous behaviour: identical displayed segments are
    grouped as ``(2)``, ``(3)``, etc., with a hit marker if any copy hits.
    """
    text = str(notation)
    tokens = text.split()
    if len(tokens) < 2:
        return text

    # Each entry is [source, destination, hit, original_order].  Expand an
    # existing ``(n)`` so the doubles-specific chaining step can move just one
    # checker from a repeated segment.  ``*(n)`` means the group contains a hit;
    # only one of identical arrivals can hit the blot, so only one expanded copy
    # carries the star.
    segments: list[list[Any]] = []
    for order, token in enumerate(tokens):
        match = re.fullmatch(r"([^/\s]+)/([^/\s]+?)(\*)?(?:\((\d+)\))?", token)
        if not match:
            # Preserve an unrecognised token as an opaque segment.  It cannot
            # participate in chaining, but grouping below will still leave it
            # intact.
            segments.append([token, "", False, order])
            continue

        source = match.group(1)
        destination = match.group(2)
        has_hit = bool(match.group(3))
        count = max(1, int(match.group(4) or 1))
        for copy_index in range(count):
            segments.append([source, destination, has_hit and copy_index == 0, order + copy_index / 100.0])

    is_double = bool(dice and len(dice) >= 2 and int(dice[0]) == int(dice[1]))
    if is_double:
        # XG2's doubles notation follows one checker through a shared
        # intermediate point even when more than one checker also leaves that
        # point.  Never hide a hit at the intermediate point.  When one of the
        # outgoing copies hits, consume that copy first so the star stays on the
        # continued checker (e.g. 8/5* 6/5 rather than 8/5 6/5*).
        while True:
            pair: tuple[int, int] | None = None
            best_key: tuple[int, float, float] | None = None

            for incoming_index, incoming in enumerate(segments):
                source, intermediate, incoming_hit, incoming_order = incoming
                if incoming_hit or not intermediate:
                    continue
                for outgoing_index, outgoing in enumerate(segments):
                    if incoming_index == outgoing_index:
                        continue
                    outgoing_source, _, outgoing_hit, outgoing_order = outgoing
                    if intermediate != outgoing_source:
                        continue

                    # Prefer a hitting continuation, then preserve the source
                    # order produced by xgread as a deterministic tiebreaker.
                    key = (0 if outgoing_hit else 1, float(incoming_order), float(outgoing_order))
                    if best_key is None or key < best_key:
                        best_key = key
                        pair = (incoming_index, outgoing_index)

            if pair is None:
                break

            incoming_index, outgoing_index = pair
            incoming = segments[incoming_index]
            outgoing = segments[outgoing_index]
            merged = [incoming[0], outgoing[1], bool(outgoing[2]), min(float(incoming[3]), float(outgoing[3]))]

            # Remove higher index first, then append the merged path.  A second
            # pass may extend it again (e.g. four identical dice used by one
            # checker over several points).
            for index in sorted(pair, reverse=True):
                segments.pop(index)
            segments.append(merged)

    def point_rank(name: str) -> int:
        if name == "Bar":
            return 25
        if name == "Off":
            return -1
        try:
            return int(name)
        except (TypeError, ValueError):
            return -2

    # XG display order is source point descending.  For a shared source, show
    # the higher destination first.  This also restores the canonical order
    # after doubles-specific paths have been merged above.
    segments.sort(
        key=lambda item: (
            -point_rank(str(item[0])),
            -point_rank(str(item[1])),
            float(item[3]),
        )
    )

    grouped: dict[tuple[str, str], dict[str, int | bool]] = {}
    order: list[tuple[str, str]] = []
    opaque: list[str] = []

    for source, destination, is_hit, _ in segments:
        if not destination:
            opaque.append(str(source))
            continue
        key = (str(source), str(destination))
        if key not in grouped:
            grouped[key] = {"count": 0, "hit": False}
            order.append(key)
        grouped[key]["count"] = int(grouped[key]["count"]) + 1
        grouped[key]["hit"] = bool(grouped[key]["hit"]) or bool(is_hit)

    compacted: list[str] = []
    for source, destination in order:
        info = grouped[(source, destination)]
        count = int(info["count"])
        hit = "*" if info["hit"] else ""
        suffix = f"({count})" if count > 1 else ""
        compacted.append(f"{source}/{destination}{hit}{suffix}")

    compacted.extend(opaque)
    return " ".join(compacted)


def checker_move_highlights(
    before_view: list[int],
    after_view: list[int],
    mover_sign: int,
) -> dict[str, Any]:
    """Return the moved checkers' final locations in the displayed position.

    The move itself can contain chained hops (13/8/5), hits, bar entries and
    bear-offs.  Comparing only the mover's checker counts before/after leaves
    intermediate points unhighlighted and does not accidentally highlight an
    opponent checker sent to the bar by a hit.
    """
    sign = 1 if int(mover_sign) >= 0 else -1

    def side_count(value: int) -> int:
        return max(sign * int(value), 0)

    points: dict[str, int] = {}
    for point in range(26):
        increase = side_count(after_view[point]) - side_count(before_view[point])
        if increase > 0:
            points[str(point)] = increase

    before_on_board = sum(side_count(value) for value in before_view)
    after_on_board = sum(side_count(value) for value in after_view)
    off_increase = max(0, before_on_board - after_on_board)

    # A checker hit by the mover is the only opponent checker that actually
    # moves during this checker play.  Track the increase on the opponent bar
    # separately so the rendered result can outline only the newly hit
    # checker(s), even when the opponent already had checkers on the bar.
    opponent_sign = -sign

    def opponent_side_count(value: int) -> int:
        return max(opponent_sign * int(value), 0)

    # In the normalized display, the opponent bar is index 0 when the mover is
    # black/on-roll (the normal rendered case), and index 25 for the mirrored
    # case.  Derive the bar slot from the mover sign instead of assuming black.
    opponent_bar_index = 0 if sign == 1 else 25
    opponent_bar_increase = max(
        0,
        opponent_side_count(after_view[opponent_bar_index])
        - opponent_side_count(before_view[opponent_bar_index]),
    )

    return {
        "sign": sign,
        "points": points,
        "off": off_increase,
        "opponentBar": opponent_bar_increase,
    }


def pip_counts_for_view(points: list[int] | tuple[int, ...]) -> tuple[int, int]:
    """Return displayed black/white pip counts for a normalized board view."""
    black = sum(point * max(int(points[point]), 0) for point in range(1, 25))
    black += 25 * max(int(points[25]), 0)
    white = sum((25 - point) * max(-int(points[point]), 0) for point in range(1, 25))
    white += 25 * max(-int(points[0]), 0)
    return black, white


def candidate_payload(move: Move) -> list[dict[str, Any]]:
    """Return only genuinely analysed checker candidates, best to worst.

    XG may store the played move in an unused candidate slot whose evaluation is
    all zero and whose equity is -1000.  Filtering those placeholders prevents
    both false 0.0% rates and absurd -1000.xxx error values.

    Internal ``_positionAfter`` / ``_moveHighlights`` fields are consumed later
    by the build step to render selectable move-result boards.
    """
    valid_candidates = [
        candidate for candidate in move.candidates
        if valid_probability_evaluation(candidate.evaluation)
    ]
    valid_candidates.sort(key=lambda candidate: float(candidate.evaluation.equity), reverse=True)
    if not valid_candidates:
        return []

    before_view = position_for_view(move.position_before.points, move.player)
    mover_sign = 1 if int(move.player) >= 0 else -1
    best_equity = float(valid_candidates[0].evaluation.equity)
    rows: list[dict[str, Any]] = []
    for rank, candidate in enumerate(valid_candidates, start=1):
        equity_loss = max(0.0, best_equity - float(candidate.evaluation.equity))
        after_points, _ = _apply_moves(candidate.moves, move.position_before)
        after_view = position_for_view(after_points, move.player)
        pip_black, pip_white = pip_counts_for_view(after_view)
        rows.append(
            {
                "rank": rank,
                "action": compact_move_notation(xgread.format_moves(candidate.moves, move.position_before), move.dice),
                "equityLoss": equity_loss,
                "pipBlack": pip_black,
                "pipWhite": pip_white,
                "_positionAfter": after_view,
                "_moveHighlights": checker_move_highlights(before_view, after_view, mover_sign),
                **probability_fields(candidate.evaluation),
            }
        )
    return rows


def cube_action_labels(cube: CubeAction) -> dict[str, str]:
    """Return XG-style action labels for an initial double or a redouble."""
    offer = "Double" if cube.cube_value == 0 else "Redouble"
    return {
        "no_offer": f"No {offer}",
        "take": f"{offer}/Take",
        "pass": f"{offer}/Pass",
    }


def cube_candidate_payload(
    cube: CubeAction,
    position_evaluation: Evaluation | None,
) -> list[dict[str, Any]]:
    """Return the three XG cube outcomes in a fixed order.

    The comparison reference follows XG's selected cube decision:

    - No Double / No Redouble / Too Good -> no-offer row
    - Double/Take / Redouble/Take -> take row
    - Double/Pass / Redouble/Pass -> pass row

    The reference row is left blank instead of displaying +0.000.  Other rows
    show their signed equity difference from that reference.
    """
    labels = cube_action_labels(cube)
    best_action = best_double_action(cube)

    no_offer_equity = float(cube.no_double_equity)
    take_equity = float(cube.double_take_equity)
    pass_equity = float(cube.double_drop_equity)

    if best_action == labels["take"]:
        reference_key = "take"
        reference_equity = take_equity
    elif best_action == labels["pass"]:
        reference_key = "pass"
        reference_equity = pass_equity
    else:
        # No Double / No Redouble and both Too Good variants compare against
        # continuing without turning the cube.
        reference_key = "no_offer"
        reference_equity = no_offer_equity

    current_cube = cube_value_number(cube.cube_value)
    current_owner = "center" if cube.cube_value == 0 else "onRoll"
    raw_rows = [
        (
            "no_offer",
            labels["no_offer"],
            no_offer_equity,
            first_available_evaluation(cube.no_double_analysis, position_evaluation),
        ),
        ("take", labels["take"], take_equity, position_evaluation),
        ("pass", labels["pass"], pass_equity, None),
    ]

    return [
        {
            "rank": order,
            "action": action,
            "equityDifference": None if key == reference_key else equity - reference_equity,
            "cubeValue": current_cube if key == "no_offer" else current_cube * 2,
            "cubeOwner": current_owner if key == "no_offer" else "opponent",
            **(
                terminal_probability_fields(win=True)
                if key == "pass"
                else probability_fields(evaluation)
            ),
        }
        for order, (key, action, equity, evaluation) in enumerate(raw_rows, start=1)
    ]

def make_checker_row(
    match: Any,
    decision: Any,
    move: Move,
    cfg: dict[str, Any],
    *,
    standalone: bool = False,
    source_identity: str | None = None,
    pre_roll_rates: dict[str, float | None] | None = None,
) -> dict[str, Any] | None:
    actor = player_name(match, move.player)
    if not cfg["includeCheckerErrors"]:
        return None
    if not standalone and not is_drill_owner(match, move.player):
        return None

    played_index = move.played_index
    played_candidate = move.candidates[played_index] if played_index is not None else None

    # move.error is XG's authoritative error for the move actually played.
    # A matched candidate can be an unanalysed placeholder with equity -1000,
    # so its derived equity_loss must not be used as the displayed error.
    loss = abs(float(move.error)) if move.is_analysed and math.isfinite(float(move.error)) else 0.0
    actual_evaluation = first_available_evaluation(
        played_candidate.evaluation if played_candidate is not None else None,
        move.analysis,
        *(candidate.evaluation for candidate in move.candidates),
    )

    checker_candidates = candidate_payload(move)
    if standalone:
        # XGP is a saved analysis position.  It commonly has ErrMove=-1000
        # because there is no historical "played mistake" to score.  The
        # candidate analysis itself is the authoritative payload.
        if not checker_candidates:
            return None
        loss = 0.0
    elif loss + 1e-12 < float(cfg["errorThreshold"]):
        return None

    best_action = checker_candidates[0]["action"] if checker_candidates else "—"
    actor_score, opponent_score = score_for_sign(decision, move.player)
    opponent = player_name(match, -move.player)
    identity = source_identity or match.identity_hash
    row_id = event_id(identity, decision.game_number, decision.move_number, "checker", actor)
    pre_roll = pre_roll_rates if pre_roll_rates is not None else probability_fields(None)
    pre_roll_fields = {
        "preRollWinRate": pre_roll.get("winRate"),
        "preRollGammonWinRate": pre_roll.get("gammonWinRate"),
        "preRollBackgammonWinRate": pre_roll.get("backgammonWinRate"),
        "preRollLoseRate": pre_roll.get("loseRate"),
        "preRollGammonLoseRate": pre_roll.get("gammonLoseRate"),
        "preRollBackgammonLoseRate": pre_roll.get("backgammonLoseRate"),
        "preRollEquity": pre_roll.get("equity"),
    }

    return {
        "id": row_id,
        "decisionType": "checker",
        "decisionKind": "checker",
        "decisionLabel": "Checker Play",
        "classification": "Position" if standalone else classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": actor,
        "opponent": opponent,
        "onRollPlayer": actor,
        "onRollOpponent": opponent,
        "sourceFile": "",
        "matchId": identity,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": actor_score,
        "opponentScore": opponent_score,
        "onRollScore": actor_score,
        "onRollOpponentScore": opponent_score,
        "dice": f"{move.dice[0]}{move.dice[1]}",
        "diceValues": list(move.dice),
        "playedAction": "" if standalone else compact_move_notation(move.notation, move.dice),
        "bestAction": best_action,
        "xgid": decision.xgid,
        "cubeValue": cube_value_number(move.cube_value),
        "cubeOwner": cube_owner_for_view(move.cube_value, move.player),
        "position": position_for_view(move.position_before.points, move.player),
        "candidates": checker_candidates,
        **probability_fields(actual_evaluation),
        **pre_roll_fields,
        "matchDate": match.header.date.date().isoformat() if match.header.date else None,
    }


def cube_response(cube: CubeAction) -> str:
    """Return the responder's optimal action after a double or redouble."""
    return "Take" if cube.double_take_equity <= cube.double_drop_equity else "Pass"


def non_double_action(cube: CubeAction) -> str:
    """Return the best no-cube label, preserving XG's Too Good distinction.

    No Double and Too Good both decline to turn the cube.  XG distinguishes
    Too Good when playing on has more equity than cashing the game at the
    Double/Pass value.  The opponent's optimal response determines whether the
    displayed suffix is Take or Pass, including the rare Too Good/Take case.
    """
    response = cube_response(cube)
    if float(cube.no_double_equity) > float(cube.double_drop_equity) + 1e-12:
        return f"Too Good/{response}"
    return cube_action_labels(cube)["no_offer"]


def best_double_action(cube: CubeAction) -> str:
    labels = cube_action_labels(cube)
    response = cube_response(cube)
    effective_double = min(cube.double_take_equity, cube.double_drop_equity)
    if effective_double > cube.no_double_equity + 1e-12:
        return labels["take"] if response == "Take" else labels["pass"]
    return non_double_action(cube)

def make_double_row(
    match: Any,
    decision: Any,
    cube: CubeAction,
    cfg: dict[str, Any],
    *,
    standalone: bool = False,
    source_identity: str | None = None,
) -> dict[str, Any] | None:
    actor_sign = cube.player
    actor = player_name(match, actor_sign)
    if not cfg["includeCubeErrors"]:
        return None
    if not standalone and not is_drill_owner(match, actor_sign):
        return None

    loss = abs(float(cube.error_double))
    if standalone:
        # Standalone XGP cube positions normally carry ErrCube=-1000 even
        # though their No Double / Double analysis is fully populated.
        analysis_values = (
            cube.no_double_equity,
            cube.double_take_equity,
            cube.double_drop_equity,
        )
        if not all(math.isfinite(float(value)) for value in analysis_values):
            return None
        loss = 0.0
    elif cube.error_double == xgread.NOT_ANALYSED or loss + 1e-12 < float(cfg["errorThreshold"]):
        return None

    invalid_reason = invalid_match_cube_reason(match, decision, cube)
    if invalid_reason is not None:
        print(
            "WARNING: Skipping invalid Double Action "
            f"{match.identity_hash} Game{decision.game_number} Move{decision.move_number}: "
            f"{invalid_reason}"
        )
        return None

    labels = cube_action_labels(cube)
    actual = (
        non_double_action(cube)
        if not cube.doubled
        else (labels["take"] if cube.took else labels["pass"])
    )
    position_evaluation = first_available_evaluation(
        cube.double_take_analysis,
        cube.no_double_analysis,
    )
    if not cube.doubled:
        actual_eval = first_available_evaluation(cube.no_double_analysis, position_evaluation)
    else:
        # Pass is terminal and therefore has no probability vector of its own.
        # Use the analysed Double/Take continuation from the same position.
        actual_eval = position_evaluation

    actor_score, opponent_score = score_for_sign(decision, actor_sign)
    opponent = player_name(match, -actor_sign)
    identity = source_identity or match.identity_hash
    row_id = event_id(identity, decision.game_number, decision.move_number, "double", actor)
    return {
        "id": row_id,
        "decisionType": "cube",
        "decisionKind": "double",
        "decisionLabel": "Cube Action",
        "classification": "Position" if standalone else classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": actor,
        "opponent": opponent,
        "onRollPlayer": actor,
        "onRollOpponent": opponent,
        "sourceFile": "",
        "matchId": identity,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": actor_score,
        "opponentScore": opponent_score,
        "onRollScore": actor_score,
        "onRollOpponentScore": opponent_score,
        "dice": "—",
        "diceValues": [],
        "playedAction": "" if standalone else actual,
        "bestAction": best_double_action(cube),
        "xgid": decision.xgid,
        "cubeValue": cube_value_number(cube.cube_value),
        # A legal cube action can only be made with the cube centered or owned
        # by the doubler, who is always displayed as black.
        "cubeOwner": "center" if cube.cube_value == 0 else "onRoll",
        "position": position_for_view(cube.position.points, actor_sign),
        "candidates": cube_candidate_payload(cube, position_evaluation),
        **probability_fields(actual_eval),
        "matchDate": match.header.date.date().isoformat() if match.header.date else None,
    }


def take_quiz_candidate_payload(cube: CubeAction) -> list[dict[str, Any]]:
    """Return Take/Pass choices from the responder's perspective.

    XG stores cube equities from the doubler's perspective.  A responder wants
    the lower doubler equity, so negate both values before comparing them.
    The best response is listed first and the alternative shows its equity
    difference from the responder's best choice.
    """
    responder_rows = [
        ("Take", -float(cube.double_take_equity)),
        ("Pass", -float(cube.double_drop_equity)),
    ]
    responder_rows.sort(key=lambda item: item[1], reverse=True)
    best_equity = responder_rows[0][1]
    offered_cube = cube_value_number(cube.cube_value) * 2
    take_rates = probability_fields(
        first_available_evaluation(cube.double_take_analysis, cube.no_double_analysis),
        invert=True,
    )
    rows: list[dict[str, Any]] = []
    for rank, (action, equity) in enumerate(responder_rows, start=1):
        rows.append(
            {
                "rank": rank,
                "action": action,
                "equityDifference": None if rank == 1 else equity - best_equity,
                "cubeValue": offered_cube,
                # In the Take drill view the responder is black/bottom.  Once
                # Take is chosen the cube belongs to that black player; for a
                # Pass we keep the offered cube in the same visible location
                # to show the action being answered.
                "cubeOwner": "onRoll",
                **(
                    take_rates
                    if action == "Take"
                    else terminal_probability_fields(win=False)
                ),
            }
        )
    return rows


def make_take_row(
    match: Any,
    decision: Any,
    cube: CubeAction,
    cfg: dict[str, Any],
    *,
    standalone: bool = False,
    source_identity: str | None = None,
) -> dict[str, Any] | None:
    if not cube.doubled or cube.took is None or not cfg["includeTakeErrors"]:
        return None

    taker_sign = -cube.player
    taker = player_name(match, taker_sign)
    if not standalone and not is_drill_owner(match, taker_sign):
        return None

    loss = abs(float(cube.error_take))
    if standalone:
        analysis_values = (cube.double_take_equity, cube.double_drop_equity)
        if not all(math.isfinite(float(value)) for value in analysis_values):
            return None
        loss = 0.0
    elif cube.error_take == xgread.NOT_ANALYSED or loss + 1e-12 < float(cfg["errorThreshold"]):
        return None

    invalid_reason = invalid_match_cube_reason(match, decision, cube)
    if invalid_reason is not None:
        print(
            "WARNING: Skipping invalid Take Action "
            f"{match.identity_hash} Game{decision.game_number} Move{decision.move_number}: "
            f"{invalid_reason}"
        )
        return None

    labels = cube_action_labels(cube)
    actual = labels["take"] if cube.took else labels["pass"]
    # Even though the recorded error belongs to the responder, the combined
    # Cube Action row is displayed from the doubler's perspective.  Its bold
    # heading must therefore show the best decision for the whole cube action,
    # including No Double and Too Good outcomes.
    best = best_double_action(cube)
    # A terminal Pass has no separate probability vector.  The Double/Take
    # analysis describes the same pre-response board and supplies W/GW/L/GL.
    actual_eval = first_available_evaluation(
        cube.double_take_analysis,
        cube.no_double_analysis,
    )

    # The displayed Take quiz is the state immediately before the offer, but
    # keeps the drill owner (the receiver/taker) as black/bottom.  The doubler
    # is therefore white/top and is the on-roll side.
    doubler_sign = cube.player
    doubler = player_name(match, doubler_sign)
    doubler_score, taker_score = score_for_sign(decision, doubler_sign)
    quiz_rates = probability_fields(actual_eval, invert=True)
    identity = source_identity or match.identity_hash
    row_id = event_id(identity, decision.game_number, decision.move_number, "take", taker)

    return {
        "id": row_id,
        "decisionType": "cube",
        "decisionKind": "take",
        "decisionLabel": "Cube Action",
        "classification": "Position" if standalone else classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": doubler,
        "opponent": taker,
        "onRollPlayer": doubler,
        "onRollOpponent": taker,
        "sourceFile": "",
        "matchId": identity,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": doubler_score,
        "opponentScore": taker_score,
        "onRollScore": doubler_score,
        "onRollOpponentScore": taker_score,
        "dice": "—",
        "diceValues": [],
        "playedAction": "" if standalone else actual,
        "bestAction": best,
        "quizBestAction": cube_response(cube),
        "quizPlayedAction": "" if standalone else ("Take" if cube.took else "Pass"),
        "quizCandidates": take_quiz_candidate_payload(cube),
        "xgid": decision.xgid,
        "cubeValue": cube_value_number(cube.cube_value),
        # Main positions view: historical doubler perspective.
        "cubeOwner": "center" if cube.cube_value == 0 else "onRoll",
        "position": position_for_view(cube.position.points, doubler_sign),
        # Receiver/taker perspective used by the Take Action diagram and game info.
        "quizPosition": position_for_view(cube.position.points, taker_sign),
        "quizPlayer": taker,
        "quizOpponent": doubler,
        "quizPlayerScore": taker_score,
        "quizOpponentScore": doubler_score,
        "quizOnRollScore": taker_score,
        "quizOnRollOpponentScore": doubler_score,
        # Offered-cube response values are retained for Take/Pass analysis only.
        # The diagram/game info use cubeValue above, i.e. the pre-offer cube.
        "quizCubeValue": cube_value_number(cube.cube_value) * 2,
        "quizCubeOwner": "opponent",
        "quizWinRate": quiz_rates["winRate"],
        "quizGammonWinRate": quiz_rates["gammonWinRate"],
        "quizBackgammonWinRate": quiz_rates["backgammonWinRate"],
        "quizLoseRate": quiz_rates["loseRate"],
        "quizGammonLoseRate": quiz_rates["gammonLoseRate"],
        "quizBackgammonLoseRate": quiz_rates["backgammonLoseRate"],
        "candidates": cube_candidate_payload(cube, actual_eval),
        **probability_fields(actual_eval),
        "matchDate": match.header.date.date().isoformat() if match.header.date else None,
    }


def svg_text(text: str) -> str:
    return html.escape(str(text), quote=True)


def quiz_render_state(row: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Return the board row/turn marker used by the drill diagram.

    Cube-decision diagrams always show the state immediately BEFORE the offer.
    The drill owner remains black/bottom:
    - Double Action: owner/doubler is black and on roll.
    - Take Action: owner/receiver is black; doubler/on-roll is white/top.
    """
    if row.get("decisionKind") != "take" or not row.get("quizPosition"):
        return row, "black"

    quiz_row = {
        **row,
        "position": row["quizPosition"],
        "player": row.get("quizPlayer", row["player"]),
        "opponent": row.get("quizOpponent", row["opponent"]),
        "playerScore": row.get("quizPlayerScore", row["playerScore"]),
        "opponentScore": row.get("quizOpponentScore", row["opponentScore"]),
        "onRollScore": row.get("quizOnRollScore", row["onRollScore"]),
        "onRollOpponentScore": row.get(
            "quizOnRollOpponentScore",
            row["onRollOpponentScore"],
        ),
        # Keep the PRE-OFFER cube value. quizCubeValue is the offered value.
        "cubeValue": row["cubeValue"],
        # Before a redouble, the live cube belongs to the doubler, who is
        # white/top in Take Action. A centered cube stays centered.
        "cubeOwner": "center" if row["cubeOwner"] == "center" else "opponent",
    }
    return quiz_row, "white"


def cube_action_render_state(
    row: dict[str, Any],
    candidate: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Return the board state after selecting a cube-action candidate."""
    render_row, marker = quiz_render_state(row)
    action_row = dict(render_row)
    if candidate.get("cubeValue") is not None:
        action_row["cubeValue"] = candidate["cubeValue"]
    if candidate.get("cubeOwner"):
        action_row["cubeOwner"] = candidate["cubeOwner"]
    return action_row, marker


def render_board_svg(
    row: dict[str, Any],
    *,
    show_pip_counts: bool = True,
    on_roll_marker: str = "black",
    move_highlights: dict[str, Any] | None = None,
) -> str:
    """Render a clean monochrome bgLog/Minstrels-inspired board diagram.

    Rows are normalized before rendering: positive checkers are the displayed
    black side and negative checkers are the displayed white side.
    """
    width, height = 702, 546
    board_top, board_bottom = 28, 518
    top_label_y, bottom_label_y = 18, 540

    left_tray_x1, left_tray_x2 = 10.5, 58.5
    left_board_x1, left_board_x2 = 59.5, 326.5
    bar_x1, bar_x2 = 327.5, 374.5
    right_board_x1, right_board_x2 = 375.5, 644.5
    right_tray_x1, right_tray_x2 = 645.5, 691.5

    top_tip_y = 251
    bottom_tip_y = 294
    side_band_top, side_band_bottom = 247, 300
    score_x = (left_tray_x1 + left_tray_x2) / 2
    score_top_y = side_band_top - 14
    score_bottom_y = side_band_bottom + 31
    unlimited_y = (side_band_top + side_band_bottom) / 2 + 11
    point_w = (left_board_x2 - left_board_x1) / 6
    # Centre bar contents on the actually rendered bar: the left boundary is
    # the line at left_board_x2 and the right boundary is the line at bar_x2.
    bar_center = (left_board_x2 + bar_x2) / 2
    checker_r = 21.1

    points = row["position"]
    highlight_sign = int((move_highlights or {}).get("sign") or 0)
    highlight_points = {
        int(point): int(count)
        for point, count in ((move_highlights or {}).get("points") or {}).items()
        if str(point).lstrip("-").isdigit() and int(count) > 0
    }
    highlight_off = max(0, int((move_highlights or {}).get("off") or 0))
    highlight_color = "#6F5424"

    on_roll_pips = sum(point * max(int(points[point]), 0) for point in range(1, 25))
    on_roll_pips += 25 * max(int(points[25]), 0)
    opponent_pips = sum((25 - point) * max(-int(points[point]), 0) for point in range(1, 25))
    opponent_pips += 25 * max(-int(points[0]), 0)

    on_roll_on_board = sum(max(int(points[point]), 0) for point in range(1, 25)) + max(int(points[25]), 0)
    opponent_on_board = sum(max(-int(points[point]), 0) for point in range(1, 25)) + max(-int(points[0]), 0)
    on_roll_off = max(0, 15 - on_roll_on_board)
    opponent_off = max(0, 15 - opponent_on_board)

    elements: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Backgammon position {svg_text(row["id"])}">',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
        '<g stroke="#000000" stroke-linejoin="round">',
        f'<rect x="11" y="{board_top}" width="680" height="{board_bottom-board_top}" fill="#ffffff" stroke-width="4"/>',
        f'<line x1="{left_tray_x2}" y1="{board_top}" x2="{left_tray_x2}" y2="{board_bottom}" stroke-width="4"/>',
        f'<line x1="{left_board_x2}" y1="{board_top}" x2="{left_board_x2}" y2="{board_bottom}" stroke-width="4"/>',
        f'<line x1="{bar_x2}" y1="{board_top}" x2="{bar_x2}" y2="{board_bottom}" stroke-width="4"/>',
        f'<line x1="{right_board_x2}" y1="{board_top}" x2="{right_board_x2}" y2="{board_bottom}" stroke-width="4"/>',
        f'<rect x="{left_tray_x1}" y="{side_band_top}" width="{left_tray_x2-left_tray_x1}" height="{side_band_bottom-side_band_top}" fill="#000000" stroke-width="0"/>',
        f'<rect x="{right_tray_x1}" y="{side_band_top}" width="{right_tray_x2-right_tray_x1}" height="{side_band_bottom-side_band_top}" fill="#000000" stroke-width="0"/>',
    ]

    def point_x(col: int, right_half: bool) -> float:
        origin = right_board_x1 if right_half else left_board_x1
        return origin + col * point_w

    # Top points: 13-18 on the left, 19-24 on the right.
    for origin_right in (False, True):
        for col in range(6):
            x = point_x(col, origin_right)
            fill = "#cfcfcf" if col % 2 == 1 else "#ffffff"
            elements.append(
                f'<polygon points="{x:.2f},{board_top+2} {x+point_w:.2f},{board_top+2} '
                f'{x+point_w/2:.2f},{top_tip_y}" fill="{fill}" stroke-width="1"/>'
            )

    # Bottom points: 12-7 on the left, 6-1 on the right.
    for origin_right in (False, True):
        for col in range(6):
            x = point_x(col, origin_right)
            fill = "#cfcfcf" if col % 2 == 0 else "#ffffff"
            elements.append(
                f'<polygon points="{x:.2f},{board_bottom-2} {x+point_w:.2f},{board_bottom-2} '
                f'{x+point_w/2:.2f},{bottom_tip_y}" fill="{fill}" stroke-width="1"/>'
            )

    elements.append('</g>')

    # Point labels, match/score display and pip counts.
    # Match play separates the match length from the current scores:
    # - the centre black band shows only the match length in white,
    # - the opponent (top) and on-roll (bottom) scores sit above/below it.
    # XG represents unlimited/money games with the sentinel match length 99999;
    # those positions show only a large U in the black band and no scores.
    match_length = int(row.get("matchLength") or 0)
    is_unlimited = match_length <= 0 or match_length >= 99999
    elements.append('<g font-family="Arial, Helvetica, sans-serif">')
    if is_unlimited:
        elements.append(
            f'<text x="{score_x:.1f}" y="{unlimited_y:.1f}" text-anchor="middle" '
            f'fill="#ffffff" font-size="27" font-weight="700">U</text>'
        )
    else:
        opponent_score_label = int(row.get("onRollOpponentScore") or 0)
        on_roll_score_label = int(row.get("onRollScore") or 0)
        elements.extend([
            f'<text x="{score_x:.1f}" y="{score_top_y}" text-anchor="middle" '
            f'fill="#000000" font-size="27" font-weight="700">{opponent_score_label}</text>',
            f'<text x="{score_x:.1f}" y="{unlimited_y:.1f}" text-anchor="middle" '
            f'fill="#ffffff" font-size="27" font-weight="700">{match_length}</text>',
            f'<text x="{score_x:.1f}" y="{score_bottom_y}" text-anchor="middle" '
            f'fill="#000000" font-size="27" font-weight="700">{on_roll_score_label}</text>',
        ])
    if show_pip_counts:
        elements.extend([
            f'<text x="{bar_center:.1f}" y="{top_label_y}" text-anchor="middle">{opponent_pips}</text>',
            f'<text x="{bar_center:.1f}" y="{bottom_label_y}" text-anchor="middle">{on_roll_pips}</text>',
        ])

    for col, point in enumerate(range(13, 19)):
        x = left_board_x1 + (col + 0.5) * point_w
        elements.append(f'<text x="{x:.2f}" y="{top_label_y}" text-anchor="middle">{point}</text>')
    for col, point in enumerate(range(19, 25)):
        x = right_board_x1 + (col + 0.5) * point_w
        elements.append(f'<text x="{x:.2f}" y="{top_label_y}" text-anchor="middle">{point}</text>')
    for col, point in enumerate(range(12, 6, -1)):
        x = left_board_x1 + (col + 0.5) * point_w
        elements.append(f'<text x="{x:.2f}" y="{bottom_label_y}" text-anchor="middle">{point}</text>')
    for col, point in enumerate(range(6, 0, -1)):
        x = right_board_x1 + (col + 0.5) * point_w
        elements.append(f'<text x="{x:.2f}" y="{bottom_label_y}" text-anchor="middle">{point}</text>')
    elements.append('</g>')

    def point_center(point: int) -> tuple[float, bool]:
        if 13 <= point <= 18:
            col = point - 13
            return left_board_x1 + (col + 0.5) * point_w, True
        if 19 <= point <= 24:
            col = point - 19
            return right_board_x1 + (col + 0.5) * point_w, True
        if 7 <= point <= 12:
            col = 12 - point
            return left_board_x1 + (col + 0.5) * point_w, False
        col = 6 - point
        return right_board_x1 + (col + 0.5) * point_w, False

    def checker(
        cx: float,
        cy: float,
        black: bool,
        count_label: int | None = None,
        *,
        highlighted: bool = False,
    ) -> None:
        if highlighted and black:
            fill = highlight_color
            stroke = highlight_color
            stroke_width = 1.6
        elif highlighted:
            fill = "#ffffff"
            stroke = highlight_color
            stroke_width = 4.0
        else:
            fill = "#000000" if black else "#ffffff"
            stroke = "#000000"
            stroke_width = 1.2
        text_fill = "#ffffff" if black else "#000000"
        elements.append(
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{checker_r}" fill="{fill}" stroke="{stroke}" stroke-width="{stroke_width}"/>'
        )
        if count_label is not None:
            elements.append(
                f'<text x="{cx:.2f}" y="{cy+6:.2f}" text-anchor="middle" fill="{text_fill}" '
                f'font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="700">{count_label}</text>'
            )

    # Checkers on points. Positive/on-roll checkers are black; opponent checkers are white.
    for point in range(1, 25):
        value = int(points[point])
        if value == 0:
            continue
        count = abs(value)
        black = value > 0
        cx, top = point_center(point)
        visible = min(count, 5)
        step = 43.0
        side_sign = 1 if black else -1
        highlighted_count = min(count, highlight_points.get(point, 0)) if side_sign == highlight_sign else 0
        highlight_from = max(0, visible - min(highlighted_count, visible))
        for idx in range(visible):
            cy = board_top + 25 + idx * step if top else board_bottom - 25 - idx * step
            checker(
                cx,
                cy,
                black,
                count if idx == visible - 1 and count > 5 else None,
                highlighted=idx >= highlight_from and highlighted_count > 0,
            )

    # Bar checkers.  Centre each visible stack halfway between the central
    # cube and the corresponding outer edge, keeping it clear of the cube.
    board_center_y = (board_top + board_bottom) / 2
    opponent_bar = max(-int(points[0]), 0)
    on_roll_bar = max(int(points[25]), 0)
    bar_checker_step = 38.0

    opponent_visible = min(opponent_bar, 5)
    opponent_anchor_y = (board_top + board_center_y) / 2
    opponent_start_y = opponent_anchor_y - (opponent_visible - 1) * bar_checker_step / 2
    # White/opponent checkers can move only when they are hit.  Highlight only
    # the checkers newly sent to the bar by this selected move; do not color
    # checkers that were already on the bar before the move.
    opponent_hit_bar = max(0, int((move_highlights or {}).get("opponentBar") or 0))
    opponent_highlighted = min(opponent_bar, opponent_hit_bar)
    # Preserve the generic white-mover highlighting path for mirrored/test
    # positions where the mover itself is white and enters onto its own bar.
    if opponent_highlighted == 0 and highlight_sign == -1:
        opponent_highlighted = min(opponent_bar, highlight_points.get(0, 0))
    opponent_highlight_from = max(0, opponent_visible - min(opponent_highlighted, opponent_visible))
    for idx in range(opponent_visible):
        checker(
            bar_center,
            opponent_start_y + idx * bar_checker_step,
            False,
            opponent_bar if idx == opponent_visible - 1 and opponent_bar > 5 else None,
            highlighted=idx >= opponent_highlight_from and opponent_highlighted > 0,
        )

    on_roll_visible = min(on_roll_bar, 5)
    on_roll_anchor_y = (board_bottom + board_center_y) / 2
    on_roll_start_y = on_roll_anchor_y - (on_roll_visible - 1) * bar_checker_step / 2
    on_roll_highlighted = min(on_roll_bar, highlight_points.get(25, 0)) if highlight_sign == 1 else 0
    on_roll_highlight_from = max(0, on_roll_visible - min(on_roll_highlighted, on_roll_visible))
    for idx in range(on_roll_visible):
        checker(
            bar_center,
            on_roll_start_y + idx * bar_checker_step,
            True,
            on_roll_bar if idx == on_roll_visible - 1 and on_roll_bar > 5 else None,
            highlighted=idx >= on_roll_highlight_from and on_roll_highlighted > 0,
        )

    # Doubling cube in the bar.
    cube_size = 36
    cube_x = bar_center - cube_size / 2
    if row["cubeOwner"] == "opponent":
        cube_y = board_top + 7
    elif row["cubeOwner"] == "onRoll":
        cube_y = board_bottom - cube_size - 7
    else:
        cube_y = (board_top + board_bottom - cube_size) / 2
    cube_label = "c" if row.get("isCrawford") else str(row["cubeValue"])
    elements.extend([
        f'<rect x="{cube_x:.2f}" y="{cube_y:.2f}" width="{cube_size}" height="{cube_size}" rx="3" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>',
        f'<text x="{bar_center:.2f}" y="{cube_y+25:.2f}" text-anchor="middle" fill="#000000" font-family="Arial, Helvetica, sans-serif" font-size="23">{cube_label}</text>',
    ])

    # Dice, placed in the right half near the centre line.
    if row["diceValues"]:
        die_size = 36
        die_gap = 10
        start_x = 470.5
        die_y = 254
        pip_map = {
            1: [(18, 18)],
            2: [(10, 10), (26, 26)],
            3: [(10, 10), (18, 18), (26, 26)],
            4: [(10, 10), (26, 10), (10, 26), (26, 26)],
            5: [(10, 10), (26, 10), (18, 18), (10, 26), (26, 26)],
            6: [(10, 8), (26, 8), (10, 18), (26, 18), (10, 28), (26, 28)],
        }
        for idx, die in enumerate(row["diceValues"]):
            dx = start_x + idx * (die_size + die_gap)
            elements.append(f'<rect x="{dx}" y="{die_y}" width="{die_size}" height="{die_size}" rx="4" fill="#000000"/>')
            for px, py in pip_map[int(die)]:
                elements.append(f'<circle cx="{dx+px}" cy="{die_y+py}" r="3.4" fill="#ffffff"/>')

    # Borne-off checkers in the right tray.
    tray_center = (right_tray_x1 + right_tray_x2) / 2
    off_w, off_h = 41, 12
    opponent_off_highlight = min(opponent_off, highlight_off) if highlight_sign == -1 else 0
    opponent_off_from = max(0, opponent_off - opponent_off_highlight)
    for idx in range(opponent_off):
        y = board_top + 5 + idx * 13.8
        if y + off_h > side_band_top - 3:
            break
        highlighted = idx >= opponent_off_from and opponent_off_highlight > 0
        elements.append(
            f'<rect x="{tray_center-off_w/2:.2f}" y="{y:.2f}" width="{off_w}" height="{off_h}" rx="4" '
            f'fill="#ffffff" stroke="{highlight_color if highlighted else "#000000"}" stroke-width="{4 if highlighted else 1}"/>'
        )
    on_roll_off_highlight = min(on_roll_off, highlight_off) if highlight_sign == 1 else 0
    on_roll_off_from = max(0, on_roll_off - on_roll_off_highlight)
    for idx in range(on_roll_off):
        y = board_bottom - 5 - off_h - idx * 13.8
        if y < side_band_bottom + 3:
            break
        highlighted = idx >= on_roll_off_from and on_roll_off_highlight > 0
        elements.append(
            f'<rect x="{tray_center-off_w/2:.2f}" y="{y:.2f}" width="{off_w}" height="{off_h}" rx="4" '
            f'fill="{highlight_color if highlighted else "#000000"}" stroke="{highlight_color if highlighted else "#000000"}" stroke-width="{1.6 if highlighted else 1}"/>'
        )

    # On-roll marker.  Checker/Double positions show the black near-side
    # player on roll.  In the quiz Take Action view, the responder is shown
    # as black near-side while the doubler (white/far-side) remains on roll.
    if on_roll_marker == "white":
        elements.append('<circle cx="667.5" cy="11" r="8.5" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>')
    else:
        elements.append('<circle cx="667.5" cy="535" r="8.5" fill="#000000"/>')
    elements.append('</svg>')
    return "".join(elements)


VALID_DECISION_KINDS = frozenset({"checker", "double", "take"})


def validate_output_rows(rows: list[dict[str, Any]]) -> None:
    """Validate generated rows before anything is published."""
    seen_ids: set[str] = set()

    for row in rows:
        row_id = str(row.get("id") or "")
        if not row_id:
            raise RuntimeError("Generated position is missing an id")
        if row_id in seen_ids:
            raise RuntimeError(f"Duplicate generated position id: {row_id}")
        seen_ids.add(row_id)

        kind = row.get("decisionKind")
        if kind not in VALID_DECISION_KINDS:
            raise RuntimeError(f"Invalid decision kind for {row_id}: {kind!r}")

        source_file = str(row.get("sourceFile") or "")
        if not source_file:
            raise RuntimeError(f"Generated position is missing sourceFile: {row_id}")

        if not isinstance(row.get("isNew"), bool):
            raise RuntimeError(f"Generated position is missing boolean isNew: {row_id}")

        try:
            error_loss = float(row["errorLoss"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"Invalid errorLoss for {row_id}") from exc
        if not math.isfinite(error_loss) or error_loss < 0:
            raise RuntimeError(
                f"Non-finite/negative errorLoss for {row_id}: {error_loss}"
            )

        for image_key in ("boardImage", "quizBoardImage"):
            relative = str(row.get(image_key) or "")
            if not relative:
                raise RuntimeError(f"{row_id} is missing {image_key}")
            if not (DIST_DIR / relative).is_file():
                raise RuntimeError(
                    f"{row_id} references missing {image_key}: {relative}"
                )

        if kind != "take":
            continue

        current_cube = int(row.get("cubeValue") or 1)
        offered_cube = int(row.get("quizCubeValue") or 0)
        if offered_cube != current_cube * 2:
            raise RuntimeError(
                f"Invalid Take Action cube transition in {source_file} "
                f"Game{row['gameNumber']}: {current_cube} -> {offered_cube}"
            )

        match_length = int(row.get("matchLength") or 0)
        if 0 < match_length < 99999:
            doubler_score = int(row.get("playerScore") or 0)
            doubler_away = match_length - doubler_score
            if current_cube >= doubler_away:
                raise RuntimeError(
                    f"Dead-cube Take Action leaked into output: {source_file} "
                    f"Game{row['gameNumber']} ({current_cube} -> {offered_cube}, "
                    f"doubler {doubler_away}-away)"
                )


def build() -> None:
    cfg = load_config()
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # Position Drill itself lives at the repository root.  Copy only the
    # public UI files into the Pages artifact; source XG/build files stay out.
    public_files = (
        "index.html",
        "app.js",
        "styles.css",
        "favicon.ico",
        "favicon-16x16.png",
        "favicon-32x32.png",
        "apple-touch-icon.png",
    )
    for filename in public_files:
        source = ROOT / filename
        if not source.exists():
            raise FileNotFoundError(f"Required Position Drill file is missing: {filename}")
        shutil.copy2(source, DIST_DIR / filename)

    BOARD_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DIST_DIR / ".nojekyll").write_text("", encoding="utf-8")

    imported_files = imported_source_files()
    rows: list[dict[str, Any]] = []
    match_summaries: list[dict[str, Any]] = []
    seen_matches: dict[str, str] = {}
    seen_xgp_positions: dict[str, str] = {}
    duplicate_match_files: list[tuple[str, str]] = []
    duplicate_xgp_files: list[tuple[str, str]] = []

    for source in imported_files:
        match = xgread.read(source)
        standalone = is_xgp_source(source)
        all_decisions = list(match.decisions())
        decisions = primary_decisions(source, match)
        decision_indexes = {
            (item.game_number, item.move_number): index
            for index, item in enumerate(all_decisions)
        }
        source_identity = xgp_identity(decisions) if standalone else match.identity_hash

        if standalone:
            # XGP files are standalone analysis positions.  Deduplicate by the
            # saved question/XGID, never by Match.identity_hash (which hashes
            # played history and therefore collides for unrelated XGP files).
            previous_source = seen_xgp_positions.get(source_identity)
            if previous_source is not None:
                duplicate_xgp_files.append((source.name, previous_source))
                print(
                    "WARNING: Skipping duplicate XGP position file "
                    f"{source.name}; same saved position as {previous_source}"
                )
                continue
            seen_xgp_positions[source_identity] = source.name
        else:
            # The same XG match can exist under multiple filenames (for example
            # a generic match_*.xg export plus a later descriptive filename).
            previous_source = seen_matches.get(source_identity)
            if previous_source is not None:
                duplicate_match_files.append((source.name, previous_source))
                print(
                    "WARNING: Skipping duplicate match file "
                    f"{source.name}; same parsed match as {previous_source}"
                )
                continue
            seen_matches[source_identity] = source.name

        uploaded_at = source_uploaded_at(source)
        is_new_source = source_is_new(uploaded_at)
        games_by_number = {game.header.game_number: game for game in match.games}
        crawford_game_numbers = {
            game.header.game_number
            for game in match.games
            if game.header.crawford_apply
        }
        crawford_game_number = min(crawford_game_numbers) if crawford_game_numbers else None
        before = len(rows)
        for decision in decisions:
            event = decision.event
            generated: list[dict[str, Any] | None]
            if isinstance(event, Move):
                generated = [
                    make_checker_row(
                        match, decision, event, cfg,
                        standalone=standalone, source_identity=source_identity,
                        pre_roll_rates=checker_pre_roll_probability_fields(
                            all_decisions,
                            decision_indexes.get((decision.game_number, decision.move_number), -1),
                        ),
                    )
                ]
            elif isinstance(event, CubeAction):
                if standalone and event.doubled and event.took is not None:
                    # A standalone responded-to cube position is a Take/Pass
                    # question.  Do not create a second Double Action card.
                    generated = [
                        make_take_row(
                            match, decision, event, cfg,
                            standalone=True, source_identity=source_identity,
                        )
                    ]
                else:
                    generated = [
                        make_double_row(
                            match, decision, event, cfg,
                            standalone=standalone, source_identity=source_identity,
                        ),
                        None if standalone else make_take_row(
                            match, decision, event, cfg,
                            source_identity=source_identity,
                        ),
                    ]
            else:
                generated = []

            for row in generated:
                if row is None:
                    continue
                game = games_by_number.get(decision.game_number)
                row["isCrawford"] = bool(game and game.header.crawford_apply)
                row["isPostCrawford"] = bool(
                    crawford_game_number is not None
                    and decision.game_number > crawford_game_number
                )
                row["sourceFile"] = source.name
                row["sourceUploadedAt"] = uploaded_at
                # Backward-compatible alias: older cached app.js versions
                # used sourceAddedAt. Keep both fields identical so a mixed
                # Pages/CDN deployment cannot make every New count become 0.
                row["sourceAddedAt"] = uploaded_at
                row["sourceUploadedAtMs"] = int(
                    datetime.fromisoformat(uploaded_at.replace("Z", "+00:00")).timestamp() * 1000
                )
                row["isNew"] = is_new_source
                if cfg["anonymizeOpponents"]:
                    row["opponent"] = "Opponent"
                    if row["onRollOpponent"] != row["player"]:
                        row["onRollOpponent"] = "Opponent"
                ensure_row_probabilities(row)
                board_relative = f"assets/boards/{row['id']}.svg"
                quiz_board_relative = f"assets/boards-quiz/{row['id']}.svg"
                row["boardImage"] = board_relative
                row["quizBoardImage"] = quiz_board_relative
                (DIST_DIR / board_relative).write_text(render_board_svg(row), encoding="utf-8")
                (DIST_DIR / quiz_board_relative).parent.mkdir(parents=True, exist_ok=True)
                quiz_render_row, quiz_marker = quiz_render_state(row)

                (DIST_DIR / quiz_board_relative).write_text(
                    render_board_svg(
                        quiz_render_row,
                        show_pip_counts=False,
                        on_roll_marker=quiz_marker,
                    ),
                    encoding="utf-8",
                )

                if row.get("decisionKind") == "checker":
                    for candidate in row.get("candidates") or []:
                        after_position = candidate.pop("_positionAfter", None)
                        move_highlights = candidate.pop("_moveHighlights", None)
                        if after_position is None:
                            continue
                        move_board_relative = (
                            f"assets/boards-moves/{row['id']}-{int(candidate.get('rank') or 0)}.svg"
                        )
                        move_board_row = dict(row)
                        move_board_row["position"] = after_position
                        candidate["moveBoardImage"] = move_board_relative
                        (DIST_DIR / move_board_relative).parent.mkdir(parents=True, exist_ok=True)
                        (DIST_DIR / move_board_relative).write_text(
                            render_board_svg(
                                move_board_row,
                                show_pip_counts=False,
                                move_highlights=move_highlights,
                            ),
                            encoding="utf-8",
                        )
                elif row.get("decisionKind") in {"double", "take"}:
                    action_candidates = (
                        row.get("quizCandidates")
                        if row.get("decisionKind") == "take"
                        else row.get("candidates")
                    ) or []
                    for candidate in action_candidates:
                        action_board_relative = (
                            f"assets/boards-actions/{row['id']}-{int(candidate.get('rank') or 0)}.svg"
                        )
                        action_board_row, action_marker = cube_action_render_state(row, candidate)
                        candidate["actionBoardImage"] = action_board_relative
                        (DIST_DIR / action_board_relative).parent.mkdir(parents=True, exist_ok=True)
                        (DIST_DIR / action_board_relative).write_text(
                            render_board_svg(
                                action_board_row,
                                show_pip_counts=False,
                                on_roll_marker=action_marker,
                            ),
                            encoding="utf-8",
                        )

                rows.append(row)

        match_summaries.append(
            {
                "sourceFile": source.name,
                "sourceUploadedAt": uploaded_at,
                "sourceAddedAt": uploaded_at,
                "sourceUploadedAtMs": int(
                    datetime.fromisoformat(uploaded_at.replace("Z", "+00:00")).timestamp() * 1000
                ),
                "isNew": is_new_source,
                "matchId": source_identity,
                "player1": match.header.player1,
                "player2": match.header.player2,
                "matchLength": match.header.match_length,
                "positions": len(rows) - before,
            }
        )

    # Validate the complete generated dataset before publishing it.
    validate_output_rows(rows)

    rows.sort(key=lambda row: (-float(row["errorLoss"]), row["sourceFile"], row["gameNumber"], row["moveNumber"]))
    payload = {
        "meta": {
            "title": cfg["databaseTitle"],
            "schemaVersion": 1,
            "generatedAt": datetime.now(UTC).isoformat(),
            "newPositionWindowDays": NEW_POSITION_WINDOW.days,
            "errorThreshold": cfg["errorThreshold"],
            "blunderThreshold": cfg["blunderThreshold"],
            "targetPlayerMode": "xg-bottom",
            "themeColor": cfg["themeColor"],
            "sourceFileCount": len(match_summaries),
            "importedFileCount": len(imported_files),
            "duplicateMatchFileCount": len(duplicate_match_files),
            "duplicatePositionFileCount": len(duplicate_xgp_files),
            "positionCount": len(rows),
            "matches": match_summaries,
        },
        "positions": rows,
    }
    (DATA_DIR / "positions.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    dated_sources = [summary for summary in match_summaries if summary.get("sourceUploadedAt")]
    new_sources = [summary for summary in match_summaries if summary.get("isNew")]
    new_rows = [row for row in rows if row.get("isNew")]
    new_by_kind = {
        kind: sum(1 for row in new_rows if row.get("decisionKind") == kind)
        for kind in ("checker", "double", "take")
    }
    print(
        f"Built {len(rows)} positions from {len(match_summaries)} unique XG/XGP source file(s) "
        f"({len(imported_files)} imported, "
        f"{len(duplicate_match_files)} duplicate match file(s), "
        f"{len(duplicate_xgp_files)} duplicate XGP position file(s) skipped)."
    )
    print(f"Git upload/update dates resolved for {len(dated_sources)}/{len(match_summaries)} XG/XGP file(s).")
    print(
        "New at build time: "
        f"{len(new_sources)} XG/XGP file(s), {len(new_rows)} position(s) "
        f"(Checker {new_by_kind['checker']}, "
        f"Double {new_by_kind['double']}, Take {new_by_kind['take']})."
    )


if __name__ == "__main__":
    build()
