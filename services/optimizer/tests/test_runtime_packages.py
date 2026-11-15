"""Runtime package updates must fail closed before installation."""

import hashlib
import importlib.util
import io
from pathlib import Path

import pytest


@pytest.fixture
def runtime(monkeypatch):
    file = Path(__file__).resolve().parents[3] / "scripts/build-optimizer-runtime.py"
    spec = importlib.util.spec_from_file_location("runtime_builder", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data = {"sqlite": b"fictional sqlite archive", "zlib": b"fictional zlib archive"}
    pins = {
        name: {
            "version": "fictional-1",
            "url": "https://packages.example.invalid/" + name,
            "sha256": {"amd64": hashlib.sha256(content).hexdigest()},
        }
        for name, content in data.items()
    }
    monkeypatch.setattr(module, "SECURITY_PACKAGES", pins)
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda url, timeout: io.BytesIO(data[url.rsplit("/", 1)[1]]),
    )
    monkeypatch.setattr(
        module.subprocess, "check_output",
        lambda args, text: "amd64" if args[0] == "dpkg" else "fictional-1",
    )
    installed = []
    monkeypatch.setattr(
        module.subprocess, "run",
        lambda args, check: installed.append({
            "paths": [Path(f) for f in args[2:]],
            "bytes": [Path(f).read_bytes() for f in args[2:]],
        }),
    )
    return module, data, installed


def test_verified_archives_are_installed_together_and_temporary_files_are_removed(runtime):
    module, data, installed = runtime
    module.install_security_packages()
    assert installed[0]["bytes"] == list(data.values())
    assert all(not file.exists() for file in installed[0]["paths"])


@pytest.mark.parametrize("name", ["sqlite", "zlib"])
def test_changed_archive_prevents_installing_either_package(runtime, name):
    module, data, installed = runtime
    data[name] += b"tampered"
    with pytest.raises(ValueError, match="RUNTIME_PACKAGE_HASH_MISMATCH"):
        module.install_security_packages()
    assert installed == []


def test_unreviewed_architecture_is_rejected_before_download(runtime, monkeypatch):
    module, _, installed = runtime
    monkeypatch.setattr(module.subprocess, "check_output", lambda *a, **k: "unreviewed")
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda *a, **k: pytest.fail("must not download for an unreviewed architecture"),
    )
    with pytest.raises(ValueError, match="UNREVIEWED_RUNTIME_ARCHITECTURE"):
        module.install_security_packages()
    assert installed == []


def test_unexpected_installed_version_cannot_complete_runtime_assembly(runtime, monkeypatch):
    module, _, _ = runtime
    monkeypatch.setattr(
        module.subprocess, "check_output",
        lambda args, text: "amd64" if args[0] == "dpkg" else "unexpected-version",
    )
    with pytest.raises(ValueError, match="RUNTIME_PACKAGE_VERSION_MISMATCH"):
        module.install_security_packages()
