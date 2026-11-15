"""Native text export in bounded pieces, preserving all model references."""

import itertools
import shutil

from ortools.sat import cp_model_pb2
from ortools.sat.python import cp_model


def export_whole_model(path, model, limit):
    pending = path.with_name(path.name + ".pending.txt")
    if any(p.exists() or p.is_symlink() for p in (path, pending)):
        raise ValueError("MODEL_HANDOFF_EXPORT_PATH")
    try:
        if not model.export_to_file(str(pending)):
            raise ValueError("MODEL_HANDOFF_EXPORT")
        if pending.stat().st_size > limit:
            raise ValueError("MODEL_HANDOFF_LIMIT")
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


def export_model(path, proto, limit, *, chunk_size=20_000):
    if type(chunk_size) is not int or not 1 <= chunk_size <= 20_000:
        raise ValueError("MODEL_HANDOFF_CHUNK_SIZE")
    fields = {
        "name",
        "variables",
        "constraints",
        "objective",
        "floating_point_objective",
        "search_strategy",
        "solution_hint",
        "assumptions",
        "symmetry",
    }
    if {field.name for field in cp_model_pb2.CpModelProto.DESCRIPTOR.fields} != fields:
        raise ValueError("MODEL_HANDOFF_SCHEMA")
    pending = path.with_name(path.name + ".pending")
    piece = path.with_name(path.name + ".piece.txt")
    if any(p.exists() or p.is_symlink() for p in (path, pending, piece)):
        raise ValueError("MODEL_HANDOFF_EXPORT_PATH")
    try:
        with pending.open("xb") as destination:
            written = 0

            def emit(model):
                nonlocal written
                if not model.export_to_file(str(piece)):
                    raise ValueError("MODEL_HANDOFF_EXPORT")
                size = piece.stat().st_size
                if written + size > limit:
                    raise ValueError("MODEL_HANDOFF_LIMIT")
                with piece.open("rb") as source:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
                written += size

            model = cp_model.CpModel()
            for field in ("variables", "constraints"):
                values = iter(getattr(proto, field))
                while True:
                    getattr(model.proto, field).clear()
                    getattr(model.proto, field).extend(list(itertools.islice(values, chunk_size)))
                    if not len(getattr(model.proto, field)):
                        break
                    emit(model)
                getattr(model.proto, field).clear()
            tail = cp_model.CpModel()
            tail.proto.name = proto.name
            tail.proto.search_strategy.extend(list(proto.search_strategy))
            tail.proto.assumptions.extend(list(proto.assumptions))
            for field in ("objective", "floating_point_objective", "solution_hint", "symmetry"):
                if getattr(proto, "has_" + field)():
                    getattr(tail.proto, field).copy_from(getattr(proto, field))
            emit(tail)
        pending.replace(path)
    finally:
        piece.unlink(missing_ok=True)
        pending.unlink(missing_ok=True)
