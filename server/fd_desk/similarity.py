import difflib

import numpy as np
from rapidfuzz import fuzz, process


class PromptMatcher:
    def __init__(self, threshold, capacity):
        self.threshold = threshold
        self.texts = []
        self.lengths = np.empty(capacity, dtype=np.int64)
        self.counts = np.empty((capacity, 32), dtype=np.int64)

    def counts_for(self, text):
        return np.bincount(np.fromiter((ord(character) & 31 for character in text), dtype=np.intp, count=len(text)), minlength=32)

    def add(self, text):
        index = len(self.texts)
        self.lengths[index] = len(text)
        self.counts[index] = self.counts_for(text)
        self.texts.append(text)

    def find(self, text):
        if self.threshold == 0:
            return 0 if self.texts else None
        lengths = self.lengths[:len(self.texts)]
        required = self.threshold * (lengths + len(text))
        candidates = np.flatnonzero(2 * np.minimum(lengths, len(text)) >= required - 1e-8)
        overlap = np.minimum(self.counts[candidates], self.counts_for(text)).sum(axis=1)
        candidates = candidates[2 * overlap >= required[candidates] - 1e-8]
        choices = {index: self.texts[index] for index in candidates}
        for other, _, index in process.extract_iter(text, choices, scorer=fuzz.ratio, score_cutoff=max(0, self.threshold * 100 - 1e-8)):
            if difflib.SequenceMatcher(None, text, other).ratio() >= self.threshold:
                return index
        return None
