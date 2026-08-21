"""Binary parsing of XG file structures (internal).

All offsets and alignment rules are taken directly from xg_format.pas.
Pascal's default record alignment: integers on 4-byte boundaries, doubles on
8-byte boundaries, ShortString/Boolean/byte do NOT align.
All data is little-endian.
"""

from __future__ import annotations

import struct
from dataclasses import replace
from datetime import datetime, timedelta

from .models import (
    NOT_ANALYSED,
    CubeAction,
    Evaluation,
    Game,
    GameFooter,
    GameHeader,
    Match,
    MatchFooter,
    MatchHeader,
    Move,
    MoveCandidate,
    MoveDetail,
    Position,
)

# ── Constants ─────────────────────────────────────────────────────────────────

RM_MAGICNUMBER = 0x484D4752   # RGMH — TRichGameHeader magic
MAGIC_NUMBER   = 0x494C4D44   # DMLI — TSaveRec match header magic
RICH_HDR_SIZE  = 8232         # sizeof(TRichGameHeader)
SAVE_REC_SIZE  = 2560         # sizeof(TSaveRec)

# EntryType values (Typesave enum)
TS_HEADER_MATCH = 0
TS_HEADER_GAME  = 1
TS_CUBE         = 2
TS_MOVE         = 3
TS_FOOTER_GAME  = 4
TS_FOOTER_MATCH = 5

# NOT_ANALYSED (-1000.0) is defined in models.py (shared with the public API) and
# re-exported here for the parser's internal use.

# ── TRichGameHeader ───────────────────────────────────────────────────────────
#
# packed record — no gaps between fields
#  dwMagicNumber    : DWORD   4
#  dwHeaderVersion  : DWORD   4
#  dwHeaderSize     : DWORD   4
#  liThumbnailOffset: int64   8
#  dwThumbnailSize  : DWORD   4
#  guidGameId       : TGUID   16  (D1:4 D2:2 D3:2 D4:8)
#  szGameName       : 1024 widechar = 2048 bytes
#  szSaveName       : 2048
#  szLevelName      : 2048
#  szComments       : 2048
#  total = 4+4+4+8+4+16+2048*4 = 8232 ✓
#
_RICH_HDR = struct.Struct("<IIIqIIHH8s2048s2048s2048s2048s")
assert _RICH_HDR.size == RICH_HDR_SIZE, f"Rich header size mismatch: {_RICH_HDR.size}"


def parse_rich_header(data: bytes) -> tuple[dict, int]:
    """Parse TRichGameHeader from the first 8232 bytes.

    Returns (header_dict, thumbnail_size).
    The game archive starts at offset 8232 + thumbnail_size.
    """
    if len(data) < RICH_HDR_SIZE:
        raise ValueError(f"File too short for TRichGameHeader: {len(data)} bytes")

    (magic, version, hdr_size, thumb_offset, thumb_size,
     guid_d1, guid_d2, guid_d3, guid_d4,
     game_name_raw, save_name_raw, level_name_raw, comments_raw) = _RICH_HDR.unpack_from(data)

    if magic != RM_MAGICNUMBER:
        raise ValueError(
            f"Invalid magic number: {magic:#010x} (expected {RM_MAGICNUMBER:#010x})"
        )

    return {
        "version": version,
        "header_size": hdr_size,
        "thumbnail_offset": thumb_offset,
        "thumbnail_size": thumb_size,
        "game_name": _decode_widechar(game_name_raw),
        "save_name": _decode_widechar(save_name_raw),
        "level_name": _decode_widechar(level_name_raw),
        "comments": _decode_widechar(comments_raw),
    }, thumb_size


# ── TSaveRec stream parser ────────────────────────────────────────────────────

