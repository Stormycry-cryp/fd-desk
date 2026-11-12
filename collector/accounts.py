import argparse

from fd_desk.account_collection import collect_accounts
from fd_desk.core import dump
from fd_desk.store import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--run-id")
    args = parser.parse_args()
    store = Store()
    try:
        print(dump(collect_accounts(store, force=args.force, run_id=args.run_id)), flush=True)
    finally:
        store.close()


if __name__ == "__main__":
    main()
