#!/usr/bin/env python3
"""
Pull the exact nx.js CI devkitPro toolchain + prebuilt portlibs (devkitA64,
switch-tools, libnx, switch-v8, switch-skia, switch-libuv, switch-ffmpeg,
switch-ada, switch-dav1d, dkp-pacman) directly from
ghcr.io/tootallnate/pacman-packages via OCI HTTPS API — no Docker required!
"""
import json
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO = "tootallnate/pacman-packages"
DEFAULT_REF = "sha256:92880d77878639768fe3696800104d68de1dfec65802bf7915689dd7bd718e53"


def get_token() -> str:
    url = f"https://ghcr.io/token?service=ghcr.io&scope=repository:{REPO}:pull"
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


def oci_get_json(url: str, token: str, accept: str) -> dict:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": accept,
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_blob(digest: str, token: str, out_path: Path) -> None:
    if out_path.exists() and out_path.stat().st_size > 0:
        print(f"  [cache] {out_path.name}")
        return
    url = f"https://ghcr.io/v2/{REPO}/blobs/{digest}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    tmp = out_path.with_suffix(".part")
    with urllib.request.urlopen(req) as resp, open(tmp, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total and (done % (16 * 1024 * 1024) < 1024 * 1024 or done == total):
                pct = done * 100 // total
                print(f"  downloading {digest[7:19]}: {done // (1024*1024)} / {total // (1024*1024)} MiB ({pct}%)", flush=True)
    tmp.replace(out_path)


def safe_extract_member(tf: tarfile.TarFile, member: tarfile.TarInfo, dest: Path) -> None:
    if member.isdir():
        dest.mkdir(parents=True, exist_ok=True)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        if dest.is_dir() and not dest.is_symlink():
            return
        dest.unlink()
    if member.issym():
        os.symlink(member.linkname, dest)
    elif member.islnk():
        # Hard link relative to root /
        target = Path("/") / member.linkname.lstrip("./")
        if target.exists():
            os.link(target, dest)
    elif member.isfile():
        with tf.extractfile(member) as src, open(dest, "wb") as dst:
            while True:
                buf = src.read(1024 * 1024)
                if not buf:
                    break
                dst.write(buf)
        os.chmod(dest, member.mode & 0o777)


def main() -> int:
    cache_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/cache/demons-roots-nxjs-portlibs").resolve()
    ref = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_REF
    layers_dir = cache_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)

    stamp = Path("/opt/devkitpro/.nxjs-oci-extracted")
    if stamp.exists() and Path("/opt/devkitpro/portlibs/switch/lib/libv8_monolith.a").exists():
        print("[oci] /opt/devkitpro already extracted with V8/Skia/libuv/FFmpeg — skipping download.")
        return 0

    print(f"[oci] Authenticating anonymously to ghcr.io/{REPO}...")
    token = get_token()

    accept = ", ".join([
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ])
    manifest = oci_get_json(f"https://ghcr.io/v2/{REPO}/manifests/{ref}", token, accept)

    if "manifests" in manifest:
        chosen = None
        for m in manifest["manifests"]:
            plat = m.get("platform", {})
            if plat.get("os") == "linux" and plat.get("architecture") == "amd64":
                chosen = m["digest"]
                break
        if not chosen:
            chosen = manifest["manifests"][0]["digest"]
        print(f"[oci] Resolved linux/amd64 manifest: {chosen}")
        manifest = oci_get_json(f"https://ghcr.io/v2/{REPO}/manifests/{chosen}", token, accept)

    layers = manifest.get("layers", [])
    print(f"[oci] Extracting /opt/devkitpro + dkp-pacman from {len(layers)} image layers...")

    total_files = 0
    for idx, layer in enumerate(layers, 1):
        digest = layer["digest"]
        size_mb = layer.get("size", 0) / (1024 * 1024)
        print(f"[oci] Layer {idx}/{len(layers)} ({size_mb:.1f} MiB): {digest[:24]}...", flush=True)
        layer_file = layers_dir / f"layer-{idx:02d}-{digest[7:19]}.tar.gz"
        download_blob(digest, token, layer_file)

        try:
            with tarfile.open(layer_file, "r:*") as tf:
                for member in tf.getmembers():
                    name = member.name.lstrip("./")
                    if not (
                        name.startswith("opt/devkitpro/")
                        or name == "opt/devkitpro"
                        or name.startswith("usr/bin/dkp-")
                        or name.startswith("etc/profile.d/devkit")
                    ):
                        continue
                    base = Path(name).name
                    if base.startswith(".wh."):
                        # Handle OCI whiteout deletions
                        target = Path("/") / Path(name).parent / base[4:]
                        if target.is_symlink() or target.is_file():
                            target.unlink()
                        continue
                    dest = Path("/") / name
                    safe_extract_member(tf, member, dest)
                    total_files += 1
        except tarfile.ReadError as e:
            print(f"  [warn] Skipping layer {idx}: {e}")

    # Ensure dkp-pacman / dkp-pacman-key wrappers exist in /usr/local/bin
    for tool in ("pacman", "pacman-key"):
        src = Path(f"/opt/devkitpro/pacman/bin/{tool}")
        dst = Path(f"/usr/local/bin/dkp-{tool}")
        if src.exists() and not dst.exists():
            os.symlink(src, dst)

    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(ref + "\n", encoding="utf-8")
    print(f"[oci] Extracted {total_files} files into /opt/devkitpro successfully!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
