#!/usr/bin/env python3
"""
Fix wabt 1.0.36 wasm2c atomics for NON-shared memories (the variant woditor.wasm uses).

wasm2c's generated `<module>-impl.h` gets two non-shared atomic helpers wrong:

  * DEFINE_ATOMIC_RMW (add/sub/and/or/xor) returns the NEW value, but Wasm
    `*.atomic.rmw.*` must return the OLD value. libc++ uses these for
    shared_ptr refcounts (`__release_shared` checks fetch_add(-1) == 0) and
    locale::id numbering, so objects get freed while still referenced ->
    use-after-free -> dlmalloc corruption -> OOB trap shortly after boot.
  * DEFINE_ATOMIC_CMP_XCHG returns `expected` instead of the loaded value,
    so every compare-and-swap appears to succeed.

The `_shared` variants (C11 atomics) are already correct. This script is idempotent;
it exits 0 and prints "patched" or "already patched".
Usage: patch-wasm2c-atomics.py <path/to/woditor_wasm-impl.h>
"""
import re
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
orig = src

# --- 1. RMW: keep the loaded value as the return, store the computed one -------------------------
rmw_bad = re.compile(
    r"(#define DEFINE_ATOMIC_RMW\(name, opname, op, t1, t2\)[^\n]*\n"
    r"(?:[^\n]*\\\n)*?)"  # lines up to the computation
    r"(\s*)ret = ret op wrapped;(\s*\\\n)"
    r"(\s*)wasm_rt_memcpy\(MEM_ADDR\(mem, addr, sizeof\(t1\)\), &ret, sizeof\(t1\)\);")
m = rmw_bad.search(src)
if m:
    src = src[:m.start()] + m.group(1) + \
        f"{m.group(2)}t1 new_val_ = ret op wrapped;{m.group(3)}" + \
        f"{m.group(4)}wasm_rt_memcpy(MEM_ADDR(mem, addr, sizeof(t1)), &new_val_, sizeof(t1));" + \
        src[m.end():]
elif "t1 new_val_ = ret op wrapped;" not in src:
    sys.exit(f"[patch-wasm2c-atomics] ERROR: DEFINE_ATOMIC_RMW pattern not found in {path}")

# --- 2. CMPXCHG (non-shared): return the value that was in memory --------------------------------
cmp_start = src.find("#define DEFINE_ATOMIC_CMP_XCHG(name, t1, t2)")
if cmp_start < 0:
    sys.exit(f"[patch-wasm2c-atomics] ERROR: DEFINE_ATOMIC_CMP_XCHG not found in {path}")
shared_start = src.find("name##_shared", cmp_start)
body = src[cmp_start:shared_start]
if "return (t1)expected_wrapped;" in body:
    body = body.replace("return (t1)expected_wrapped;", "return (t1)ret;              ", 1)
    src = src[:cmp_start] + body + src[shared_start:]
elif "return (t1)ret;" not in body:
    sys.exit(f"[patch-wasm2c-atomics] ERROR: unexpected DEFINE_ATOMIC_CMP_XCHG body in {path}")

if src != orig:
    open(path, "w", encoding="utf-8", newline="\n").write(src)
    print("patched")
else:
    print("already patched")
