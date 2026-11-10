from collections import Counter

from .core import LEVELS, LINES, POOLS, ApiProblem, digest, ratio, shift_week, week_key
from .engine import main_value, rate, ref


def meta(engine):
    engine.refresh()
    weeks = sorted({week_key(row["day"]) for row in engine.coverage_rows})
    coverage = [engine.coverage(line, week) for week in weeks for line in LINES if engine.coverage(line, week)["days"]]
    jobs = [job for job in engine.store.import_jobs() if job["state"] == "done"]
    return {
        "lines": list(LINES), "weeks": weeks, "coverage": coverage,
        "latestWeek": {line: max((item["week"] for item in coverage if item["line"] == line), default=None) for line in LINES},
        "excluded": engine.settings["excluded"], "lastImportAt": jobs[0]["createdAt"] if jobs else None,
        "siteBaseUrl": engine.settings["siteBaseUrl"],
        "fdAccount": {"ready": False, "userName": None, "externalShareAllowed": False, "checkedAt": None},
    }


def roster(engine, line, week):
    rows = engine.base_roster(line, week)
    return {"line": line, "week": week, "rows": rows, "poolCounts": {pool: sum(row["pool"] == pool for row in rows) for pool in POOLS}}


def overview(engine, line, week):
    current = engine.group(line, week)
    coverage = engine.coverage(line, week)
    if current.empty:
        raise ApiProblem(404, "no_data", "该产品线在所选周没有任务数据")
    previous_week = shift_week(week, -1)
    previous_coverage = engine.coverage(line, previous_week)
    a, b, days = engine.comparable(line, week)
    rows = engine.base_roster(line, week)
    excluded = engine.settings["excluded"][line]
    def metric(fn):
        return {
            "value": fn(current),
            "comparable": {"current": fn(a), "previous": fn(b)} if days else None,
            "comparableExcluded": {
                "current": fn(a[~a.enterprise_id.isin(excluded)]),
                "previous": fn(b[~b.enterprise_id.isin(excluded)]),
            } if days and excluded else None,
        }
    levels = {level: sum(row["level"] == level for row in rows) for level in LEVELS} if coverage["complete"] else None
    stable = None
    if levels is not None:
        stable = {"value": levels["heavy"] + levels["medium"], "comparable": None, "comparableExcluded": None}
        if previous_coverage["complete"]:
            previous_rows = engine.base_roster(line, previous_week)
            stable["comparable"] = {"current": stable["value"], "previous": sum(row["level"] in ("heavy", "medium") for row in previous_rows)}
            if excluded:
                stable["comparableExcluded"] = {
                    "current": sum(row["level"] in ("heavy", "medium") and row["enterprise"]["id"] not in excluded for row in rows),
                    "previous": sum(row["level"] in ("heavy", "medium") and row["enterprise"]["id"] not in excluded for row in previous_rows),
                }
    by_enterprise = current.groupby("enterprise_id").size().sort_values(ascending=False)
    by_points = current.groupby("enterprise_id").points.sum().sort_values(ascending=False)
    dominant = str(by_points.index[0] if line == "video" else by_enterprise.index[0])
    comparison_tasks = a.groupby("enterprise_id").size()
    previous_tasks = b.groupby("enterprise_id").size()
    if len(a):
        comparable_top = str(a.groupby("enterprise_id").points.sum().idxmax() if line == "video" else comparison_tasks.idxmax())
    else:
        comparable_top = dominant
    diff = comparison_tasks.sub(previous_tasks, fill_value=0).drop(index=comparable_top, errors="ignore")
    large = previous_tasks[(previous_tasks >= engine.settings["thresholds"][line]["moverBase"]) & (previous_tasks.index != comparable_top)]
    movers = {key: [] for key in ("rising", "falling", "new", "returned", "silent")}
    unit = "points" if line == "video" else "tasks"
    for row in rows:
        enterprise_id = row["enterprise"]["id"]
        ca = a[a.enterprise_id == enterprise_id]
        cb = b[b.enterprise_id == enterprise_id]
        current_value = int(ca.points.sum()) if line == "video" else len(ca)
        previous_value = int(cb.points.sum()) if line == "video" else len(cb)
        item = {"enterprise": row["enterprise"], "current": current_value, "previous": previous_value, "unit": unit}
        if enterprise_id != comparable_top and days:
            if len(ca) > len(cb):
                movers["rising"].append(item)
            elif len(ca) < len(cb):
                movers["falling"].append(item)
        if row["movement"] in ("new", "returned", "silent"):
            movers[row["movement"]].append(item)
    for key, values in movers.items():
        values.sort(key=lambda item: (-abs(item["current"] - item["previous"]), item["enterprise"]["id"]))
        movers[key] = values[:8]
    history = []
    for offset in range(-11, 1):
        history_week = shift_week(week, offset)
        part = engine.group(line, history_week)
        full = engine.coverage(line, history_week)["complete"]
        history_levels = Counter(engine.level(line, group, full) for _, group in part.groupby("enterprise_id"))
        history.append({"week": history_week, "complete": full,
            "stable": history_levels["heavy"] + history_levels["medium"] if full else None,
            "heavy": history_levels["heavy"] if full else None, "medium": history_levels["medium"] if full else None,
            "activeEnterprises": int(part.enterprise_id.nunique()), "tasks": len(part), "points": int(part.points.sum()), "downloadRate": rate(part)})
    inspiration, video = None, None
    if line == "inspiration":
        quick = current[current.pattern != "agent"]
        batch = quick[quick.pattern == "batch"]
        stuck = quick[quick.pattern.isin(["retry", "tweak"])]
        agent = current[current.pattern == "agent"]
        inspiration = {
            "outputs": int(current.outputs.map(len).sum()), "batchShare": ratio(len(batch), len(quick)), "batchDownloadRate": rate(batch),
            "stuckShare": ratio(len(stuck), len(quick)), "stuckDownloadRate": rate(stuck), "intents": engine.intent_stats(current),
            "agent": {"rows": len(agent), "turns": len(agent.drop_duplicates(["source_id", "created_at"])),
                "enterprises": int(agent.enterprise_id.nunique()), "topUserRows": int(agent.user_phone.value_counts().max()) if agent.user_phone.notna().any() else 0},
            "officialTemplates": engine.template_stats(current),
        }
    else:
        downloaded = current[current.downloaded]
        points = int(current.points.sum())
        not_downloaded = int(current[~current.downloaded].points.sum())
        video = {"pointsDownloaded": int(downloaded.points.sum()), "pointsNotDownloaded": not_downloaded,
            "notDownloadedShare": ratio(not_downloaded, points), "pointsPerDownloaded": points / max(len(downloaded), 1),
            "modes": engine.mode_stats(current), "failures": engine.failure_stats(current)}
    alerts = engine.alerts(line, week)
    alert_counts = Counter(item["kind"] for item in alerts if not item["dismissed"])
    return {
        "line": line, "week": week, "coverage": coverage,
        "previousCoverage": previous_coverage if previous_coverage["days"] else None, "comparableWeekdays": days,
        "stable": stable, "levels": levels,
        "activeEnterprises": metric(lambda group: int(group.enterprise_id.nunique())),
        "users": metric(lambda group: int(group.user_phone.nunique())), "tasks": metric(len),
        "points": metric(lambda group: int(group.points.sum())), "downloadRate": metric(rate),
        "failed": metric(lambda group: int(group.failed.sum())),
        "concentration": {"top1": ref(engine.enterprises[dominant]), "top1TaskShare": ratio(int(by_enterprise.iloc[0]), len(current)),
            "top10TaskShare": ratio(int(by_enterprise.head(10).sum()), len(current)), "top1PointShare": ratio(int(by_points.iloc[0]), int(current.points.sum()))},
        "history": history, "movers": movers,
        "moverCounts": {"rising": int((diff > 0).sum()), "falling": int((diff < 0).sum()),
            "largeAccounts": len(large), "largeAccountsHalved": int((comparison_tasks.reindex(large.index, fill_value=0) < large * 0.5).sum())},
        "alerts": [{"kind": key, "severity": next(item["severity"] for item in alerts if item["kind"] == key), "count": count} for key, count in sorted(alert_counts.items())],
        "inspiration": inspiration, "video": video,
    }