def parse_xg_stream(data: bytes, thumbnail: bytes = b"") -> Match:
    """Parse a sequence of TSaveRec records and assemble a Match.

    *data* is the raw .xg bytes (extracted from the ZLB archive or read directly).
    """
    if len(data) % SAVE_REC_SIZE != 0:
        raise ValueError(
            f"XG stream length {len(data)} is not a multiple of {SAVE_REC_SIZE}"
        )

    match_header: MatchHeader | None = None
    match_footer: MatchFooter | None = None
    games: list[Game] = []
    current_game_hdr: GameHeader | None = None
    current_events: list[Move | CubeAction] = []

    for i in range(0, len(data), SAVE_REC_SIZE):
        rec = data[i : i + SAVE_REC_SIZE]
        entry_type = rec[8]

        if entry_type == TS_HEADER_MATCH:
            match_header = _parse_header_match(rec)
        elif entry_type == TS_HEADER_GAME:
            current_game_hdr = _parse_header_game(rec)
            current_events = []
        elif entry_type == TS_CUBE:
            current_events.append(_parse_cube(rec))
        elif entry_type == TS_MOVE:
            current_events.append(_parse_move(rec))
        elif entry_type == TS_FOOTER_GAME:
            footer = _parse_footer_game(rec)
            if current_game_hdr is not None:
                games.append(Game(current_game_hdr, tuple(current_events), footer))
            current_events = []
        elif entry_type == TS_FOOTER_MATCH:
            match_footer = _parse_footer_match(rec)

    # Include any trailing in-progress game that has no tsFooterGame record
    if current_game_hdr is not None:
        games.append(Game(current_game_hdr, tuple(current_events), footer=None))

    if match_header is None:
        raise ValueError("No tsHeaderMatch record found in XG stream")

    return Match(match_header, tuple(games), match_footer, thumbnail)


# ── Record parsers ────────────────────────────────────────────────────────────
#
# Offsets are absolute from the start of the 2560-byte TSaveRec buffer.
# Alignment is as documented in xg_format.pas (and verified by the inline table
# in that file).  All struct.unpack_from calls use "<" (little-endian).


def _parse_header_match(rec: bytes) -> MatchHeader:
    # Offsets verified against the inline example in xg_format.pas
    s_player1 = _shortstring(rec, 9)
    s_player2 = _shortstring(rec, 50)

    # integer fields — aligned to 4-byte boundaries
    match_length, variation = struct.unpack_from("<ii", rec, 92)
    crawford, jacoby, beaver, auto_double = struct.unpack_from("<4?", rec, 100)
    elo1, elo2 = struct.unpack_from("<dd", rec, 104)
    exp1, exp2 = struct.unpack_from("<ii", rec, 120)
    date_raw, = struct.unpack_from("<d", rec, 128)
    s_event = _shortstring(rec, 136)

    game_id, = struct.unpack_from("<i", rec, 268)  # 265→pad→268
    comp_level1, comp_level2 = struct.unpack_from("<ii", rec, 272)
    count_for_elo, add_profile1, add_profile2 = struct.unpack_from("<3?", rec, 280)
    s_location = _shortstring(rec, 283)

    game_mode, = struct.unpack_from("<i", rec, 412)
    s_round = _shortstring(rec, 417)  # offset 417: after Imported(1) at 416

    invert, version, magic = struct.unpack_from("<iii", rec, 548)  # 546→pad→548

    entered, counted, unrated_imp = struct.unpack_from("<3?", rec, 572)
    comment_hdr, comment_ftr = struct.unpack_from("<ii", rec, 576)  # 575→pad→576
    is_money, = struct.unpack_from("<?", rec, 584)
    win_money, lose_money = struct.unpack_from("<ff", rec, 588)  # 585→pad→588
    currency, = struct.unpack_from("<i", rec, 596)
    fee_money, table_stake = struct.unpack_from("<ff", rec, 600)
    site_id, cube_limit, auto_double_max = struct.unpack_from("<iii", rec, 608)
    transcribed, = struct.unpack_from("<?", rec, 620)

    # TShortUnicodeString fields (array[0..128] of WideChar = 258 bytes each)
    # array of char aligns to 2-byte boundary; 621 is odd → pad 1 → 622
    u_event    = _short_unicode(rec, 622)
    u_player1  = _short_unicode(rec, 880)
    u_player2  = _short_unicode(rec, 1138)
    u_location = _short_unicode(rec, 1396)
    u_round    = _short_unicode(rec, 1654)

    # TTimeSetting starts at 1912; ClockType at 1912, PerGame at 1916,
    # Time1 at 1920 (1917→pad→1920)
    # (We don't expose TimeSetting in the public model right now)

    # Transcriber (TShortUnicodeString) at 1960
    # u_transcriber = _short_unicode(rec, 1960)

    # Use Unicode names when version >= 24; fall back to ANSI for older files
    player1  = u_player1  if (version >= 24 and u_player1)  else s_player1
    player2  = u_player2  if (version >= 24 and u_player2)  else s_player2
    event    = u_event    if (version >= 24 and u_event)    else s_event
    location = u_location if (version >= 24 and u_location) else s_location
    round_name = u_round  if (version >= 24 and u_round)    else s_round

    return MatchHeader(
        player1=player1,
        player2=player2,
        match_length=match_length,
        variation=variation,
        crawford=crawford,
        jacoby=jacoby,
        beaver=beaver,
        elo1=elo1,
        elo2=elo2,
        experience1=exp1,
        experience2=exp2,
        date=_tdatetime(date_raw),
        event=event,
        location=location,
        round_name=round_name,
        game_mode=game_mode,
        version=version,
        magic=magic,
        site_id=site_id,
        cube_limit=cube_limit,
        comment_header_index=comment_hdr,
        comment_footer_index=comment_ftr,
    )


