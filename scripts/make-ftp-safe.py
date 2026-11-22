#!/usr/bin/env python3
"""
Create an FTP-safe ASCII patch folder for any RPG Maker MV / MZ / VX Ace / VX / XP
game that contains Japanese or non-ASCII filenames which Switch FTP servers (ftpd)
fail to transfer.

Usage:
  python scripts/make-ftp-safe.py "C:\path\to\GameFolder"
  (or drag-and-drop a game folder onto make-ftp-safe.bat)

Output:
  Creates "<GameFolder>_ftp_patch\" containing ONLY:
    - _jp_map.txt (and www/_jp_map.txt for MV games)
    - Pure-ASCII copies (_jp_0001.png, _jp_0002.ogg, ...) of every non-ASCII file
  Simply upload the contents of "<GameFolder>_ftp_patch\" into your existing
  game folder on the Switch 2 via FTP! Both switch2-MV-loader.nro and
  mkxp-z-switch2.nro automatically read _jp_map.txt at startup.
"""
from pathlib import Path
import shutil
import sys


def is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def try_recover_mojibake(s: str) -> list[str]:
    """If a Japanese Shift-JIS zip was extracted on German/English Windows,
    recover the original UTF-8 Japanese path string as an extra alias."""
    recovered: list[str] = []
    for cp in ("cp850", "cp437", "cp1252", "latin1"):
        try:
            raw = bytearray()
            for ch in s:
                o = ord(ch)
                if o < 0x80 or (0x80 <= o <= 0x9F):
                    raw.append(o)
                else:
                    raw.extend(ch.encode(cp))
            # Restore Shift-JIS 0x5C ('\') trail bytes if split into '/'
            i = 0
            while i < len(raw):
                b = raw[i]
                if ((0x81 <= b <= 0x9F) or (0xE0 <= b <= 0xFC)) and (i + 1 < len(raw)):
                    if raw[i + 1] == ord("/"):
                        raw[i + 1] = ord("\\")
                    i += 2
                else:
                    i += 1
            utf8_str = bytes(raw).decode("cp932").replace("\\", "/")
            if utf8_str != s and utf8_str not in recovered:
                recovered.append(utf8_str)
        except Exception:
            pass
    return recovered


def process_game_folder(game_dir: Path, in_place: bool = False) -> None:
    game_dir = game_dir.resolve()
    if not game_dir.is_dir():
        print(f"[error] Not a directory: {game_dir}")
        return

    if in_place:
        out_dir = game_dir
    else:
        out_dir = game_dir.parent / f"{game_dir.name}_ftp_patch"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

    has_www = (game_dir / "www").is_dir()
    counter = 0
    map_lines: list[str] = ["# Universal Switch 2 Loader FTP-Safe Unicode Filename Map"]
    www_map_lines: list[str] = ["# Universal Switch 2 Loader FTP-Safe Unicode Filename Map (www)"]
    moved_sources: list[Path] = []

    for src_path in sorted(game_dir.rglob("*")):
        if not src_path.is_file():
            continue
        rel = src_path.relative_to(game_dir).as_posix()
        if rel.endswith("_jp_map.txt") or "/_jp_files/" in f"/{rel}":
            continue
        if is_ascii(rel):
            continue

        counter += 1
        ext = src_path.suffix if is_ascii(src_path.suffix) else ""
        parts = rel.split("/")

        # Keep leading pure-ASCII directory segments so files stay in their normal folder
        # when the folder name is ASCII (e.g. Audio/BGM/_jp_0001.ogg, www/img/pictures/_jp_0002.png)
        ascii_dir_parts: list[str] = []
        for p in parts[:-1]:
            if is_ascii(p):
                ascii_dir_parts.append(p)
            else:
                ascii_dir_parts.append("_jp_dir")
                break

        ascii_name = f"_jp_{counter:04d}{ext}"
        ascii_rel = "/".join(ascii_dir_parts + [ascii_name]) if ascii_dir_parts else ascii_name

        dst_path = out_dir / ascii_rel
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if in_place:
            shutil.move(str(src_path), str(dst_path))
            moved_sources.append(src_path)
        else:
            shutil.copy2(src_path, dst_path)

        # Record exact filename and any un-mojibaked Japanese UTF-8 filename
        all_keys = [rel] + try_recover_mojibake(rel)
        for key in all_keys:
            map_lines.append(f"{key}\t{ascii_rel}")
            if has_www and key.lower().startswith("www/") and ascii_rel.lower().startswith("www/"):
                www_map_lines.append(f"{key[4:]}\t{ascii_rel[4:]}")

        print(f"  [{counter:04d}] {rel} -> {ascii_rel}")

    if counter == 0:
        if not in_place:
            shutil.rmtree(out_dir, ignore_errors=True)
        print(f"[ok] No non-ASCII filenames found in '{game_dir.name}'.")
        return

    # Remove any now-empty non-ASCII directories when converting in-place
    if in_place:
        for d in sorted((p for p in game_dir.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            if not is_ascii(d.relative_to(game_dir).as_posix()):
                try:
                    d.rmdir()
                except OSError:
                    pass

    (out_dir / "_jp_map.txt").write_text("\n".join(map_lines) + "\n", encoding="utf-8", newline="\n")
    if has_www:
        www_out = out_dir / "www"
        www_out.mkdir(parents=True, exist_ok=True)
        (www_out / "_jp_map.txt").write_text("\n".join(www_map_lines) + "\n", encoding="utf-8", newline="\n")

    print("")
    print("===================================================================")
    print(f"  Converted {counter} non-ASCII file(s) for '{game_dir.name}'!")
    if in_place:
        print(f"  Folder is now 100% FTP-safe in place: {out_dir}")
        print("  Next step: Upload the entire folder directly via FTP!")
    else:
        print(f"  Patch folder: {out_dir}")
        print("  Next step:")
        print(f"    Upload the contents of '{out_dir.name}' into")
        print(f"    'sdmc:/switch/SW2RPGMGL/games/{game_dir.name}/' via FTP.")
    print("===================================================================")


def main() -> int:
    args = sys.argv[1:]
    in_place = False
    if "--in-place" in args:
        in_place = True
        args = [a for a in args if a != "--in-place"]
    if not args:
        print("Usage: python scripts/make-ftp-safe.py [--in-place] <PathToGameFolder> [...]")
        return 1
    for arg in args:
        process_game_folder(Path(arg), in_place=in_place)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
