"""Reuse only ordinary draft-day candidate tests within one solve call."""


class CandidateCatalog:
    def __init__(self, data, generate):
        self.data, self.generate = data, generate
        self.cache = {}
        self.special = set()
        for collection in ('locks','exceptions'):
            self.special.update((x['staffId'],x['date']) for x in data[collection])
        for event in data['events']:
            self.special.update((sid,event['date']) for sid in event['staffIds'])
        for staff in data['staff']:
            self.special.update((staff['id'],x['date']) for x in staff['unavailable'])
        self.hits = 0

    def get(self, staff, day):
        key = staff['id'], day.isoformat()
        if self.data['mode'] != 'draft' or key in self.special:
            return self.generate(self.data,staff,day)
        # Patterns/break rule belong to the same immutable solve input. In an
        # ordinary day the generator reads only contract admission and daily
        # maxima; week/month and task/role constraints stay in the full model.
        signature = (day.weekday() in staff['contract']['weekdays'],
                     staff['contract']['start'],staff['contract']['end'],
                     tuple(sorted(r['dailyMax'] for r in staff['rules'])))
        if signature not in self.cache:
            self.cache[signature] = self.generate(self.data,staff,day)
        else:
            self.hits += 1
        # Public assignments must not alias another staff-day's break/cancel
        # arrays even though eligibility was calculated from one template.
        return [None if c is None else {**c,'break':list(c['break']) if c['break'] is not None else None,
                                        'cancelled':[list(x) for x in c['cancelled']]}
                for c in self.cache[signature]]
