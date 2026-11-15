from copy import deepcopy

import pytest

from optimizer.fixtures import multi_synthetic
from optimizer.model_handoff import solve_probe
from optimizer.multi_checker import check_multi
from test_model_handoff import capture
from test_saved_candidate import source


@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("priority", ["coverage", "preference"])
def test_release_and_reload_keep_real_optimum_and_assignments(tmp_path, slot, priority):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    unchanged = deepcopy(data)
    root = tmp_path / "bundle"
    saved = capture(root, data, export_mode="whole-native-v1")
    traces = []
    results = [
        solve_probe(
            root,
            data,
            saved["sha"],
            5,
            seed_first=True,
            release_layout=release,
            progress_callback=traces.append,
        )
        for release in (False, True)
    ]
    assert data == unchanged and all(r["solverStatus"] == "OPTIMAL" for r in results)
    assert results[0]["assignments"] == results[1]["assignments"]
    assert results[0]["validation"] == results[1]["validation"]
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)
    phases = [r["phase"] for r in traces]
    assert "releaseLayout" in phases and "reloadLayout" in phases


def test_fixed_events_and_roles_survive_layout_release(tmp_path):
    data, candidate = source()
    root = tmp_path / "bundle"
    saved = capture(root, data, saved_assignments=candidate)
    results = [
        solve_probe(root, data, saved["sha"], 5, seed_first=True, release_layout=release)
        for release in (False, True)
    ]
    assert all(r["solverStatus"] == "OPTIMAL" for r in results)
    assert results[0]["validation"] == results[1]["validation"]
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)


@pytest.mark.parametrize("damage", ["same-length", "missing", "symlink"])
def test_layout_changed_after_initial_validation_is_rejected(tmp_path, damage):
    data = multi_synthetic(1, 30, tiny=True)
    root = tmp_path / "bundle"
    saved = capture(root, data)
    path = root / "layout.json"
    original = path.read_bytes()
    changed = []

    def progress(row):
        if row["event"] == "cpStart" and not changed:
            changed.append(True)
            if damage == "same-length":
                path.write_bytes(b"[" + original[1:])
            elif damage == "missing":
                path.unlink()
            else:
                other = tmp_path / "untrusted.json"
                other.write_bytes(original)
                path.unlink()
                path.symlink_to(other)

    with pytest.raises(ValueError, match="MODEL_HANDOFF_LAYOUT_CHANGED"):
        solve_probe(
            root,
            data,
            saved["sha"],
            5,
            seed_first=True,
            release_layout=True,
            progress_callback=progress,
        )


@pytest.mark.parametrize("value", [0, 1, None, "true"])
def test_release_setting_is_boolean(value):
    with pytest.raises(ValueError, match="MODEL_HANDOFF_LAYOUT_RELEASE"):
        solve_probe(None, {}, "", release_layout=value)
