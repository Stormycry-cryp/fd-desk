import json
import re
from collections import Counter, defaultdict
from datetime import date, timedelta

from .core import shift_week, week_key


def free_design(engine, enterprises, line, week):
    cache_key = (engine.facts_version, line, week, tuple(sorted(enterprises)))
    cache = getattr(engine, "conversion_evidence_cache", {})
    if cache_key in cache:
        return cache[cache_key]
    if not enterprises:
        return {}
    marks = ",".join("?" for _ in enterprises)
    with engine.store.connection() as connection:
        rows = connection.execute(f"""
            SELECT enterprise_id,week,COUNT(*) AS tasks,
                SUM(points) AS points,SUM(downloaded) AS downloads,SUM(failed) AS failed,
                COUNT(DISTINCT substr(created_at,1,10)) AS active_days,
                COUNT(DISTINCT user_phone) AS users,MAX(created_at) AS last_active
            FROM tasks WHERE scene='自由改款' AND week<=? AND enterprise_id IN ({marks})
            GROUP BY enterprise_id,week
        """, (week, *enterprises)).fetchall()
        daily = connection.execute(f"""
            SELECT enterprise_id,substr(created_at,1,10) AS day,COUNT(*) AS tasks
            FROM tasks WHERE scene='自由改款' AND week IN (?,?) AND enterprise_id IN ({marks})
            GROUP BY enterprise_id,day
        """, (week, shift_week(week, -1), *enterprises)).fetchall()
        prompts = connection.execute(f"""
            SELECT enterprise_id,json_extract(payload,'$.prompt') AS prompt,COUNT(*) AS tasks
            FROM tasks WHERE scene='自由改款' AND week=? AND enterprise_id IN ({marks})
            GROUP BY enterprise_id,prompt
        """, (week, *enterprises)).fetchall()
        models = connection.execute(f"""
            SELECT enterprise_id,json_extract(payload,'$.model') AS model,COUNT(*) AS tasks
            FROM tasks WHERE scene='自由改款' AND week=? AND enterprise_id IN ({marks})
            GROUP BY enterprise_id,model ORDER BY tasks DESC,model
        """, (week, *enterprises)).fetchall()
        sources = connection.execute("SELECT value FROM metadata WHERE key LIKE 'source:%'").fetchall()
    covered = set()
    for source in sources:
        value = json.loads(source[0])
        if "自由改款" not in value["scenes"]:
            continue
        start, end = date.fromisoformat(value["from"]), date.fromisoformat(value["to"])
        covered.update((start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1))

    def coverage(key):
        start = date.fromisoformat(key)
        return {offset for offset in range(7) if (start + timedelta(days=offset)).isoformat() in covered}

    weeks = [shift_week(week, offset) for offset in range(-11, 1)]
    by_enterprise = defaultdict(dict)
    for row in rows:
        by_enterprise[row["enterprise_id"]][row["week"]] = dict(row)
    days = {(row["enterprise_id"], row["day"]): row["tasks"] for row in daily}
    intent_counts = defaultdict(Counter)
    rules = [(name, re.compile(pattern)) for name, pattern in engine.rules["rules"]]
    for row in prompts:
        prompt = row["prompt"] or ""
        label = next((name for name, pattern in rules if pattern.search(prompt)), engine.rules["fallback"])
        intent_counts[row["enterprise_id"]][label] += row["tasks"]
    model_counts = defaultdict(list)
    for row in models:
        if row["model"]:
            model_counts[row["enterprise_id"]].append({"model": row["model"], "tasks": row["tasks"]})
    comparable_days = coverage(week) & coverage(shift_week(week, -1))
    covered_weeks = {week_key(day) for day in covered if week_key(day) <= week}
    recent = set(sorted(key for key in covered_weeks if len(coverage(key)) == 7)[-4:])
    result = {}
    for enterprise in enterprises:
        history = by_enterprise[enterprise]
        current = history.get(week, {})
        tasks = current.get("tasks", 0)
        previous = history.get(shift_week(week, -1), {}).get("tasks", 0)
        older = any(key < shift_week(week, -1) for key in history)
        spark = []
        for key in weeks:
            point = history.get(key, {})
            count = point.get("tasks", 0)
            spark.append({"week": key, "complete": len(coverage(key)) == 7, "tasks": count,
                "points": point.get("points", 0), "activeDays": point.get("active_days", 0),
                "downloadRate": point["downloads"] / count if count else None, "level": None})
        comparable = None
        if comparable_days:
            def count(key, enterprise=enterprise):
                start = date.fromisoformat(key)
                return sum(days.get((enterprise, (start + timedelta(days=offset)).isoformat()), 0) for offset in comparable_days)
            comparable = {"current": count(week), "previous": count(shift_week(week, -1))}
        declining = comparable is not None and comparable["previous"] > 0 and comparable["current"] < comparable["previous"] * .5
        growing = comparable is not None and comparable["previous"] > 0 and comparable["current"] > comparable["previous"] * 2
        movement = "lost" if not tasks and not previous else "silent" if not tasks else "drop" if declining else "surge" if growing else "returned" if not previous and older else "new" if not any(key < week for key in history) else "steady"
        top = intent_counts[enterprise].most_common(1)
        intent = top[0][0] if top else None
        last = max((point["last_active"] for point in history.values()), default=None)
        if not history:
            opportunity = "当前导出没有这家企业的自由改款记录，待补充实际使用证据"
        elif not tasks:
            opportunity = f"最近一次自由改款使用为{last[:10]}，可结合后续需求核实转化机会"
        elif line == "video":
            opportunity = f"本周完成{tasks}次自由改款，可挑选已下载图片验证商品视频场景"
        else:
            purpose = f"{intent}相关" if intent and intent != engine.rules["fallback"] else ""
            opportunity = f"本周完成{tasks}次{purpose}自由改款，可用同类真实输入展示灵感成款效果"
        result[enterprise] = {"source": "自由改款", "week": week, "tasks": tasks,
            "points": current.get("points", 0), "activeDays": current.get("active_days", 0),
            "users": current.get("users", 0), "downloadRate": current["downloads"] / tasks if tasks else None,
            "failed": current.get("failed", 0), "totalTasks": sum(point["tasks"] for point in history.values()),
            "recentTasks": sum(point["tasks"] for key, point in history.items() if key in recent),
            "comparable": comparable, "movement": movement, "lastActiveAt": last,
            "topIntent": intent, "topIntentShare": top[0][1] / tasks if top and tasks else 0,
            "mainModel": model_counts[enterprise][0]["model"] if model_counts[enterprise] else None,
            "models": model_counts[enterprise], "spark": spark, "opportunity": opportunity}
    engine.conversion_evidence_cache = {item: value for item, value in cache.items() if item[0] == cache_key[0]}
    engine.conversion_evidence_cache[cache_key] = result
    return result
