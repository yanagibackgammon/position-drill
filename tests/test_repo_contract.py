import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RepositoryContractTests(unittest.TestCase):
    """Keep Position Drill isolated from unrelated application sources."""

    def test_match_replay_only_paths_are_absent(self):
        forbidden = (
            ROOT / "matches",
            ROOT / "scripts" / "xg-parser.cjs",
        )
        for path in forbidden:
            self.assertFalse(path.exists(), f"Unrelated Match Replay path detected: {path.relative_to(ROOT)}")

    def test_entrypoint_remains_position_drill(self):
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("<title>POSITION DRILL</title>", index)
        self.assertIn('id="quiz-card"', index)
        self.assertNotIn("Backgammon Match Replay", index)
        self.assertNotIn('id="stage-wrap"', index)


if __name__ == "__main__":
    unittest.main()
