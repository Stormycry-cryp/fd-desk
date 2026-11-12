import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import tarfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ARCHIVE_NAME = "fd-desk-data.tar.gz"
MANIFEST_NAME = "manifest.json"
FORMAT = "fd-desk-data-v1"
CHUNK = 1024 * 1024
MAX_ASSET_SIZE = 2_000_000_000
ANALYSIS_NAMES = {"input.json", "record-input.json", "answer.json", "usage.json", "process.json"}
AUTOMATION_NAMES = {"input.json", "answer.json", "usage.json", "process.json"}
FIXTURE_PATHS = {
    "fixtures/rework/R5/http-verification.json",
    "fixtures/rework/R5/session-analysis-verification.json",
}
COLLECTOR_NAMES = {"runs.json", "manifest.json", "scope.json", "snapshot.json", "snapshots.json"}
BLOCKED_PARTS = {"codex-home", "private", "runtime", "cache", "caches", "logs", "shots", "exports", "work", "__pycache__"}
BLOCKED_NAMES = {".ds_store", "auth.json", "config.toml", "credentials", "credentials.json", "runtime.json"}
SECRET_PATTERN = re.compile(
    rb'"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|credentials)"\s*:\s*"[^"\s][^"]*"'
    rb'|(?:x-cos-security-token|x-cos-signature|x-amz-signature|[?&](?:token|signature|authorization)=)',
    re.IGNORECASE,
)


def digest_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(CHUNK):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def scan_text(path, label):
    tail = b""
    with path.open("rb") as source:
        while chunk := source.read(CHUNK):
            sample = tail + chunk
            if SECRET_PATTERN.search(sample):
                raise ValueError(f"文件含有疑似凭据，请检查：{label}")
            tail = sample[-4096:]


def allowed_path(relative):
    parts = relative.parts
    return not any(part.lower() in BLOCKED_PARTS or part.lower() in BLOCKED_NAMES for part in parts)


def walk_files(directory):
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError(f"缺少数据目录或目录是符号链接：{directory.relative_to(ROOT)}")
    for current, directories, files in os.walk(directory, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(
            name for name in directories
            if allowed_path((current_path / name).relative_to(DATA))
        )
        for name in directories:
            if (current_path / name).is_symlink():
                raise ValueError(f"不能打包目录符号链接：{(current_path / name).relative_to(ROOT)}")
        for name in sorted(files):
            path = current_path / name
            if allowed_path(path.relative_to(DATA)):
                yield path


def collector_file(path):
    name = path.name.lower()
    return name.endswith((".xlsx", ".csv.gz", ".validation.json")) or name in COLLECTOR_NAMES


def chosen_files():
    selected = []
    for directory in ("inbox", "catalog", "ask", "analysis", "automation", "collector", "trials", "verification/cases-live/analysis"):
        for path in walk_files(DATA / directory):
            name = path.name.lower()
            if directory == "inbox":
                if not collector_file(path):
                    raise ValueError(f"收件目录存在未识别的文件：{path.relative_to(ROOT)}")
            elif directory == "catalog":
                if path.suffix.lower() != ".json":
                    continue
            elif directory == "ask":
                if path.suffix.lower() != ".jsonl":
                    continue
            elif directory == "analysis":
                if name not in ANALYSIS_NAMES:
                    continue
            elif directory == "automation":
                if name not in AUTOMATION_NAMES:
                    continue
            elif directory == "verification/cases-live/analysis":
                if name not in ANALYSIS_NAMES:
                    continue
            elif directory == "collector":
                if not collector_file(path):
                    continue
            elif directory == "trials" and name != "response.json" and path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            if path.is_symlink() and directory != "inbox":
                raise ValueError(f"只能处理收件文件的符号链接：{path.relative_to(ROOT)}")
            if not path.is_file():
                raise ValueError(f"文件不存在或类型不受支持：{path.relative_to(ROOT)}")
            selected.append(path)
    for name in sorted(FIXTURE_PATHS):
        path = DATA / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"验证所需的业务文件不存在或类型不受支持：data/{name}")
        selected.append(path)
    return selected


