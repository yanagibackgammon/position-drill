#!/usr/bin/env python3
"""Build the static backgammon error-position database from imports/*.xg."""

from __future__ import annotations

import hashlib
import html
import json
import math
import shutil
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

import xgread  # noqa: E402
from xgread import CubeAction, Evaluation, Move  # noqa: E402

IMPORTS_DIR = ROOT / "imports"
DIST_DIR = ROOT / "dist"
BOARD_DIR = DIST_DIR / "assets" / "boards"
DATA_DIR = DIST_DIR / "data"
CONFIG_PATH = ROOT / "config.json"


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


def compact_move_notation(notation: str) -> str:
    """Collapse repeated identical checker moves, e.g. 8/4 8/4 8/4 -> 8/4(3)."""
    tokens = str(notation).split()
    if len(tokens) < 2:
        return str(notation)

    counts: dict[str, int] = {}
    order: list[str] = []
    for token in tokens:
        if token not in counts:
            counts[token] = 0
            order.append(token)
        counts[token] += 1

    return " ".join(
        f"{token}({counts[token]})" if counts[token] > 1 else token
        for token in order
    )


def candidate_payload(move: Move) -> list[dict[str, Any]]:
    """Return only genuinely analysed checker candidates, best to worst.

    XG may store the played move in an unused candidate slot whose evaluation is
    all zero and whose equity is -1000.  Filtering those placeholders prevents
    both false 0.0% rates and absurd -1000.xxx error values.
    """
    valid_candidates = [
        candidate for candidate in move.candidates
        if valid_probability_evaluation(candidate.evaluation)
    ]
    valid_candidates.sort(key=lambda candidate: float(candidate.evaluation.equity), reverse=True)
    if not valid_candidates:
        return []

    best_equity = float(valid_candidates[0].evaluation.equity)
    rows: list[dict[str, Any]] = []
    for rank, candidate in enumerate(valid_candidates, start=1):
        equity_loss = max(0.0, best_equity - float(candidate.evaluation.equity))
        rows.append(
            {
                "rank": rank,
                "action": compact_move_notation(xgread.format_moves(candidate.moves, move.position_before)),
                "equityLoss": equity_loss,
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

    raw_rows = [
        (
            "no_offer",
            labels["no_offer"],
            no_offer_equity,
            first_available_evaluation(cube.no_double_analysis, position_evaluation),
        ),
        ("take", labels["take"], take_equity, position_evaluation),
        ("pass", labels["pass"], pass_equity, position_evaluation),
    ]

    return [
        {
            "rank": order,
            "action": action,
            "equityDifference": None if key == reference_key else equity - reference_equity,
            **probability_fields(evaluation),
        }
        for order, (key, action, equity, evaluation) in enumerate(raw_rows, start=1)
    ]

def make_checker_row(match: Any, decision: Any, move: Move, cfg: dict[str, Any]) -> dict[str, Any] | None:
    actor = player_name(match, move.player)
    if not is_drill_owner(match, move.player) or not cfg["includeCheckerErrors"]:
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

    if loss + 1e-12 < float(cfg["errorThreshold"]):
        return None

    checker_candidates = candidate_payload(move)
    best_action = checker_candidates[0]["action"] if checker_candidates else "—"
    actor_score, opponent_score = score_for_sign(decision, move.player)
    opponent = player_name(match, -move.player)
    row_id = event_id(match.identity_hash, decision.game_number, decision.move_number, "checker", actor)

    return {
        "id": row_id,
        "decisionType": "checker",
        "decisionKind": "checker",
        "decisionLabel": "Checker Play",
        "classification": classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": actor,
        "opponent": opponent,
        "onRollPlayer": actor,
        "onRollOpponent": opponent,
        "sourceFile": "",
        "matchId": match.identity_hash,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": actor_score,
        "opponentScore": opponent_score,
        "onRollScore": actor_score,
        "onRollOpponentScore": opponent_score,
        "dice": f"{move.dice[0]}{move.dice[1]}",
        "diceValues": list(move.dice),
        "playedAction": compact_move_notation(move.notation),
        "bestAction": best_action,
        "xgid": decision.xgid,
        "cubeValue": cube_value_number(move.cube_value),
        "cubeOwner": cube_owner_for_view(move.cube_value, move.player),
        "position": position_for_view(move.position_before.points, move.player),
        "candidates": checker_candidates,
        **probability_fields(actual_evaluation),
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

def make_double_row(match: Any, decision: Any, cube: CubeAction, cfg: dict[str, Any]) -> dict[str, Any] | None:
    actor_sign = cube.player
    actor = player_name(match, actor_sign)
    if not is_drill_owner(match, actor_sign) or not cfg["includeCubeErrors"]:
        return None

    loss = abs(float(cube.error_double))
    if cube.error_double == xgread.NOT_ANALYSED or loss + 1e-12 < float(cfg["errorThreshold"]):
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
    row_id = event_id(match.identity_hash, decision.game_number, decision.move_number, "double", actor)
    return {
        "id": row_id,
        "decisionType": "cube",
        "decisionKind": "double",
        "decisionLabel": "Cube Action",
        "classification": classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": actor,
        "opponent": opponent,
        "onRollPlayer": actor,
        "onRollOpponent": opponent,
        "sourceFile": "",
        "matchId": match.identity_hash,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": actor_score,
        "opponentScore": opponent_score,
        "onRollScore": actor_score,
        "onRollOpponentScore": opponent_score,
        "dice": "—",
        "diceValues": [],
        "playedAction": actual,
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
    return [
        {
            "rank": rank,
            "action": action,
            "equityDifference": None if rank == 1 else equity - best_equity,
        }
        for rank, (action, equity) in enumerate(responder_rows, start=1)
    ]


def make_take_row(match: Any, decision: Any, cube: CubeAction, cfg: dict[str, Any]) -> dict[str, Any] | None:
    if not cube.doubled or cube.took is None or not cfg["includeTakeErrors"]:
        return None

    taker_sign = -cube.player
    taker = player_name(match, taker_sign)
    if not is_drill_owner(match, taker_sign):
        return None

    loss = abs(float(cube.error_take))
    if cube.error_take == xgread.NOT_ANALYSED or loss + 1e-12 < float(cfg["errorThreshold"]):
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

    # The main positions database keeps its historical doubler-perspective
    # representation.  The quiz, however, treats Take Action as a separate
    # decision and therefore shows the responder (the cube receiver) as black.
    # Keep both perspectives in the same row so the positions page is unchanged.
    doubler_sign = cube.player
    doubler = player_name(match, doubler_sign)
    doubler_score, taker_score = score_for_sign(decision, doubler_sign)
    quiz_rates = probability_fields(actual_eval, invert=True)
    row_id = event_id(match.identity_hash, decision.game_number, decision.move_number, "take", taker)

    return {
        "id": row_id,
        "decisionType": "cube",
        "decisionKind": "take",
        "decisionLabel": "Cube Action",
        "classification": classification(loss, float(cfg["blunderThreshold"])),
        "errorLoss": loss,
        "player": doubler,
        "opponent": taker,
        "onRollPlayer": doubler,
        "onRollOpponent": taker,
        "sourceFile": "",
        "matchId": match.identity_hash,
        "matchLength": match.header.match_length,
        "gameNumber": decision.game_number,
        "moveNumber": decision.move_number,
        "playerScore": doubler_score,
        "opponentScore": taker_score,
        "onRollScore": doubler_score,
        "onRollOpponentScore": taker_score,
        "dice": "—",
        "diceValues": [],
        "playedAction": actual,
        "bestAction": best,
        "quizBestAction": cube_response(cube),
        "quizPlayedAction": "Take" if cube.took else "Pass",
        "quizCandidates": take_quiz_candidate_payload(cube),
        "xgid": decision.xgid,
        "cubeValue": cube_value_number(cube.cube_value),
        # Main positions view: historical doubler perspective.
        "cubeOwner": "center" if cube.cube_value == 0 else "onRoll",
        "position": position_for_view(cube.position.points, doubler_sign),
        # Quiz Take Action view: responder/taker is black and remains on the
        # near side of the rendered board, matching the XG take perspective.
        "quizPosition": position_for_view(cube.position.points, taker_sign),
        "quizPlayer": taker,
        "quizOpponent": doubler,
        "quizPlayerScore": taker_score,
        "quizOpponentScore": doubler_score,
        "quizOnRollScore": taker_score,
        "quizOnRollOpponentScore": doubler_score,
        # A Take Action is the state *after* the opponent has offered the cube.
        # XG's CubeAction.cube_value is the pre-offer cube (1 for an initial
        # double, 2 for a redouble from 2, ...), so the response position shows
        # the offered value and places the cube on the opponent/doubler side.
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


def render_board_svg(
    row: dict[str, Any],
    *,
    show_pip_counts: bool = True,
    on_roll_marker: str = "black",
) -> str:
    """Render a clean monochrome bgLog/Minstrels-inspired board diagram.

    Rows are normalized before rendering: positive checkers are the displayed
    black side and negative checkers are the displayed white side.
    """
    width, height = 690, 546
    board_top, board_bottom = 28, 518
    top_label_y, bottom_label_y = 18, 540

    left_tray_x1, left_tray_x2 = 11, 59
    left_board_x1, left_board_x2 = 60, 327
    bar_x1, bar_x2 = 328, 367
    right_board_x1, right_board_x2 = 368, 637
    right_tray_x1, right_tray_x2 = 638, 684

    top_tip_y = 251
    bottom_tip_y = 294
    side_band_top, side_band_bottom = 247, 300
    score_x = (left_tray_x1 + left_tray_x2) / 2
    score_top_y = side_band_top - 10
    score_bottom_y = side_band_bottom + 22
    point_w = (left_board_x2 - left_board_x1) / 6
    checker_r = 21.1

    points = row["position"]

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
        '<rect width="690" height="546" fill="#ffffff"/>',
        '<g stroke="#000000" stroke-linejoin="round">',
        f'<rect x="{left_tray_x1}" y="{board_top}" width="{right_tray_x2-left_tray_x1}" height="{board_bottom-board_top}" fill="#ffffff" stroke-width="4"/>',
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

    # Point labels, scores and pip counts.
    # XG represents unlimited/money games with the sentinel match length 99999.
    # On the board, display money-game scores as 0/0 instead of 0/99999.
    match_length = int(row.get("matchLength") or 0)
    is_unlimited = match_length >= 99999
    score_match_length = 0 if is_unlimited else match_length
    opponent_score_label = 0 if is_unlimited else row["onRollOpponentScore"]
    on_roll_score_label = 0 if is_unlimited else row["onRollScore"]
    elements.extend([
        '<g fill="#000000" font-family="Arial, Helvetica, sans-serif" font-size="17">',
        f'<text x="{score_x:.1f}" y="{score_top_y}" text-anchor="middle">{opponent_score_label}/{score_match_length}</text>',
        f'<text x="{score_x:.1f}" y="{score_bottom_y}" text-anchor="middle">{on_roll_score_label}/{score_match_length}</text>',
    ])
    if show_pip_counts:
        elements.extend([
            f'<text x="347.5" y="{top_label_y}" text-anchor="middle">{opponent_pips}</text>',
            f'<text x="347.5" y="{bottom_label_y}" text-anchor="middle">{on_roll_pips}</text>',
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

    def checker(cx: float, cy: float, black: bool, count_label: int | None = None) -> None:
        fill = "#000000" if black else "#ffffff"
        text_fill = "#ffffff" if black else "#000000"
        elements.append(
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{checker_r}" fill="{fill}" stroke="#000000" stroke-width="1.2"/>'
        )
        if count_label is not None:
            elements.append(
                f'<text x="{cx:.2f}" y="{cy+6:.2f}" text-anchor="middle" fill="{text_fill}" '
                f'font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700">{count_label}</text>'
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
        for idx in range(visible):
            cy = board_top + 25 + idx * step if top else board_bottom - 25 - idx * step
            checker(cx, cy, black, count if idx == visible - 1 and count > 5 else None)

    # Bar checkers.  Centre each visible stack halfway between the central
    # cube and the corresponding outer edge, keeping it clear of the cube.
    bar_center = (bar_x1 + bar_x2) / 2
    board_center_y = (board_top + board_bottom) / 2
    opponent_bar = max(-int(points[0]), 0)
    on_roll_bar = max(int(points[25]), 0)
    bar_checker_step = 38.0

    opponent_visible = min(opponent_bar, 5)
    opponent_anchor_y = (board_top + board_center_y) / 2
    opponent_start_y = opponent_anchor_y - (opponent_visible - 1) * bar_checker_step / 2
    for idx in range(opponent_visible):
        checker(
            bar_center,
            opponent_start_y + idx * bar_checker_step,
            False,
            opponent_bar if idx == opponent_visible - 1 and opponent_bar > 5 else None,
        )

    on_roll_visible = min(on_roll_bar, 5)
    on_roll_anchor_y = (board_bottom + board_center_y) / 2
    on_roll_start_y = on_roll_anchor_y - (on_roll_visible - 1) * bar_checker_step / 2
    for idx in range(on_roll_visible):
        checker(
            bar_center,
            on_roll_start_y + idx * bar_checker_step,
            True,
            on_roll_bar if idx == on_roll_visible - 1 and on_roll_bar > 5 else None,
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
        start_x = 463
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
    for idx in range(opponent_off):
        y = board_top + 5 + idx * 13.8
        if y + off_h > side_band_top - 3:
            break
        elements.append(
            f'<rect x="{tray_center-off_w/2:.2f}" y="{y:.2f}" width="{off_w}" height="{off_h}" rx="4" fill="#ffffff" stroke="#000000" stroke-width="1"/>'
        )
    for idx in range(on_roll_off):
        y = board_bottom - 5 - off_h - idx * 13.8
        if y < side_band_bottom + 3:
            break
        elements.append(
            f'<rect x="{tray_center-off_w/2:.2f}" y="{y:.2f}" width="{off_w}" height="{off_h}" rx="4" fill="#000000" stroke="#000000" stroke-width="1"/>'
        )

    # On-roll marker.  Checker/Double positions show the black near-side
    # player on roll.  In the quiz Take Action view, the responder is shown
    # as black near-side while the doubler (white/far-side) remains on roll.
    if on_roll_marker == "white":
        elements.append('<circle cx="660" cy="11" r="8.5" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>')
    else:
        elements.append('<circle cx="660" cy="535" r="8.5" fill="#000000"/>')
    elements.append('</svg>')
    return "".join(elements)


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

    imported_files = sorted(
        [*IMPORTS_DIR.rglob("*.xg"), *IMPORTS_DIR.rglob("*.xgp")],
        key=lambda path: path.as_posix().casefold(),
    )
    rows: list[dict[str, Any]] = []
    match_summaries: list[dict[str, Any]] = []

    for source in imported_files:
        match = xgread.read(source)
        games_by_number = {game.header.game_number: game for game in match.games}
        crawford_game_numbers = {
            game.header.game_number
            for game in match.games
            if game.header.crawford_apply
        }
        crawford_game_number = min(crawford_game_numbers) if crawford_game_numbers else None
        before = len(rows)
        for decision in match.decisions():
            event = decision.event
            generated: list[dict[str, Any] | None]
            if isinstance(event, Move):
                generated = [make_checker_row(match, decision, event, cfg)]
            elif isinstance(event, CubeAction):
                generated = [
                    make_double_row(match, decision, event, cfg),
                    make_take_row(match, decision, event, cfg),
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
                quiz_render_row = row
                if row.get("decisionKind") == "take" and row.get("quizPosition"):
                    quiz_render_row = {
                        **row,
                        "position": row["quizPosition"],
                        "player": row.get("quizPlayer", row["player"]),
                        "opponent": row.get("quizOpponent", row["opponent"]),
                        "playerScore": row.get("quizPlayerScore", row["playerScore"]),
                        "opponentScore": row.get("quizOpponentScore", row["opponentScore"]),
                        "onRollScore": row.get("quizOnRollScore", row["onRollScore"]),
                        "onRollOpponentScore": row.get("quizOnRollOpponentScore", row["onRollOpponentScore"]),
                        "cubeValue": row.get("quizCubeValue", row["cubeValue"]),
                        "cubeOwner": row.get("quizCubeOwner", row["cubeOwner"]),
                    }
                (DIST_DIR / quiz_board_relative).write_text(
                    render_board_svg(
                        quiz_render_row,
                        show_pip_counts=False,
                        on_roll_marker="white" if row.get("decisionKind") == "take" else "black",
                    ),
                    encoding="utf-8",
                )
                rows.append(row)

        match_summaries.append(
            {
                "sourceFile": source.name,
                "matchId": match.identity_hash,
                "player1": match.header.player1,
                "player2": match.header.player2,
                "matchLength": match.header.match_length,
                "positions": len(rows) - before,
            }
        )

    rows.sort(key=lambda row: (-float(row["errorLoss"]), row["sourceFile"], row["gameNumber"], row["moveNumber"]))
    payload = {
        "meta": {
            "title": cfg["databaseTitle"],
            "generatedAt": datetime.now(UTC).isoformat(),
            "errorThreshold": cfg["errorThreshold"],
            "blunderThreshold": cfg["blunderThreshold"],
            "targetPlayerMode": "xg-bottom",
            "themeColor": cfg["themeColor"],
            "sourceFileCount": len(imported_files),
            "positionCount": len(rows),
            "matches": match_summaries,
        },
        "positions": rows,
    }
    (DATA_DIR / "positions.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Built {len(rows)} positions from {len(imported_files)} match file(s).")


if __name__ == "__main__":
    build()
