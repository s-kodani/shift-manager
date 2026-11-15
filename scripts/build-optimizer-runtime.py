"""Assemble CPython's noninteractive runtime with Debian package provenance.

Runs only in the pinned Debian builder. The final distroless image supplies
libc, OpenSSL, libgcc and libstdc++; these additional packages supply CPython's
compression, XML, ctypes and SQLite extensions. Never copy the builder rootfs.
"""

from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path("/runtime")
PACKAGES = (
    "libbz2-1.0",
    "libffi8",
    "liblzma5",
    "libsqlite3-0",
    "zlib1g",
    "libcrypt1",
    "libdb5.3t64",
    "libgdbm6t64",
    "libzstd1",
)

# Debian's stable SQLite package has no fix yet. Install only the reviewed
# ABI-compatible library from sid, plus the stable security update for zlib.
# Exact archive hashes keep later repository changes from changing the build.
SECURITY_PACKAGES = {
    "libsqlite3-0": {
        "version": "3.54.1-2",
        "url": "https://deb.debian.org/debian/pool/main/s/sqlite3/libsqlite3-0_3.54.1-2_{arch}.deb",
        "sha256": {
            "amd64": "7789bf0b2338b781de388d83d7c473f9386c9ef638af110b5c1b3d1debb36f00",
            "arm64": "27416ae5fd9a8a491cacc2316cb08ebf31ac0d3d628da5576e04eeba365605a4",
        },
    },
    "zlib1g": {
        "version": "1:1.3.dfsg+really1.3.1-1+deb13u1",
        "url": "https://security.debian.org/debian-security/pool/updates/main/z/zlib/"
        "zlib1g_1.3.dfsg+really1.3.1-1+deb13u1_{arch}.deb",
        "sha256": {
            "amd64": "8c27c342230503b73dfde629642c3b352e87b554e06d60cf58772f236a305ceb",
            "arm64": "0e41b3d7ad8ad7fcd36dd4d61ca91a70018478fc4af652e044f4be770784ddff",
        },
    },
}


def install_security_packages():
    arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    if any(arch not in pin["sha256"] for pin in SECURITY_PACKAGES.values()):
        raise ValueError("UNREVIEWED_RUNTIME_ARCHITECTURE")
    with tempfile.TemporaryDirectory(prefix="optimizer-runtime-packages-") as directory:
        archives = []
        for name, pin in SECURITY_PACKAGES.items():
            with urllib.request.urlopen(pin["url"].format(arch=arch), timeout=60) as response:
                content = response.read(16_000_001)
            if len(content) > 16_000_000 or hashlib.sha256(content).hexdigest() != pin["sha256"][arch]:
                raise ValueError("RUNTIME_PACKAGE_HASH_MISMATCH")
            archive = Path(directory) / (name + ".deb")
            archive.write_bytes(content)
            archives.append(str(archive))
        # Verify all archives before installing either package. dpkg checks
        # architecture and ABI dependencies; never force dependency resolution.
        subprocess.run(["dpkg", "-i", *archives], check=True)
        for name, pin in SECURITY_PACKAGES.items():
            version = subprocess.check_output(
                ["dpkg-query", "-W", "-f=${Version}", name], text=True
            ).strip()
            if version != pin["version"]:
                raise ValueError("RUNTIME_PACKAGE_VERSION_MISMATCH")


def assemble():
    for package in PACKAGES:
        # Copy every file owned by the package, including its symlink targets.
        files = subprocess.check_output(["dpkg-query", "-L", package], text=True)
        for name in files.splitlines():
            source = Path(name)
            if source.is_dir() or not (source.is_file() or source.is_symlink()):
                continue
            target = ROOT / source.relative_to("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                target.symlink_to(source.readlink())
            else:
                shutil.copy2(source, target)
        # Distroless keeps dpkg status.d. Preserve full installed-package records
        # so Trivy can scan the added libraries against Debian advisories too.
        metadata = ROOT / "var/lib/dpkg/status.d" / package
        metadata.parent.mkdir(parents=True, exist_ok=True)
        metadata.write_text(
            subprocess.check_output(["dpkg-query", "-s", package], text=True)
        )
    # No terminal/desktop UI or OS UUID backend is needed by this HTTP/solver service.
    # Remove their Python extensions too, rather than leave unresolved ELF links.
    extensions = Path("/usr/local/lib/python3.11/lib-dynload")
    for pattern in ("_curses*.so", "readline*.so", "_uuid*.so", "_tkinter*.so"):
        for extension in extensions.glob(pattern):
            extension.unlink()


if __name__ == "__main__":
    install_security_packages()
    assemble()
