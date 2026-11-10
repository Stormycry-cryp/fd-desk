import difflib
import hashlib
import json
import re
from collections import defaultdict

import pandas as pd
from rapidfuzz import fuzz, process

from .core import ApiProblem, digest, dump, ratio
from .engine import main_value, rate, ref


def inspiration(engine, week, excluded=False):
    group = engine.group("inspiration", week)
    if excluded:
        group = group[~group.enterprise_id.isin(engine.settings["excluded"]["inspiration"])]
    matrix = []
    for (intent, model), part in group.groupby(["intent", "model"], dropna=False):
        counts = part.enterprise_id.value_counts()
        medians = part.groupby("enterprise_id").downloaded.mean()
        matrix.append({"intent": str(intent), "model": "unknown" if pd.isna(model) else str(model),
            "tasks": len(part), "enterprises": len(counts), "downloadRate": rate(part),
            "enterpriseMedianDownloadRate": float(medians.median()) if len(medians) else None,
            "dominantEnterpriseShare": ratio(int(counts.iloc[0]), len(part)) if len(counts) else 0})
    return {"week": week, "intents": engine.intent_stats(group), "models": sorted({item["model"] for item in matrix}),
        "matrix": matrix, "patterns": [{"pattern": key, "tasks": len(part), "share": ratio(len(part), len(group)),
            "downloadRate": rate(part), "enterprises": int(part.enterprise_id.nunique())} for key, part in group.groupby("pattern")],
        "unclassifiedShare": ratio(int((group.intent == engine.rules["fallback"]).sum()), len(group))}


def video(engine, week, excluded=False):
    group = engine.group("video", week)
    if excluded:
        group = group[~group.enterprise_id.isin(engine.settings["excluded"]["video"])]
    matrix = []
    for (mode, model), part in group.groupby(["mode", "model"], dropna=False):
        downloads = int(part.downloaded.sum())
        matrix.append({"mode": str(mode), "model": "unknown" if pd.isna(model) else str(model), "tasks": len(part),
            "enterprises": int(part.enterprise_id.nunique()), "points": int(part.points.sum()), "downloadRate": rate(part),
            "failed": int(part.failed.sum()), "pointsPerDownloaded": float(part.points.sum()) / downloads if downloads else None})
    chains = sum(len(engine.chains[key]) >= 3 and not engine.frame.loc[engine.chains[key]].downloaded.any()
        for key in group.chain_id.dropna().unique())
    return {"week": week, "modes": engine.mode_stats(group), "matrix": matrix, "failures": engine.failure_stats(group),
        "failureSamples": [engine.task(row) for _, row in group[group.failed].sort_values("created_at", ascending=False).head(50).iterrows()],
        "rerollChains": chains}


def build_clusters(engine, line):
    engine.refresh()
    if line in engine.cluster_cache:
        return engine.cluster_cache[line]
    group = engine.frame[(engine.frame.line == line) & (engine.frame.pattern != "agent")]
    signature = hashlib.sha256(dump({"algorithm": 1, "similarity": engine.settings["clusters"]["similarity"]}).encode())
    for row in group.itertuples():
        signature.update(dump([row.row_key, row.prompt]).encode())
    cache_directory = engine.store.directory / "cache/clusters"
    cache_directory.mkdir(parents=True, exist_ok=True)
    path = cache_directory / f"{line}.json"
    if path.is_file():
        cached = json.loads(path.read_text())
        if cached["fingerprint"] == signature.hexdigest():
            lookup = dict(zip(group.row_key, group.index))
            result = {key: [lookup[row] for row in rows] for key, rows in cached["members"].items()}
            engine.cluster_cache[line] = result
            return result
    normalized = group.prompt.map(lambda text: re.sub(r"[\W_]+", "", text))
    exact = defaultdict(list)
    for index, value in normalized.items():
        if value:
            exact[value].append(index)
    representatives = []
    texts = []
    threshold = engine.settings["clusters"]["similarity"]
    for text, indices in sorted(exact.items(), key=lambda item: (-len(item[1]), item[0])):
        match = None
        for other, _score, candidate in process.extract_iter(text, texts, scorer=fuzz.ratio, score_cutoff=max(0, threshold * 100 - 1e-8)):
            if difflib.SequenceMatcher(None, text, other).ratio() >= threshold:
                match = candidate
                break
        if match is None:
            texts.append(text)
            representatives.append((text, list(indices)))
        else:
            representatives[match][1].extend(indices)
    result = {}
    for text, indices in representatives:
        key = digest(f"cluster|{line}|{text}")
        result[key] = indices
    engine.cluster_cache[line] = result
    temporary = path.with_suffix(".partial")
    temporary.write_text(dump({"fingerprint": signature.hexdigest(), "members": {key: list(engine.frame.loc[indices].row_key) for key, indices in result.items()}}))
    temporary.replace(path)
    return result


