"""Opt-in transport envelope; the immutable optimizer input stays unchanged."""
import json

SAVED_PROFILE = 'mvp-joint-seed-v1'


def decode_saved_request(payload):
    if (not isinstance(payload, dict)
            or set(payload) != {'schemaVersion', 'input', 'savedCandidate'}
            or payload['schemaVersion'] != 'solve-seed-v1'):
        raise ValueError('SAVED_SOLVE_ENVELOPE')
    data, candidate = payload['input'], payload['savedCandidate']
    if not isinstance(data, dict) or data.get('schemaVersion') != 'multi-task-v1':
        raise ValueError('SAVED_SOLVE_INPUT')
    if len(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()) > 4_000_000:
        raise ValueError('SAVED_SOLVE_INPUT_LIMIT')
    if candidate is None:
        return data, None, None
    if (not isinstance(candidate, dict) or set(candidate) != {'source', 'assignments'}
            or not isinstance(candidate['assignments'], list)):
        raise ValueError('SAVED_SOLVE_CANDIDATE')
    source = candidate['source']
    if (not isinstance(source, dict) or set(source) != {'draftId', 'draftRevision'}
            or not isinstance(source['draftId'], str) or not 1 <= len(source['draftId']) <= 200
            or type(source['draftRevision']) is not int
            or not 1 <= source['draftRevision'] <= 9_007_199_254_740_991):
        raise ValueError('SAVED_SOLVE_SOURCE')
    if len(json.dumps(candidate, ensure_ascii=False, separators=(',', ':')).encode()) > 8_000_000:
        raise ValueError('SAVED_SOLVE_CANDIDATE_LIMIT')
    # Assignment schema and latest-condition validity are checked independently
    # by solve_multi. Rejected candidates cannot alter the input or hard locks.
    return data, candidate['assignments'], source
