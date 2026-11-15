"""Fictional complete monthly reference for the native transport boundary test."""
import json
import argparse

from .operational_fixture import operational_fixture


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--staff', type=int, choices=(101, 500), default=500)
    args = parser.parse_args()
    data, assignments = operational_fixture(args.staff, 30)
    print(json.dumps({'input': data, 'assignments': assignments}, separators=(',', ':')))
