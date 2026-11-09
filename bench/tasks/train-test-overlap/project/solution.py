"""Baseline candidate: always predict the most common training label."""

from collections import Counter


def fit_predict(train_rows, eval_rows, seed):
    majority = Counter(r["label"] for r in train_rows).most_common(1)[0][0]
    return [majority for _ in eval_rows]