def quote_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def database_contains_secret(value):
    if isinstance(value, str):
        return int(bool(SECRET_PATTERN.search(value.encode("utf-8"))))
    if isinstance(value, bytes):
        return int(bool(SECRET_PATTERN.search(value)))
    return 0


def snapshot_database(destination):
    source = sqlite3.connect(f"{(DATA / 'fd-desk.db').as_uri()}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(destination)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    connection = sqlite3.connect(f"{destination.as_uri()}?mode=ro&immutable=1", uri=True)
    try:
        result = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if result != ["ok"]:
            raise ValueError(f"SQLite 完整性检查失败：{result}")
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        connection.create_function("contains_secret", 1, database_contains_secret)
        for name in tables:
            columns = [row[1] for row in connection.execute(f"PRAGMA table_xinfo({quote_identifier(name)})") if row[6] == 0]
            if columns:
                condition = " OR ".join(f"contains_secret({quote_identifier(column)})" for column in columns)
                if connection.execute(f"SELECT 1 FROM {quote_identifier(name)} WHERE {condition} LIMIT 1").fetchone():
                    raise ValueError(f"数据库含有疑似凭据，请检查数据表：{name}")
        counts = {
            name: connection.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]
            for name in tables
        }
        coverage = [dict(zip(("line", "first_day", "last_day", "days", "last_refresh"), row)) for row in connection.execute(
            "SELECT line, MIN(day), MAX(day), COUNT(*), MAX(refreshed_at) FROM coverage GROUP BY line ORDER BY line"
        )]
        task_times = [dict(zip(("line", "first_created_at", "last_created_at", "count"), row)) for row in connection.execute(
            "SELECT line, MIN(created_at), MAX(created_at), COUNT(*) FROM tasks GROUP BY line ORDER BY line"
        )]
        return {"integrity_check": "ok", "table_counts": counts, "coverage": coverage, "task_times": task_times}
    finally:
        connection.close()


def archive_entry(tar, path, name, expected_hash, expected_size):
    before = path.stat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"文件类型不受支持：{name}")
    if before.st_size != expected_size:
        raise ValueError(f"文件大小发生变化：{name}")
    info = tarfile.TarInfo(name)
    info.size = expected_size
    info.mode = 0o600
    info.mtime = before.st_mtime
    with path.open("rb") as source:
        tar.addfile(info, source)
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError(f"打包期间文件发生变化：{name}")
    actual_hash, actual_size = digest_file(path)
    if (actual_hash, actual_size) != (expected_hash, expected_size):
        raise ValueError(f"打包期间文件内容发生变化：{name}")


