from .core import now

LINE_NAMES = {"inspiration": "灵感成款", "video": "AI视频"}


def narratives(engine, result):
    observations = []
    recommendations = []
    for item in result["lines"]:
        line = item["line"]
        label = LINE_NAMES[line]
        coverage = engine.coverage(line, result["week"])
        days = coverage["days"]
        scope = "完整周" if coverage["complete"] else f"部分覆盖，{days[0]}至{days[-1]}，共{len(days)}天"
        tasks = item["tasks"]["value"]
        active = item["activeEnterprises"]["value"]
        download = item["downloadRate"]["value"]
        values = f"{tasks:,}个任务、{active}家活跃企业，下载率{download:.1%}"
        if line == "video":
            values += f"，消耗{item['points']['value']:,}点"
        if item["stable"] is not None:
            values += f"，稳定使用{item['stable']['value']}家"
        observations.append(f"{label}（{scope}）：{values}。")
        group = engine.group(line, result["week"])
        failed = int(group.failed.sum())
        if failed:
            recommendations.append(f"{label}：检查{failed}个失败任务的失败分类与原始样本。")
        falling = [mover for mover in item["falling"] if mover["current"] < mover["previous"]][:2]
        if falling:
            unit = "点" if line == "video" else "个任务"
            changes = "、".join(f"{mover['enterprise']['name']}（{mover['previous']:,}降至{mover['current']:,}{unit}）" for mover in falling)
            recommendations.append(f"{label}：优先核查{changes}的使用变化与未下载样本。")
        else:
            recommendations.append(f"{label}：复查未下载样本，结合任务类型、模型与使用天数确认后续跟进对象。")
    touches = result["touches"]
    observations.append(f"触达记录：已发送{touches['sent']}条，已回复{touches['replied']}条，有效果记录{touches['withOutcome']}条。")
    if not touches["sent"]:
        observations.append("本周运营动作尚未录入。")
    recommendations.append("建议经人工核查后安排触达并记录发送时间、回复及后续效果。")
    return {"done": "\n".join(observations), "next": "依据本周数据生成的后续建议：\n" + "\n".join(recommendations)}


def complete(engine, result):
    generated = narratives(engine, result)
    timestamp = now()
    for field in ("done", "next"):
        current = result[field]
        if current is None or current["source"] == "rule":
            result[field] = {
                "text": generated[field],
                "source": "rule",
                "updatedAt": current["updatedAt"] if current and current["text"] == generated[field] else timestamp,
            }
    return result


def backfill(store):
    from .engine import Engine
    from .views import meta, report
    engine = Engine(store)
    weeks = meta(engine)["weeks"]
    proposals = [report(engine, week) for week in weeks]
    counts = {"weeks": len(weeks), "written": 0, "preserved": 0, "unchanged": 0}
    with store.lock, store.connection() as conn:
        for result in proposals:
            for field in ("done", "next"):
                scope = f"report_{field}"
                current = store.authored_in(conn, scope, result["week"])
                if current and current["source"] != "rule":
                    counts["preserved"] += 1
                elif current and current["text"] == result[field]["text"]:
                    counts["unchanged"] += 1
                else:
                    store.write_authored(conn, scope, result["week"], result[field]["text"], "rule")
                    counts["written"] += 1
    return counts
