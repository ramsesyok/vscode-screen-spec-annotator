"""Exercise the bundled custom editor in an isolated desktop VS Code instance."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAMgAAABkAQAAAADr/UKmAAAAGUlEQVR4nO3BgQAAAADDoPlTH+AKVQEAQGcKKAABU/WK2gAAAABJRU5ErkJggg=="
)


def write_fixture(workspace):
    workspace.mkdir()
    (workspace / "image.png").write_bytes(PNG)
    size = {"width": 200, "height": 100}
    item = {"id": "sample", "number": 1, "name": "initial", "values": {},
            "region": {"x": 20, "y": 20, "width": 40, "height": 30}, "marker": {"x": 65, "y": 20}}
    data = {"version": 2, "imagePath": "image.png", "coordinateSize": size,
            "confirmedImage": {**size, "sha256": hashlib.sha256(PNG).hexdigest()},
            "coordinateReviewPending": False, "highestIssuedNumber": 1,
            "style": {"color": "#113a60", "lineStyle": "solid"}, "items": [item]}
    file = workspace / "sample.annotations.json"
    file.write_text(json.dumps(data), encoding="utf-8")
    return file


def wait_for(read, description, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = read()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for " + description)


def exercise(page, panel, file):
    name = panel.locator("#rows textarea")
    rect = panel.locator("rect[data-drag=move]")
    expect(rect).to_be_visible()
    save_key = "Meta+s" if sys.platform == "darwin" else "Control+s"

    def saved_as(value):
        try:
            return json.loads(file.read_text(encoding="utf-8-sig"))["items"][0]["name"] == value
        except (json.JSONDecodeError, PermissionError, FileNotFoundError):
            return False

    name.fill("保存テスト")
    name.press(save_key)
    wait_for(lambda: saved_as("保存テスト"), "Webview edit on disk")
    data = json.loads(file.read_text(encoding="utf-8-sig"))
    item = data["items"][0]

    # An external move during pointer capture must survive the subsequent drop.
    box = rect.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    item["region"]["x"], item["marker"]["x"] = 80, 125
    file.write_text(json.dumps(data), encoding="utf-8")
    expect(panel.locator("#region-x")).to_have_value("80")
    page.mouse.move(x + 10, y)
    page.mouse.up()
    expect(panel.locator("#notice")).to_contain_text("ドラッグ")
    name.fill("after drop")
    name.press(save_key)
    wait_for(lambda: saved_as("after drop"), "save after cancelled drag")
    saved_item = json.loads(file.read_text(encoding="utf-8-sig"))["items"][0]
    assert (saved_item["region"]["x"], saved_item["marker"]["x"]) == (80, 125)

    # Change the document from outside while an IME composition holds a local draft.
    for action in ("入力した名称を再適用", "最新の名称を使う"):
        name.focus()
        name.dispatch_event("compositionstart")
        name.fill("local " + action)
        item["name"] = "external " + action
        item["marker"]["y"] += 1
        file.write_text(json.dumps(data), encoding="utf-8")
        expect(panel.locator("#marker-y")).to_have_value(str(item["marker"]["y"]))
        name.dispatch_event("compositionend")
        choice = panel.get_by_role("button", name=action)
        expect(choice).to_be_visible()
        expect(name).to_have_value("local " + action)
        choice.click()
        wanted = "local " + action if action.startswith("入力") else item["name"]
        expect(name).to_have_value(wanted)
        name.press(save_key)
        wait_for(lambda: saved_as(wanted), "conflict resolution on disk")

    panel.locator("#region-x").fill("90")
    data["coordinateSize"]["width"] = 300
    file.write_text(json.dumps(data), encoding="utf-8")
    name.focus()
    expect(panel.locator("#notice")).to_contain_text("基準寸法")
    for selector in ("#region-x", "#remove", "#image-marker-diameter", "#item-marker-diameter"):
        expect(panel.locator(selector)).to_be_disabled()
    panel.locator("#viewport").focus()
    page.keyboard.press("Delete")
    name.fill("final")
    name.press(save_key)
    wait_for(lambda: saved_as("final"), "name saved while geometry is locked")
    persisted = json.loads(file.read_text(encoding="utf-8-sig"))["items"][0]
    assert (persisted["region"]["x"], persisted["marker"]["x"]) == (80, 125)


def run(directory, executable):
    workspace = directory / "workspace"
    file = write_fixture(workspace)
    profile = directory / "profile"
    args = [executable, "--new-window", "--skip-welcome", "--skip-release-notes",
            "--disable-updates", "--disable-workspace-trust", "--remote-debugging-port=0",
            "--user-data-dir=" + str(profile), "--extensions-dir=" + str(directory / "extensions"),
            "--extensionDevelopmentPath=" + str(ROOT),
            "--extensionTestsPath=" + str(ROOT / "integration" / "webview-host.cjs"), str(workspace)]
    env = {**os.environ, "SCREEN_SPEC_TEST_DIR": str(directory)}
    env.pop("ELECTRON_RUN_AS_NODE", None)
    process = subprocess.Popen(args, env=env)
    try:
        def port_number():
            if process.poll() is not None:
                raise RuntimeError("VS Code exited before opening the test window")
            port_file = profile / "DevToolsActivePort"
            if port_file.exists():
                lines = port_file.read_text().splitlines()
                if lines:
                    return int(lines[0])

        port = wait_for(port_number, "VS Code test window", 50)
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event("page")
            page.set_viewport_size({"width": 1350, "height": 900})
            (directory / "connected").touch()
            panel = page.frame_locator("iframe.webview").frame_locator("#active-frame")
            exercise(page, panel, file)
            panel.locator("body").evaluate("body => body.dataset.originalPanel = 'yes'")
            (directory / "reopen").touch()
            expect(panel.locator("body:not([data-original-panel]) #rows textarea")).to_have_value("final")
    finally:
        (directory / "finished").touch()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=15)
    if process.returncode:
        raise RuntimeError(f"VS Code exited with status {process.returncode}")


if __name__ == "__main__":
    executable = os.environ.get("VSCODE_EXECUTABLE")
    if not executable and os.name == "nt" and shutil.which("code"):
        executable = str(Path(shutil.which("code")).resolve().parents[1] / "Code.exe")
    if not executable:
        sys.exit("Set VSCODE_EXECUTABLE to the VS Code desktop application executable.")
    with tempfile.TemporaryDirectory(prefix="screen-spec-panel-") as temp:
        run(Path(temp), executable)
    print("Screen Spec Annotator Webview checks passed")
