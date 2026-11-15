import argparse
import json
from pathlib import Path

from .fixtures import multi_synthetic, synthetic
from .model import solve
from .multi_model import solve_multi

parser = argparse.ArgumentParser()
parser.add_argument('--input', type=Path)
parser.add_argument('--staff', type=int, default=2)
parser.add_argument('--slot', type=int, choices=[30, 60], default=60)
parser.add_argument('--seconds', type=float, default=10)
parser.add_argument('--profile', choices=['single-task-v0', 'multi-task-v1'], default='single-task-v0')
parser.add_argument('--output', type=Path)
parser.add_argument('--saved-candidate', type=Path,
                    help='Experimental multi-task assignment array; latest-input check and CP proof required')
parser.add_argument('--hint-strategy', choices=['legacy-first-v1', 'balanced-coverage-v1', 'balanced-incumbent-v1', 'balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4'],
                    default='legacy-first-v1', help='Multi-task starting values; not a constraint')
args = parser.parse_args()
factory = multi_synthetic if args.profile == 'multi-task-v1' else synthetic
data = json.loads(args.input.read_text()) if args.input else factory(args.staff, args.slot)
engine = solve_multi if data.get('schemaVersion') == 'multi-task-v1' else solve
if args.saved_candidate and engine is not solve_multi:
    parser.error('--saved-candidate requires multi-task-v1')
candidate = json.loads(args.saved_candidate.read_text()) if args.saved_candidate else None
result = (engine(data, args.seconds, hint_strategy=args.hint_strategy, saved_assignments=candidate)
          if engine is solve_multi else engine(data, args.seconds))
content = json.dumps(result, ensure_ascii=False, indent=2)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(content + '\n')
else:
    print(content)
