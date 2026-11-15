"""Exact immutable day geometry; no solver variables or staff rules are cached."""
from dataclasses import dataclass
from types import MappingProxyType

from .minute_set import MinuteSet


@dataclass(frozen=True)
class DutyGeometry:
    possible: MinuteSet
    slots: tuple
    amounts: dict
    present: dict
    seen: dict
    geometry: tuple


def duty_geometry(minute_sets, slot_minutes, geometry_cache, make_geometry):
    bits = 0
    geometry = []
    for minutes in minute_sets:
        bits |= minutes.bits
        key = minutes.bits, slot_minutes
        if key not in geometry_cache:
            geometry_cache[key] = make_geometry(minutes, slot_minutes)
        geometry.append(geometry_cache[key])
    slots = tuple(sorted({slot for facts in geometry for slot in facts}))
    first = [min(facts, default=1440) for facts in geometry]
    amounts = {b: tuple(facts.get(b, (0, None))[0] for facts in geometry) for b in slots}
    present = {b: tuple(i for i, amount in enumerate(amounts[b]) if amount) for b in slots}
    seen = {b: tuple(i for i, start in enumerate(first) if start < b + slot_minutes) for b in slots}
    return DutyGeometry(MinuteSet.from_bits(bits), slots, MappingProxyType(amounts),
                        MappingProxyType(present), MappingProxyType(seen),
                        tuple(MappingProxyType(facts) for facts in geometry))
