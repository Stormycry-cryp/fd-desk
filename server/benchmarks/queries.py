import argparse
import asyncio
import hashlib
import json
from datetime import datetime
from math import ceil
from statistics import median
from time import perf_counter
from zoneinfo import ZoneInfo

import httpx

from fd_desk.core import ROOT


def percentile(values, fraction):
    return sorted(values)[ceil(len(values) * fraction) - 1]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=100)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--requests", type=int, default=400)
    parser.add_argument("--week", default="2026-11-02")
    args = parser.parse_args()
    if min(args.runs, args.workers, args.requests) < 1:
        parser.error("测量次数和并发数量必须为正数")
    week = args.week
    cases = [
        ("overview", f"/api/overview?line=inspiration&week={week}"),
        ("video-overview", f"/api/overview?line=video&week={week}"),
        ("customers", f"/api/enterprises?line=inspiration&week={week}"),
        ("video-customers", f"/api/enterprises?line=video&week={week}"),
        ("tasks", f"/api/tasks?line=inspiration&week={week}"),
        ("video-tasks", f"/api/tasks?line=video&week={week}"),
        ("sample", f"/api/tasks?line=inspiration&week={week}&sample=2"),
        ("clusters", f"/api/clusters?line=inspiration&week={week}"),
        ("video-clusters", f"/api/clusters?line=video&week={week}"),
        ("analysis", f"/api/analysis/inspiration?week={week}"),
        ("video-analysis", f"/api/analysis/video?week={week}"),
        ("touches", f"/api/touches?line=inspiration&week={week}"),
        ("report", f"/api/report?week={week}"),
        ("daily", "/api/daily?line=inspiration&from=2026-09-10&to=2026-11-10"),
        ("conversion", "/api/conversion?line=inspiration"),
        ("video-conversion", "/api/conversion?line=video"),
        ("cross-line", f"/api/cross-line?week={week}"),
    ]
    output = ROOT / "data/fixtures/query-performance"
    output.mkdir(parents=True, exist_ok=True)
    results = []
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8765", timeout=120) as client:
        for name, path in cases:
            durations, hashes = [], set()
            for attempt in range(args.runs + 1):
                start = perf_counter()
                response = await client.get(path)
                elapsed = (perf_counter() - start) * 1000
                response.raise_for_status()
                durations.append(elapsed)
                hashes.add(hashlib.sha256(response.content).hexdigest())
            result = {"name": name, "firstMs": round(durations[0], 3), "medianMs": round(median(durations[1:]), 3),
                "p95Ms": round(percentile(durations[1:], 0.95), 3), "p99Ms": round(percentile(durations[1:], 0.99), 3),
                "payloadBytes": len(response.content), "responseVariants": len(hashes)}
            results.append(result)
            print(json.dumps(result), flush=True)
            if name == "customers":
                enterprise = response.json()["rows"][0]["enterprise"]["id"]
                cases.append(("enterprise", f"/api/enterprises/{enterprise}?week={week}"))

        semaphore = asyncio.Semaphore(args.workers)

        async def request(index):
            async with semaphore:
                _, path = cases[index % len(cases)]
                start = perf_counter()
                response = await client.get(path)
                response.raise_for_status()
                return (perf_counter() - start) * 1000

        start = perf_counter()
        concurrent = await asyncio.gather(*(request(index) for index in range(args.requests)))
        elapsed = perf_counter() - start
        meta = await client.get("/api/meta")
        meta.raise_for_status()
    concurrent_result = {"workers": args.workers, "requests": args.requests, "elapsedSeconds": round(elapsed, 3),
        "requestsPerSecond": round(args.requests / elapsed, 1), "medianMs": round(median(concurrent), 3),
        "p95Ms": round(percentile(concurrent, 0.95), 3), "p99Ms": round(percentile(concurrent, 0.99), 3)}
    value = {"measuredAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
        "transport": "HTTP 127.0.0.1:8765", "client": "httpx.AsyncClient", "warmRunsPerCase": args.runs, "week": week,
        "coverage": meta.json()["coverage"], "results": results, "concurrent": concurrent_result}
    latest = output / "latest.json"
    if latest.exists():
        latest.replace(output / "previous.json")
    latest.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    print(json.dumps({"concurrent": concurrent_result, "evidence": str(latest)}))


if __name__ == "__main__":
    asyncio.run(main())