def _parse_header_game(rec: bytes) -> GameHeader:
    # First integer needs 4-byte alignment from offset 9 → pad to 12
    score1, score2 = struct.unpack_from("<ii", rec, 12)
    crawford_apply, = struct.unpack_from("<?", rec, 20)
    pos_init = _position(rec, 21)          # 26 signed bytes, no alignment
    game_number, = struct.unpack_from("<i", rec, 48)   # 47→pad→48
    in_progress, = struct.unpack_from("<?", rec, 52)
    comment_hdr, comment_ftr = struct.unpack_from("<ii", rec, 56)  # 53→pad→56
    n_auto_doubles, = struct.unpack_from("<i", rec, 64)

    return GameHeader(
        score1=score1,
        score2=score2,
        crawford_apply=crawford_apply,
        initial_position=pos_init,
        game_number=game_number,
        in_progress=in_progress,
        n_auto_doubles=n_auto_doubles,
        comment_index=comment_hdr,
    )


def _parse_move(rec: bytes) -> Move:
    pos_before = _position(rec, 9)    # 26 bytes at 9
    pos_after  = _position(rec, 35)   # 26 bytes at 35
    # ActifP: integer, needs 4-byte align from 61 → pad to 64
    actif, = struct.unpack_from("<i", rec, 64)
    # Moves[1..8]: 8 integers at 68
    raw_moves = struct.unpack_from("<8i", rec, 68)
    dice = struct.unpack_from("<2i", rec, 100)
    # CubeA at 108 (log-encoded cube state: 0=centre, +n=player owns 2^n, -n=opp owns 2^n)
    cube_a, = struct.unpack_from("<i", rec, 108)
    # ErrorM (double) at 112 (8-byte aligned ✓); NMoveEval at 120
    n_move_eval, = struct.unpack_from("<i", rec, 120)
    # DataMoves (EngineStructBestMove, 2184 bytes) at 124:
    #   NMoveEval ends at 124; EngineStructBestMove needs 4-byte align; 124%4=0 ✓
    _DMOVES_BASE = 124
    # ErrMove (double): Played(1) at 2308, then 2309→align8→2312
    err_move, = struct.unpack_from("<d", rec, 2312)
    err_luck, = struct.unpack_from("<d", rec, 2320)
    # CompChoice (integer) at 2328 is the *computer's* recommended move, not the one
    # played, so it is not read here. The played move is in `move_details`; which
    # candidate that corresponds to is derived by Move.played_index.
    # Flagged (Boolean) at 2520; CommentMove (integer): 2521→align4→2524
    flagged, = struct.unpack_from("<?", rec, 2520)
    comment_move, = struct.unpack_from("<i", rec, 2524)

    # Parse the moves list (terminated by -1)
    move_details = _parse_move_list(raw_moves)

    candidates = _parse_all_candidates(rec, _DMOVES_BASE, n_move_eval)

    return Move(
        player=actif,
        position_before=pos_before,
        position_after=pos_after,
        dice=(dice[0], dice[1]),
        moves=tuple(move_details),
        cube_value=cube_a,
        error=err_move,
        luck=err_luck,
        candidates=candidates,
        flagged=flagged,
        comment_index=comment_move,
    )


