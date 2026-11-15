"""Bounded, row-wise JSON serialization for the private model handoff."""

import json


class LimitedWriter:
    def __init__(self, file, limit):
        self.file, self.limit, self.bytes = file, limit, 0

    def write(self, text):
        raw = text.encode("utf-8")
        if self.bytes + len(raw) > self.limit:
            raise ValueError("MODEL_HANDOFF_LIMIT")
        self.file.write(raw)
        self.bytes += len(raw)


def write_layout(path, rows, metadata, limit):
    """Consume each assignment extraction row once; retain no full row list."""
    with path.open("wb") as file:
        out = LimitedWriter(file, limit)

        def encode(value):
            return json.dumps(value, separators=(",", ":"), allow_nan=False)

        out.write('{"version":1,"slotMinutes":' + encode(metadata["slotMinutes"]) + ',"rows":[')
        first = True
        for row in rows:
            if not first:
                out.write(",")
            out.write(encode(row))
            first = False
        out.write("]")
        for name in ("activeSlotPools", "objectives", "settings"):
            out.write("," + encode(name) + ":" + encode(metadata[name]))
        out.write("}")
