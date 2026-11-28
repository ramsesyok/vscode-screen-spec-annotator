"""Exercise the bundled custom editor in an isolated desktop VS Code instance."""
import base64
import csv
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
    name = panel.locator('#rows input[type="text"]').first
    rect = panel.locator("rect[data-drag=move]")
    expect(rect).to_be_visible(timeout=30000)
    save_key = "Meta+s" if sys.platform == "darwin" else "Control+s"
    picker = panel.locator("#marker-position")
    picker_style = panel.locator(".marker-position-picker")
    align = panel.locator("button[data-align=left]")
    zoom_in = panel.locator("#zoom-in")
    expect(picker).to_be_disabled()
    expect(picker_style).to_have_css("opacity", align.evaluate("button => getComputedStyle(button).opacity"))
    expect(picker).to_have_css("background-color", align.evaluate("button => getComputedStyle(button).backgroundColor"))
    name.click()
    expect(picker).to_be_enabled()
    expect(picker_style).to_have_css("opacity", "1")
    expect(picker).to_have_css("background-color", zoom_in.evaluate("button => getComputedStyle(button).backgroundColor"))

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
    panel.locator("#zoom-in").click()
    panel.get_by_role("button", name="PNGを出力").click()
    png = file.parent / "output" / "sample.annotated.png"
    try:
        wait_for(png.is_file, "annotated PNG")
    except AssertionError as error:
        notice = panel.locator("#notice").text_content(timeout=2000)
        raise AssertionError(f"{error}. Editor notice: {notice!r}") from error
    pixels = panel.locator("body").evaluate("""async (_, encoded) => {
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
        const number = context.getImageData(61, 16, 8, 8).data;
        const hasNumber = number.some((value, index) => index % 4 === 0 && value < 80);
        return { size: [bitmap.width, bitmap.height], edge: pixel(20, 30),
                 marker: pixel(60, 20), background: pixel(5, 5), hasNumber };
    }""", base64.b64encode(png.read_bytes()).decode("ascii"))
    assert pixels == {"size": [200, 100], "edge": [17, 58, 96, 255],
                      "marker": [255, 255, 255, 255], "background": [0, 0, 0, 255], "hasNumber": True}
    panel.locator("#fit").click()
    exercise_styles(panel, file, png, save_key)

    # An external move during pointer capture must survive the subsequent drop.
    box = wait_for(rect.bounding_box, "rectangle after the save response")
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
    data["items"].append({**item, "id": "second", "name": "次へ", "number": 2})
    data["highestIssuedNumber"] = 2
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


