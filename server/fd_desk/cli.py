import argparse
import json

import uvicorn

from .core import dump


def main():
    parser = argparse.ArgumentParser(prog="fd-desk")
    parser.add_argument("command", choices=("serve", "scan", "selfcheck"), nargs="?", default="serve")
    args = parser.parse_args()
    if args.command == "serve":
        from .app import create_app
        from .ingest import scan
        app = create_app()
        scan(app.state.store)
        uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False)
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
