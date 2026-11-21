const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isDocumentRequest } = require("../src/protocol.ts");

test("only numbered document operations enter the host queue", () => {
  for (const type of ["save", "saveDefaultStyle", "edit", "copyRects", "pasteRects"]) {
    assert.ok(isDocumentRequest({ type, version: 1, request: 1 }));
  }
  for (const message of [null, { type: "openJson" }, { type: "ready", version: 1, request: 1 },
    { type: "save", request: "1", version: 1 }, { type: "save", request: 1, version: Infinity }]) {
    assert.equal(isDocumentRequest(message), false);
  }
});
