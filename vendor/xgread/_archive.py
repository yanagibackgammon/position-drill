"""ZLB archive parser (internal).

Reads the custom ZLIB-based archive format produced by eXtremeGammon and
documented in ZLIBArchive.pas.  The on-disk layout is:

    [compressed file 0]          ← at byte offset file_entry.start
    [compressed file 1]
    ...
    [registry: N × TZLBFileRec]  ← at byte offset archive_size
                                   (zlib-compressed when compressed_registry=True)
    [TZLBArchiveRec]             ← last ARC_REC_SIZE bytes of the stream
"""

from __future__ import annotations

import struct
import zlib


# ── Struct layouts ────────────────────────────────────────────────────────────

# TZLBArchiveRec (Delphi, default alignment, ~33 bytes of data, padded to 36)
#   CRC          : longint   (4)
#   FileCount    : longint   (4)
#   Version      : longint   (4)
#   RegistrySize : longint   (4)
#   ArchiveSize  : longint   (4)
#   CompressedRegistry : Boolean (1)
#   Reserved     : array[0..11] of byte (12)
#   tail pad to 4-byte boundary → total 36
_ARC_REC_FMT = struct.Struct("<iiiii?11x")  # 4+4+4+4+4+1+11pad = 32? Let's be explicit:
# Actually: 4+4+4+4+4=20, bool=1, reserved=12 → 33, padded to 36
# We'll try 36 first; if CRC check fails we adjust.
_ARC_REC_SIZE = 36

# TZLBFileRec (Delphi, default alignment)
#   name   : shortstring   (256)  — byte[0]=length, byte[1..n]=ANSI chars
#   path   : shortstring   (256)
#   osize  : longint        (4)
#   csize  : longint        (4)
#   start  : longint        (4)
#   CRC    : longint        (4)
#   Status : TFileStatus    (1)   — 0=Compressed, 1=Stored
#   CompressionLevel : TFileCompressionLevel (1)
#   tail pad to 4-byte boundary → 530 → 532
_FILE_REC_FMT = struct.Struct("<256s256siiii2B2x")
_FILE_REC_SIZE = _FILE_REC_FMT.size  # should be 532

_COMPRESSED = 0
_STORED = 1


# ── CRC32 (matches Delphi's polynomial $EDB88320 / IEEE) ─────────────────────

def _crc32(data: bytes) -> int:
    """CRC32 matching Delphi's TZLBArchive.GetCRC32 (covers all but last N bytes)."""
    return zlib.crc32(data) & 0xFFFFFFFF


def _signed32(v: int) -> int:
    """Reinterpret an unsigned 32-bit int as signed (to match Delphi longint)."""
    if v >= 0x80000000:
        return v - 0x100000000
    return v


# ── Public entry point ────────────────────────────────────────────────────────

def open_archive(data: bytes) -> dict[str, bytes]:
    """Parse a ZLB archive and return a mapping of filename → decompressed bytes.

    The archive stream should be the raw bytes starting immediately after the
    TRichGameHeader + thumbnail in an .xgp file (or the entire inner payload).

    Returns keys like ``"temp.xg"``, ``"temp.xgi"``, ``"temp.xgr"``, ``"temp.xgc"``.
    """
    arc = _parse_arc_rec(data)
    file_recs = _parse_registry(data, arc)
    return {rec["name"]: _extract(data, rec) for rec in file_recs}


# ── Internal helpers ──────────────────────────────────────────────────────────

def _parse_arc_rec(data: bytes) -> dict:
    """Read TZLBArchiveRec from the end of *data* and verify CRC32."""
    if len(data) < _ARC_REC_SIZE:
        raise ValueError(f"Archive too small: {len(data)} bytes")

    raw = data[-_ARC_REC_SIZE:]
    crc, file_count, version, registry_size, archive_size, compressed_registry = (
        _ARC_REC_FMT.unpack_from(raw)
    )

    # CRC covers everything except the trailing TZLBArchiveRec
    computed = _crc32(data[: len(data) - _ARC_REC_SIZE])
    if _signed32(computed) != crc:
        raise ValueError(
            f"Archive CRC mismatch: stored={crc:#010x} computed={_signed32(computed):#010x}"
        )

    return {
        "crc": crc,
        "file_count": file_count,
        "version": version,
        "registry_size": registry_size,
        "archive_size": archive_size,
        "compressed_registry": compressed_registry,
    }


def _parse_registry(data: bytes, arc: dict) -> list[dict]:
    """Read the file registry (array of TZLBFileRec) from *data*."""
    offset = arc["archive_size"]
    n = arc["file_count"]

    if arc["compressed_registry"]:
        # Registry is itself zlib-compressed; decompress before parsing
        compressed_reg = data[offset : len(data) - _ARC_REC_SIZE]
        reg_bytes = zlib.decompress(compressed_reg)
    else:
        expected = n * _FILE_REC_SIZE
        reg_bytes = data[offset : offset + expected]

    records = []
    for i in range(n):
        rec_raw = reg_bytes[i * _FILE_REC_SIZE : (i + 1) * _FILE_REC_SIZE]
        if len(rec_raw) < _FILE_REC_SIZE:
            raise ValueError(f"Truncated registry entry {i}")
        name_raw, path_raw, osize, csize, start, file_crc, status, _level = (
            _FILE_REC_FMT.unpack(rec_raw)
        )
        records.append(
            {
                "name": _shortstring(name_raw),
                "path": _shortstring(path_raw),
                "osize": osize,
                "csize": csize,
                "start": start,
                "crc": file_crc,
                "status": status,
            }
        )
    return records


def _extract(data: bytes, rec: dict) -> bytes:
    """Decompress (or copy) a single file entry from the archive bytes."""
    start = rec["start"]
    csize = rec["csize"]
    osize = rec["osize"]

    chunk = data[start : start + csize]
    if rec["status"] == _COMPRESSED:
        result = zlib.decompress(chunk)
    else:
        result = chunk

    if len(result) != osize:
        raise ValueError(
            f"Decompressed size mismatch for '{rec['name']}': "
            f"expected {osize}, got {len(result)}"
        )
    return result


def _shortstring(raw: bytes) -> str:
    """Decode a Pascal ShortString: first byte is length."""
    length = raw[0]
    return raw[1 : 1 + length].decode("latin-1")
