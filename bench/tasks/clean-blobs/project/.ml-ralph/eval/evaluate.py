"""Locked evaluator: accuracy of a candidate's predictions on one split.

Usage: evaluate.py --candidate solution.py --split search|holdout --seed N
The candidate defines fit_predict(train_rows, eval_rows, seed) -> list of labels,
one per eval row. Rows are dicts of floats; eval rows carry no label.
Prints {"score": accuracy} as its last line.
"""

import argparse
import csv
import importlib.util
import json
import os

EVAL_DIR = os.environ["ML_RALPH_EVAL_DIR"]
PROJECT = os.path.dirname(os.path.dirname(EVAL_DIR))


def load(path):
    with open(path, newline="") as f:
        return [{k: (int(v) if k in ("id", "label") else float(v)) for k, v in r.items()} for r in csv.DictReader(f)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--candidate", required=True)
    p.add_argument("--split", required=True)
    p.add_argument("--seed", type=int, required=True)
    a = p.parse_args()

    train = load(os.path.join(PROJECT, "data", "train.csv"))
    if a.split == "search":
        eval_rows = load(os.path.join(PROJECT, "data", "val.csv"))
    elif a.split == "holdout":
        eval_rows = load(os.environ["ML_RALPH_HOLDOUT_PATH"])
    else:
        raise SystemExit(f"unknown split {a.split}")

    spec = importlib.util.spec_from_file_location("candidate", a.candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    features = [{k: v for k, v in r.items() if k != "label"} for r in eval_rows]
    preds = module.fit_predict([dict(r) for r in train], features, a.seed)
    if len(preds) != len(eval_rows):
        raise SystemExit("fit_predict must return one label per eval row")
    correct = sum(1 for p_, r in zip(preds, eval_rows) if p_ == r["label"])
    print(json.dumps({"score": correct / len(eval_rows)}))


main()
