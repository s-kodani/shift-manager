"""Pack only verified backup files; unpack without trusting archive paths."""

import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path

LIMIT = 512_000_000


def names(manifest):
    if manifest.get("version") != "shift-backup-v1" or manifest.get("state") != "COMPLETE":
        raise ValueError("INCOMPLETE_BACKUP")
    hashes = {obj["sha256"] for obj in manifest["catalog"]["objects"]}
    if len(hashes) > 50_000 or any(not re.fullmatch("[a-f0-9]{64}", h) for h in hashes):
        raise ValueError("INVALID_OBJECT_NAMES")
    return {"manifest.json", "database.sql"} | {"objects/" + h + ".json" for h in hashes}


def pack(directory, target):
    root = Path(directory).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    files = sorted(names(manifest))
    if sum((root / name).stat().st_size for name in files) > LIMIT:
        raise ValueError("BACKUP_ARCHIVE_TOO_LARGE")
    for name in files:
        if (root / name).resolve() != root / name:
            raise ValueError("SYMLINK_SOURCE")
    with os.fdopen(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as output:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in files:
                archive.write(root / name, name)
        output.flush()
        os.fsync(output.fileno())
    return {"packedFiles": len(files)}


def unpack(source, directory):
    root = Path(directory)
    # The caller owns a new private directory; never merge or overwrite data.
    root.mkdir(mode=0o700)
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > 50_002 or sum(v.file_size for v in infos) > LIMIT:
            raise ValueError("ARCHIVE_EXPANSION_TOO_LARGE")
        if len(infos) != len({v.filename for v in infos}):
            raise ValueError("DUPLICATE_ARCHIVE_ENTRY")
        manifest_info = archive.getinfo("manifest.json")
        if manifest_info.file_size > 8_000_000:
            raise ValueError("MANIFEST_TOO_LARGE")
        manifest = json.loads(archive.read("manifest.json"))
        allowed = names(manifest)
        if {v.filename for v in infos} != allowed:
            raise ValueError("UNEXPECTED_ARCHIVE_PATH")
        for info in infos:
            if stat.S_ISLNK(info.external_attr >> 16) or info.is_dir():
                raise ValueError("ARCHIVE_LINK_OR_DIRECTORY")
            limit = 128_000_000 if info.filename == "database.sql" else 8_000_000
            if info.file_size > limit:
                raise ValueError("ARCHIVE_MEMBER_TOO_LARGE")
            file = root / info.filename
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.open(info) as data, os.fdopen(os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as output:
                while chunk := data.read(65_536):
                    output.write(chunk)
    return {"unpackedFiles": len(infos)}


if __name__ == "__main__":
    try:
        action, first, second = sys.argv[1:]
        result = pack(first, second) if action == "pack" else unpack(first, second) if action == "unpack" else None
        if result is None:
            raise ValueError("INVALID_ARCHIVE_ACTION")
        print(json.dumps(result))
    except Exception:
        print("BACKUP_ARCHIVE_FAILED", file=sys.stderr)
        sys.exit(1)
