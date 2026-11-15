import json

import pytest

from optimizer.stream_export import write_layout


def test_streamed_layout_bytes_match_previous_encoding_with_late_pools(tmp_path):
    pools = []
    metadata = {"slotMinutes": 30, "activeSlotPools": pools, "objectives": [], "settings": {}}
    values = [{"staffId": "架空", "x": [-1, 0], "options": [None]}, {"date": "2026-10-01"}]

    def rows():
        for row in values:
            pools.append([540])
            yield row

    path = tmp_path / "layout.json"
    write_layout(path, rows(), metadata, 100_000)
    expected = {
        "version": 1,
        "slotMinutes": 30,
        "rows": values,
        **{k: metadata[k] for k in ("activeSlotPools", "objectives", "settings")},
    }
    assert path.read_text() == json.dumps(expected, separators=(",", ":"), allow_nan=False)


def test_size_limit_stops_writing_before_exceeding_limit(tmp_path):
    path = tmp_path / "limited"
    metadata = {"slotMinutes": 30, "activeSlotPools": [], "objectives": [], "settings": {}}
    with pytest.raises(ValueError, match="MODEL_HANDOFF_LIMIT"):
        write_layout(path, iter([{"large": "x" * 100}]), metadata, 80)
    assert path.stat().st_size <= 80


def test_interrupted_layout_cannot_publish_a_manifest(tmp_path, monkeypatch):
    from optimizer import model_handoff
    from optimizer.fixtures import multi_synthetic
    from test_model_handoff import capture

    root = tmp_path / "bundle"
    data = multi_synthetic(1, 30, tiny=True)
    monkeypatch.setitem(model_handoff.LIMITS, "layout.json", 80)
    with pytest.raises(ValueError, match="MODEL_HANDOFF_LIMIT"):
        capture(root, data)
    assert (root / "model.pb.txt").is_file()
    assert (root / "layout.json").stat().st_size <= 80
    assert not (root / "manifest.json").exists()
    with pytest.raises(ValueError, match="MODEL_HANDOFF_LIMIT"):
        model_handoff.load_bundle(root, data, "fictional-unfinished")
