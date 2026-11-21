const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OperationQueue } = require("../src/webview/operation-queue.ts");

const name = value => ({ kind: "edit", edit: { kind: "name", id: "item01", name: value } });

test("coalesced names retain the original comparison value", () => {
  const sent = [];
  const queue = new OperationQueue(message => sent.push(message));
  for (const [previousName, value] of [["", "A"], ["A", "AB"], ["AB", "ABC"]]) {
    queue.enqueue({ kind: "edit", edit: { ...name(value).edit, previousName } });
  }
  queue.sendNext(1);
  assert.deepEqual(sent[0].edit, { ...name("ABC").edit, previousName: "" });
});

test("only adjacent waiting names coalesce, and state notifications cannot acknowledge a request", () => {
  const sent = [];
  const queue = new OperationQueue(message => sent.push(message));
  queue.enqueue(name("A"));
  queue.sendNext(undefined);
  assert.equal(sent.length, 0);
  queue.sendNext(10);
  queue.enqueue(name("AB"));
  queue.enqueue(name("ABC"));
  queue.enqueue({ kind: "save" });
  assert.deepEqual(queue.queuedEdits(), [name("A").edit, name("ABC").edit]);
  assert.equal(queue.complete(99, true), undefined);
  queue.sendNext(11);
  assert.equal(sent.length, 1);
  assert.deepEqual(queue.complete(1, false), name("A"));
  queue.sendNext(11);
  queue.complete(2, false);
  queue.sendNext(12);
  assert.deepEqual(sent, [
    { type: "edit", version: 10, request: 1, edit: name("A").edit },
    { type: "edit", version: 11, request: 2, edit: name("ABC").edit },
    { type: "save", version: 12, request: 3 },
  ]);
});

test("a failed request drops queued saves while retaining subsequent edits and clipboard requests", () => {
  const sent = [];
  const queue = new OperationQueue(message => sent.push(message));
  queue.enqueue(name("failed"));
  queue.sendNext(3);
  const otherName = { kind: "edit", edit: { kind: "name", id: "item02", name: "later" } };
  for (const operation of [{ kind: "save" }, name("stale"), otherName, { kind: "saveDefaultStyle" },
    { kind: "copyRects", ids: ["item01"] }, { kind: "pasteRects" }]) queue.enqueue(operation);
  queue.complete(1, true);
  for (const request of [2, 3, 4]) {
    queue.sendNext(4);
    queue.complete(request, false);
  }
  queue.sendNext(4);
  assert.deepEqual(sent.map(m => m.type), ["edit", "edit", "copyRects", "pasteRects"]);
  assert.equal(sent[1].edit.id, "item02");
  assert.deepEqual(sent[2].ids, ["item01"]);
  assert.deepEqual(queue.queuedEdits(), []);
});
