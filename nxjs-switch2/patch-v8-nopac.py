#!/usr/bin/env python3
"""
Extract `v8_snapshot.embedded.o` from Switch 1's `libv8_monolith.a` and patch
ARMv8.3 Pointer Authentication (PAC) HINT instructions in `.text` to ARM64 NOP
(`0xd503201f`) for Nintendo Switch 2 (Cortex-A78C).

Why:
  switch-v8's prebuilt embedded builtins contain 9,508 ARMv8.3 PAC HINT
  instructions (`pacibsp`, `autibsp`, `pacib1716`, `autib1716`), while V8's C++
  stack unwinder was compiled WITHOUT `V8_ENABLE_CONTROL_FLOW_INTEGRITY`
  (no `StripPAC` / `xpaclri`).
  - On Switch 1 (Cortex-A57, ARMv8.0): those HINTs execute as hardware NOPs.
  - On Switch 2 (Cortex-A78C, ARMv8.3 with EnIB enabled by Horizon OS): the CPU
    tags LR with PAC bits in [63:48], causing V8's stack walker
    `Heap::FindCodeForInnerPointer(pc)` to fail with:
      `Check failed: maybe_code.has_value().`
  Replacing those HINT instructions with NOP reproduces Switch 1's exact
  execution semantics cleanly without modifying `/opt/devkitpro`.
"""
import struct
import subprocess
import sys
from pathlib import Path

PAC_HINTS = {
    0xd503233f: "paciasp",
    0xd503237f: "pacibsp",
    0xd50323bf: "autiasp",
    0xd50323ff: "autibsp",
    0xd503211f: "pacia1716",
    0xd503215f: "pacib1716",
    0xd503219f: "autia1716",
    0xd50321df: "autib1716",
}
ARM64_NOP = 0xd503201f


def find_elf64_section(data: bytes, target_name: str):
    assert data[:4] == b"\x7fELF" and data[4] == 2 and data[5] == 1, "Expected 64-bit LE ELF"
    e_shoff = struct.unpack_from("<Q", data, 40)[0]
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 58)

    str_sh_off = e_shoff + e_shstrndx * e_shentsize
    shstr_offset = struct.unpack_from("<Q", data, str_sh_off + 24)[0]
    shstr_size = struct.unpack_from("<Q", data, str_sh_off + 32)[0]
    shstr = data[shstr_offset:shstr_offset + shstr_size]

    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        sh_name = struct.unpack_from("<I", data, off)[0]
        end = shstr.find(b"\x00", sh_name)
        name = shstr[sh_name:end].decode("ascii", errors="replace")
        if name == target_name:
            sh_offset = struct.unpack_from("<Q", data, off + 24)[0]
            sh_size = struct.unpack_from("<Q", data, off + 32)[0]
            return sh_offset, sh_size
    raise RuntimeError(f"Section {target_name} not found in ELF")


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <libv8_monolith.a> <out_v8_snapshot_nopac.o>", file=sys.stderr)
        return 2

    lib_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    ar = "/opt/devkitpro/devkitA64/bin/aarch64-none-elf-ar"
    raw = subprocess.check_output([ar, "p", str(lib_path), "v8_snapshot.embedded.o"])
    buf = bytearray(raw)

    text_off, text_size = find_elf64_section(buf, ".text")
    assert text_size % 4 == 0, f".text size {text_size} not 4-byte aligned"

    counts = {}
    nop_bytes = struct.pack("<I", ARM64_NOP)
    for pos in range(text_off, text_off + text_size, 4):
        insn = struct.unpack_from("<I", buf, pos)[0]
        name = PAC_HINTS.get(insn)
        if name is not None:
            buf[pos:pos + 4] = nop_bytes
            counts[name] = counts.get(name, 0) + 1

    total = sum(counts.values())
    assert total > 0, "Expected PAC instructions in v8_snapshot.embedded.o .text, found 0"

    out_path.write_bytes(buf)
    print(f"[nopac] Patched {total} PAC HINT instructions -> NOP in {out_path} ({counts})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
