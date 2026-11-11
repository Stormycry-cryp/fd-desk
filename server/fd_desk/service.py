import logging
import logging.config
import os
import plistlib
import re
import subprocess
import sys
import time
from pathlib import Path

from .core import ROOT, data_path, dump

LABEL = "cn.zhiyitech.fd-desk.server"


def logging_configuration(directory):
    logs = directory / "service/logs"
    logs.mkdir(parents=True, exist_ok=True)
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"service": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
        "handlers": {"service": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": str(logs / "server.log"),
            "maxBytes": 2 * 1024 * 1024,
            "backupCount": 1,
            "encoding": "utf-8",
            "formatter": "service",
        }},
        "root": {"handlers": ["service"], "level": "WARNING"},
        "loggers": {
            "uvicorn": {"handlers": [], "propagate": True, "level": "INFO"},
            "uvicorn.error": {"handlers": [], "propagate": True, "level": "INFO"},
            "uvicorn.access": {"handlers": [], "propagate": False, "level": "WARNING"},
        },
    }


def install():
    directory = data_path()
    work = directory / "work/service"
    work.mkdir(parents=True, exist_ok=True)
    destination = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    destination.parent.mkdir(parents=True, exist_ok=True)
    configuration = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "fd_desk.service"],
        "WorkingDirectory": str(ROOT / "server"),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ExitTimeOut": 30,
        "ProcessType": "Interactive",
        "EnvironmentVariables": {
            "FD_DESK_DATA_DIR": str(directory),
            "PATH": os.environ["PATH"],
            "TMPDIR": str(work),
            "PYTHONUNBUFFERED": "1",
        },
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": "/dev/null",
    }
    previous = plistlib.loads(destination.read_bytes()) if destination.exists() else None
    if previous and (previous.get("WorkingDirectory") != configuration["WorkingDirectory"]
                     or previous.get("ProgramArguments") != configuration["ProgramArguments"]):
        raise RuntimeError("已有同名服务使用其他启动程序或目录，需要核对当前配置")
    destination.write_bytes(plistlib.dumps(configuration))
    destination.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    current = subprocess.run(["launchctl", "print", f"{domain}/{LABEL}"], capture_output=True, check=False)
    if current.returncode == 0 and previous != configuration:
        match = re.search(rb"(?m)^\s*pid = (\d+)$", current.stdout)
        subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], check=True)
        deadline = time.monotonic() + 35
        while match and subprocess.run(["ps", "-p", match[1].decode(), "-o", "pid="], capture_output=True, check=False).returncode == 0:
            if time.monotonic() >= deadline:
                raise RuntimeError("已有后端进程未在限定时间内退出")
            time.sleep(0.1)
    if current.returncode:
        subprocess.run(["launchctl", "enable", f"{domain}/{LABEL}"], check=True)
    if current.returncode or previous != configuration:
        subprocess.run(["launchctl", "bootstrap", domain, str(destination)], check=True)
    from .ask_service import install as install_ask
    ask = install_ask()
    print(dump({"label": LABEL, "plist": str(destination), "url": "http://127.0.0.1:8765", "ask": ask}))


def run():
    configuration = logging_configuration(data_path())
    logging.config.dictConfig(configuration)

    def failure(error_type, value, traceback):
        logging.getLogger(__name__).critical("本机服务启动失败：%s", error_type.__name__)

    sys.excepthook = failure
    from .cli import serve
    serve(log_config=configuration)


if __name__ == "__main__":
    run()
