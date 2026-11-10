import hashlib
import json
from collections import defaultdict

import pandas as pd

from .core import ApiProblem, digest, dump, ratio
from .engine import main_value, rate, ref
from .similarity import PromptMatcher


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
    normalized = group.normalized_prompt
    exact = defaultdict(list)
    for index, value in normalized.items():
        if value:
            exact[value].append(index)
    representatives = []
    threshold = engine.settings["clusters"]["similarity"]
    matcher = PromptMatcher(threshold, len(exact))
    for text, indices in sorted(exact.items(), key=lambda item: (-len(item[1]), item[0])):
        match = matcher.find(text)
        if match is None:
            matcher.add(text)
            representatives.append((text, list(indices)))
        else:
            representatives[match][1].extend(indices)
    result = {}
    for text, indices in representatives:
        key = digest(f"cluster|{line}|{text}")
        result[key] = indices
    engine.cluster_cache[line] = result
    temporary = path.with_suffix(".partial")
    row_keys = engine.frame.row_key.to_numpy()
    temporary.write_text(dump({"fingerprint": signature.hexdigest(), "members": {key: [row_keys[index] for index in indices] for key, indices in result.items()}}))
    temporary.replace(path)
    return result


def clusters(engine, line, week=None, enterprise=None, candidate=None):
    members = build_clusters(engine, line)
    drafts = {item.get("clusterId"): item["id"] for item in reversed(engine.store.items("drafts"))}
    cache_key = (line, week, enterprise)
    if cache_key in engine.cluster_stats_cache:
        return [{**item, "draftId": drafts.get(item["id"])} for item in engine.cluster_stats_cache[cache_key] if candidate is None or candidate == item["candidate"]]
    catalog = {item["id"]: item for item in engine.catalog}
    selected = engine.frame.index
    if week:
        selected = engine.group(line, week, enterprise).index
    elif enterprise:
        selected = engine.frame.index[engine.frame.enterprise_id == enterprise]
    selected = set(selected)
    result = []
    for key, indices in members.items():
        indices = [index for index in indices if index in selected]
        if not indices:
            continue
        part = engine.frame.loc[indices]
        matched = part.template_id.dropna()
        template = catalog[int(matched.iloc[0])] if len(matched) else None
        is_candidate = len(part) >= engine.settings["clusters"]["candidateMinUses"] and template is None
        counts = part.enterprise_id.value_counts()
        result.append({"id": key, "line": line, "sample": part.iloc[0].prompt, "uses": len(part), "enterprises": len(counts),
            "downloadRate": rate(part), "intent": main_value(part.intent), "matchedTemplate": {"id": template["id"], "name": template.get("templateName", template.get("name", template.get("title", "")))} if template else None,
            "candidate": is_candidate, "topEnterprises": [{"enterprise": ref(engine.enterprises[eid]), "uses": int(uses)} for eid, uses in counts.head(10).items()],
            "draftId": drafts.get(key)})
    result.sort(key=lambda item: (-item["uses"] * item["downloadRate"], -item["uses"], item["id"]))
    engine.cluster_stats_cache[cache_key] = result
    return [item for item in result if candidate is None or candidate == item["candidate"]]


def cluster_indices(engine, line, key):
    members = build_clusters(engine, line)
    if key not in members:
        raise ApiProblem(404, "not_found", "提示词簇不存在或来源记录已更新")
    return members[key]


def conversion(engine, line, week=None):
    engine.refresh()
    bound = " AND t.week<=?" if week is not None else ""
    used_bound = " AND u.week<=?" if week is not None else ""
    parameters = [line, *([week] if week is not None else []), line, *([week] if week is not None else [])]
    with engine.store.connection() as conn:
        rows = conn.execute("WITH candidates AS MATERIALIZED (SELECT e.id FROM enterprises e "
            "WHERE e.kind<>'internal' AND e.contract NOT IN ('expired','internal') AND NOT EXISTS "
            "(SELECT 1 FROM tasks u WHERE u.enterprise_id=e.id AND u.line=?" + used_bound + ")) "
            "SELECT t.enterprise_id, t.scene, COUNT(*) AS tasks, MAX(t.created_at) AS last_active, MIN(t.created_at) AS first_seen "
            "FROM candidates c JOIN tasks t ON t.enterprise_id=c.id WHERE t.line<>?" + bound + " "
            "GROUP BY t.enterprise_id,t.scene ORDER BY t.enterprise_id,tasks DESC,first_seen,t.scene", parameters).fetchall()
    candidates = {}
    for row in rows:
        candidate = candidates.setdefault(row["enterprise_id"], {"scenes": [], "lastActiveAt": row["last_active"]})
        candidate["scenes"].append({"scene": row["scene"], "tasks": row["tasks"]})
        candidate["lastActiveAt"] = max(candidate["lastActiveAt"], row["last_active"])
    result = []
    for eid, candidate in candidates.items():
        item = engine.enterprises[eid]
        result.append({"enterprise": ref(item), "contract": item["contract"], "owner": {"sales": item["sales"], "afterSales": item["after_sales"]},
            "scenes": candidate["scenes"], "lastActiveAt": candidate["lastActiveAt"], "suggestedDraftId": None})
    return sorted(result, key=lambda item: item["lastActiveAt"], reverse=True)


def cross_line(engine, week):
    inspiration_ids = set(engine.group("inspiration", week).enterprise_id)
    video_ids = set(engine.group("video", week).enterprise_id)
    return {"week": week, **{key: [ref(engine.enterprises[eid]) for eid in sorted(ids)] for key, ids in {
        "both": inspiration_ids & video_ids, "inspirationOnly": inspiration_ids - video_ids, "videoOnly": video_ids - inspiration_ids}.items()}}