def _parse_cube(rec: bytes) -> CubeAction:
    # First integer: needs 4-byte align from offset 9 → 12
    actif, = struct.unpack_from("<i", rec, 12)
    doubled, = struct.unpack_from("<i", rec, 16)
    take, = struct.unpack_from("<i", rec, 20)
    beaver_r, = struct.unpack_from("<i", rec, 24)
    cube_b, = struct.unpack_from("<i", rec, 32)
    pos = _position(rec, 36)

    # EngineStructDoubleAction (DoubleD) at offset 64 (132 bytes).
    # Parse equB/equDouble/equDrop from DoubleD:
    # Layout of EngineStructDoubleAction (all offsets relative to DoubleD start at rec[64]):
    #   Pos (26b) at 0
    #   Level (integer) at 28 (26→pad→28)
    #   Score[1..2] (2×int) at 32
    #   Cube (int) at 40
    #   CubePos (int) at 44
    #   Jacoby (int) at 48
    #   Crawford (SmallInt) at 52
    #   met (SmallInt) at 54
    #   FlagDouble (SmallInt) at 56
    #   isBeaver (SmallInt) at 58
    #   Eval[0..6] (7×single) at 60
    #   equB (single) at 88
    #   equDouble (single) at 92
    #   equDrop (single) at 96
    #   LevelRequest (SmallInt) at 100
    #   DoubleChoice3 (SmallInt) at 102
    #   EvalDouble[0..6] (7×single) at 104
    dd_base = 64
    flag_double, = struct.unpack_from("<h", rec, dd_base + 56)
    is_beaver, = struct.unpack_from("<h", rec, dd_base + 58)
    eval_no_double = Evaluation.from_seq(struct.unpack_from("<7f", rec, dd_base + 60))
    equ_b, equ_double, equ_drop = struct.unpack_from("<fff", rec, dd_base + 88)
    eval_double_take = Evaluation.from_seq(struct.unpack_from("<7f", rec, dd_base + 104))

    # Fields after DoubleD (ends at 64+132=196):
    # ErrCube (Double): needs 8-byte align from 196 → 200? 196/8=24.5 → 200
    err_cube_offset = _align8(196)
    err_cube, = struct.unpack_from("<d", rec, err_cube_offset)
    # DiceRolled (string[2] = 3 bytes) at err_cube_offset+8
    # ErrTake (Double): after DiceRolled → 3 bytes → then align to 8
    dice_rolled_end = err_cube_offset + 8 + 3
    err_take_offset = _align8(dice_rolled_end)
    err_take, = struct.unpack_from("<d", rec, err_take_offset)
    # RolloutindexD (integer) at err_take_offset+8
    rollout_idx, = struct.unpack_from("<i", rec, err_take_offset + 8)
    # CompChoiceD (integer)
    comp_choice_d, = struct.unpack_from("<i", rec, err_take_offset + 12)
    # AnalyzeC (integer)
    analyze_c, = struct.unpack_from("<i", rec, err_take_offset + 16)
    # ErrBeaver (Double): align to 8
    err_beaver_offset = _align8(err_take_offset + 20)
    err_beaver, = struct.unpack_from("<d", rec, err_beaver_offset)
    # ErrRaccoon (Double)
    err_raccoon, = struct.unpack_from("<d", rec, err_beaver_offset + 8)
    # AnalyzeCR (integer)
    # inValid (integer)
    # TutorCube (ShortInt) / TutorTake (ShortInt) / ErrTutorCube (Double) / ErrTutorTake (Double)
    # FlaggedDouble (Boolean) at some offset
    # CommentCube (integer)

    # For the comment index, approximate: skip ahead from err_raccoon
    after_raccoon = err_beaver_offset + 16   # 2 doubles
    # inValid(int) at next 4-byte boundary
    invalid_offset = _align4(after_raccoon + 4 + 4)  # AnalyzeCR + inValid
    # TutorCube (b) + TutorTake (b)
    # ErrTutorCube (d) at 8-byte boundary
    # ErrTutorTake (d)
    # FlaggedDouble (?)
    # CommentCube (i)
    # EditedCube (?)
    # TimeDelayCube (?)
    # TimeDelayCubeDone (?)
    # NumberOfAutoDoubleCube (i)
    # TimeBot, TimeTop (i, i)

    # Rather than chasing every byte, parse FlaggedDouble and CommentCube
    # relative to known positions.  after_raccoon+16 = err_beaver_offset+16+4+4
    # Let's compute carefully:
    # err_raccoon ends at err_beaver_offset+16
    analyze_cr_offset = err_beaver_offset + 16
    invalid_offset2   = analyze_cr_offset + 4
    tutor_cube_offset = invalid_offset2 + 4   # ShortInt
    tutor_take_offset = tutor_cube_offset + 1  # ShortInt
    err_tutor_cube_offset = _align8(tutor_take_offset + 1)
    err_tutor_take_offset = err_tutor_cube_offset + 8
    flagged_offset = err_tutor_take_offset + 8  # Boolean
    comment_offset = _align4(flagged_offset + 1)
    comment_cube, = struct.unpack_from("<i", rec, comment_offset)
    flagged, = struct.unpack_from("<?", rec, flagged_offset)

    doubled_bool = (doubled == 1)
    took_val: bool | None = bool(take) if doubled_bool else None

    return CubeAction(
        player=actif,
        doubled=doubled_bool,
        took=took_val,
        beavered=bool(beaver_r),
        cube_value=cube_b,
        position=pos,
        error_double=err_cube,
        error_take=err_take,
        no_double_equity=equ_b,
        double_take_equity=equ_double,
        double_drop_equity=equ_drop,
        no_double_analysis=eval_no_double,
        double_take_analysis=eval_double_take,
        flagged=bool(flagged),
        comment_index=comment_cube,
    )


