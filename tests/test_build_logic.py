from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from scripts import build
from vendor.xgread._notation import _collapse_unambiguous_hops


class BuildLogicTests(unittest.TestCase):
    def test_terminal_probability_fields_are_single_game_results(self) -> None:
        winner = build.terminal_probability_fields(win=True)
        loser = build.terminal_probability_fields(win=False)
        self.assertEqual((winner["winRate"], winner["loseRate"]), (1.0, 0.0))
        self.assertEqual((loser["winRate"], loser["loseRate"]), (0.0, 1.0))
        self.assertEqual(winner["gammonWinRate"], 0.0)
        self.assertEqual(loser["backgammonLoseRate"], 0.0)

    def test_checker_pre_roll_rates_use_preceding_cube_analysis(self) -> None:
        evaluation = build.Evaluation(
            lose_bg=0.02,
            lose_gammon=0.12,
            lose_single=0.44,
            win_single=0.56,
            win_gammon=0.18,
            win_bg=0.03,
            equity=0.22,
        )
        position = build.xgread.Position(tuple([0] * 26))
        cube = build.CubeAction(
            player=1,
            doubled=False,
            took=None,
            beavered=False,
            cube_value=0,
            position=position,
            error_double=0.0,
            error_take=build.xgread.NOT_ANALYSED,
            no_double_equity=0.22,
            double_take_equity=0.20,
            double_drop_equity=1.0,
            no_double_analysis=evaluation,
            double_take_analysis=evaluation,
            flagged=False,
            comment_index=-1,
        )
        move = build.Move(
            player=1,
            position_before=position,
            position_after=position,
            dice=(3, 1),
            moves=(),
            cube_value=0,
            error=0.0,
            luck=0.0,
            candidates=(),
            flagged=False,
            comment_index=-1,
        )
        decisions = [
            SimpleNamespace(game_number=1, event=cube),
            SimpleNamespace(game_number=1, event=move),
        ]
        rates = build.checker_pre_roll_probability_fields(decisions, 1)
        self.assertAlmostEqual(rates["winRate"], 0.56)
        self.assertAlmostEqual(rates["gammonWinRate"], 0.18)
        self.assertAlmostEqual(rates["loseRate"], 0.44)

    def test_checker_pre_roll_rates_recover_preceding_dance_by_result_board(self) -> None:
        evaluation = build.Evaluation(
            lose_bg=0.01,
            lose_gammon=0.08,
            lose_single=0.40,
            win_single=0.60,
            win_gammon=0.14,
            win_bg=0.02,
            equity=0.31,
        )
        position = build.xgread.Position(tuple([0] * 26))
        dance_candidate = build.xgread.MoveCandidate(
            moves=(build.xgread.MoveDetail(from_point=0, die=0),),
            evaluation=evaluation,
        )
        prior_move = build.Move(
            player=-1,
            position_before=position,
            position_after=position,
            dice=(6, 6),
            moves=(),
            cube_value=0,
            error=0.0,
            luck=0.0,
            candidates=(dance_candidate,),
            flagged=False,
            comment_index=-1,
        )
        current_move = build.Move(
            player=1,
            position_before=position,
            position_after=position,
            dice=(3, 2),
            moves=(),
            cube_value=0,
            error=0.0,
            luck=0.0,
            candidates=(),
            flagged=False,
            comment_index=-1,
        )
        decisions = [
            SimpleNamespace(game_number=1, event=prior_move),
            SimpleNamespace(game_number=1, event=current_move),
        ]
        rates = build.checker_pre_roll_probability_fields(decisions, 1)
        self.assertAlmostEqual(rates["winRate"], 0.40)
        self.assertAlmostEqual(rates["loseRate"], 0.60)
        self.assertAlmostEqual(rates["gammonWinRate"], 0.08)

    def test_played_move_evaluation_recovers_missing_candidate_by_errmove_equity(self) -> None:
        position = build.xgread.Position(tuple([0] * 26))
        best = build.Evaluation(
            lose_bg=0.01, lose_gammon=0.10, lose_single=0.45,
            win_single=0.55, win_gammon=0.12, win_bg=0.02, equity=0.30,
        )
        played = build.Evaluation(
            lose_bg=0.02, lose_gammon=0.13, lose_single=0.48,
            win_single=0.52, win_gammon=0.10, win_bg=0.01, equity=0.28,
        )
        move = build.Move(
            player=-1,
            position_before=position,
            position_after=position,
            dice=(4, 1),
            moves=(build.xgread.MoveDetail(from_point=12, die=8),),
            cube_value=0,
            error=-0.02,
            luck=0.0,
            candidates=(
                build.xgread.MoveCandidate(
                    moves=(build.xgread.MoveDetail(from_point=10, die=6),),
                    evaluation=best,
                ),
                build.xgread.MoveCandidate(
                    moves=(build.xgread.MoveDetail(from_point=9, die=5),),
                    evaluation=played,
                ),
            ),
            flagged=False,
            comment_index=-1,
        )
        self.assertIsNone(move.played_index)
        evaluation = build.played_move_evaluation(move)
        self.assertIsNotNone(evaluation)
        self.assertAlmostEqual(evaluation.equity, 0.28)
        self.assertAlmostEqual(evaluation.win_single, 0.52)

    def test_checker_pre_roll_rates_keep_first_checker_move_empty(self) -> None:
        position = build.xgread.Position(tuple([0] * 26))
        move = build.Move(
            player=1,
            position_before=position,
            position_after=position,
            dice=(3, 1),
            moves=(),
            cube_value=0,
            error=0.0,
            luck=0.0,
            candidates=(),
            flagged=False,
            comment_index=-1,
        )
        decisions = [SimpleNamespace(game_number=1, event=move)]
        rates = build.checker_pre_roll_probability_fields(decisions, 0)
        self.assertIsNone(rates["winRate"])
        self.assertIsNone(rates["loseRate"])

    def test_cube_action_render_state_applies_selected_cube_to_take_view(self) -> None:
        row = {
            "decisionKind": "take",
            "position": [0] * 26,
            "quizPosition": [0] * 26,
            "player": "Doubler",
            "opponent": "Taker",
            "quizPlayer": "Taker",
            "quizOpponent": "Doubler",
            "playerScore": 2,
            "opponentScore": 1,
            "quizPlayerScore": 1,
            "quizOpponentScore": 2,
            "onRollScore": 2,
            "onRollOpponentScore": 1,
            "quizOnRollScore": 1,
            "quizOnRollOpponentScore": 2,
            "cubeValue": 2,
            "cubeOwner": "onRoll",
        }
        rendered, marker = build.cube_action_render_state(
            row,
            {"cubeValue": 4, "cubeOwner": "onRoll"},
        )
        self.assertEqual(rendered["position"], row["quizPosition"])
        self.assertEqual(rendered["cubeValue"], 4)
        self.assertEqual(rendered["cubeOwner"], "onRoll")
        self.assertEqual(marker, "white")

    def test_new_window_is_seven_days(self) -> None:
        now = datetime(2026, 8, 24, 0, 0, tzinfo=UTC)
        self.assertTrue(build.source_is_new((now - timedelta(days=7)).isoformat(), now))
        self.assertFalse(
            build.source_is_new(
                (now - timedelta(days=7, seconds=1)).isoformat(),
                now,
            )
        )
        self.assertTrue(
            build.source_is_new(
                (now + timedelta(minutes=5)).isoformat(),
                now,
            )
        )
        self.assertFalse(
            build.source_is_new(
                (now + timedelta(minutes=5, seconds=1)).isoformat(),
                now,
            )
        )


    def test_pip_counts_for_view_returns_both_sides_after_move(self) -> None:
        points = [0] * 26
        points[6] = 2
        points[25] = 1
        points[24] = -1
        points[0] = -1
        self.assertEqual(build.pip_counts_for_view(points), (37, 26))

    def test_cube_value_number(self) -> None:
        self.assertEqual(build.cube_value_number(0), 1)
        self.assertEqual(build.cube_value_number(1), 2)
        self.assertEqual(build.cube_value_number(-2), 4)
        self.assertEqual(build.cube_value_number(3), 8)

    def test_imported_source_files_accepts_uppercase_xg_extensions(self) -> None:
        original = build.IMPORTS_DIR
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.XGP").write_bytes(b"x")
            (root / "b.XG").write_bytes(b"x")
            (root / "ignore.txt").write_text("x", encoding="utf-8")
            build.IMPORTS_DIR = root
            try:
                self.assertEqual(
                    [path.name for path in build.imported_source_files()],
                    ["a.XGP", "b.XG"],
                )
            finally:
                build.IMPORTS_DIR = original

    def test_imported_source_files_reads_nested_subfolders_recursively(self) -> None:
        original = build.IMPORTS_DIR
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "archive" / "2026" / "august"
            nested.mkdir(parents=True)
            (root / "root.xg").write_bytes(b"x")
            (nested / "nested.xgp").write_bytes(b"x")
            (nested / "UPPER.XG").write_bytes(b"x")
            (nested / "ignore.txt").write_text("x", encoding="utf-8")
            build.IMPORTS_DIR = root
            try:
                relative = [
                    path.relative_to(root).as_posix()
                    for path in build.imported_source_files()
                ]
                self.assertEqual(
                    relative,
                    [
                        "archive/2026/august/nested.xgp",
                        "archive/2026/august/UPPER.XG",
                        "root.xg",
                    ],
                )
            finally:
                build.IMPORTS_DIR = original

    def test_standalone_xgp_cube_is_kept_when_errcube_is_not_analysed(self) -> None:
        evaluation = build.Evaluation(
            lose_bg=0.01,
            lose_gammon=0.10,
            lose_single=0.40,
            win_single=0.60,
            win_gammon=0.20,
            win_bg=0.01,
            equity=0.30,
        )
        cube = SimpleNamespace(
            player=1,
            doubled=False,
            took=None,
            cube_value=0,
            error_double=build.xgread.NOT_ANALYSED,
            error_take=build.xgread.NOT_ANALYSED,
            no_double_equity=0.30,
            double_take_equity=0.55,
            double_drop_equity=1.0,
            no_double_analysis=evaluation,
            double_take_analysis=evaluation,
            position=SimpleNamespace(points=tuple([0] * 26)),
        )
        match = SimpleNamespace(
            identity_hash="match-history-hash",
            header=SimpleNamespace(
                player1="Player 1",
                player2="Player 2",
                match_length=99999,
                invert=1,
                date=None,
            ),
            games=[],
        )
        decision = SimpleNamespace(
            game_number=1, move_number=1, score1=0, score2=0, xgid="XGID=standalone"
        )
        cfg = build.load_config()

        self.assertIsNone(build.make_double_row(match, decision, cube, cfg))
        row = build.make_double_row(
            match,
            decision,
            cube,
            cfg,
            standalone=True,
            source_identity="xgpid1-test",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["errorLoss"], 0.0)
        self.assertEqual(row["classification"], "Position")
        self.assertEqual(row["matchId"], "xgpid1-test")
        self.assertEqual(row["playedAction"], "")
        self.assertEqual(row["bestAction"], "Double/Take")

    def test_xgp_identity_uses_saved_position_not_played_match_history(self) -> None:
        event = SimpleNamespace()
        first = [SimpleNamespace(event=event, xgid="XGID=AAA")]
        second = [SimpleNamespace(event=event, xgid="XGID=BBB")]
        self.assertNotEqual(build.xgp_identity(first), build.xgp_identity(second))
        self.assertEqual(build.xgp_identity(first), build.xgp_identity(first))

    def test_dead_cube_guard_allows_2_to_4_but_rejects_4_to_8_at_4_4_in_7pt(self) -> None:
        game = SimpleNamespace(
            header=SimpleNamespace(game_number=6, crawford_apply=False)
        )
        match = SimpleNamespace(
            header=SimpleNamespace(match_length=7),
            games=[game],
        )
        decision = SimpleNamespace(game_number=6, score1=4, score2=4)

        legal = SimpleNamespace(player=1, cube_value=1)  # current 2 -> offer 4
        self.assertIsNone(
            build.invalid_match_cube_reason(match, decision, legal)
        )

        dead = SimpleNamespace(player=1, cube_value=2)  # current 4 -> offer 8
        reason = build.invalid_match_cube_reason(match, decision, dead)
        self.assertIsNotNone(reason)
        self.assertIn("dead cube", reason)

    def test_crawford_cube_is_rejected(self) -> None:
        game = SimpleNamespace(
            header=SimpleNamespace(game_number=3, crawford_apply=True)
        )
        match = SimpleNamespace(
            header=SimpleNamespace(match_length=7),
            games=[game],
        )
        decision = SimpleNamespace(game_number=3, score1=6, score2=4)
        cube = SimpleNamespace(player=-1, cube_value=0)
        self.assertIn(
            "Crawford",
            build.invalid_match_cube_reason(match, decision, cube),
        )

    def test_take_quiz_uses_receiver_view_but_pre_offer_cube(self) -> None:
        row = {
            "decisionKind": "take",
            "position": [0] * 26,
            "quizPosition": [1] + [0] * 25,
            "player": "Doubler",
            "opponent": "Me",
            "quizPlayer": "Me",
            "quizOpponent": "Doubler",
            "playerScore": 4,
            "opponentScore": 4,
            "quizPlayerScore": 4,
            "quizOpponentScore": 4,
            "onRollScore": 4,
            "onRollOpponentScore": 4,
            "quizOnRollScore": 4,
            "quizOnRollOpponentScore": 4,
            "cubeValue": 2,
            "quizCubeValue": 4,
            "cubeOwner": "onRoll",
        }
        rendered, marker = build.quiz_render_state(row)

        self.assertEqual(marker, "white")
        self.assertIs(rendered["position"], row["quizPosition"])
        self.assertEqual(rendered["player"], "Me")
        self.assertEqual(rendered["opponent"], "Doubler")
        self.assertEqual(rendered["cubeValue"], 2)
        self.assertEqual(rendered["cubeOwner"], "opponent")

    def test_double_quiz_keeps_black_on_roll(self) -> None:
        row = {"decisionKind": "double"}
        rendered, marker = build.quiz_render_state(row)
        self.assertIs(rendered, row)
        self.assertEqual(marker, "black")

    def test_move_chain_collapse_preserves_unambiguous_single_checker_chain(self) -> None:
        # 21/15 15/9 plus two unrelated identical moves.
        rendered = [
            (20, 14, False),
            (14, 8, False),
            (12, 6, False),
            (12, 6, False),
        ]
        self.assertEqual(
            _collapse_unambiguous_hops(rendered),
            [
                (20, 8, False),
                (12, 6, False),
                (12, 6, False),
            ],
        )

    def test_compact_move_notation(self) -> None:
        self.assertEqual(
            build.compact_move_notation("8/4 8/4 8/4"),
            "8/4(3)",
        )
        self.assertEqual(
            build.compact_move_notation("7/4 7/4*"),
            "7/4*(2)",
        )
        self.assertEqual(
            build.compact_move_notation("13/11 8/6 6/4*(2)", (2, 2)),
            "13/11 8/4* 6/4",
        )
        self.assertEqual(
            build.compact_move_notation("8/6 6/5*(2)", (1, 1)),
            "8/5* 6/5",
        )
        self.assertEqual(
            build.compact_move_notation("Bar/23* 6/4 4/2(2)", (2, 2)),
            "Bar/23* 6/2 4/2",
        )
        self.assertEqual(
            build.compact_move_notation("Bar/24 24/23(2) 9/8", (1, 1)),
            "Bar/23 24/23 9/8",
        )
        # Keep the legacy grouping rule for ordinary, non-double dice.
        self.assertEqual(
            build.compact_move_notation("8/6 6/5*(2)", (2, 1)),
            "8/6 6/5*(2)",
        )


    def test_checker_move_highlights_track_only_mover_final_checker(self) -> None:
        before = [0] * 26
        after = [0] * 26
        before[13] = 1
        before[8] = -1
        after[8] = 1
        after[0] = -1

        highlights = build.checker_move_highlights(before, after, 1)
        self.assertEqual(highlights["sign"], 1)
        self.assertEqual(highlights["points"], {"8": 1})
        self.assertEqual(highlights["off"], 0)
        self.assertEqual(highlights["opponentBar"], 1)

    def test_checker_move_highlights_support_white_and_bearoff(self) -> None:
        before = [0] * 26
        after = [0] * 26
        before[1] = -1

        highlights = build.checker_move_highlights(before, after, -1)
        self.assertEqual(highlights["sign"], -1)
        self.assertEqual(highlights["points"], {})
        self.assertEqual(highlights["off"], 1)
        self.assertEqual(highlights["opponentBar"], 0)


    def test_hit_white_bar_highlights_only_newly_hit_checker(self) -> None:
        before = [0] * 26
        after = [0] * 26
        # One white checker was already on the bar; a second is hit by black.
        before[0] = -1
        before[8] = -1
        before[13] = 1
        after[0] = -2
        after[8] = 1

        highlights = build.checker_move_highlights(before, after, 1)
        self.assertEqual(highlights["opponentBar"], 1)

        row = {
            "id": "TEST-HIT-BAR",
            "position": after,
            "matchLength": 7,
            "onRollScore": 0,
            "onRollOpponentScore": 0,
            "cubeOwner": "center",
            "cubeValue": 1,
            "diceValues": [],
        }
        svg = build.render_board_svg(
            row,
            show_pip_counts=False,
            move_highlights=highlights,
        )
        self.assertEqual(
            svg.count('fill="#ffffff" stroke="#6F5424" stroke-width="4.0"'),
            1,
        )

    def test_move_highlight_svg_uses_dark_gold_fill_for_black_and_outline_for_white(self) -> None:
        base_row = {
            "id": "TEST-HIGHLIGHT",
            "position": [0] * 26,
            "matchLength": 7,
            "onRollScore": 0,
            "onRollOpponentScore": 0,
            "cubeOwner": "center",
            "cubeValue": 1,
            "diceValues": [],
        }

        black_row = dict(base_row)
        black_row["position"] = [0] * 26
        black_row["position"][6] = 1
        black_svg = build.render_board_svg(
            black_row,
            show_pip_counts=False,
            move_highlights={"sign": 1, "points": {"6": 1}, "off": 0},
        )
        self.assertIn('fill="#6F5424" stroke="#6F5424"', black_svg)

        black_off_row = dict(base_row)
        black_off_row["position"] = [0] * 26
        black_off_row["onRollOff"] = 1
        black_off_svg = build.render_board_svg(
            black_off_row,
            show_pip_counts=False,
            move_highlights={"sign": 1, "points": {}, "off": 1},
        )
        self.assertIn('fill="#6F5424" stroke="#6F5424" stroke-width="1.6"', black_off_svg)

        white_row = dict(base_row)
        white_row["position"] = [0] * 26
        white_row["position"][19] = -1
        white_svg = build.render_board_svg(
            white_row,
            show_pip_counts=False,
            move_highlights={"sign": -1, "points": {"19": 1}, "off": 0},
        )
        self.assertIn('fill="#ffffff" stroke="#6F5424" stroke-width="4.0"', white_svg)

    def test_match_board_separates_match_length_and_scores(self) -> None:
        row = {
            "id": "TEST-MATCH",
            "position": [0] * 26,
            "matchLength": 25,
            "onRollScore": 7,
            "onRollOpponentScore": 12,
            "cubeOwner": "center",
            "cubeValue": 4,
            "diceValues": [],
        }
        svg = build.render_board_svg(row, show_pip_counts=False)
        self.assertIn('fill="#ffffff" font-size="27" font-weight="700">25</text>', svg)
        self.assertNotIn(">ML</text>", svg)
        self.assertIn('fill="#000000" font-size="27" font-weight="700">12</text>', svg)
        self.assertIn('fill="#000000" font-size="27" font-weight="700">7</text>', svg)
        self.assertNotIn(">12/25</text>", svg)
        self.assertNotIn(">7/25</text>", svg)

    def test_unlimited_board_shows_u_without_scores(self) -> None:
        row = {
            "id": "TEST-UNLIMITED",
            "position": [0] * 26,
            "matchLength": 99999,
            "onRollScore": 12,
            "onRollOpponentScore": 34,
            "cubeOwner": "center",
            "cubeValue": 4,
            "diceValues": [],
        }
        svg = build.render_board_svg(row, show_pip_counts=False)
        self.assertIn('fill="#ffffff" font-size="27" font-weight="700">U</text>', svg)
        self.assertNotIn('font-size="27" font-weight="700">12</text>', svg)
        self.assertNotIn('font-size="27" font-weight="700">34</text>', svg)
        self.assertNotIn(">ML</text>", svg)
        self.assertIn(">4</text>", svg)


if __name__ == "__main__":
    unittest.main()
