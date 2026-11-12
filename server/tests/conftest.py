import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fd_desk.app import create_app
from fd_desk.core import ROOT
from fd_desk.ingest import import_file


@pytest.fixture(scope="session")
def client():
    directory = ROOT / "data/verification"
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="api-tests-", dir=directory) as path:
        app = create_app(path)
        inbox = Path(path) / "inbox"
        inbox.mkdir()
        for source in sorted((ROOT / "data/inbox").glob("*.xlsx")):
            (inbox / source.name).symlink_to(source)
            import_file(app.state.store, source)
        with TestClient(app) as test_client:
            yield test_client