def _parse_footer_game(rec: bytes) -> GameFooter:
    # First integer: 4-byte align from 9 → 12
    score1, score2 = struct.unpack_from("<ii", rec, 12)
    crawford_applyg, = struct.unpack_from("<?", rec, 20)
    winner, = struct.unpack_from("<i", rec, 24)  # 21→pad→24
    points_won, termination = struct.unpack_from("<ii", rec, 28)
    # ErrResign (double): 36→pad→40 (8-byte boundary after 32+4=36)
    err_resign, err_take_resign = struct.unpack_from("<dd", rec, 40)
    # Eval[0..6] (7 doubles) at 56
    eval_level, = struct.unpack_from("<i", rec, 56 + 7 * 8)

    return GameFooter(
        score1=score1,
        score2=score2,
        winner=winner,
        points_won=points_won,
        termination=termination,
        comment_index=-1,
    )


def _parse_footer_match(rec: bytes) -> MatchFooter:
    # First integer: 4-byte align from 9 → 12
    score1, score2, winner_m = struct.unpack_from("<iii", rec, 12)
    # Elo1m (double): 12+12=24, already 8-byte aligned ✓
    elo1, elo2 = struct.unpack_from("<dd", rec, 24)
    exp1, exp2 = struct.unpack_from("<ii", rec, 40)
    date_raw, = struct.unpack_from("<d", rec, 48)

    return MatchFooter(
        score1=score1,
        score2=score2,
        winner=winner_m,
        elo1=elo1,
        elo2=elo2,
        experience1=exp1,
        experience2=exp2,
        date=_tdatetime(date_raw),
    )


# ── EngineStructBestMove helpers ──────────────────────────────────────────────
#
# EngineStructBestMove layout (2184 bytes, starting at offset `base` in rec):
#   Pos            (26b)   base+0
#   Dice[1..2]     (2×i)   base+28  (align 4 from 26→28)
#   Level          (i)     base+36
#   Score[1..2]    (2×i)   base+40
#   Cube           (i)     base+48
#   CubePos        (i)     base+52
#   Crawford       (i)     base+56
#   Jacoby         (i)     base+60
#   Nmoves         (i)     base+64
#   PosPlayed[1..32] (32×26b)  base+68
#   Moves[1..32, 1..8] (32×8b)  base+68+32*26=68+832=900
#   EvalLevel[1..32] (32×4b)    base+900+32*8=900+256=1156
#   Eval[1..32, 0..6] (32×7×4b) base+1156+32*4=1156+128=1284 — wait align needed?
#     EvalLevel is TEvalLevel = {Level:SmallInt, isDouble:Boolean, Fill1:byte} = 4 bytes
#     So 32×4 = 128 bytes → EvalLevel ends at base+1156+128=1284
#   Eval[1..32, 0..6]: 32×7 singles = 896 bytes, starts at base+1284
#     But Eval[i] has 7 singles → each eval block is 28 bytes; 32×28=896
#   Irrelevant (Boolean) at base+1284+896=base+2180
#   met (ShortInt) at base+2181
#   Choice0 (ShortInt) at base+2182
#   Choice3 (ShortInt) at base+2183

