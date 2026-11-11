import asyncio
from contextlib import suppress

from . import (
    case_analysis,
    cases,
    exports,
    findings,
    followups,
    movements,
    pipeline,
    profiles,
    record_analysis,
    records,
    templates,
    trends,
    trials,
)
from .jobs import Jobs
from .model_runner import ModelRunner
from .rework_store import Repo


class ReworkContext:
    def __init__(self, store, engine, media, cache):
        self.store = store
        self.engine = engine
        self.media = media
        self.cache = cache
        self.repo = Repo(store)
        self.jobs = Jobs(self.repo, store)
        self.model = ModelRunner(store)
        self.profiles = profiles.Profiles(self)
        self.cases = cases.Cases(self)
        self.case_analyses = case_analysis.CaseAnalyses(self)
        self.records = records.Records(self)
        self.record_analyses = record_analysis.RecordAnalyses(self)
        self.templates = templates.Templates(self)
        self.trials = trials.Trials(self)
        self.movements = movements.Movements(self)
        self.followups = followups.Followups(self)
        self.findings = findings.Findings(self)
        self.exports = exports.Exports(self)
        self.pipeline = pipeline.Pipeline(self)
        self.watcher = None

    async def watch(self):
        while True:
            await asyncio.to_thread(self.pipeline.consume_initialization)
            await asyncio.to_thread(self.pipeline.consume_event)
            await asyncio.sleep(15)

    def start(self):
        self.jobs.recover()
        self.trials.recover()
        self.pipeline.recover()
        self.watcher = asyncio.create_task(self.watch())

    async def close(self):
        if self.watcher is not None:
            self.watcher.cancel()
            with suppress(asyncio.CancelledError):
                await self.watcher
        await asyncio.to_thread(self.pipeline.shutdown)
        await asyncio.to_thread(self.jobs.shutdown)
        await asyncio.to_thread(self.trials.shutdown)


def mount(app, context):
    for module in (profiles, records, record_analysis, trends, movements, templates, trials, followups, pipeline, findings, exports, case_analysis, cases):
        module.mount(app, context)
