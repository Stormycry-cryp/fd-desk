import json
from collections import Counter
from datetime import datetime
from statistics import median

from .core import ZONE, digest, shift_week, week_key
from .trends import calculate as calculate_trends


def calculate(engine, enterprise):
    engine.refresh()
    selected = engine.frame.iloc[engine.enterprise_all_indices.get(enterprise, [])]
    records = selected.to_dict("records")
    with engine.store.connection() as conn:
        for row in conn.execute("SELECT payload FROM tasks WHERE enterprise_id=? AND line='other'", (enterprise,)):
            item = json.loads(row[0])
            item.update(intent=None, pattern="none", chain_id=None)
            records.append(item)
    current = week_key(datetime.now(ZONE))
    trends = {line: next((item["kind"] for item in calculate_trends(engine, line, current) if item["enterpriseId"] == enterprise), None) for line in ("inspiration", "video")}
    coverage_weeks = sorted({week_key(row["day"]) for row in engine.coverage_rows if week_key(row["day"]) < current}, reverse=True)
    unresolved_chains = []
    for key in selected.chain_id.dropna().unique():
        indices = engine.chains[key]
        if len(indices) >= 3:
            chain = engine.frame.loc[indices]
            last = chain.iloc[-1]
            if not chain.downloaded.any():
                unresolved_chains.append((last.line, last.week))

    def build(scope):
        rows = [row for row in records if scope == "all" or row["line"] == scope]
        if not rows:
            return None
        lines = ("inspiration", "video") if scope == "all" else (scope,)
        recent = set([week for week in coverage_weeks if all(engine.coverage(line, week)["complete"] for line in lines)][:4])
        rows.sort(key=lambda row: row["created_at"])
        recent_rows = [row for row in rows if row["week"] in recent]
        count = len(rows)
        hours = [[0] * 24 for _ in range(7)]
        for row in rows:
            instant = datetime.fromisoformat(row["created_at"])
            instant = instant.replace(tzinfo=ZONE) if instant.tzinfo is None else instant.astimezone(ZONE)
            hours[instant.weekday()][instant.hour] += 1
        hourly = [sum(day[hour] for day in hours) for hour in range(24)]
        prime = max(range(24), key=lambda hour: sum(hourly[(hour + step) % 24] for step in range(4)))
        first = week_key(rows[0]["created_at"])
        weeks = []
        week = first
        while week <= current:
            part = [row for row in rows if row["week"] == week]
            lines = ("inspiration", "video") if scope == "all" else (scope,)
            complete = all(engine.coverage(line, week)["complete"] for line in lines)
            levels = [engine.week_point(line, week, enterprise)["level"] for line in lines]
            level = next((tier for tier in ("heavy", "medium", "burst", "light", "trial") if tier in levels), None)
            weeks.append({"week": week, "complete": complete, "tasks": len(part), "points": sum(int(row.get("points") or 0) for row in part), "activeDays": len({row["day"] for row in part}), "downloadRate": sum(bool(row.get("downloaded")) for row in part) / len(part) if part else None, "level": level})
            week = shift_week(week, 1)
        complete_weeks = [item for item in weeks if item["complete"] and item["week"] < current]
        gap = 0
        for item in complete_weeks:
            if item["tasks"]:
                gap = 0
            else:
                gap += 1
        current_gap = gap
        active_count = sum(item["tasks"] > 0 for item in complete_weeks)
        # 两段之间的空白周表示一次批次间隔。
        gaps = []
        last_active = None
        for index, item in enumerate(complete_weeks):
            if item["tasks"]:
                if last_active is not None and index - last_active > 1:
                    gaps.append(index - last_active - 1)
                last_active = index
        rhythm = "continuous" if complete_weeks and active_count / len(complete_weeks) >= .75 else "batch" if gaps else "occasional"
        stable = []
        for line in ("inspiration", "video") if scope == "all" else (scope,):
            stable.append(sum(engine.week_point(line, item["week"], enterprise)["level"] in ("heavy", "medium") for item in weeks if item["week"] < current))

        def groups(key):
            result = {}
            for row in rows:
                value = key(row)
                if value is not None and value != "":
                    result.setdefault(str(value), []).append(row)
            return sorted(result.items(), key=lambda item: (-len(item[1]), item[0]))

        def rate(part):
            return sum(bool(row.get("downloaded")) for row in part) / len(part) if part else None

        scenes = [{"scene": name.split("\0", 1)[1], "line": name.split("\0", 1)[0], "tasks": len(part), "share": len(part) / count, "recentShare": sum(row["week"] in recent for row in part) / len(recent_rows) if recent_rows else 0} for name, part in groups(lambda row: row["line"] + "\0" + (row.get("scene") or "未知"))]
        intents = [{"key": name, "tasks": len(part), "share": len(part) / count, "downloadRate": rate(part)} for name, part in groups(lambda row: row.get("intent") or row.get("mode"))]
        models = [{"model": name, "tasks": len(part), "share": len(part) / count, "downloadRate": rate(part), "firstUsedAt": part[0]["created_at"][:10], "lastUsedAt": part[-1]["created_at"][:10]} for name, part in groups(lambda row: row.get("model"))]
        def distribution(key):
            return [{"key": name, "share": len(part) / count} for name, part in groups(key)]
        image_counts = Counter(len(row.get("inputs") or []) for row in rows)
        quick = [row for row in rows if row["line"] == "inspiration" and row.get("mode") != "灵感成款-Agent"]
        stuck_keys = set(selected.loc[list(engine.stuck_tails & set(selected.index)), "row_key"])
        unresolved = sum(week in recent and (scope == "all" or line == scope) for line, week in unresolved_chains)
        failures = Counter((row.get("failure") or {}).get("category", "other") for row in rows if row.get("failed"))
        members = [{"id": digest(name, 10), "name": part[-1].get("user_name") or "", "phone": name, "tasks": len(part), "downloadRate": rate(part), "lastActiveAt": part[-1]["created_at"]} for name, part in groups(lambda row: row.get("user_phone"))]
        return {"scope": scope, "totals": {"tasks": count, "recentTasks": len(recent_rows), "points": sum(int(row.get("points") or 0) for row in rows), "recentPoints": sum(int(row.get("points") or 0) for row in recent_rows), "downloadRate": rate(rows), "recentDownloadRate": rate(recent_rows), "activeWeeks": len({row["week"] for row in rows}), "stableWeeks": max(stable, default=0), "firstSeenAt": rows[0]["created_at"], "lastActiveAt": rows[-1]["created_at"]}, "weekly": weeks, "hours": hours, "primeHours": {"from": prime, "to": (prime + 4) % 24}, "weekendShare": sum(map(sum, hours[5:])) / count, "scenes": scenes, "intents": intents, "models": models, "inputs": {"imageCounts": [{"count": key, "share": value / count} for key, value in sorted(image_counts.items())], "promptLengthMedian": median(len(row.get("prompt") or "") for row in rows), "ratios": distribution(lambda row: (row.get("config") or {}).get("ratio") or (row.get("config") or {}).get("videoRatio") or (row.get("config") or {}).get("aspectRatio")), "resolutions": distribution(lambda row: (row.get("config") or {}).get("resolution") or (row.get("config") or {}).get("videoResolution"))}, "quality": {"stuckShare": sum(row.get("row_key") in stuck_keys for row in quick) / len(quick) if quick else None, "batchShare": sum(row.get("pattern") == "batch" for row in quick) / len(quick) if quick else None, "failed": sum(failures.values()), "failures": [{"category": key, "count": value} for key, value in sorted(failures.items())], "unresolvedChains": unresolved}, "rhythm": {"kind": rhythm, "batchGapWeeks": median(gaps) if gaps else None, "currentGapWeeks": current_gap}, "members": members}
    result = {scope: build(scope) for scope in ("all", "inspiration", "video")}
    for scope, facts in result.items():
        if facts:
            facts["rhythm"]["trend"] = trends.get(scope) if scope != "all" else next((kind for kind in ("churned", "sliding", "fading") if kind in trends.values()), None)
    return result
