from collections import Counter, defaultdict
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .core import digest, shift_week


def majority(values):
    counts = Counter(value for value in values if value is not None and value != "")
    return max(counts, key=counts.get) if counts else None


def step_result(row):
    if row.status == "deleted":
        return "deleted"
    if row.failed:
        return "failed"
    return "downloaded" if row.downloaded else "not_downloaded"


@dataclass(frozen=True, slots=True)
class CaseFact:
    id: str
    unit: str
    line: str
    enterprise: str
    indices: tuple
    day: str
    week: str
    started: str
    ended: str
    outcome: str
    downloaded_at: int | None
    intent: str | None
    model: str | None
    mode: str
    patterns: frozenset
    results: frozenset
    points: int
    duration: float | None
    slow: bool


class CaseIndex:
    def __init__(self, engine):
        self.engine = engine
        self.rows = list(engine.frame.itertuples(index=False, name="CaseSource"))
        self.row_indices = {row.row_key: index for index, row in enumerate(self.rows)}
        self.facts = {}
        self.by_line = defaultdict(list)
        self.by_day = defaultdict(list)
        self.task_chains = {}
        self.slow = set()
        durations = engine.frame.dropna(subset=["duration_seconds"])
        for (line, model), group in durations.groupby(["line", "model"], dropna=False, sort=False):
            for week in sorted(group.week.unique()):
                baseline = group[(group.week >= shift_week(week, -3)) & (group.week <= week)]
                threshold = float(np.quantile(baseline.duration_seconds.to_numpy(dtype=float), 0.9))
                current = group[(group.week == week) & (group.duration_seconds > threshold)]
                self.slow.update(current.index)
        for key, indices in engine.chains.items():
            self.add(key, "chain", indices)
        for index, row in enumerate(self.rows):
            if row.chain_id is None:
                self.add(digest("chain|" + row.row_key), "chain", [index])
            self.add(row.row_key, "task", [index])

    def add(self, key, unit, indices):
        rows = [self.rows[index] for index in indices]
        first, last = rows[0], rows[-1]
        results = [step_result(row) for row in rows]
        downloads = [position for position, result in enumerate(results) if result == "downloaded"]
        failures = [position for position, result in enumerate(results) if result in ("failed", "deleted")]
        bad = not downloads or bool(failures and failures[-1] > downloads[-1])
        outcome = "bad" if bad else "good" if downloads[0] == 0 else "grind"
        durations = [float(row.duration_seconds) for row in rows if not pd.isna(row.duration_seconds)]
        fact = CaseFact(key, unit, first.line, first.enterprise_id, tuple(indices), first.day, first.week,
                        first.created_at, last.created_at, outcome, downloads[0] if downloads else None,
                        majority(row.intent for row in rows), majority(row.model for row in rows),
                        majority(row.mode or row.scene for row in rows) or "",
                        frozenset(row.pattern for row in rows), frozenset(results), sum(int(row.points) for row in rows),
                        sum(durations) if len(durations) == len(rows) else None, any(index in self.slow for index in indices))
        self.facts[unit, key] = fact
        self.by_line[first.line, unit].append(fact)
        self.by_day[first.line, unit, first.day].append(fact)
        if unit == "chain":
            for row in rows:
                self.task_chains[row.row_key] = key