def exercise_styles(panel, file, png, save_key):
    rect = panel.locator("rect[data-drag=move]")
    marker = panel.locator("circle[data-drag=marker]")
    reference = panel.locator("rect.region-reference")
    reference_halo = panel.locator("rect.region-reference-halo")
    label = panel.locator(".marker-text")
    row_name = panel.locator("#rows .row-name")
    color_dialog = panel.locator("#color-dialog")
    hex_field = color_dialog.locator("#color-hex")
    opacity_field = color_dialog.locator("#color-opacity")

    def set_number(selector, value):
        field = panel.locator(selector)
        field.fill(str(value))
        field.press("Enter")

    def set_color(selector, color=None, opacity=None):
        panel.locator(selector).click()
        expect(color_dialog).to_be_visible()
        if color is not None:
            hex_field.fill(color)
        if opacity is not None:
            opacity_field.fill(str(opacity))
        color_dialog.get_by_role("button", name="確定").click()
        expect(color_dialog).to_be_hidden()

    def check_opacities(values):
        for shape, attribute, value in zip((rect, marker, marker, label),
                                           ("stroke-opacity", "stroke-opacity", "fill-opacity", "fill-opacity"), values):
            expect(shape).to_have_attribute(attribute, value)

    row_name.focus()
    panel.locator("#image-style-toggle").click()
    item_style = panel.get_by_role("checkbox", name="項目スタイルの個別設定", exact=True)
    item_fields = panel.locator("#item-style-fields")
    rect_color = panel.locator("#item-color")
    expect(item_style).not_to_be_checked()
    expect(item_fields).to_be_hidden()
    common_color = panel.locator("#image-marker-stroke")
    item_color = panel.locator("#item-marker-stroke")
    expect(common_color).to_have_attribute("title", "#113a60 · 不透明度 100%")
    common_color.click()
    expect(color_dialog).to_be_visible()
    expect(hex_field).to_have_value("#113a60")
    expect(opacity_field).to_have_value("100")
    preview = color_dialog.locator("#color-preview > span")
    expect(preview).to_have_css("background-color", "rgb(17, 58, 96)")
    plane = color_dialog.locator("#color-plane")
    plane.click(position={"x": 15, "y": 15})
    picked = hex_field.input_value()
    assert picked != "#113a60"
    plane.press("Shift+ArrowRight")
    expect(hex_field).not_to_have_value(picked)
    opacity_field.fill("37.5")
    expect(color_dialog.locator("#color-opacity-slider")).to_have_value("37.5")
    expect(preview).to_have_css("opacity", "0.375")
    color_dialog.locator("#color-opacity-slider").press("Home")
    expect(opacity_field).to_have_value("0")
    expect(preview).to_have_css("opacity", "0")
    hex_field.press("Escape")
    expect(color_dialog).to_be_hidden()
    expect(common_color).to_have_attribute("title", "#113a60 · 不透明度 100%")
    set_color("#image-marker-stroke", "#008040")
    common_line = panel.locator("#image-line")
    common_line.select_option("dashed")
    expect(rect).to_have_attribute("stroke-dasharray", "8 6")
    common_width = panel.locator("#image-stroke-width")
    common_width.fill("6")
    common_width.press("Enter")
    expect(rect).to_have_attribute("stroke-dasharray", "24 18")
    expect(marker).to_have_attribute("stroke-width", "2")
    set_number("#image-marker-stroke-width", 3)
    expect(marker).to_have_attribute("stroke-width", "3")
    expect(rect).to_have_attribute("stroke-width", "6")
    expect(marker).to_have_css("stroke-dasharray", "none")
    common_line.select_option("dotted")
    expect(rect).to_have_attribute("stroke-dasharray", "0 12")
    expect(rect).to_have_css("stroke-linecap", "round")
    expect(marker).to_have_css("stroke-dasharray", "none")
    expect(marker).to_have_attribute("stroke", "#008040")
    check_opacities(("1", "1", "1", "1"))
    for color, value in zip(("color", "marker-stroke", "marker-fill", "marker-text"), (50, 75, 40, 25)):
        set_color(f"#image-{color}", opacity=value)
    check_opacities(("0.5", "0.75", "0.4", "0.25"))

    item_style.check()
    expect(item_fields).to_be_visible()
    expect(item_fields.get_by_role("checkbox")).to_have_count(0)
    expect(rect_color).to_be_enabled()
    expect(rect_color).to_have_attribute("title", "#113a60 · 不透明度 50%")
    expect(item_color).to_have_attribute("title", "#008040 · 不透明度 75%")
    set_color("#item-color", "#446688")
    expect(rect).to_have_attribute("stroke", "#446688")
    set_color("#image-marker-stroke", "#005020")
    expect(marker).to_have_attribute("stroke", "#008040")

    item_line = panel.locator("#item-line")
    expect(item_line).to_have_value("dotted")
    item_line.select_option("dashed")
    expect(rect).to_have_attribute("stroke-dasharray", "24 18")
    item_width = panel.locator("#item-stroke-width")
    item_width.fill("10")
    item_width.press("Enter")
    expect(rect).to_have_attribute("stroke-dasharray", "40 30")
    expect(marker).to_have_attribute("stroke-width", "3")
    set_number("#item-marker-stroke-width", 4)
    expect(marker).to_have_attribute("stroke-width", "4")
    expect(rect).to_have_attribute("stroke-width", "10")
    expect(marker).to_have_css("stroke-dasharray", "none")
    set_color("#item-marker-stroke", "#d12070", 90)
    set_color("#item-marker-fill", "#f2e612", 60)
    set_color("#item-marker-text", "#1a237e", 50)
    expect(marker).to_have_attribute("stroke", "#d12070")
    expect(marker).to_have_attribute("fill", "#f2e612")
    expect(label).to_have_attribute("fill", "#1a237e")
    marker.click()
    expect(reference).to_have_count(0)
    set_color("#item-color", opacity=0)
    check_opacities(("0", "0.9", "0.6", "0.5"))
    expect(reference).to_be_visible()
    expect(reference_halo).to_be_visible()
    for attribute in ("x", "y", "width", "height"):
        geometry = rect.get_attribute(attribute)
        expect(reference).to_have_attribute(attribute, geometry)
        expect(reference_halo).to_have_attribute(attribute, geometry)
    expect(reference).to_have_css("pointer-events", "none")
    expect(reference_halo).to_have_css("pointer-events", "none")
    expect(reference_halo).to_have_css("stroke", "rgb(255, 255, 255)")
    panel.locator("#zoom-out").click()
    displayed_width = reference_halo.evaluate("""outline => {
        const svg = outline.ownerSVGElement;
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        return parseFloat(getComputedStyle(outline).strokeWidth) * scale;
    }""")
    assert abs(displayed_width - 3.5) < 0.01
    panel.locator("#fit").click()
    expect(panel.locator("rect.selection-outline, circle.handle")).to_have_count(0)
    row_selection = panel.locator('#rows input[type="checkbox"]')
    expect(row_selection).to_have_js_property("indeterminate", True)
    row_selection.click()
    expect(panel.locator("rect.selection-outline")).to_be_visible()
    expect(reference).to_have_count(0)
    expect(reference_halo).to_have_count(0)
    panel.locator("#viewport").press("Escape")
    expect(reference).to_have_count(0)
    marker.click()
    expect(reference).to_be_visible()
    item_diameter = panel.locator("#item-marker-diameter")
    item_diameter.fill("18")
    item_diameter.press("Enter")
    expect(marker).to_have_attribute("r", "9")

    item_style.uncheck()
    expect(item_fields).to_be_hidden()
    expect(rect).to_have_attribute("stroke", "#113a60")
    expect(rect).to_have_attribute("stroke-dasharray", "0 12")
    expect(marker).to_have_attribute("stroke", "#005020")
    expect(marker).to_have_attribute("fill", "#ffffff")
    expect(marker).to_have_attribute("r", "7")
    expect(label).to_have_attribute("fill", "#0b253d")
    check_opacities(("0.5", "0.75", "0.4", "0.25"))
    expect(marker).to_have_attribute("stroke-width", "3")
    item_style.check()
    expect(item_fields).to_be_visible()
    expect(rect_color).to_have_attribute("title", "#113a60 · 不透明度 50%")
    expect(item_color).to_have_attribute("title", "#005020 · 不透明度 75%")
    set_color("#item-marker-stroke", "#d12070", 50)
    item_width.fill("10")
    item_width.press("Enter")
    set_number("#item-marker-stroke-width", 4)
    set_color("#item-marker-fill", opacity=0)
    set_color("#item-marker-text", opacity=0)
    expect(rect).to_have_attribute("stroke-dasharray", "0 20")
    expect(marker).to_have_attribute("stroke", "#d12070")
    expect(marker).to_have_css("stroke-dasharray", "none")
    row_name.press(save_key)

    common_style = {"color": "#113a60", "lineStyle": "dotted", "regionStrokeWidth": 6, "markerStrokeWidth": 3,
                    "colorOpacity": 50, "markerStrokeColor": "#005020", "markerStrokeOpacity": 75,
                    "markerFillOpacity": 40, "markerTextOpacity": 25}

    def saved_styles():
        try:
            saved = json.loads(file.read_text(encoding="utf-8-sig"))
            return (saved["style"] == common_style and
                    saved["items"][0].get("style") ==
                    {"color": "#113a60", "colorOpacity": 50, "markerStrokeColor": "#d12070", "markerStrokeOpacity": 50,
                     "markerFillColor": "#ffffff", "markerFillOpacity": 0, "markerTextColor": "#0b253d", "markerTextOpacity": 0,
                     "lineStyle": "dotted", "regionStrokeWidth": 10, "markerStrokeWidth": 4, "markerDiameter": None})
        except (json.JSONDecodeError, PermissionError):
            return False

    wait_for(saved_styles, "common and item styles on disk")
    panel.get_by_role("button", name="新規画像の既定スタイルにする").click()
    settings_file = file.parent.parent / "profile" / "User" / "settings.json"

    def saved_default_style():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8-sig"))
            return settings.get("screenSpecAnnotator.defaultStyle") == common_style
        except (FileNotFoundError, json.JSONDecodeError, PermissionError):
            return False

    wait_for(saved_default_style, "common style saved as the VS Code default")
    png.unlink()
    panel.get_by_role("button", name="PNGを出力").click()
    wait_for(png.is_file, "PNG with dotted rectangle and solid marker")
    pixels = rect.evaluate("""async (rect, encoded) => {
        const svg = document.createElementNS(rect.namespaceURI, "svg");
        svg.setAttribute("width", 200);
        svg.setAttribute("height", 100);
        const outline = rect.cloneNode();
        outline.setAttribute("fill", "none");
        svg.append(outline);
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const png = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const image = new Image();
        const svgUrl = URL.createObjectURL(new Blob(
            [new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
        image.src = svgUrl;
        await image.decode();
        URL.revokeObjectURL(svgUrl);
        const pixels = (source, points) => {
            const context = new OffscreenCanvas(200, 100).getContext("2d");
            context.drawImage(source, 0, 0);
            return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
        };
        const dot = [[40, 20], [36, 20], [40, 16], [44, 24], [50, 20]];
        const marker = [[72, 20], [65, 27], [65, 13], [65, 10], [65, 20]];
        return { svg: pixels(image, dot).map(pixel => pixel[3]),
                 png: pixels(png, dot), marker: pixels(png, marker) };
    }""", base64.b64encode(png.read_bytes()).decode("ascii"))
    assert all(alpha in (127, 128) for alpha in pixels["svg"][:3]), pixels
    assert pixels["svg"][3:] == [0, 0], pixels
    assert all(abs(pixel[0] - 8.5) <= 0.5 and pixel[1:] == [29, 48, 255] for pixel in pixels["png"][:3]), pixels
    assert pixels["png"][3:] == [[0, 0, 0, 255]] * 2, pixels
    assert all(abs(pixel[0] - 104.5) <= 0.5 and pixel[1:] == [16, 56, 255] for pixel in pixels["marker"][:3]), pixels
    assert pixels["marker"][3:] == [[0, 0, 0, 255]] * 2, pixels

    set_color("#item-color", opacity=100)
    item_line.select_option("dashed")
    expect(rect).to_have_attribute("stroke-dasharray", "40 30")
    row_name.press(save_key)
    wait_for(lambda: json.loads(file.read_text(encoding="utf-8-sig"))["items"][0]["style"]["lineStyle"] == "dashed",
             "dashed item style on disk")
    png.unlink()
    panel.get_by_role("button", name="PNGを出力").click()
    wait_for(png.is_file, "PNG with thick dashed rectangle")
    pixels = rect.evaluate("""async (_, encoded) => {
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const context = new OffscreenCanvas(image.width, image.height).getContext("2d");
        context.drawImage(image, 0, 0);
        return [[45, 20], [60, 40], [45, 50], [20, 35]].map(([x, y]) =>
            Array.from(context.getImageData(x, y, 1, 1).data));
    }""", base64.b64encode(png.read_bytes()).decode("ascii"))
    assert pixels == [[17, 58, 96, 255], [0, 0, 0, 255]] * 2, pixels