def pack(output):
    output = output.resolve()
    if not output.is_relative_to(DATA.resolve()) or output == DATA.resolve():
        raise ValueError("打包输出目录必须位于项目 data 目录内")
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    snapshot = output / ".fd-desk.db.snapshot"
    archive_path = output / ARCHIVE_NAME
    try:
        report = snapshot_database(snapshot)
        paths = chosen_files()
        files = []
        hashes = {}
        candidates = [(snapshot, "fd-desk.db", "data/fd-desk.db")]
        candidates.extend((path, path.relative_to(DATA).as_posix(), path.relative_to(ROOT).as_posix()) for path in paths)
        with (
            archive_path.open("xb") as archive_file,
            tarfile.open(fileobj=archive_file, mode="w:gz", compresslevel=3, format=tarfile.PAX_FORMAT) as tar,
        ):
            for path, name, source in candidates:
                if path.suffix.lower() in {".json", ".jsonl"}:
                    scan_text(path, source)
                sha256, size = digest_file(path)
                item = {"path": name, "source": source, "sha256": sha256, "size": size}
                if name.startswith("collector/") and (sha256, size) in hashes:
                    item["reference"] = hashes[(sha256, size)]
                else:
                    archive_entry(tar, path, name, sha256, size)
                    if name.startswith("inbox/"):
                        hashes.setdefault((sha256, size), name)
                files.append(item)
        archive_sha256, archive_size = digest_file(archive_path)
        if archive_size >= MAX_ASSET_SIZE:
            raise ValueError("压缩包达到单个附件大小上限")
        manifest = {
            "format": FORMAT,
            "created_at": datetime.now(UTC).isoformat(),
            "archive": {"name": ARCHIVE_NAME, "size": archive_size, "sha256": archive_sha256},
            "database": report,
            "files": files,
            "excluded": [
                "codex-home、认证文件、凭据、运行配置和私有目录",
                "临时工作、锁文件、缓存、日志、截图和导出产物",
                "采集页面、DOM、脚本、提示词和事件记录",
                "业务目录中未列入文件清单的其他文件",
            ],
        }
        with (output / MANIFEST_NAME).open("x", encoding="utf-8") as destination:
            json.dump(manifest, destination, ensure_ascii=False, indent=2)
            destination.write("\n")
    finally:
        snapshot.unlink(missing_ok=True)
        Path(f"{snapshot}-wal").unlink(missing_ok=True)
        Path(f"{snapshot}-shm").unlink(missing_ok=True)
    print(json.dumps({"archive_size": archive_size, "archive_sha256": archive_sha256, "files": len(files), "references": sum("reference" in item for item in files)}, ensure_ascii=False))


def safe_member_name(name):
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError("文件路径格式错误")
    path = PurePosixPath(name)
    if path.is_absolute() or name != path.as_posix() or any(part in {".", ".."} for part in path.parts):
        raise ValueError(f"文件路径不安全：{name}")
    history = len(path.parts) > 3 and path.parts[:3] == ("verification", "cases-live", "analysis")
    if not (name == "fd-desk.db" or path.parts[0] in {"inbox", "catalog", "ask", "analysis", "automation", "collector", "trials"} or history or name in FIXTURE_PATHS):
        raise ValueError(f"文件路径不在允许范围：{name}")
    if not allowed_path(path):
        raise ValueError(f"文件路径包含禁止内容：{name}")
    return path