_ESB_POS_PLAYED_OFFSET = 68
_ESB_MOVES_OFFSET      = _ESB_POS_PLAYED_OFFSET + 32 * 26   # 68+832=900
_ESB_EVAL_LEVEL_OFFSET = _ESB_MOVES_OFFSET + 32 * 8          # 900+256=1156
_ESB_EVAL_OFFSET       = _ESB_EVAL_LEVEL_OFFSET + 32 * 4     # 1156+128=1284
_ESB_CHOICE0_OFFSET    = 2182
_ESB_CHOICE3_OFFSET    = 2183


def _parse_all_candidates(rec: bytes, base: int, n_moves: int) -> tuple[MoveCandidate, ...]:
    """Parse all engine candidate moves from EngineStructBestMove (best-first order)."""
    result = []
    for i in range(min(max(n_moves, 0), 32)):
        move_offset = base + _ESB_MOVES_OFFSET + i * 8
        raw = struct.unpack_from("<8b", rec, move_offset)  # ShortInt (1-byte signed)
        details = _parse_move_list(raw)
        eval_offset = base + _ESB_EVAL_OFFSET + i * 7 * 4
        if eval_offset + 28 > len(rec):
            break
        vals = struct.unpack_from("<7f", rec, eval_offset)
        result.append(MoveCandidate(moves=tuple(details), evaluation=Evaluation.from_seq(vals)))

    # Candidates are stored best-first; fill in equity lost vs. the best move.
    if result:
        best_equity = result[0].evaluation.equity
        result = [
            replace(c, equity_loss=best_equity - c.evaluation.equity) for c in result
        ]
    return tuple(result)


# ── Low-level helpers ─────────────────────────────────────────────────────────

def _position(rec: bytes, offset: int) -> Position:
    """Read 26 signed bytes (PositionEngine) from *rec* at *offset*."""
    return Position(tuple(struct.unpack_from("<26b", rec, offset)))


def _shortstring(rec: bytes, offset: int) -> str:
    """Decode a Pascal ShortString at *offset* in *rec*."""
    length = rec[offset]
    return rec[offset + 1 : offset + 1 + length].decode("latin-1")


def _short_unicode(rec: bytes, offset: int) -> str:
    """Decode a TShortUnicodeString (129 WideChars = 258 bytes) at *offset*."""
    raw = rec[offset : offset + 258]
    # Decode UTF-16-LE, stop at first null character
    try:
        s = raw.decode("utf-16-le")
    except UnicodeDecodeError:
        return ""
    null = s.find("\x00")
    return s[:null] if null != -1 else s


def _decode_widechar(raw: bytes) -> str:
    """Decode a null-terminated UTF-16-LE string (from TRichGameHeader)."""
    try:
        s = raw.decode("utf-16-le")
    except UnicodeDecodeError:
        return ""
    null = s.find("\x00")
    return s[:null] if null != -1 else s


def _tdatetime(value: float) -> datetime | None:
    """Convert Delphi TDateTime (days since 1899-12-30) to Python datetime."""
    if value == 0.0:
        return None
    try:
        return datetime(1899, 12, 30) + timedelta(days=value)
    except (OverflowError, ValueError):
        return None


def _parse_move_list(raw: tuple[int, ...]) -> list[MoveDetail]:
    """Interpret Moves[1..8] as (from1, dest1, from2, dest2, …), terminated by -1 on from.

    dest may be negative (bearing off); only from == -1 signals end of list.
    """
    details = []
    it = iter(raw)
    for from_pt in it:
        if from_pt == -1:
            break
        try:
            die = next(it)
        except StopIteration:
            break
        details.append(MoveDetail(from_point=from_pt, die=die))
    return details


def _align4(offset: int) -> int:
    return (offset + 3) & ~3


def _align8(offset: int) -> int:
    return (offset + 7) & ~7
