import sys, json, re, hashlib, difflib
from pathlib import Path
import pandas as pd

HERE = Path(__file__).parent
INTENTS = json.loads((HERE / "intents.json").read_text(encoding="utf-8"))
VIDEO_SCENES = {"自由创作", "图生视频", "多图参考", "首尾帧", "故事板", "故事板视频", "动作跟随", "全能替换", "实况图"}
LINE_OF = lambda s: "inspiration" if s == "灵感成款" else ("video" if s in VIDEO_SCENES else "other")
GAP_SECONDS = 3600
SIMILAR = 0.8
THRESHOLDS = {"inspiration": {"heavy": (100, 4), "medium": (20, 3), "burst": 20}, "video": {"heavy": (20, 3), "medium": (5, 2), "burst": 5}}


def lines(v):
    return [x.strip() for x in str(v).split("\n") if x.strip()] if isinstance(v, str) else []


def seconds(v):
    if not isinstance(v, str):
        return None
    m = re.findall(r"(\d+)(小时|分|秒)", v)
    return sum(int(n) * {"小时": 3600, "分": 60, "秒": 1}[u] for n, u in m) if m else None


def failure(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        j = json.loads(v)
    except ValueError:
        return "other"
    m = str(j.get("providerErrorMsg") or j.get("message") or "")
    if re.search(r"Sensitive|sensitive|copyright|Risk label|敏感|风险", m):
        return "moderation"
    if re.search(r"帧率|DURATION|duration|时长|尺寸|分辨率|宽高", m):
        return "material"
    if re.search(r"超时|timed out|TIMEOUT|Timeout", m + str(j.get("code"))):
        return "timeout"
    if re.search(r"502|UPSTREAM|unexpected error|No image data|Bad Gateway|素材处理失败|预处理失败", m):
        return "upstream"
    return "other"


def user_message(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        return json.loads(v).get("userErrorMsg")
    except ValueError:
        return None


def intent(p):
    if p.startswith(INTENTS["agent_prefix"]):
        return INTENTS["agent_label"]
    for name, rx in INTENTS["rules"]:
        if re.search(rx, p):
            return name
    return INTENTS["fallback"]


def load(paths):
    frames = []
    for order, path in enumerate(paths):
        d = pd.read_excel(path, sheet_name=0)
        d["file_order"] = order
        d["row_no"] = range(len(d))
        frames.append(d)
    d = pd.concat(frames, ignore_index=True)
    d["created_at"] = pd.to_datetime(d["时间"])
    d["line"] = d["生成场景"].map(LINE_OF)
    d["enterprise"] = d["企业"].str.split("\n").str[0].str.strip()
    d["admin_phone"] = d["企业"].str.split("\n").str[-1].str.replace("超管", "", regex=False).str.strip()
    d["user_phone"] = d["用户"].str.split("\n").str[-1].str.strip()
    d["prompt"] = d["提示词"].fillna("").astype(str)
    d["inputs"] = d["输入"].map(lines)
    d["outputs"] = d["输出"].map(lines)
    cfg = d["配置项"].map(json.loads)
    d["mode"] = cfg.map(lambda j: j.get("modeLabel"))
    d["model"] = cfg.map(lambda j: j.get("model"))
    d["status"] = d["状态"].map({"成功": "success", "失败": "failed", "已删除": "deleted"}).fillna("unknown")
    d["downloaded"] = d["下载状态"].fillna("否") != "否"
    d["points"] = d["扣点"].fillna(0).astype(int)
    d["failure_category"] = d["失败原因"].map(failure)
    d["failure_user_message"] = d["失败原因"].map(user_message)
    d["failed"] = (d["status"] == "failed") | ((d["status"] == "deleted") & d["failure_category"].notna())
    d["duration_seconds"] = d["耗时"].map(seconds)
    d["week"] = (d["created_at"].dt.normalize() - pd.to_timedelta(d["created_at"].dt.dayofweek, unit="D")).dt.strftime("%Y-%m-%d")
    d["weekday"] = d["created_at"].dt.dayofweek
    base = d["id"].astype(str) + "|" + d["时间"].astype(str) + "|" + d["outputs"].map("\n".join).where(d["outputs"].map(len) > 0, d["prompt"] + "|" + d["inputs"].map("\n".join))
    d["occurrence"] = d.groupby(base).cumcount()
    d["row_key"] = [hashlib.sha1(f"{b}|{o}".encode()).hexdigest() for b, o in zip(base, d["occurrence"])]
    d = d.drop_duplicates("row_key", keep="last")
    return d.sort_values(["created_at", "file_order", "row_no"], ascending=[True, True, False]).reset_index(drop=True)


def transitions(d):
    out = pd.Series("none", index=d.index)
    quick = d[(d["line"] == "inspiration") & (d["mode"] != "灵感成款-Agent") & d["user_phone"].notna()]
    out[d[(d["line"] == "inspiration") & (d["mode"] == "灵感成款-Agent")].index] = "agent"
    for _, g in quick.groupby("user_phone", sort=False):
        prev = None
        for r in g.itertuples():
            label = "new"
            if prev is not None and (r.created_at - prev.created_at).total_seconds() < GAP_SECONDS:
                a, b = set(r.inputs), set(prev.inputs)
                if r.prompt == prev.prompt:
                    ps = "same"
                elif r.prompt and prev.prompt and difflib.SequenceMatcher(None, r.prompt[:300], prev.prompt[:300]).ratio() >= SIMILAR:
                    ps = "similar"
                else:
                    ps = "changed"
                im = "same" if a and a == b else ("partial" if a & b else "changed")
                if ps == "same" and im == "same":
                    label = "retry"
                elif ps == "similar" and im == "same":
                    label = "tweak"
                elif ps == "same":
                    label = "batch"
                elif ps == "similar":
                    label = "adapt"
                elif im != "changed":
                    label = "rework"
            out[r.Index] = label
            prev = r
    return out


def squash(text):
    return re.sub(r"\s+", "", text)


def template_match(d, catalog_path):
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))["official"]
    keys = []
    for t in catalog:
        text = squash("".join(c.get("value", "") for c in json.loads(t["templateConfig"]) if c.get("type") == "text"))
        if len(text) >= 16:
            keys.append((t["id"], text[:16], text[-16:]))
    out = {}
    for week, g in d[(d["line"] == "inspiration") & (d["mode"] == "灵感成款-快速")].groupby("week"):
        hit = g["prompt"].map(squash).map(lambda p: next((i for i, head, tail in keys if head in p or tail in p), None))
        top = hit.dropna().astype(int).value_counts()
        out[week] = {
            "quick_tasks": int(len(g)),
            "matched": int(hit.notna().sum()),
            "matched_enterprises": int(g[hit.notna()]["admin_phone"].nunique()),
            "matched_download_rate": share(g[hit.notna()]["downloaded"].mean()),
            "top3_share_of_matched": share(top.head(3).sum() / max(top.sum(), 1)),
            "templates_in_catalog": len(catalog),
            "templates_used": int(top.size),
        }
    return out


