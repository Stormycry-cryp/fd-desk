import argparse
import json
from pathlib import Path

import uvicorn

from .core import dump


def serve(log_config=uvicorn.config.LOGGING_CONFIG):
    from .app import create_app
    from .ingest import scan
    app = create_app()
    scan(app.state.store)
    uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False, log_config=log_config)


def main():
    parser = argparse.ArgumentParser(prog="fd-desk")
    parser.add_argument("command", choices=("serve", "install-service", "install-lan", "backfill-reports", "scan", "selfcheck", "import", "profiles"), nargs="?", default="serve")
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--replace-range", action="store_true")
    parser.add_argument("--scope", type=Path)
    args = parser.parse_args()
    if args.command == "profiles":
        if str(args.file) != "init" or args.replace_range or args.scope:
            parser.error("档案初始化命令为 fd-desk profiles init")
        initialize_profiles()
        return
    if args.command == "import":
        if args.file is None:
            parser.error("import 需要提供文件路径")
        from .ingest import import_file
        from .store import Store
        print(dump(import_file(Store(), args.file, replace_range=args.replace_range, scope=args.scope)))
        return
    if args.file is not None or args.replace_range or args.scope is not None:
        parser.error("文件路径、--replace-range 和 --scope 只用于 import")
    if args.command == "serve":
        serve()
    elif args.command == "install-service":
        from .service import install
        install()
    elif args.command == "install-lan":
        from .lan_service import install
        install()
    elif args.command == "backfill-reports":
        from .reports import backfill
        from .store import Store
        store = Store()
        try:
            print(dump(backfill(store)))
        finally:
            store.close()
    elif args.command == "scan":
        from .ingest import scan
        from .store import Store
        jobs = scan(Store())
        print(dump({"imports": len(jobs), "inserted": sum(job["inserted"] for job in jobs), "updated": sum(job["updated"] for job in jobs)}))
    else:
        from .verification import selfcheck
        print(json.dumps(selfcheck(), ensure_ascii=False, indent=2))


def initialize_profiles():
    import httpx

    with httpx.Client(base_url="http://127.0.0.1:8765", timeout=60) as client:
        response = client.post("/api/profiles/init")
        response.raise_for_status()
        print(dump({"run": response.json(), "persistent": True, "status": "/api/pipeline"}), flush=True)


if __name__ == "__main__":
    main()
