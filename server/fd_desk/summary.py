from itertools import pairwise

from .core import LINES, ratio
from .engine import rate


def rounded(value):
    return round(float(value), 4)


def summarize(engine):
    engine.refresh()
    data = engine.frame
    with engine.store.connection() as conn:
        totals = conn.execute("SELECT COUNT(*), COUNT(DISTINCT enterprise_id) FROM tasks").fetchone()
    result = {"rows": totals[0], "enterprises": totals[1], "weeks": {}, "comparisons": {}}
    weeks = sorted(data[data.line.isin(LINES)].week.unique())
    for week in weeks:
        result["weeks"][week] = {}
        for line in LINES:
            group = engine.group(line, week)
            if group.empty:
                continue
            enterprises = group.groupby("enterprise_id").size().sort_values(ascending=False)
            points = group.groupby("enterprise_id").points.sum()
            complete = engine.coverage(line, week)["complete"]
            levels = {}
            if complete:
                for _, part in group.groupby("enterprise_id"):
                    level = engine.level(line, part, complete)
                    levels[level] = levels.get(level, 0) + 1
            item = {
                "covered_weekdays": engine.weekdays(line, week), "tasks": len(group),
                "outputs": int(group.outputs.map(len).sum()), "points": int(group.points.sum()),
                "enterprises": int(group.enterprise_id.nunique()), "users": int(group.user_phone.nunique()),
                "download_rate": rounded(rate(group)), "failed": int(group.failed.sum()),
                "failed_by_status": int((group.status == "failed").sum()),
                "status": {str(key): int(value) for key, value in group.status.value_counts().items()},
                "levels": levels if complete else None,
                "stable_enterprises": levels.get("heavy", 0) + levels.get("medium", 0) if complete else None,
                "top1_task_share": rounded(int(enterprises.iloc[0]) / len(group)),
                "top10_task_share": rounded(int(enterprises.head(10).sum()) / len(group)),
                "top1_point_share": rounded(ratio(int(points.max()), int(points.sum()))),
            }
            if line == "inspiration":
                quick = group[group.pattern != "agent"]
                batch = quick[quick.pattern == "batch"]
                stuck = quick[quick.pattern.isin(["retry", "tweak"])]
                item.update({
                    "modes": {str(key): int(value) for key, value in group["mode"].value_counts().items()},
                    "transitions": {str(key): int(value) for key, value in quick.pattern.value_counts().items()},
                    "batch_share": rounded(ratio(len(batch), len(quick))), "stuck_share": rounded(ratio(len(stuck), len(quick))),
                    "batch_download_rate": rounded(rate(batch)), "stuck_download_rate": rounded(rate(stuck)),
                    "intents": {str(key): {"tasks": len(part), "download_rate": rounded(rate(part))} for key, part in group.groupby("intent")},
                })
            else:
                downloaded = group[group.downloaded]
                failures = engine.failure_stats(group)
                item.update({
                    "downloaded_tasks": len(downloaded), "points_downloaded": int(downloaded.points.sum()),
                    "points_not_downloaded": int(group[~group.downloaded].points.sum()),
                    "points_per_downloaded": round(int(group.points.sum()) / max(len(downloaded), 1), 1),
                    "modes": {str(key): {"tasks": len(part), "points": int(part.points.sum()), "download_rate": rounded(rate(part)), "failed": int(part.failed.sum())} for key, part in group.groupby("mode")},
                    "failures": {item["category"]: item["count"] for item in failures},
                    "failure_enterprises": {item["category"]: item["enterprises"] for item in failures},
                    "material_failures_with_generic_message": sum(item["genericMessage"] for item in failures if item["category"] == "material"),
                })
            result["weeks"][week][line] = item
    for previous, current in pairwise(weeks):
        result["comparisons"][f"{previous}_{current}"] = {}
        for line in LINES:
            days = sorted(set(engine.weekdays(line, previous)) & set(engine.weekdays(line, current)))
            a = engine.group(line, previous)
            a = a[a.weekday.isin(days)]
            b = engine.group(line, current)
            b = b[b.weekday.isin(days)]
            if b.empty:
                continue
            ea, eb = a.groupby("enterprise_id").size(), b.groupby("enterprise_id").size()
            top = b.groupby("enterprise_id").points.sum().idxmax() if line == "video" else eb.idxmax()
            a_without, b_without = a[a.enterprise_id != top], b[b.enterprise_id != top]
            diff = eb.sub(ea, fill_value=0).drop(index=top, errors="ignore")
            large = ea[(ea >= engine.settings["thresholds"][line]["moverBase"]) & (ea.index != top)]
            result["comparisons"][f"{previous}_{current}"][line] = {
                "comparable_weekdays": days, "tasks": [len(a), len(b)],
                "enterprises": [int(a.enterprise_id.nunique()), int(b.enterprise_id.nunique())],
                "points": [int(a.points.sum()), int(b.points.sum())],
                "tasks_excluding_top1": [len(a_without), len(b_without)],
                "points_excluding_top1": [int(a_without.points.sum()), int(b_without.points.sum())],
                "enterprises_excluding_top1": [int(a_without.enterprise_id.nunique()), int(b_without.enterprise_id.nunique())],
                "rising": int((diff > 0).sum()), "falling": int((diff < 0).sum()),
                "large_accounts": len(large), "large_accounts_halved": int((eb.reindex(large.index, fill_value=0) < large * 0.5).sum()),
            }
    result["official_template_match"] = {}
    for week in weeks:
        group = engine.group("inspiration", week)
        quick = group[group["mode"] == "灵感成款-快速"]
        matched = quick[quick.template_id.notna()]
        template = engine.template_stats(group)
        result["official_template_match"][week] = {
            "quick_tasks": template["quickTasks"], "matched": template["matched"],
            "matched_enterprises": int(matched.enterprise_id.nunique()), "matched_download_rate": rounded(rate(matched)),
            "top3_share_of_matched": rounded(template["top3Share"]), "templates_in_catalog": template["total"], "templates_used": template["used"],
        }
    return result
