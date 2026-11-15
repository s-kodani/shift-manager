from itertools import combinations

import pytest

from optimizer.multi_model import active_slot_geometry
from optimizer.multi_model import solve_multi
from test_saved_candidate import source


@pytest.mark.parametrize('slot_minutes', [30, 60])
def test_slot_geometry_matches_exact_minutes_for_every_fragmented_subset(slot_minutes):
    # Include preparation lengths, both sides of slot boundaries, interrupted
    # slots and the empty/off candidate. Expected facts use independent sets.
    boundaries = [0, 7, 10, 29, 30, 31, 59, 60]
    for size in range(len(boundaries) + 1):
        for subset in combinations(boundaries, size):
            minutes = set(subset)
            unchanged = minutes.copy()
            geometry = active_slot_geometry(minutes, slot_minutes)
            assert minutes == unchanged
            assert set(geometry) == {m - m % slot_minutes for m in minutes}
            for start in range(0, 120, slot_minutes):
                actual = sorted(minutes & set(range(start, start + slot_minutes)))
                count, first = geometry.get(start, (0, None))
                assert count == len(actual)
                assert first == (actual[0] if actual else None)
                assert (min(geometry, default=1440) < start + slot_minutes) == any(
                    m < start + slot_minutes for m in minutes)
                for length in (0, 7, 10, slot_minutes):
                    previous_invalid = bool(actual) and (
                        actual[0] != start or not set(range(start, start + length)) <= minutes)
                    indexed_invalid = bool(count) and (
                        first != start or not set(range(start, start + length)) <= minutes)
                    assert indexed_invalid == previous_invalid


def test_budget_failure_separates_candidate_precheck_from_unfinished_model():
    data, candidate = source()
    result = solve_multi(data, 0, hint_strategy='balanced-incumbent-v4',
                         saved_assignments=candidate)
    assert result['solverStatus'] == 'UNKNOWN'
    assert result['validation']['status'] == 'NOT_RUN'
    assert result['assignments'] is None
    assert result['termination'] == 'BUILD_BUDGET_EXHAUSTED'
    assert result['metrics']['savedCandidate']['precheckStatus'] == 'VERIFIED'
    assert result['metrics']['savedCandidate']['adopted'] is False
    timings = result['metrics']['phaseTimings']
    assert timings['modelBuildComplete'] is False
    assert timings['lastPhase'] == 'candidates'
    assert timings['seconds']['savedCandidatePrecheck'] > 0
    assert 'initialFeasibility' not in timings['seconds']
