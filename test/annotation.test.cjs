const assert = require("node:assert/strict");
const { test } = require("node:test");
const { applyAnnotationEdit, newAnnotation, parseAnnotation, pasteAnnotations } = require("../src/annotation.ts");

function documentWithItems() {
  const data = newAnnotation("../shared/image.png", { width: 120, height: 80, sha256: "a".repeat(64) });
  for (const [id, x] of [["item01", 4], ["item02", 40], ["item03", 84]]) {
    applyAnnotationEdit(data, { kind: "add", region: { x, y: 0, width: 10, height: 10 } }, () => id);
  }
  return data;
}

test("v2 preserves row order, optional styles, column values and extension fields after a name edit", () => {
  const data = documentWithItems();
  data.items.reverse();
  data.items[0].values.column = "日本語\n二行目";
  data.items[0].style = { lineStyle: "dashed" };
  data.extra = { source: "fixture" };
  const loaded = parseAnnotation("\uFEFF" + JSON.stringify(data));
  applyAnnotationEdit(loaded, { kind: "name", id: "item02", name: "更新" });
  data.items[1].name = "更新";
  assert.deepEqual(parseAnnotation(JSON.stringify(loaded)), data);
});

test("invalid JSON, v1, duplicate numbers or IDs and an inconsistent maximum are rejected", () => {
  assert.throws(() => parseAnnotation("{"));
  for (const change of [
    data => { data.version = 1; },
    data => { data.items[1].id = data.items[0].id; },
    data => { data.items[1].number = data.items[0].number; },
    data => { data.highestIssuedNumber = 2; },
  ]) {
    const data = documentWithItems();
    change(data);
    assert.throws(() => parseAnnotation(JSON.stringify(data)));
  }
});

test("pasting after deleting the highest number and reopening uses fresh IDs and numbers", () => {
  const data = documentWithItems();
  applyAnnotationEdit(data, { kind: "remove", ids: ["item03"] });
  const loaded = parseAnnotation(JSON.stringify(data));
  const source = loaded.items[0];
  source.values.column = "値";
  const ids = ["item01", "item04"];
  assert.deepEqual(pasteAnnotations(loaded, [source], () => ids.shift()), ["item04"]);
  const copy = loaded.items.at(-1);
  assert.equal(copy.number, 4);
  assert.equal(loaded.highestIssuedNumber, 4);
  assert.deepEqual(copy.values, source.values);
  assert.notEqual(copy.values, source.values);
  assert.equal(copy.marker.x - copy.region.x, source.marker.x - source.region.x);
  assert.equal(copy.marker.y - copy.region.y, source.marker.y - source.region.y);
});

test("an invalid final geometry rejects the entire batch", () => {
  const data = documentWithItems();
  const before = structuredClone(data);
  assert.throws(() => applyAnnotationEdit(data, { kind: "geometry", changes: [
    { id: "item01", region: { x: 20 } }, { id: "item02", region: { x: 120 } },
  ] }));
  assert.deepEqual(data, before);
});

test("moving a rectangle preserves marker offset except on explicitly edited axes", () => {
  const data = documentWithItems();
  assert.deepEqual(data.items[0].marker, { x: 14, y: 7 });
  applyAnnotationEdit(data, { kind: "geometry", changes: [
    { id: "item01", region: { x: 14, y: 20 }, marker: { y: 35 } },
  ] });
  assert.deepEqual(data.items[0].marker, { x: 24, y: 35 });
});

test("a paste that does not fit preserves all destination items and the issued maximum", () => {
  const data = documentWithItems();
  const destination = newAnnotation("small.png", { ...data.confirmedImage, width: 16 });
  const before = structuredClone(destination);
  const ids = ["copy01", "copy02"];
  assert.throws(() => pasteAnnotations(destination, data.items.slice(0, 2), () => ids.shift()));
  assert.deepEqual(destination, before);
});

test("mixed alignment uses each marker's diameter and only moves the selected parts", () => {
  const data = documentWithItems();
  applyAnnotationEdit(data, { kind: "style", id: "item03", property: "markerDiameter", value: 20 });
  applyAnnotationEdit(data, { kind: "align", alignment: "left", subjects: [
    { id: "item01", part: "region" }, { id: "item02", part: "marker" }, { id: "item03", part: "marker" },
  ] });
  assert.deepEqual(data.items.map(item => item.region.x), [4, 40, 84]);
  // The two selected circles have radii 7 and 10. Their left edges align at x=4.
  assert.deepEqual(data.items.map(item => item.marker.x), [14, 11, 14]);
});

test("horizontal distribution fixes the outer rectangles and moves the middle marker with its rectangle", () => {
  const data = documentWithItems();
  const before = structuredClone(data);
  applyAnnotationEdit(data, { kind: "distribute", direction: "horizontal", subjects: [
    { id: "item03", part: "region" }, { id: "item01", part: "region" }, { id: "item02", part: "region" },
  ] });
  assert.deepEqual(data.items[0], before.items[0]);
  assert.deepEqual(data.items[2], before.items[2]);
  assert.deepEqual(data.items[1].region, { ...before.items[1].region, x: 44 });
  assert.deepEqual(data.items[1].marker, { ...before.items[1].marker, x: 54 });
});
