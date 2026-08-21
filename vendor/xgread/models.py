from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

MONEY_MATCH_LENGTH = 99999
NOT_ANALYSED = -1000.0


@dataclass(frozen=True)
class Position:
    """Board state from the on-roll player's point of view.

    Index 0 is the opponent bar, indexes 1-24 are board points and index 25 is
    the on-roll player's bar. Positive values are the on-roll player's checkers;
    negative values are the opponent's checkers.
    """

    points: tuple[int, ...]


@dataclass(frozen=True)
class MoveDetail:
    from_point: int
    die: int


@dataclass(frozen=True)
class Evaluation:
    lose_bg: float
    lose_gammon: float
    lose_single: float
    win_single: float
    win_gammon: float
    win_bg: float
    equity: float

    @classmethod
    def from_seq(cls, seq: tuple[float, ...]) -> "Evaluation":
        return cls(*seq[:7])


@dataclass(frozen=True)
class MoveCandidate:
    moves: tuple[MoveDetail, ...]
    evaluation: Evaluation
    equity_loss: float = 0.0


@dataclass(frozen=True)
class Move:
    player: int
    position_before: Position
    position_after: Position
    dice: tuple[int, int]
    moves: tuple[MoveDetail, ...]
    cube_value: int
    error: float
    luck: float
    candidates: tuple[MoveCandidate, ...]
    flagged: bool
    comment_index: int

    @property
    def is_analysed(self) -> bool:
        return self.error != NOT_ANALYSED

    @property
    def played_index(self) -> int | None:
        from ._notation import played_candidate_index

        return played_candidate_index(self.moves, self.candidates, self.position_before)

    @property
    def analysis(self) -> Evaluation | None:
        idx = self.played_index
        return self.candidates[idx].evaluation if idx is not None else None

    @property
    def notation(self) -> str:
        from ._notation import format_moves

        return format_moves(self.moves, self.position_before)


@dataclass(frozen=True)
class CubeAction:
    player: int
    doubled: bool
    took: bool | None
    beavered: bool
    cube_value: int
    position: Position
    error_double: float
    error_take: float
    no_double_equity: float
    double_take_equity: float
    double_drop_equity: float
    no_double_analysis: Evaluation
    double_take_analysis: Evaluation
    flagged: bool
    comment_index: int

    @property
    def is_analysed(self) -> bool:
        return self.error_double != NOT_ANALYSED


@dataclass(frozen=True)
class GameHeader:
    score1: int
    score2: int
    crawford_apply: bool
    initial_position: Position
    game_number: int
    in_progress: bool
    n_auto_doubles: int
    comment_index: int


@dataclass(frozen=True)
class GameFooter:
    score1: int
    score2: int
    winner: int
    points_won: int
    termination: int
    comment_index: int


@dataclass(frozen=True)
class Game:
    header: GameHeader
    events: tuple[Move | CubeAction, ...]
    footer: GameFooter | None

    @property
    def moves(self) -> tuple[Move, ...]:
        return tuple(event for event in self.events if isinstance(event, Move))

    @property
    def cube_actions(self) -> tuple[CubeAction, ...]:
        return tuple(event for event in self.events if isinstance(event, CubeAction))

    def position_after(self, move_number: int) -> Position:
        moves = self.moves
        if move_number < 1 or move_number > len(moves):
            raise IndexError(
                f"move_number {move_number} out of range (1..{len(moves)})"
            )
        return moves[move_number - 1].position_after


@dataclass(frozen=True)
class MatchHeader:
    player1: str
    player2: str
    match_length: int
    variation: int
    crawford: bool
    jacoby: bool
    beaver: bool
    elo1: float
    elo2: float
    experience1: int
    experience2: int
    date: datetime | None
    event: str
    location: str
    round_name: str
    game_mode: int
    version: int
    magic: int
    site_id: int
    cube_limit: int
    comment_header_index: int
    comment_footer_index: int


@dataclass(frozen=True)
class MatchFooter:
    score1: int
    score2: int
    winner: int
    elo1: float
    elo2: float
    experience1: int
    experience2: int
    date: datetime | None


@dataclass(frozen=True)
class Decision:
    game_number: int
    move_number: int
    score1: int
    score2: int
    event: Move | CubeAction
    xgid: str


@dataclass(frozen=True)
class Match:
    header: MatchHeader
    games: tuple[Game, ...]
    footer: MatchFooter | None
    thumbnail: bytes

    @property
    def identity_hash(self) -> str:
        from ._identity import match_identity

        return match_identity(self)

    def decisions(self) -> Iterator[Decision]:
        from ._xgid import build_xgid

        xgid_match_length = 0 if self.header.match_length == MONEY_MATCH_LENGTH else self.header.match_length
        for game in self.games:
            score1, score2 = game.header.score1, game.header.score2
            for move_number, event in enumerate(game.events, start=1):
                if isinstance(event, Move):
                    points = event.position_before.points
                    dice: tuple[int, int] | None = event.dice
                else:
                    points = event.position.points
                    dice = None
                on_roll = event.player
                player_score = score1 if on_roll == 1 else score2
                opponent_score = score2 if on_roll == 1 else score1
                xgid = build_xgid(
                    points=points,
                    cube_value=event.cube_value,
                    dice=dice,
                    player_score=player_score,
                    opp_score=opponent_score,
                    match_length=xgid_match_length,
                    crawford_game=game.header.crawford_apply,
                    jacoby=self.header.jacoby,
                    beaver=self.header.beaver,
                    cube_limit=self.header.cube_limit,
                )
                yield Decision(
                    game_number=game.header.game_number,
                    move_number=move_number,
                    score1=score1,
                    score2=score2,
                    event=event,
                    xgid=xgid,
                )


PLAYER_LEVELS: dict[int, str] = {
    0: "1-ply", 1: "2-ply", 2: "3-ply", 12: "3-ply red",
    3: "4-ply", 4: "5-ply", 5: "6-ply", 6: "7-ply",
    100: "Rollout", 998: "Opening Book V2", 999: "Opening Book V1",
    1000: "XGRoller", 1001: "XGRoller+", 1002: "XGRoller++",
}

GAME_MODES: dict[int, str] = {
    0: "Free", 1: "Tutor", 2: "Teaching", 3: "Coaching",
    4: "Competition", 5: "IronMan", 6: "Custom",
}

VARIATIONS: dict[int, str] = {
    0: "Backgammon", 1: "Nackgammon", 2: "Hypergammon", 3: "Longgammon",
}

SITE_NAMES: dict[int, str] = {
    0: "GammonSite", 1: "FIBS", 2: "TrueMoney Games", 3: "GridGammon",
    4: "DailyGammon", 5: "NetGammon", 6: "VOG", 7: "Gammon Empire/Play65",
    8: "Club Games", 9: "PartyGammon", 10: "XcitingGames", 11: "BGRoom",
    12: "DiceArena", 13: "Safe Harbor Games", 14: "GameAccount", 15: "XG Mobile",
}

TERMINATION_NAMES: dict[int, str] = {
    0: "Drop", 1: "Single", 2: "Gammon", 3: "Backgammon",
    100: "Resign Single", 101: "Resign Single", 102: "Resign Gammon",
    103: "Resign Backgammon", 1000: "Settle",
}
