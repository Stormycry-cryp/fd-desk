import os
import plistlib
import re
import shutil
import subprocess
from pathlib import Path

from .core import ROOT, data_path, dump

LABEL = "cn.zhiyitech.fd-desk.lan"


def install():
    executable = shutil.which("caddy")
    if executable is None:
        raise RuntimeError("内网入口需要 Caddy，请先执行 brew install caddy")
    directory = data_path()
    work = directory / "work/lan-service"
    work.mkdir(parents=True, exist_ok=True)
    (directory / "service/logs").mkdir(parents=True, exist_ok=True)
    environment = {
        "FD_DESK_DATA_DIR": str(directory),
        "TMPDIR": str(work),
        "XDG_DATA_HOME": str(directory / "service/caddy/data"),
        "XDG_CONFIG_HOME": str(directory / "service/caddy/config"),
    }
    config = ROOT / "server/Caddyfile"
    subprocess.run(
        [executable, "validate", "--config", str(config), "--adapter", "caddyfile"],
        env={**os.environ, **environment}, check=True, capture_output=True,
    )
    destination = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    configuration = {
        "Label": LABEL,
        "ProgramArguments": [executable, "run", "--config", str(config), "--adapter", "caddyfile"],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ExitTimeOut": 30,
        "ProcessType": "Background",
        "EnvironmentVariables": environment,
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    previous = plistlib.loads(destination.read_bytes()) if destination.exists() else None
    if previous and (previous.get("WorkingDirectory") != configuration["WorkingDirectory"]
                     or previous.get("ProgramArguments") != configuration["ProgramArguments"]):
        raise RuntimeError("已有同名内网服务使用其他程序或目录")
    domain = f"gui/{os.getuid()}"
    current = subprocess.run(["launchctl", "print", f"{domain}/{LABEL}"], capture_output=True, check=False)
    if current.returncode == 0 and previous != configuration:
        subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], check=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(plistlib.dumps(configuration))
    destination.chmod(0o600)
    if current.returncode or previous != configuration:
        subprocess.run(["launchctl", "enable", f"{domain}/{LABEL}"], check=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(destination)], check=True)
    subprocess.run(["launchctl", "kickstart", f"{domain}/{LABEL}"], check=True)
    hostname = subprocess.run(["scutil", "--get", "LocalHostName"], check=True, capture_output=True, text=True).stdout.strip().lower()
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", hostname):
        raise RuntimeError("本机局域网主机名称无效")
    receipt = {"label": LABEL, "plist": str(destination), "port": 8767, "hostname": f"{hostname}.local", "url": f"http://{hostname}.local:8767"}
    (directory / "service/lan.json").write_text(dump(receipt))
    print(dump(receipt))
