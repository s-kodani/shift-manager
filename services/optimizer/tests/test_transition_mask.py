from itertools import product
from copy import deepcopy

import pytest
from ortools.sat.python import cp_model

from optimizer import multi_model
from optimizer.transition_mask import add_transition_exclusion
from optimizer.fixtures import multi_synthetic
from optimizer.multi_checker import check_multi
from test_multi_optimizer import assignments, block
from test_saved_candidate import source


def individual(model, left, right, seen, indices, activity):
    for i in indices:
        model.add_bool_or([left.Not(), right.Not(), seen.Not(), activity((i,)).Not()])
    return len(indices)


@pytest.mark.parametrize("grouped", [False, True])
def test_every_candidate_mask_and_condition_matches_literal_oracle(grouped):
    add = add_transition_exclusion if grouped else individual
    for mask in range(16):
        indices = tuple(i for i in range(4) if mask & (1 << i))
        for selected in range(4):
            for conditions in product((0, 1), repeat=3):
                model = cp_model.CpModel()
                xs = [model.new_bool_var(f"x{i}") for i in range(4)]
                model.add_exactly_one(xs)
                for i, x in enumerate(xs):
                    model.add(x == int(i == selected))
                terms = [model.new_constant(v) for v in conditions]

                def activity(items):
                    flag = model.new_bool_var("mask")
                    model.add(flag == sum(xs[i] for i in items))
                    return flag

                add(model, *terms, indices, activity)
                solver = cp_model.CpSolver()
                solver.parameters.num_search_workers = 1
                feasible = solver.solve(model) in (cp_model.FEASIBLE, cp_model.OPTIMAL)
                assert feasible == (not (all(conditions) and selected in indices))


@pytest.mark.parametrize("priority", ["coverage", "preference"])
@pytest.mark.parametrize("slot", [30, 60])
@pytest.mark.parametrize("minutes", [0, 7, "whole"])
def test_joint_preparation_matches_independent_assignment_oracle(
    monkeypatch, priority, slot, minutes
):
    data = multi_synthetic(1, slot, tiny=True)
    data["priority"] = priority
    data["transitions"] = [
        {
            "fromTaskId": "phone",
            "toTaskId": "backoffice",
            "minutes": slot if minutes == "whole" else minutes,
        },
        {"fromTaskId": "backoffice", "toTaskId": "phone", "minutes": 7},
    ]
    # Preserve 30-minute shift/rest rules; transitions are exact integer minutes.
    unchanged = deepcopy(data)
    vectors = []
    for sequence in product(("phone", "backoffice"), repeat=120 // slot):
        checked = check_multi(
            data,
            assignments(
                data,
                [block(540 + i * slot, 540 + (i + 1) * slot, t) for i, t in enumerate(sequence)],
            ),
        )
        if checked["status"] == "VERIFIED":
            vectors.append(checked["objectiveVector"])
    assert vectors
    results = []
    for add in (individual, add_transition_exclusion):
        monkeypatch.setattr(multi_model, "add_transition_exclusion", add)
        results.append(multi_model.solve_multi(data, 5, common_runs=True))
    assert data == unchanged
    assert all(
        r["solverStatus"] == "OPTIMAL"
        and r["validation"]["objectiveVector"] == min(vectors)
        and check_multi(data, r["assignments"])["status"] == "VERIFIED"
        for r in results
    )


@pytest.mark.parametrize("variant", ["training", "meeting", "saved"])
def test_events_and_saved_candidates_stay_independently_checked(monkeypatch, variant):
    saved = variant == "saved"
    if saved:
        data, candidate = source()
    else:
        data = multi_synthetic(1, 30, tiny=True)
        candidate = None
        data["events"] = [
            {
                "id": "fictional-event",
                "date": "2026-10-01",
                "start": 570,
                "end": 600,
                "kind": variant,
                "staffIds": [data["staff"][0]["id"]],
            }
        ]
    results = []
    for add in (individual, add_transition_exclusion):
        monkeypatch.setattr(multi_model, "add_transition_exclusion", add)
        results.append(
            multi_model.solve_multi(
                data,
                5,
                hint_strategy="balanced-incumbent-v4",
                saved_assignments=candidate if saved else None,
                common_runs=True,
            )
        )
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)


@pytest.mark.parametrize("minimum", [0, 7, 30])
def test_single_task_ordinal_has_no_false_task_change(minimum):
    from optimizer.common_run import add_common_runs

    for lengths in product((0, 7, 30), repeat=3):
        model = cp_model.CpModel()
        choices = {(i, "only"): model.new_constant(1) for i in range(3)}
        seen = {i: model.new_constant(int(any(lengths[: i + 1]))) for i in range(3)}
        add_common_runs(
            model,
            [0, 1, 2],
            choices,
            dict(enumerate(lengths)),
            seen,
            {"only": minimum},
            90,
            "fictional",
        )
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        feasible = solver.solve(model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        assert feasible == (not any(lengths) or sum(lengths) >= minimum)


@pytest.mark.parametrize("kind", ["training", "meeting"])
def test_non_aligned_event_groups_multiple_invalid_candidates(monkeypatch, kind):
    data = multi_synthetic(1, 30, tiny=True)
    duplicate = deepcopy(data["patterns"][0])
    duplicate["id"] = "fictional-copy-short"
    data["patterns"].append(duplicate)
    data["events"] = [
        {
            "id": "fictional-nonaligned",
            "date": "2026-10-01",
            "start": 577,
            "end": 586,
            "kind": kind,
            "staffIds": [data["staff"][0]["id"]],
        }
    ]
    data["transitions"] = [
        {"fromTaskId": "phone", "toTaskId": "backoffice", "minutes": 10},
        {"fromTaskId": "backoffice", "toTaskId": "phone", "minutes": 7},
    ]
    results = []
    for add in (individual, add_transition_exclusion):
        monkeypatch.setattr(multi_model, "add_transition_exclusion", add)
        results.append(multi_model.solve_multi(data, 5, common_runs=True))
    assert all(check_multi(data, r["assignments"])["status"] == "VERIFIED" for r in results)
    assert (
        results[0]["validation"]["objectiveVector"] == results[1]["validation"]["objectiveVector"]
    )
    stats = results[1]["metrics"]["transitionMaskStats"]
    assert stats["groups"] > 0 and stats["individualClausesReplaced"] > stats["groups"]
