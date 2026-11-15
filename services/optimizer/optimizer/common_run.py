"""One exact cumulative run for the one selected logical task per slot.

Inactive slots must carry their prior task, as in the enclosing model. Break,
meeting and training minutes are zero lengths, not breaks in the logical run.
"""


def add_common_runs(model, slots, by_task, lengths, seen, minima, upper, label, *, debug_names=True):
    if not any(minima.values()):
        return 0
    runs=[]
    uniform=len(set(minima.values()))==1
    for n,b in enumerate(slots):
        cumulative=model.new_int_var(0,upper,f'common-run:{label}:{b}' if debug_names else '')
        if not n:
            model.add(cumulative==lengths[b])
        else:
            previous=slots[n-1]
            same=model.new_bool_var(f'same-task:{label}:{b}' if debug_names else '')
            # Each side chooses exactly one task. The small ordinal is an
            # exact categorical code, not an objective weight or approximation.
            previous_code=sum(i*by_task[previous,task] for i,task in enumerate(minima))
            current_code=sum(i*by_task[b,task] for i,task in enumerate(minima))
            model.add(previous_code==current_code).only_enforce_if(same)
            model.add(previous_code!=current_code).only_enforce_if(same.Not())
            model.add(cumulative==runs[-1]+lengths[b]).only_enforce_if(same)
            model.add(cumulative==lengths[b]).only_enforce_if(same.Not())
            if uniform:
                model.add(runs[-1]>=next(iter(minima.values()))).only_enforce_if([same.Not(),seen[previous]])
            else:
                for task,minimum in minima.items():
                    if minimum:
                        model.add(runs[-1]>=minimum).only_enforce_if([by_task[previous,task],same.Not(),seen[previous]])
        runs.append(cumulative)
    last=slots[-1]
    if uniform:
        model.add(runs[-1]>=next(iter(minima.values()))).only_enforce_if(seen[last])
    else:
        for task,minimum in minima.items():
            if minimum:
                model.add(runs[-1]>=minimum).only_enforce_if([by_task[last,task],seen[last]])
    return len(runs)
