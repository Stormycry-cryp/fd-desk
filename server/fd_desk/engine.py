import difflib
import json
import re
from datetime import date
from urllib.parse import urlencode, urlsplit

import pandas as pd

from .core import ROOT, ApiProblem, digest, ratio, read_spec, shift_week, week_key


def rate(frame):
    return ratio(int(frame.downloaded.sum()), len(frame))


def main_value(series):
    values = series.dropna().value_counts()
    return str(values.index[0]) if len(values) else None


def ref(enterprise):
    return {"id": enterprise["id"], "name": enterprise["name"], "kind": enterprise["kind"]}


class Engine:
    def __init__(self, store):
        self.store = store
        self.version = None
        self.roster_cache = {}

    def refresh(self):
        generation = self.store.generation
        if self.version == generation:
            return
        with self.store.connection() as conn:
            records = []
            for row in conn.execute("SELECT payload, file_order FROM tasks ORDER BY created_at, file_order, row_no DESC"):
                records.append({**json.loads(row["payload"]), "file_order": row["file_order"]})
            self.enterprises = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM enterprises")}
            self.coverage_rows = [dict(row) for row in conn.execute("SELECT * FROM coverage ORDER BY day")]
            self.findings = [json.loads(row[0]) for row in conn.execute("SELECT value FROM findings")]
            self.dismissed = {row["id"]: bool(row["dismissed"]) for row in conn.execute("SELECT * FROM alert_state")}
        self.settings = self.store.settings()
        self.rules = read_spec("intents.json")
        self.frame = pd.DataFrame(records, columns=[
            "row_key", "source_id", "created_at", "day", "week", "weekday", "row_no", "enterprise_id",
            "enterprise_name", "admin_phone", "user_phone", "user_name", "line", "scene", "mode", "model",
            "config", "prompt", "inputs", "outputs", "status", "downloaded", "download_via", "points",
            "failure", "failed", "duration_seconds", "file_order",
        ])
        self.frame["downloaded"] = self.frame.downloaded.astype(bool)
        self.frame["failed"] = self.frame.failed.astype(bool)
        self.frame["points"] = self.frame.points.astype(int)
        self.frame["pattern"] = "none"
        self.frame["intent"] = None
        self.frame["chain_id"] = None
        self.frame["template_id"] = None
        self.catalog = []
        paths = sorted((ROOT / "data/catalog").glob("official_templates_*.json"))
        if paths:
            self.catalog = json.loads(paths[-1].read_text(encoding="utf-8"))["official"]
        self.template_keys = []
        for template in self.catalog:
            content = json.loads(template["templateConfig"])
            text = re.sub(r"\s+", "", "".join(item.get("value", "") for item in content if item.get("type") == "text"))
            if len(text) >= 16:
                self.template_keys.append((template["id"], text[:16], text[-16:]))
        for index, row in self.frame.iterrows():
            if row.line == "inspiration":
                label = self.rules["fallback"]
                if row.prompt.startswith(self.rules["agent_prefix"]):
                    label = self.rules["agent_label"]
                else:
                    label = next((name for name, pattern in self.rules["rules"] if re.search(pattern, row.prompt)), label)
                self.frame.at[index, "intent"] = label
                if row["mode"] == "灵感成款-Agent":
                    self.frame.at[index, "pattern"] = "agent"
                if row["mode"] == "灵感成款-快速":
                    prompt = re.sub(r"\s+", "", row.prompt)
                    self.frame.at[index, "template_id"] = next((key for key, head, tail in self.template_keys if head in prompt or tail in prompt), None)
        self.chains = {}
        quick = self.frame[(self.frame.line == "inspiration") & (self.frame["mode"] != "灵感成款-Agent") & self.frame.user_phone.notna()]
        for _, group in quick.groupby("user_phone", sort=False):
            previous = None
            chain = []
            for row in group.itertuples():
                pattern = "new"
                connected = False
                if previous is not None and (pd.Timestamp(row.created_at) - pd.Timestamp(previous.created_at)).total_seconds() < 3600:
                    current_images, previous_images = set(row.inputs), set(previous.inputs)
                    connected = bool(current_images & previous_images) and row.enterprise_id == previous.enterprise_id
                    image_same = bool(current_images) and current_images == previous_images
                    prompt_same = row.prompt == previous.prompt
                    prompt_similar = bool(row.prompt and previous.prompt) and difflib.SequenceMatcher(None, row.prompt[:300], previous.prompt[:300]).ratio() >= 0.8
                    if prompt_same:
                        pattern = "retry" if image_same else "batch"
                    elif prompt_similar:
                        pattern = "tweak" if image_same else "adapt"
                    elif current_images & previous_images:
                        pattern = "rework"
                if not connected:
                    self.register_chain(chain)
                    chain = []
                chain.append(row.Index)
                self.frame.at[row.Index, "pattern"] = pattern
                previous = row
            self.register_chain(chain)
        video = self.frame[(self.frame.line == "video") & self.frame.user_phone.notna()]
        for _, group in video.groupby("user_phone", sort=False):
            previous = None
            chain = []
            for row in group.itertuples():
                first_frame = row.config.get("firstFrameImage") or (row.inputs[0] if row.inputs else None)
                connected = previous is not None and row.enterprise_id == previous.enterprise_id and row.prompt == previous.prompt
                if connected:
                    previous_first = previous.config.get("firstFrameImage") or (previous.inputs[0] if previous.inputs else None)
                    connected = first_frame == previous_first and (pd.Timestamp(row.created_at) - pd.Timestamp(previous.created_at)).total_seconds() <= 3600
                if not connected:
                    self.register_chain(chain)
                    chain = []
                chain.append(row.Index)
                previous = row
            self.register_chain(chain)
        self.roster_cache.clear()
        self.version = generation

    def register_chain(self, indices):
        if not indices:
            return
        key = digest("chain|" + self.frame.at[indices[0], "row_key"])
        self.chains[key] = indices
        self.frame.loc[indices, "chain_id"] = key

    def group(self, line, week, enterprise=None):
        self.refresh()
        mask = (self.frame.line == line) & (self.frame.week == week)
        if enterprise is not None:
            mask &= self.frame.enterprise_id == enterprise
        return self.frame[mask]

    def coverage(self, line, week):
        rows = [row for row in self.coverage_rows if row["line"] == line and week_key(row["day"]) == week]
        return {
            "line": line, "week": week, "days": [row["day"] for row in rows], "complete": len(rows) == 7,
            "refreshedAt": max((row["refreshed_at"] for row in rows), default="1970-01-01T00:00:00+08:00"),
        }

    def weekdays(self, line, week):
        return [date.fromisoformat(day).weekday() for day in self.coverage(line, week)["days"]]

    def comparable(self, line, week, enterprise=None):
        current = self.group(line, week, enterprise)
        previous = self.group(line, shift_week(week, -1), enterprise)
        days = sorted(set(self.weekdays(line, week)) & set(self.weekdays(line, shift_week(week, -1))))
        return current[current.weekday.isin(days)], previous[previous.weekday.isin(days)], days

    def level(self, line, frame, complete):
        if not complete or frame.empty:
            return None
        thresholds = self.settings["thresholds"][line]
        tasks, days = len(frame), frame.day.nunique()
        for tier in ("heavy", "medium"):
            if tasks >= thresholds[tier]["tasks"] and days >= thresholds[tier]["days"]:
                return tier
        if tasks >= thresholds["medium"]["tasks"]:
            return "burst"
        return "light" if days >= 2 else "trial"

    def week_point(self, line, week, enterprise):
        group = self.group(line, week, enterprise)
        complete = self.coverage(line, week)["complete"]
        return {
            "week": week, "complete": complete, "tasks": len(group), "points": int(group.points.sum()),
            "activeDays": int(group.day.nunique()), "downloadRate": rate(group) if len(group) else None,
            "level": self.level(line, group, complete),
        }

    def failure_stats(self, group):
        counts = {}
        for row in group[group.failed].itertuples():
            category = row.failure["category"] if row.failure else "other"
            item = counts.setdefault(category, {"category": category, "count": 0, "enterprises": set(), "genericMessage": 0})
            item["count"] += 1
            item["enterprises"].add(row.enterprise_id)
            item["genericMessage"] += bool(row.failure and row.failure["userMessage"] == "处理失败，请稍后重试")
        return [{**item, "enterprises": len(item["enterprises"])} for _, item in sorted(counts.items())]

    def intent_stats(self, group):
        return sorted([
            {"intent": str(key), "tasks": len(part), "enterprises": int(part.enterprise_id.nunique()), "share": ratio(len(part), len(group)), "downloadRate": rate(part)}
            for key, part in group.groupby("intent")
        ], key=lambda item: (-item["tasks"], item["intent"]))

    def mode_stats(self, group):
        return sorted([
            {"mode": str(key), "tasks": len(part), "enterprises": int(part.enterprise_id.nunique()),
             "points": int(part.points.sum()), "pointShare": ratio(int(part.points.sum()), int(group.points.sum())),
             "downloadRate": rate(part), "failed": int(part.failed.sum())}
            for key, part in group.groupby("mode")
        ], key=lambda item: (-item["points"], item["mode"]))

    def template_stats(self, group):
        quick = group[group["mode"] == "灵感成款-快速"]
        matched = quick[quick.template_id.notna()]
        hits = matched.template_id.value_counts()
        return {"quickTasks": len(quick), "matched": len(matched), "used": len(hits), "total": len(self.catalog), "top3Share": ratio(int(hits.head(3).sum()), len(matched))}

    def reusable_uses(self, group):
        representatives = []
        candidates = group[(group.pattern != "agent") & group.template_id.isna()]
        normalized = candidates.prompt.map(lambda prompt: re.sub(r"[\W_]+", "", prompt))
        for prompt, uses in normalized.value_counts().items():
            if not prompt:
                continue
            for representative in representatives:
                if difflib.SequenceMatcher(None, prompt, representative[0]).ratio() >= self.settings["clusters"]["similarity"]:
                    representative[1] += int(uses)
                    break
            else:
                representatives.append([prompt, int(uses)])
        return max((item[1] for item in representatives), default=0)

    def base_roster(self, line, week):
        self.refresh()
        cache_key = (line, week)
        if cache_key in self.roster_cache:
            return self.roster_cache[cache_key]
        rows = []
        all_line = self.frame[(self.frame.line == line) & (self.frame.week <= week)]
        current_all = self.group(line, week)
        current_comparable, previous_comparable, days = self.comparable(line, week)
        complete = self.coverage(line, week)["complete"]
        for enterprise_id, history in all_line.groupby("enterprise_id", sort=False):
            enterprise = self.enterprises[enterprise_id]
            current = history[history.week == week]
            previous = history[history.week == shift_week(week, -1)]
            older = history[history.week < shift_week(week, -1)]
            a = current_comparable[current_comparable.enterprise_id == enterprise_id]
            b = previous_comparable[previous_comparable.enterprise_id == enterprise_id]
            base = self.settings["thresholds"][line]["moverBase"]
            if current.empty and previous.empty:
                movement = "lost"
            elif current.empty:
                movement = "silent"
            elif days and len(b) >= base and len(a) < len(b) * 0.5:
                movement = "drop"
            elif days and len(a) >= base and len(a) > len(b) * 2:
                movement = "surge"
            elif previous.empty and len(older):
                movement = "returned"
            elif len(history[history.week < week]) == 0:
                movement = "new"
            else:
                movement = "steady"
            quick = current[current.pattern != "agent"]
            batch_share = ratio(int((quick.pattern == "batch").sum()), len(quick))
            stuck_share = ratio(int(quick.pattern.isin(["retry", "tweak"]).sum()), len(quick))
            download_rate = rate(current) if len(current) else None
            unreliable = self.settings["pools"]["unreliable"]
            reliable = not (len(current) >= unreliable["minTasks"] and rate(current) < unreliable["downloadRate"])
            level = self.level(line, current, complete)
            peak = int(history.groupby("week").size().max())
            pool = None
            if movement == "drop":
                pool = "retain"
            elif movement in ("silent", "lost") and peak >= self.settings["pools"]["recall"]["minPeakTasks"]:
                pool = "recall"
            elif len(current) >= self.settings["thresholds"][line]["medium"]["tasks"] and (
                (reliable and rate(current) < self.settings["pools"]["help"]["downloadRate"])
                or (line == "inspiration" and stuck_share >= self.settings["pools"]["help"]["stuckShare"])
            ):
                pool = "help"
            elif level in ("heavy", "medium"):
                pool = "keep"
            elif len(current):
                pool = "nurture"
            alerts = []
            params = self.settings["alerts"]
            if movement == "drop":
                alerts.append("drop")
            if movement == "silent" and len(b) >= base:
                alerts.append("vanished")
            if line == "inspiration" and len(current) >= params["stuck"]["minTasks"] and (
                stuck_share >= params["stuck"]["stuckShare"] or (reliable and rate(current) < params["stuck"]["downloadRate"])
            ):
                alerts.append("stuck")
            if reliable and movement == "new" and len(current) >= params["coldStart"]["minTasks"] and not current.downloaded.any():
                alerts.append("cold_start")
            if line == "inspiration":
                for finding in self.findings:
                    rule = finding.get("rule")
                    if (
                        finding["line"] == line and finding["verdict"] == "confirmed" and rule
                        and rule["kind"] == "mismatch"
                        and len(current[(current.intent == rule["intent"]) & (current.model == rule["model"])]) >= params["mismatch"]["minTasks"]
                    ):
                        alerts.append("mismatch")
                        break
            if line == "video" and reliable and int(current.points.sum()) >= params["waste"]["minPoints"] and rate(current) < params["waste"]["downloadRate"]:
                alerts.append("waste")
            if line == "video" and any(item["count"] >= params["failures"]["minCount"] for item in self.failure_stats(current)):
                alerts.append("failures")
            if self.reusable_uses(current) >= params["reuse"]["minUses"]:
                alerts.append("reuse")
            if movement == "surge":
                alerts.append("surge")
            comparable = None
            if days:
                comparable = {"current": int(a.points.sum()) if line == "video" else len(a), "previous": int(b.points.sum()) if line == "video" else len(b)}
            inspiration, video = None, None
            if line == "inspiration":
                intents = current.intent.value_counts()
                inspiration = {"topIntent": str(intents.index[0]) if len(intents) else None,
                    "topIntentShare": ratio(int(intents.iloc[0]), len(current)) if len(intents) else 0.0,
                    "batchShare": batch_share, "stuckShare": stuck_share,
                    "agentShare": ratio(int((current.pattern == "agent").sum()), len(current)), "mainModel": main_value(current.model)}
            else:
                modes = current["mode"].value_counts()
                downloaded = int(current.downloaded.sum())
                video = {"topMode": str(modes.index[0]) if len(modes) else None,
                    "topModeShare": ratio(int(modes.iloc[0]), len(current)) if len(modes) else 0.0,
                    "pointShare": ratio(int(current.points.sum()), int(current_all.points.sum())),
                    "pointsPerDownloaded": ratio(int(current.points.sum()), downloaded) if downloaded else None,
                    "notDownloadedPoints": int(current[~current.downloaded].points.sum()), "failed": int(current.failed.sum()), "mainModel": main_value(current.model)}
            action = self.store.authored("next_action", f"{enterprise_id}:{line}")
            if action is None:
                actions = {"retain": "问清本周用量下降的原因", "recall": "在下一批任务到来时带着模板联系",
                    "help": "准备真实输入的重跑对比", "keep": "把批量提示词保存为团队模板", "nurture": "提供同类任务的用法和入门模板"}
                action_text = "确认客户如何保存结果" if not reliable else actions.get(pool)
                if action_text:
                    action = {"text": action_text, "source": "rule", "updatedAt": self.coverage(line, week)["refreshedAt"]}
            rows.append({
                "enterprise": ref(enterprise), "contract": enterprise["contract"],
                "owner": {"sales": enterprise["sales"], "afterSales": enterprise["after_sales"]},
                "excluded": enterprise_id in self.settings["excluded"][line], "level": level,
                "movement": movement, "pool": pool, "tasks": len(current), "points": int(current.points.sum()),
                "activeDays": int(current.day.nunique()), "users": int(current.user_phone.nunique()),
                "comparable": comparable, "downloadRate": download_rate, "downloadSignalReliable": reliable,
                "lastActiveAt": history.created_at.max(), "weeksActive": int(history.week.nunique()),
                "spark": [self.week_point(line, shift_week(week, offset), enterprise_id) for offset in range(-11, 1)],
                "alerts": alerts, "nextAction": action,
                "lastTouch": None, "inspiration": inspiration, "video": video,
            })
        rows.sort(key=lambda item: (-item["points"] if line == "video" else -item["tasks"], item["enterprise"]["id"]))
        self.roster_cache[cache_key] = rows
        return rows

    def alerts(self, line, week):
        severities = {"drop": 3, "vanished": 3, "stuck": 2, "cold_start": 2, "mismatch": 2, "waste": 3, "failures": 2, "reuse": 1, "surge": 1}
        alerts = []
        for row in self.base_roster(line, week):
            for kind in row["alerts"]:
                key = digest(f"alert|{line}|{week}|{row['enterprise']['id']}|{kind}")
                facts = [f"本周任务 {row['tasks']} 个，使用 {row['activeDays']} 天"]
                if row["comparable"]:
                    unit = "点" if line == "video" else "个任务"
                    facts.append(f"同星期用量 {row['comparable']['previous']} → {row['comparable']['current']} {unit}")
                if row["downloadRate"] is not None:
                    facts.append(f"下载率 {row['downloadRate']:.1%}")
                alerts.append({"id": key, "kind": kind, "severity": severities[kind], "line": line, "week": week,
                    "enterprise": row["enterprise"], "facts": facts, "suggestedPool": row["pool"], "dismissed": self.dismissed.get(key, False)})
        return sorted(alerts, key=lambda item: (-item["severity"], item["id"]))

    def media(self, url, config):
        video = urlsplit(url).path.lower().endswith((".mp4", ".mov", ".webm", ".m4v"))
        poster = config.get("firstFrameImage") if video else None
        thumb_source = poster or url
        return {"kind": "video" if video else "image", "url": url,
            "thumb": "/api/media/thumb?" + urlencode({"url": thumb_source, "w": 480}), "poster": poster}

    def task(self, row, sample_reason=None):
        config = row.config
        def number(value, integer=False):
            if value is None or value == "":
                return None
            return int(value) if integer else float(value)
        video_duration = config.get("duration") or config.get("videoDuration")
        audio = config.get("generateAudio", config.get("audio"))
        if audio is None and config.get("videoAudioLabel"):
            label = config["videoAudioLabel"]
            audio = False if any(term in label for term in ("不", "无", "关闭")) else True if any(term in label for term in ("音", "开启")) else None
        return {
            "rowKey": row.row_key, "sourceId": row.source_id,
            "turnKey": digest(f"turn|{row.source_id}|{row.created_at}") if row.pattern == "agent" else None,
            "line": row.line, "scene": row.scene, "mode": row["mode"] or row.scene, "createdAt": row.created_at,
            "enterprise": ref(self.enterprises[row.enterprise_id]),
            "user": {"id": digest(row.user_phone, 10), "name": row.user_name} if row.user_phone else None,
            "model": row.model, "prompt": row.prompt,
            "inputs": [self.media(url, config) for url in row.inputs], "outputs": [self.media(url, config) for url in row.outputs],
            "points": int(row.points), "status": row.status, "failed": bool(row.failed), "downloaded": bool(row.downloaded),
            "downloadVia": row.download_via, "failure": row.failure, "durationSeconds": None if pd.isna(row.duration_seconds) else float(row.duration_seconds),
            "intent": row.intent, "pattern": row.pattern, "chainId": row.chain_id, "sampleReason": sample_reason,
            "config": {"resolution": str(config.get("resolution") or config.get("videoResolution")) if config.get("resolution") or config.get("videoResolution") else None,
                "ratio": str(config.get("ratio") or config.get("videoRatio") or config.get("aspectRatio")) if config.get("ratio") or config.get("videoRatio") or config.get("aspectRatio") else None,
                "videoDuration": number(video_duration, True), "audio": audio if isinstance(audio, bool) else None,
                "referenceImages": len(config.get("referenceImages") or config.get("chattingOriginalImages") or [url for url in row.inputs if not urlsplit(url).path.lower().endswith((".mp4", ".mov", ".webm"))]),
                "hasReferenceVideo": bool(config.get("actionFollowRefVideo")) or any(urlsplit(url).path.lower().endswith((".mp4", ".mov", ".webm")) for url in row.inputs)},
        }

    def task_list(self, query):
        self.refresh()
        group = self.frame[self.frame.line == query["line"]]
        for field, column in {"week": "week", "enterprise": "enterprise_id", "pattern": "pattern", "intent": "intent", "mode": "mode", "model": "model", "downloaded": "downloaded", "failed": "failed"}.items():
            if query.get(field) is not None:
                group = group[group[column] == query[field]]
        if query.get("user") is not None:
            group = group[group.user_phone.map(lambda phone: digest(phone, 10) if phone else None) == query["user"]]
        if query.get("cluster") is not None:
            raise ApiProblem(409, "milestone_unavailable", "按提示词簇筛选在 M2 提供")
        total = len(group)
        group = group.sort_values(["created_at", "file_order", "row_no"], ascending=[False, False, True])
        sample = query.get("sample")
        if sample is not None:
            stuck_tails = {
                indices[-1] for indices in self.chains.values()
                if len(indices) >= 3 and not self.frame.loc[indices].downloaded.any()
            }
            strata = [
                ("stuck", group[group.index.isin(stuck_tails)]),
                ("batch", group[group.pattern == "batch"]),
                ("failed", group[group.failed]),
                ("downloaded", group[group.downloaded]),
                ("not_downloaded", group[~group.downloaded]),
            ]
            seen, items = set(), []
            for reason, candidates in strata:
                selected = candidates[~candidates.index.isin(seen)].head(sample)
                for index, row in selected.iterrows():
                    items.append(self.task(row, reason))
                    seen.add(index)
        else:
            offset, limit = query.get("offset", 0), query.get("limit", 50)
            items = [self.task(row) for _, row in group.iloc[offset:offset + limit].iterrows()]
        return {"items": items, "total": total}

    def chain_list(self, line, week, enterprise=None, min_length=3, downloaded=None):
        self.refresh()
        items = []
        for key, indices in self.chains.items():
            full = self.frame.loc[indices]
            group = full[(full.line == line) & (full.week == week)]
            if enterprise:
                group = group[group.enterprise_id == enterprise]
            if group.empty or len(full) < min_length:
                continue
            has_download = bool(full.downloaded.any())
            if downloaded is not None and has_download != downloaded:
                continue
            first = full.iloc[0]
            items.append({"id": key, "line": line, "enterprise": ref(self.enterprises[first.enterprise_id]),
                "user": {"id": digest(first.user_phone, 10), "name": first.user_name} if first.user_phone else None,
                "startedAt": full.created_at.min(), "endedAt": full.created_at.max(), "length": len(full),
                "downloaded": has_download, "points": int(full.points.sum()),
                "tasks": [self.task(row) for _, row in full.iterrows()]})
        items.sort(key=lambda item: item["endedAt"], reverse=True)
        return {"items": items, "total": len(items)}