def level(line, tasks, days, full):
    if not full:
        return None
    t = THRESHOLDS[line]
    if tasks >= t["heavy"][0] and days >= t["heavy"][1]:
        return "heavy"
    if tasks >= t["medium"][0] and days >= t["medium"][1]:
        return "medium"
    if tasks >= t["burst"]:
        return "burst"
    return "light" if days >= 2 else "trial"


def share(s):
    return round(float(s), 4)


def summarize(d):
    d = d.copy()
    d["transition"] = transitions(d)
    d["intent"] = [intent(p) if l == "inspiration" else None for p, l in zip(d["prompt"], d["line"])]
    result = {"rows": int(len(d)), "enterprises": int(d["admin_phone"].nunique()), "weeks": {}}
    coverage = {(l, w): sorted(g["weekday"].unique().tolist()) for (l, w), g in d.groupby(["line", "week"])}
    for (line, week), g in d.groupby(["line", "week"]):
        if line == "other":
            continue
        full = len(coverage[(line, week)]) == 7
        ent = g.groupby("admin_phone").agg(tasks=("row_key", "size"), days=("created_at", lambda s: s.dt.date.nunique()), points=("points", "sum"), downloaded=("downloaded", "mean"))
        ent["level"] = [level(line, t, dd, full) for t, dd in zip(ent["tasks"], ent["days"])]
        top = ent["tasks"].sort_values(ascending=False)
        item = {
            "covered_weekdays": coverage[(line, week)],
            "tasks": int(len(g)),
            "outputs": int(g["outputs"].map(len).sum()),
            "points": int(g["points"].sum()),
            "enterprises": int(g["admin_phone"].nunique()),
            "users": int(g["user_phone"].nunique()),
            "download_rate": share(g["downloaded"].mean()),
            "failed": int(g["failed"].sum()),
            "failed_by_status": int((g["status"] == "failed").sum()),
            "status": g["status"].value_counts().to_dict(),
            "levels": ent["level"].value_counts().to_dict() if full else None,
            "stable_enterprises": int(ent["level"].isin(["heavy", "medium"]).sum()) if full else None,
            "top1_task_share": share(top.iloc[0] / top.sum()),
            "top10_task_share": share(top.head(10).sum() / top.sum()),
            "top1_point_share": share(ent["points"].max() / ent["points"].sum()),
        }
        if line == "inspiration":
            q = g[g["transition"] != "agent"]
            item["modes"] = g["mode"].value_counts().to_dict()
            item["transitions"] = q["transition"].value_counts().to_dict()
            item["batch_share"] = share((q["transition"] == "batch").mean())
            item["stuck_share"] = share(q["transition"].isin(["retry", "tweak"]).mean())
            item["batch_download_rate"] = share(q[q["transition"] == "batch"]["downloaded"].mean())
            item["stuck_download_rate"] = share(q[q["transition"].isin(["retry", "tweak"])]["downloaded"].mean())
            item["intents"] = {k: {"tasks": int(v["row_key"]), "download_rate": share(v["downloaded"])} for k, v in g.groupby("intent").agg({"row_key": "size", "downloaded": "mean"}).iterrows()}
        else:
            ok = g[g["downloaded"]]
            item["downloaded_tasks"] = int(len(ok))
            item["points_downloaded"] = int(ok["points"].sum())
            item["points_not_downloaded"] = int(g["points"].sum() - ok["points"].sum())
            item["points_per_downloaded"] = round(float(g["points"].sum() / max(len(ok), 1)), 1)
            item["modes"] = {k: {"tasks": int(v["row_key"]), "points": int(v["points"]), "download_rate": share(v["downloaded"]), "failed": int(v["failed"])} for k, v in g.groupby("mode").agg({"row_key": "size", "points": "sum", "downloaded": "mean", "failed": "sum"}).iterrows()}
            bad = g[g["failed"]]
            item["failures"] = bad["failure_category"].value_counts().to_dict()
            item["failure_enterprises"] = {k: int(v) for k, v in bad.groupby("failure_category")["admin_phone"].nunique().items()}
            item["material_failures_with_generic_message"] = int(((bad["failure_category"] == "material") & (bad["failure_user_message"] == "处理失败，请稍后重试")).sum())
        result["weeks"].setdefault(week, {})[line] = item
    weeks = sorted(result["weeks"])
    result["comparisons"] = {}
    for prev, cur in zip(weeks, weeks[1:]):
        for line in ("inspiration", "video"):
            days = sorted(set(coverage.get((line, prev), [])) & set(coverage.get((line, cur), [])))
            a = d[(d["line"] == line) & (d["week"] == prev) & d["weekday"].isin(days)]
            b = d[(d["line"] == line) & (d["week"] == cur) & d["weekday"].isin(days)]
            ea, eb = a.groupby("admin_phone").size(), b.groupby("admin_phone").size()
            top = (b.groupby("admin_phone")["points"].sum() if line == "video" else eb).idxmax()
            diff = eb.sub(ea, fill_value=0)
            rest = diff.drop(index=top, errors="ignore")
            big = ea[(ea >= 50) & (ea.index != top)] if line == "inspiration" else ea[(ea >= 10) & (ea.index != top)]
            result["comparisons"].setdefault(f"{prev}_{cur}", {})[line] = {
                "comparable_weekdays": days,
                "tasks": [int(len(a)), int(len(b))],
                "enterprises": [int(a["admin_phone"].nunique()), int(b["admin_phone"].nunique())],
                "points": [int(a["points"].sum()), int(b["points"].sum())],
                "tasks_excluding_top1": [int(len(a[a["admin_phone"] != top])), int(len(b[b["admin_phone"] != top]))],
                "points_excluding_top1": [int(a[a["admin_phone"] != top]["points"].sum()), int(b[b["admin_phone"] != top]["points"].sum())],
                "enterprises_excluding_top1": [int(a[a["admin_phone"] != top]["admin_phone"].nunique()), int(b[b["admin_phone"] != top]["admin_phone"].nunique())],
                "rising": int((rest > 0).sum()),
                "falling": int((rest < 0).sum()),
                "large_accounts": int(len(big)),
                "large_accounts_halved": int((eb.reindex(big.index, fill_value=0) < big * 0.5).sum()),
            }
    return result


if __name__ == "__main__":
    args = sys.argv[1:]
    catalog = args[args.index("--catalog") + 1] if "--catalog" in args else None
    files = [a for a in args if a.endswith(".xlsx")]
    data = load(files)
    summary = summarize(data)
    if catalog:
        summary["official_template_match"] = template_match(data, catalog)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