def clusters(engine, line, week=None, enterprise=None, candidate=None):
    members = build_clusters(engine, line)
    drafts = {item.get("clusterId"): item["id"] for item in reversed(engine.store.items("drafts"))}
    catalog = {item["id"]: item for item in engine.catalog}
    result = []
    for key, indices in members.items():
        part = engine.frame.loc[indices]
        if week:
            part = part[part.week == week]
        if enterprise:
            part = part[part.enterprise_id == enterprise]
        if part.empty:
            continue
        matched = part.template_id.dropna()
        template = catalog[int(matched.iloc[0])] if len(matched) else None
        is_candidate = len(part) >= engine.settings["clusters"]["candidateMinUses"] and template is None
        if candidate is not None and candidate != is_candidate:
            continue
        counts = part.enterprise_id.value_counts()
        result.append({"id": key, "line": line, "sample": part.iloc[0].prompt, "uses": len(part), "enterprises": len(counts),
            "downloadRate": rate(part), "intent": main_value(part.intent), "matchedTemplate": {"id": template["id"], "name": template.get("templateName", template.get("name", template.get("title", "")))} if template else None,
            "candidate": is_candidate, "topEnterprises": [{"enterprise": ref(engine.enterprises[eid]), "uses": int(uses)} for eid, uses in counts.head(10).items()],
            "draftId": drafts.get(key)})
    return sorted(result, key=lambda item: (-item["uses"] * item["downloadRate"], -item["uses"], item["id"]))


def cluster_indices(engine, line, key):
    members = build_clusters(engine, line)
    if key not in members:
        raise ApiProblem(404, "not_found", "提示词簇不存在或来源记录已更新")
    return members[key]


def conversion(engine, line, week=None):
    engine.refresh()
    history = engine.frame if week is None else engine.frame[engine.frame.week <= week]
    used = set(history.loc[history.line == line, "enterprise_id"])
    other = history[(history.line != line) & (~history.enterprise_id.isin(used))]
    result = []
    for eid, part in other.groupby("enterprise_id"):
        item = engine.enterprises[eid]
        if item["kind"] == "internal" or item["contract"] in ("expired", "internal"):
            continue
        result.append({"enterprise": ref(item), "contract": item["contract"], "owner": {"sales": item["sales"], "afterSales": item["after_sales"]},
            "scenes": [{"scene": str(scene), "tasks": int(count)} for scene, count in part.scene.value_counts().items()],
            "lastActiveAt": part.created_at.max(), "suggestedDraftId": None})
    return sorted(result, key=lambda item: item["lastActiveAt"], reverse=True)


def cross_line(engine, week):
    inspiration_ids = set(engine.group("inspiration", week).enterprise_id)
    video_ids = set(engine.group("video", week).enterprise_id)
    return {"week": week, **{key: [ref(engine.enterprises[eid]) for eid in sorted(ids)] for key, ids in {
        "both": inspiration_ids & video_ids, "inspirationOnly": inspiration_ids - video_ids, "videoOnly": video_ids - inspiration_ids}.items()}}
