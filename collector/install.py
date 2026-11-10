import os
import plistlib
import subprocess
from pathlib import Path

from fd_desk.codex_runner import runtime
from fd_desk.core import ROOT, dump
from fd_desk.store import Store


def main():
    store = Store()
    configuration = runtime(store.directory)
    label = "cn.zhiyitech.fd-desk.daily"
    directory = Path.home() / "Library/LaunchAgents"
    directory.mkdir(exist_ok=True)
    path = directory / (label + ".plist")
    logs = store.directory / "collector/logs"
    logs.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": label,
        "ProgramArguments": [str(Path.home() / ".local/bin/uv"), "run", "--frozen", "--directory", str(ROOT / "server"), "python", str(ROOT / "collector/daily.py")],
        "WorkingDirectory": str(ROOT), "RunAtLoad": True, "StartInterval": 1800,
        "StartCalendarInterval": {"Hour": 7, "Minute": 30},
        "EnvironmentVariables": {"CODEX_HOME": configuration["codexHome"], "PATH": os.environ["PATH"], "TMPDIR": str(store.directory / "work")},
        "ProcessType": "Background", "ThrottleInterval": 300,
        "StandardOutPath": str(logs / "daily.log"), "StandardErrorPath": str(logs / "error.log"),
    }
    if path.exists() and plistlib.loads(path.read_bytes()) != plist:
        raise RuntimeError("已有同名调度配置不同，请先核对当前任务")
    path.write_bytes(plistlib.dumps(plist))
    domain = f"gui/{os.getuid()}"
    current = subprocess.run(["launchctl", "print", domain + "/" + label], check=False, capture_output=True)
    if current.returncode:
        subprocess.run(["launchctl", "bootstrap", domain, str(path)], check=True)
    print(dump({"label": label, "plist": str(path), "state": "installed"}))


if __name__ == "__main__":
    main()
