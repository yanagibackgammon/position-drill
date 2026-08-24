from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from scripts import build
from vendor.xgread._notation import _collapse_unambiguous_hops


class BuildLogicTests(unittest.TestCase):
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

    def test_cube_value_number(self) -> None:
        self.assertEqual(build.cube_value_number(0), 1)
        self.assertEqual(build.cube_value_number(1), 2)
        self.assertEqual(build.cube_value_number(-2), 4)
        self.assertEqual(build.cube_value_number(3), 8)

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

    def test_unlimited_board_score_is_zero_zero(self) -> None:
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
        self.assertGreaterEqual(svg.count(">0/0</text>"), 2)
        self.assertIn(">4</text>", svg)


if __name__ == "__main__":
    unittest.main()
