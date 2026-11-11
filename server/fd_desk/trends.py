import math
from datetime import datetime

from .core import ZONE, Line, validate_week, week_key


def classify(enterprise, line, points, base, settings):
    weeks = [point for point in points if point["complete"]]
    if len(weeks) < 2:
        return None
    counts = [point["tasks"] for point in weeks]
    series = [{"week": point["week"], "tasks": point["tasks"]} for point in weeks[-8:]]
    gap = 0
    for count in reversed(counts):
        if count:
            break
        gap += 1

    def result(kind, length, start, end, peak):
        return {"enterpriseId": enterprise, "line": line, "kind": kind, "weeks": length,
                "from": start, "to": end, "peakWeek": peak, "series": series}

    if gap >= settings["churnGapWeeks"]:
        if sum(point["level"] in ("heavy", "medium") for point in weeks[-8:]) >= settings["churnStableWeeks"]:
            active = [point for point in weeks[-8:] if point["tasks"]]
            peak = max(active, key=lambda point: point["tasks"])
            return result("churned", gap, peak["tasks"], 0, peak["week"])
        return None
    if gap >= 2:
        return None
    falling = 0
    for index in range(len(counts) - 1, 0, -1):
        if counts[index] >= counts[index - 1]:
            break
        falling += 1
    start = weeks[-1 - falling]
    last = counts[-1]
    if falling >= settings["slideWeeks"] and start["tasks"] >= base and last <= start["tasks"] * settings["slideRatio"]:
        return result("sliding", falling, start["tasks"], last, start["week"])
    if len(counts) >= 6:
        previous = counts[-6:-2]
        average = sum(previous) / 4
        recent = sum(counts[-2:]) / 2
        if sum(count > 0 for count in previous) >= 3 and average >= base and recent < average * settings["fadeRatio"] and last <= average * settings["fadeRatio"]:
            return result("fading", 2, math.floor(average + .5), last, weeks[-6]["week"])
    return None


def calculate(engine, line, week):
    engine.refresh()
    current = week_key(datetime.now(ZONE))
    key = (line, week, current)
    if key in engine.trend_cache:
        return engine.trend_cache[key]
    candidates = sorted({week_key(row["day"]) for row in engine.coverage_rows
                         if row["line"] == line and week_key(row["day"]) <= week and week_key(row["day"]) < current})
    complete = [value for value in candidates if engine.coverage(line, value)["complete"]]
    enterprises = sorted({enterprise for product, value, enterprise in engine.week_stats if product == line and value <= week})
    results = []
    for enterprise in enterprises:
        points = [engine.week_point(line, value, enterprise) for value in complete]
        trend = classify(enterprise, line, points, engine.settings["thresholds"][line]["moverBase"], engine.settings["trends"])
        if trend:
            results.append(trend)
    engine.trend_cache[key] = results
    return results


def mount(app, context):
    @app.get("/api/trends")
    def trends(line: Line, week: str):
        with context.store.lock:
            return calculate(context.engine, line, validate_week(week))