def exercise_numbering(panel, file):
    labels = panel.locator("#rows .row-number span")
    expect(labels).to_have_text(["1", "2"])
    first_number = panel.locator("#rows .row-number").first
    first_number.click()
    expect(first_number).to_have_attribute("aria-pressed", "true")
    first_number.dblclick()
    number = panel.get_by_role("spinbutton", name="1番の新しい番号")
    expect(panel.locator("#number-dialog")).not_to_be_visible()
    number.fill("11")
    number.press("Escape")
    expect(first_number).to_be_focused()
    expect(labels).to_have_text(["1", "2"])
    first_number.dblclick()
    number.fill("2")
    number.press("Enter")
    expect(panel.locator(".inline-number-error")).to_contain_text("使用中")
    number.fill("10")
    number.press("Enter")
    expect(labels).to_have_text(["10", "2"])
    first_number.press("F2")
    updated = panel.get_by_role("spinbutton", name="10番の新しい番号")
    updated.fill("12")
    updated.press("Tab")
    expect(labels).to_have_text(["12", "2"])
    expect(panel.locator("g[data-id=sample] text")).to_have_text("12")
    rows = panel.locator("#rows tr")
    rows.nth(1).locator("td:last-child .row-handle").drag_to(rows.first, target_position={"x": 12, "y": 3})
    expect(labels).to_have_text(["2", "12"])
    names = rows.locator(".row-name")
    names.first.press("Tab")
    expect(names.last).to_be_focused()
    names.last.press("Shift+Tab")
    expect(names.first).to_be_focused()
    names.first.press("Shift+Tab")
    expect(rows.first.locator(".row-number")).to_be_focused()
    names.last.press("Tab")
    expect(rows.last.locator(".row-handle")).to_be_focused()
    bulk = panel.get_by_role("button", name="一括再付番")
    bulk.click()
    expect(panel.locator("#preview-rows tr").first.locator("td")).to_have_text(["2", "1", "次へ"])
    panel.get_by_role("button", name="取消", exact=True).click()
    expect(labels).to_have_text(["2", "12"])
    bulk.click()
    panel.get_by_role("button", name="確定", exact=True).click()
    expect(labels).to_have_text(["1", "2"])
    expect(panel.locator("g[data-id=sample] text")).to_have_text("2")
    panel.locator('#rows input[type="text"]').first.press("Meta+s" if sys.platform == "darwin" else "Control+s")

    def saved_order():
        try:
            saved = json.loads(file.read_text(encoding="utf-8-sig"))
            return (saved["highestIssuedNumber"] == 12 and
                    [(row["id"], row["number"]) for row in saved["items"]] == [("second", 1), ("sample", 2)])
        except (json.JSONDecodeError, PermissionError, FileNotFoundError):
            return False
    wait_for(saved_order, "row order and numbers on disk")
    screen_id = panel.get_by_label("画面ID入力")
    expect(screen_id).to_have_value("")
    screen_id.fill('S001,"検索"')
    screen_id.press("Meta+s" if sys.platform == "darwin" else "Control+s")
    wait_for(lambda: json.loads(file.read_text(encoding="utf-8-sig")).get("screenId") == 'S001,"検索"',
             "screen ID on disk")
    panel.get_by_role("button", name="一覧出力").click()
    output = file.parent / "output" / "sample.csv"
    wait_for(output.is_file, "metadata CSV")
    with output.open(encoding="utf-8-sig", newline="") as stream:
        assert list(csv.reader(stream)) == [
            ["画面ID", "項目ID", "表示番号", "名称"],
            ['S001,"検索"', "second", "1", "次へ"], ['S001,"検索"', "sample", "2", "final"],
        ]


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
            exercise_numbering(panel, file)
            panel.locator("body").evaluate("body => body.dataset.originalPanel = 'yes'")
            (directory / "reopen").touch()
            names = panel.locator('body:not([data-original-panel]) #rows input[type="text"]')
            expect(names.nth(0)).to_have_value("次へ")
            expect(names.nth(1)).to_have_value("final")
            expect(panel.get_by_label("画面ID入力")).to_have_value('S001,"検索"')
            expect(panel.locator("#rows .row-number span")).to_have_text(["1", "2"])
            page.keyboard.press("F1")
            commands = page.locator(".quick-input-widget input")
            commands.fill(">Excel連携の手順を開く")
            expect(page.get_by_text("Excel連携の手順を開く", exact=True)).to_be_visible()
            commands.press("Enter")
            guide = page.frame_locator("iframe.webview:visible").frame_locator("#active-frame")
            expect(guide.get_by_role("navigation", name="目次")).to_be_visible()
            toc = guide.get_by_role("navigation", name="目次")
            chapter = toc.get_by_role("link", name="追加属性を追加・変更する")
            chapter.click()
            expect(guide.get_by_role("heading", name="追加属性を追加・変更する")).to_be_focused()
            guide.locator('main a[href="#add-attributes"]').first.click()
            expect(guide.get_by_role("heading", name="新しい項目に説明や備考を追加する")).to_be_focused()
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
