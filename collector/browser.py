import argparse
import json
import subprocess
from pathlib import Path

from fd_desk.core import ROOT

BRIDGE = ROOT / "collector/chrome_dom.applescript"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--page", choices=("records", "accounts"), default="records")
    args = parser.parse_args()
    page = "/fd-plus/generation-analytics" if args.page == "accounts" else "/fd-plus/generation-records"
    marker = ROOT / "data/collector" / ("accounts-browser.json" if args.page == "accounts" else "browser.json")
    marker.parent.mkdir(parents=True, exist_ok=True)
    if marker.is_file():
        identity = json.loads(marker.read_text())
        found = subprocess.run(["osascript", str(BRIDGE), "find", str(identity["tabId"]), page], check=True, capture_output=True, text=True)
        location = json.loads(found.stdout)
    else:
        location = None
    if location is None:
        created = subprocess.run(["osascript", str(BRIDGE), "open", page], check=True, capture_output=True, text=True)
        marker.write_text(json.dumps({"tabId": int(created.stdout)}))
        found = subprocess.run(["osascript", str(BRIDGE), "find", created.stdout.strip(), page], check=True, capture_output=True, text=True)
        location = json.loads(found.stdout)
    if location is None:
        raise RuntimeError("新建的 FD 页面无法定位")
    window, tab = location
    if args.script:
        script = args.script.resolve()
        if not script.is_relative_to((ROOT / "data").resolve()):
            parser.error("DOM 脚本必须位于项目 data/ 目录")
        source = script.read_text()
        forbidden = ("localStorage", "sessionStorage", "document.cookie", "fetch(", "XMLHttpRequest", "indexedDB")
        if any(term in source for term in forbidden):
            parser.error("DOM 操作禁止读取凭据或额外发送接口请求")
    else:
        source = "JSON.stringify({origin:location.origin,path:location.pathname,title:document.title,inputs:[...document.querySelectorAll('input')].map(x=>({placeholder:x.placeholder,value:x.value,readOnly:x.readOnly})),buttons:[...document.querySelectorAll('button')].map(x=>x.innerText)})"
    result = subprocess.run(["osascript", str(BRIDGE), "evaluate", str(window), str(tab), source, page], check=True, capture_output=True, text=True)
    if args.output:
        output = args.output.resolve()
        if not output.is_relative_to((ROOT / "data").resolve()):
            parser.error("DOM 输出必须位于项目 data/ 目录")
        output.write_text(result.stdout)
    else:
        print(result.stdout.strip())


if __name__ == "__main__":
    main()