def enterprise_detail(engine, enterprise_id, week):
    engine.refresh()
    enterprise = engine.store.enterprise(enterprise_id)
    all_tasks = engine.frame[(engine.frame.enterprise_id == enterprise_id) & (engine.frame.week <= week)]
    if all_tasks.empty:
        raise ApiProblem(404, "no_data", "企业在所选周及之前没有任务")
    details = {}
    alerts = []
    for line in LINES:
        candidates = engine.base_roster(line, week)
        row = next((item for item in candidates if item["enterprise"]["id"] == enterprise_id), None)
        if row is None:
            details[line] = None
            continue
        group = engine.group(line, week, enterprise_id)
        peers = engine.group(line, week)
        key_column = "intent" if line == "inspiration" else "mode"
        breakdown = []
        for key, part in group.groupby(key_column):
            other = peers[(peers[key_column] == key) & (peers.enterprise_id != enterprise_id)]
            medians = other.groupby("enterprise_id").downloaded.mean()
            breakdown.append({"key": str(key), "tasks": len(part), "share": ratio(len(part), len(group)), "points": int(part.points.sum()),
                "downloadRate": rate(part), "peerMedianDownloadRate": float(medians.median()) if len(medians) else None,
                "peerEnterprises": len(medians), "mainModel": main_value(part.model)})
        members = []
        for phone, part in group.groupby("user_phone"):
            members.append({"id": digest(str(phone), 10), "name": part.iloc[-1].user_name, "phone": str(phone),
                "tasks": len(part), "downloadRate": rate(part), "lastActiveAt": part.created_at.max()})
        details[line] = {
            "line": line, "week": week, **{key: row[key] for key in ("level", "movement", "pool", "tasks", "points", "activeDays", "downloadRate", "downloadSignalReliable", "nextAction")},
            "history": row["spark"], "breakdown": sorted(breakdown, key=lambda item: -item["tasks"]),
            "patterns": [{"pattern": str(key), "tasks": len(part), "share": ratio(len(part), len(group)), "downloadRate": rate(part)} for key, part in group.groupby("pattern")],
            "models": [{"model": str(key), "tasks": len(part), "downloadRate": rate(part)} for key, part in group.groupby("model")],
            "failures": engine.failure_stats(group), "members": sorted(members, key=lambda item: -item["tasks"]),
        }
        alerts.extend(item for item in engine.alerts(line, week) if item["enterprise"]["id"] == enterprise_id)
    with engine.store.connection() as conn:
        notes = [{"id": row["id"], "text": row["text"], "createdAt": row["created_at"]} for row in conn.execute("SELECT * FROM notes WHERE enterprise_id=? ORDER BY created_at DESC, rowid DESC", (enterprise_id,))]
    return {
        "enterprise": ref(enterprise), "adminPhone": enterprise["admin_phone"], "contract": enterprise["contract"],
        "owner": {"sales": enterprise["sales"], "afterSales": enterprise["after_sales"]},
        "firstSeenAt": all_tasks.created_at.min(), "lastActiveAt": all_tasks.created_at.max(),
        "summary": engine.store.authored("summary", enterprise_id), "lines": details, "alerts": alerts, "touches": [], "notes": notes,
    }


def report(engine, week):
    lines = []
    for line in LINES:
        if engine.group(line, week).empty:
            continue
        item = overview(engine, line, week)
        lines.append({"line": line, **{key: item[key] for key in ("stable", "activeEnterprises", "tasks", "points", "downloadRate")},
            "top1Share": item["concentration"]["top1PointShare" if line == "video" else "top1TaskShare"],
            "falling": [{**{key: mover[key] for key in ("enterprise", "current", "previous")}, "reason": None} for mover in item["movers"]["falling"]],
            "rising": [{**{key: mover[key] for key in ("enterprise", "current", "previous")}, "reason": None} for mover in item["movers"]["rising"]]})
    return {"week": week, "lines": lines, "touches": {"sent": 0, "replied": 0, "withOutcome": 0},
        "done": engine.store.authored("report_done", week), "next": engine.store.authored("report_next", week)}
