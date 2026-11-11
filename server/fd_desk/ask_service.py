import json
import os
import plistlib
import subprocess
from pathlib import Path

from .core import ROOT, data_path

LABEL = "cn.zhiyitech.fd-desk.ask"


def install():
    directory = data_path()
    runtime = json.loads((directory / "runtime.json").read_text())
    executable = Path(runtime["ask"]["nodeExecutable"]).resolve(strict=True)
    version = subprocess.run([str(executable), "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if not version.startswith("v24."):
        raise RuntimeError("问答服务需要 Node 24")
    if not (ROOT / "agent/node_modules/@earendil-works/pi-durable").is_dir():
        raise RuntimeError("请先安装 agent/package-lock.json 中锁定的问答依赖")
    work = directory / "work/ask-service"
    work.mkdir(parents=True, exist_ok=True)
    destination = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    configuration = {
        "Label": LABEL,
        "ProgramArguments": [str(executable), str(ROOT / "agent/server.js")],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ExitTimeOut": 30,
        "ProcessType": "Interactive",
        "EnvironmentVariables": {"FD_DESK_DATA_DIR": str(directory), "TMPDIR": str(work)},
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    previous = plistlib.loads(destination.read_bytes()) if destination.exists() else None
    if previous and (previous.get("WorkingDirectory") != configuration["WorkingDirectory"]
                     or previous.get("ProgramArguments") != configuration["ProgramArguments"]):
        raise RuntimeError("已有同名问答服务使用其他程序或目录")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(plistlib.dumps(configuration))
    destination.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    current = subprocess.run(["launchctl", "print", f"{domain}/{LABEL}"], capture_output=True, check=False)
    if current.returncode == 0 and previous != configuration:
        subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], check=True)
    if current.returncode or previous != configuration:
        subprocess.run(["launchctl", "enable", f"{domain}/{LABEL}"], check=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(destination)], check=True)
    return {"label": LABEL, "plist": str(destination), "url": "http://127.0.0.1:8766"}
