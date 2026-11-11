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
    parser.add_argument("command", choices=("serve", "install-service", "backfill-reports", "scan", "selfcheck", "import"), nargs="?", default="serve")
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--replace-range", action="store_true")
    parser.add_argument("--scope", type=Path)
    args = parser.parse_args()
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


if __name__ == "__main__":
    main()