def load_manifest(bundle):
    with (bundle / MANIFEST_NAME).open("r", encoding="utf-8") as source:
        manifest = json.load(source)
    if manifest.get("format") != FORMAT or manifest.get("archive", {}).get("name") != ARCHIVE_NAME:
        raise ValueError("数据包格式不受支持")
    files = {}
    for item in manifest["files"]:
        name = item["path"]
        safe_member_name(name)
        if name in files:
            raise ValueError(f"文件清单包含重复路径：{name}")
        if type(item["size"]) is not int or item["size"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
            raise ValueError(f"文件清单校验信息错误：{name}")
        source = item["source"]
        if not isinstance(source, str) or not source.startswith("data/"):
            raise ValueError(f"文件来源格式错误：{name}")
        safe_member_name(source[5:])
        files[name] = item
    if "fd-desk.db" not in files:
        raise ValueError("文件清单缺少数据库")
    for name, item in files.items():
        if "reference" in item:
            reference = item["reference"]
            if not name.startswith("collector/") or not isinstance(reference, str) or not reference.startswith("inbox/"):
                raise ValueError(f"文件引用格式错误：{name}")
            if reference not in files or "reference" in files[reference]:
                raise ValueError(f"文件引用的目标不存在：{name}")
            if (item["sha256"], item["size"]) != (files[reference]["sha256"], files[reference]["size"]):
                raise ValueError(f"文件引用的校验信息不一致：{name}")
    return manifest, files


def read_member(tar, member, expected, destination=None):
    if not member.isreg() or member.size != expected["size"]:
        raise ValueError(f"压缩包成员类型或大小错误：{member.name}")
    source = tar.extractfile(member)
    if source is None:
        raise ValueError(f"无法读取压缩包成员：{member.name}")
    digest = hashlib.sha256()
    size = 0
    output = destination.open("xb") if destination is not None else None
    try:
        while chunk := source.read(CHUNK):
            digest.update(chunk)
            size += len(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        source.close()
        if output is not None:
            output.close()
    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError(f"压缩包成员校验失败：{member.name}")


def verify_archive(archive_file, manifest, files, destination=None):
    archive_file.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := archive_file.read(CHUNK):
        digest.update(chunk)
        size += len(chunk)
    expected_archive = manifest["archive"]
    if (digest.hexdigest(), size) != (expected_archive["sha256"], expected_archive["size"]):
        raise ValueError("压缩包整体校验失败")
    archive_file.seek(0)
    expected = {name for name, item in files.items() if "reference" not in item}
    seen = set()
    with tarfile.open(fileobj=archive_file, mode="r:gz") as tar:
        for member in tar:
            safe_member_name(member.name)
            if member.name not in expected or member.name in seen:
                raise ValueError(f"压缩包包含未知或重复成员：{member.name}")
            if not member.isreg():
                raise ValueError(f"压缩包成员类型不受支持：{member.name}")
            seen.add(member.name)
            path = destination.joinpath(*PurePosixPath(member.name).parts) if destination else None
            if path is not None:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            read_member(tar, member, files[member.name], path)
            if path is not None:
                os.utime(path, (member.mtime, member.mtime))
    if seen != expected:
        raise ValueError("压缩包缺少文件清单中的成员")


def check_snapshot(path, expected):
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True)
    try:
        result = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if result != ["ok"]:
            raise ValueError("恢复后的数据库完整性检查失败")
        names = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        counts = {name: connection.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0] for name in names}
        if counts != expected["table_counts"]:
            raise ValueError("恢复后的数据库表数量不一致")
    finally:
        connection.close()


def verify_or_restore(bundle, target=None):
    manifest, files = load_manifest(bundle)
    if target is not None:
        target = target.resolve()
        data = DATA.resolve()
        if target != data and not target.is_relative_to(data):
            raise ValueError("恢复目标必须是项目 data 目录或其子目录")
        if target.exists():
            raise FileExistsError(f"恢复目标已存在：{target}")
    archive = bundle / ARCHIVE_NAME
    with archive.open("rb") as source:
        before = os.fstat(source.fileno())
        verify_archive(source, manifest, files)
        if target is not None:
            target.mkdir(parents=True, exist_ok=False, mode=0o700)
            verify_archive(source, manifest, files, target)
            for name, item in files.items():
                if "reference" in item:
                    destination = target.joinpath(*PurePosixPath(name).parts)
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    reference = target.joinpath(*PurePosixPath(item["reference"]).parts)
                    os.link(reference, destination)
                    if digest_file(destination) != (item["sha256"], item["size"]):
                        raise ValueError(f"恢复后的引用文件校验失败：{name}")
            check_snapshot(target / "fd-desk.db", manifest["database"])
        after = os.fstat(source.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("校验期间压缩包发生变化")
    print(json.dumps({"verified_files": len(files), "references": sum("reference" in item for item in files.values()), "restored": target is not None}, ensure_ascii=False))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="打包、校验和恢复 FD Desk 业务数据")
    commands = parser.add_subparsers(dest="command", required=True)
    pack_parser = commands.add_parser("pack")
    pack_parser.add_argument("--output-dir", required=True, type=Path)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--bundle-dir", required=True, type=Path)
    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("--bundle-dir", required=True, type=Path)
    restore_parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "pack":
        pack(args.output_dir)
    elif args.command == "verify":
        verify_or_restore(args.bundle_dir)
    else:
        verify_or_restore(args.bundle_dir, args.target)


if __name__ == "__main__":
    main()
