import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from urllib.parse import urlsplit

import anyio

from fd_desk.core import ROOT
from fd_desk.media import ALLOWED_HOSTS, Thumbnails


class MeasuredThumbnails(Thumbnails):
    def __init__(self, directory):
        super().__init__(directory)
        self.measurement_lock = Lock()
        self.active = 0
        self.peak = 0
        self.durations = []

    def render(self, url, width):
        with self.measurement_lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        start = time.perf_counter()
        try:
            return super().render(url, width)
        finally:
            with self.measurement_lock:
                self.durations.append(time.perf_counter() - start)
                self.active -= 1


def real_urls():
    with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as connection:
        rows = connection.execute("""
            SELECT DISTINCT image.value FROM tasks t, json_each(t.payload,'$.outputs') image
            WHERE t.line='inspiration' AND t.week='2026-11-02'
                AND json_extract(t.payload,'$.downloaded')=1 LIMIT 100
        """).fetchall()
    urls = [row[0] for row in rows if urlsplit(row[0]).hostname in ALLOWED_HOSTS and urlsplit(row[0]).scheme == "https"][:24]
    assert len(urls) == 24
    return urls


def parallel(thumbnails, urls):
    barrier = Barrier(len(urls))

    def request(url):
        barrier.wait(timeout=15)
        return thumbnails.get(url, 480)

    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=len(urls)) as executor:
        results = list(executor.map(request, urls))
    return results, time.perf_counter() - start


def test_24_real_thumbnails_download_concurrently(tmp_path):
    thumbnails = MeasuredThumbnails(tmp_path)
    results, elapsed = parallel(thumbnails, real_urls())
    slowest = max(thumbnails.durations)
    assert len(results) == len(thumbnails.durations) == 24
    assert all(result.startswith(b"RIFF") for result in results)
    assert thumbnails.peak >= 16
    assert elapsed <= slowest * 1.5
    assert not thumbnails.inflight
    print(f"真实24张缩略图：总耗时 {elapsed:.3f}s，最慢 {slowest:.3f}s，比例 {elapsed / slowest:.3f}，并发 {thumbnails.peak}")


def test_same_real_thumbnail_shares_one_download(tmp_path):
    thumbnails = MeasuredThumbnails(tmp_path)
    url = real_urls()[0]
    results, _ = parallel(thumbnails, [url] * 24)
    assert len(thumbnails.durations) == 1
    assert all(result == results[0] for result in results)
    assert thumbnails.get(url, 480) == results[0]
    assert len(thumbnails.durations) == 1 and not thumbnails.inflight
    assert Thumbnails(tmp_path).get(url, 480) == results[0]


def test_http_worker_capacity():
    async def capacity():
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    assert anyio.run(capacity) >= 24
